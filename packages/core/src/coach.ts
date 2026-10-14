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

const SYSTEM = `You are Tempo, a grandmaster coaching a club player at the board.

Stockfish analysis is in every request and it is ground truth. Rules:
- Only describe tactics, threats, and lines that the engine lines support. If the engine lines don't show it, don't claim it.
- Think like a grandmaster: pawn structure, king safety, piece activity, weak squares and outposts, open files, the center, and the typical plans and maneuvers of the opening on the board. Name the opening when you know it.
- Use the standard names for tactics when one is present: fork, pin, skewer, discovered attack, double attack, deflection, decoy, overloaded defender, removing the defender, x-ray, zwischenzug, back-rank mate, trapped piece, clearance, interference, Greek gift.
- Use SAN for moves. Refer to squares and pieces concretely ("the knight on f3").
- Talk the way a strong human coach talks: direct, specific to this position, short sentences. Never generic advice that fits any position ("improve your worst piece", "it's a quiet position"). No filler, no praise, no hedging, no engine jargon like "centipawns" or "eval".
- Under 110 words for the explanation unless told otherwise.`;

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
  ? `In at most two short sentences (under 40 words), say what ${ctx.playedSan} allowed or missed and what the better move does. Concrete: name the piece, square, or threat. The takeaway is one short rule.`
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

Write three hint levels, each revealing a little more:
- plan: the strategic plan for the next few moves and why, as a grandmaster sees this position. Typical maneuvers for this opening or structure, what to aim at, what to avoid. Must not name the engine's top move or the piece that plays it. Under 35 words.
- piece: which piece to move now and why that piece, without saying where it goes. Under 20 words.
- move: why the engine's top move (${ctx.lines[0]?.pvSan[0] ?? "the first move of line 1"}) is best, naming the tactic or threat if there is one. Don't start by repeating the move. Under 30 words.`;
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
