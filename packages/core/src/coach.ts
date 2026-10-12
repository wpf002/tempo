import Anthropic from "@anthropic-ai/sdk";
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
  explanation: z.string().min(1).max(1200),
  takeaway: z.string().min(1).max(300),
});
export type Explanation = z.infer<typeof Explanation>;

const GameSummary = z.object({
  summary: z.string().min(1).max(1500),
  focus: z.array(z.string().max(200)).min(1).max(3),
});
export type GameSummary = z.infer<typeof GameSummary>;

const SYSTEM = `You are Tempo, a chess coach with grandmaster-level understanding teaching an improving club player.

Stockfish analysis is in every request and it is ground truth. Rules:
- Only describe tactics, threats, and lines that the engine lines support. If the engine lines don't show it, don't claim it.
- Use SAN for moves. Refer to squares and pieces concretely ("the knight on f3"), not vaguely.
- Explain the idea behind the best move and what the played move allowed or missed. Why, not just what.
- Pick the single motif that best fits.
- The takeaway is one rule of thumb the player can reuse in future games. Concrete, not a platitude.
- Plain language. No filler, no praise, no hedging. Under 110 words for the explanation.`;

export interface MoveContext {
  fenBefore: string;
  playedSan: string;
  playedScore: EngineLine["score"];
  grade: Grade;
  bestLines: EngineLine[];
  playerColor: "w" | "b";
  phase: Phase;
  moveNumber: number;
}

export interface PositionContext {
  fen: string;
  lines: EngineLine[];
}

export interface CoachOptions {
  apiKey: string;
  model: string;
  /** Override for tests. */
  client?: Pick<Anthropic, "messages">;
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
  private client: Pick<Anthropic, "messages">;

  constructor(private readonly opts: CoachOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
  }

  private async callTool<T>(schema: z.ZodType<T>, toolName: string, inputSchema: Anthropic.Tool["input_schema"], prompt: string, maxTokens = 700): Promise<T> {
    const res = await this.client.messages.create({
      model: this.opts.model,
      max_tokens: maxTokens,
      system: SYSTEM,
      tools: [{ name: toolName, description: "Return the coaching output.", input_schema: inputSchema }],
      tool_choice: { type: "tool", name: toolName },
      messages: [{ role: "user", content: prompt }],
    });
    const block = res.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") throw new Error("coach returned no structured output");
    return schema.parse(block.input);
  }

  private static explanationSchema: Anthropic.Tool["input_schema"] = {
    type: "object",
    properties: {
      motif: { type: "string", enum: [...MOTIFS] },
      explanation: { type: "string" },
      takeaway: { type: "string" },
    },
    required: ["motif", "explanation", "takeaway"],
  };

  /** Explain a played move against the engine's best lines. */
  explainMove(ctx: MoveContext): Promise<Explanation> {
    const side = ctx.playerColor === "w" ? "White" : "Black";
    const prompt = `The player is ${side}. Move ${ctx.moveNumber}, ${ctx.phase}.

Position before the move (FEN ${ctx.fenBefore}):
${board(ctx.fenBefore)}

Player played: ${ctx.playedSan} (eval after: ${formatScore(ctx.playedScore)}). Graded: ${ctx.grade}.

Engine's best lines from the position before the move (evals are from White's point of view):
${linesBlock(ctx.bestLines)}

Explain what ${ctx.playedSan} got wrong and what the best move does.`;
    return this.callTool(Explanation, "coach_move", Coach.explanationSchema, prompt);
  }

  /** Explain the best move in a position (the "why" after a tier-3 hint). */
  explainPosition(ctx: PositionContext): Promise<Explanation> {
    const side = new Chess(ctx.fen).turn() === "w" ? "White" : "Black";
    const prompt = `${side} to move. FEN ${ctx.fen}
${board(ctx.fen)}

Engine's best lines (evals from White's point of view):
${linesBlock(ctx.lines)}

Explain why the top move is best and what the position is about.`;
    return this.callTool(Explanation, "coach_position", Coach.explanationSchema, prompt);
  }

  /** Summarize a whole game from its graded mistakes. */
  summarizeGame(input: {
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

Write a short game summary (what decided the game, under 120 words) and 1-3 focus areas for the next week of practice, weighted by recurring motifs.`;
    return this.callTool(
      GameSummary,
      "coach_summary",
      {
        type: "object",
        properties: {
          summary: { type: "string" },
          focus: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
        },
        required: ["summary", "focus"],
      },
      prompt,
      900,
    );
  }
}
