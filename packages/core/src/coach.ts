import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Chess } from "chess.js";
import { z } from "zod";
import type { EngineLine } from "./engine.js";
import { formatScore, type Grade, type Phase } from "./grade.js";

export const MOTIFS = [
  "fork", "pin", "skewer", "discovered attack", "double attack", "hanging piece",
  "back-rank weakness", "overloaded defender", "deflection", "removing the defender",
  "trapped piece", "missed mate", "missed threat", "king safety", "development",
  "center control", "pawn structure", "weak square", "piece activity", "endgame technique", "other",
] as const;
export type Motif = (typeof MOTIFS)[number];

const Explanation = z.object({
  motif: z.enum(MOTIFS),
  explanation: z.string(),
  takeaway: z.string(),
});
export type Explanation = z.infer<typeof Explanation>;

const HintSet = z.object({
  strategy: z.string(),
  keySquares: z.array(z.string()),
  plan: z.string(),
  piece: z.string(),
  move: z.string(),
});
export type HintSet = z.infer<typeof HintSet>;

const GameSummary = z.object({
  summary: z.string(),
  focus: z.array(z.string()),
});
export type GameSummary = z.infer<typeof GameSummary>;

const SYSTEM = `You are Tempo, a grandmaster coaching a beginner at the board. They don't read chess notation and don't know chess jargon.

Stockfish analysis is in every request and it is ground truth. Rules:
- Only describe tactics, threats, and lines that the engine lines support. If the engine lines don't show it, don't claim it.
- Think like a grandmaster (king safety, the center, which pieces are doing nothing, what the opponent wants next), then say it the way you'd say it to a friend across the board.
- Never write algebraic notation like "Bh3", "Nf3", "exd5", or "O-O". Say "bishop to h3", "knight to f3", "pawn takes on d5", "castle". Squares like e4 are fine.
- No chess jargon or slang: no "diagonal", "open lines", "loose", "fianchetto", "tempo", "bites on nothing", "develops with purpose", "minor piece", "prophylaxis", "initiative". Say what actually happens: "your bishop can be chased away", "nothing protects your pawn on g4".
- If a tactic is the point, name it and say what it does in the same breath: "a fork, where one piece attacks two of theirs at once".
- Plain words, short sentences, the way people talk. No filler, no praise, no hedging, no numbers about the evaluation.`;

export interface MoveContext {
  fenBefore: string;
  playedSan: string;
  playedScore: EngineLine["score"];
  grade: Grade;
  bestLines: EngineLine[];
  playerColor: "w" | "b";
  phase: Phase;
  moveNumber: number;
  /** Two sentences for the live overlay instead of a full explanation. */
  brief?: boolean;
}

export interface PositionContext {
  fen: string;
  lines: EngineLine[];
}

export interface CoachOptions {
  apiKey: string;
  model: string;
  /** Needed when the API key isn't scoped to a workspace. */
  workspaceId?: string;
  /** Override for tests. */
  client?: Pick<Anthropic, "beta">;
}

function board(fen: string): string {
  return new Chess(fen).ascii();
}

function linesBlock(lines: EngineLine[]): string {
  return lines
    .map((l, i) => `${i + 1}. ${l.pvSan.slice(0, 8).join(" ")}  [eval ${formatScore(l.score)}, depth ${l.depth}]`)
    .join("\n");
}

export class Coach {
  private client: Pick<Anthropic, "beta">;

  constructor(private readonly opts: CoachOptions) {
    this.client =
      opts.client ??
      new Anthropic({ apiKey: opts.apiKey, defaultHeaders: opts.workspaceId ? { "anthropic-workspace-id": opts.workspaceId } : undefined });
  }

  /** One structured-output call. Effort stays low: these are short answers grounded in engine lines. */
  private async ask<T>(schema: z.ZodType<T>, prompt: string, maxTokens = 4000, effort: "low" | "medium" = "low"): Promise<T> {
    const res = await this.client.beta.messages.parse({
      model: this.opts.model,
      max_tokens: maxTokens,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
      output_config: { format: betaZodOutputFormat(schema), effort },
      // If a safety classifier declines, the API reruns the request on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (res.stop_reason === "refusal") throw new Error("coach request was declined");
    if (res.parsed_output == null) throw new Error(`coach returned no structured output (${res.stop_reason})`);
    return res.parsed_output;
  }

  /** Explain a played move against the engine's best lines. */
  explainMove(ctx: MoveContext): Promise<Explanation> {
    const side = ctx.playerColor === "w" ? "White" : "Black";
    const prompt = `The player is ${side}. Move ${ctx.moveNumber}, ${ctx.phase}.

Position before the move (FEN ${ctx.fenBefore}):
${board(ctx.fenBefore)}

Player played: ${ctx.playedSan} (eval after: ${formatScore(ctx.playedScore)}). Graded: ${ctx.grade}.

Engine's best lines from the position before the move (evals are from White's point of view):
${linesBlock(ctx.bestLines)}

${ctx.brief
  ? `In at most two short sentences (under 35 words), say what was wrong with that move and what the better move does instead, in everyday words. The takeaway is one short rule they can remember.`
  : `Explain what ${ctx.playedSan} got wrong and what the best move does.`}`;
    return this.ask(Explanation, prompt);
  }

  /**
   * The three hint levels for the player's move, in a grandmaster's words: the plan, then the piece, then why the move works.
   * Each level must not give away the next.
   */
  hintPosition(ctx: { fen: string; lines: EngineLine[]; sans: string[]; opening: string | null }): Promise<HintSet> {
    const side = new Chess(ctx.fen).turn() === "w" ? "White" : "Black";
    const history = ctx.sans.length
      ? ctx.sans.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${m}` : m)).join(" ")
      : "(no moves yet, or Tempo joined mid-game)";
    const prompt = `The player is ${side} and it is their move.
Moves so far: ${history}
Opening: ${ctx.opening ?? "not in Tempo's list; name it from the moves if you know it"}

Position (FEN ${ctx.fen}):
${board(ctx.fen)}

Engine's best lines (evals from White's point of view):
${linesBlock(ctx.lines)}

Write the coaching for this move:
- strategy: the name of the plan in 2 to 4 plain words, Title Case. Use a well-known name when one fits ("Castle Early", "Control the Center", "Kingside Attack", "Trade When Ahead", "Knight Fork"), otherwise name what the plan does.
- keySquares: up to 3 squares the plan is about (lowercase, like "e4"), for highlighting on a diagram.
- plan: what to aim for over the next few moves and why, the way a grandmaster would explain it to a beginner. Must not name the best move or the piece that plays it. Under 30 words.
- piece: which piece to move now and why that one, without saying where it goes. Under 20 words.
- move: why the best move (${ctx.lines[0]?.pvSan[0] ?? "the first move of line 1"}) is good, in everyday words. Don't start by repeating the move. Under 25 words.`;
    return this.ask(HintSet, prompt, 4000, "medium");
  }

  /** Explain the best move in a position (the "why" after a tier-3 hint). */
  explainPosition(ctx: PositionContext): Promise<Explanation> {
    const side = new Chess(ctx.fen).turn() === "w" ? "White" : "Black";
    const prompt = `${side} to move. FEN ${ctx.fen}
${board(ctx.fen)}

Engine's best lines (evals from White's point of view):
${linesBlock(ctx.lines)}

Explain why the top move is best and what the position is about.`;
    return this.ask(Explanation, prompt);
  }

  /** Summarize a whole game from its graded mistakes. */
  async summarizeGame(input: {
    playerColor: "w" | "b";
    result: string;
    accuracy: number;
    mistakes: { moveNumber: number; san: string; grade: Grade; motif: string; phase: Phase; bestSan: string }[];
    history: { motif: string; count: number }[];
  }): Promise<GameSummary> {
    const side = input.playerColor === "w" ? "White" : "Black";
    const list = input.mistakes.length
      ? input.mistakes.map((m) => `- Move ${m.moveNumber} ${m.san} (${m.grade}, ${m.phase}, motif: ${m.motif}); best was ${m.bestSan}`).join("\n")
      : "- No inaccuracies or worse.";
    const hist = input.history.length
      ? input.history.map((h) => `- ${h.motif}: ${h.count}`).join("\n")
      : "- No history yet.";
    const prompt = `The player was ${side}. Result: ${input.result}. Accuracy: ${input.accuracy.toFixed(0)}%.

Mistakes this game:
${list}

Mistake motifs across all past games:
${hist}

Write a short game summary (what decided the game, under 120 words) and 1-3 focus areas for the next week of practice, weighted by recurring motifs. Each focus area is one short line.`;
    const out = await this.ask(GameSummary, prompt);
    return { summary: out.summary, focus: out.focus.slice(0, 3) };
  }
}
