import { Chess, type Square } from "chess.js";
import type { Analysis } from "./engine.js";
import { applyUci } from "./notation.js";
import { povChances } from "./grade.js";

export interface Hint {
  tier: 1 | 2 | 3;
  text: string;
  /** Tier 2: the square of the piece to move, so the panel can highlight it. */
  square?: string;
  /** Tier 3: the move in UCI, so the panel can draw it. */
  uci?: string;
  /** Tier 3: the engine's expected continuation after the move, in SAN. */
  line?: string;
}

const PIECE_NAMES: Record<string, string> = {
  p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king",
};
const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export type Threat =
  | { kind: "check" }
  | { kind: "mate" }
  | { kind: "material"; square: Square; piece: string };

/** What would the opponent do if it were their move? Null-move probe for mate threats and loose pieces. */
export function opponentThreat(fen: string): Threat | null {
  const c = new Chess(fen);
  if (c.inCheck()) return { kind: "check" };
  const us = c.turn();
  const parts = fen.split(" ");
  parts[1] = us === "w" ? "b" : "w";
  parts[3] = "-";
  let flipped: Chess;
  try {
    flipped = new Chess(parts.join(" "));
  } catch {
    return null;
  }
  const replies = flipped.moves({ verbose: true });
  for (const m of replies) {
    flipped.move(m);
    const mate = flipped.isCheckmate();
    flipped.undo();
    if (mate) return { kind: "mate" };
  }
  let worst: { square: Square; piece: string; value: number } | null = null;
  for (const m of replies) {
    if (!m.captured) continue;
    const gain = VALUE[m.captured] ?? 0;
    if (gain < 3) continue;
    const defended = c.isAttacked(m.to, us);
    if (!defended || gain > (VALUE[m.piece] ?? 0)) {
      if (!worst || gain > worst.value) worst = { square: m.to, piece: m.captured, value: gain };
    }
  }
  return worst ? { kind: "material", square: worst.square, piece: worst.piece } : null;
}

/**
 * Build the three hint tiers from engine output. Deterministic, no LLM, so it's instant and never invents a tactic.
 * Tier 1: what kind of move to look for. Tier 2: which piece. Tier 3: the move and the line.
 */
export function buildHints(analysis: Analysis): Hint[] {
  const best = analysis.lines[0];
  if (!best || !analysis.bestMove) return [{ tier: 1, text: "No legal moves. The game is over." }];

  const chess = new Chess(analysis.fen);
  const color = chess.turn();
  const from = analysis.bestMove.slice(0, 2) as Square;
  const piece = chess.get(from);
  const mv = applyUci(chess, analysis.bestMove);
  if (!mv) return [{ tier: 1, text: "Couldn't read the engine's move." }];

  const second = analysis.lines[1];
  const bestChances = povChances(best.score, color);
  const gap = second ? bestChances - povChances(second.score, color) : 0;
  const mateFor = best.score.mate !== null && (best.score.mate > 0) === (color === "w") ? Math.abs(best.score.mate) : null;
  const threat = opponentThreat(analysis.fen);
  const forcing = mv.san.includes("+") || !!mv.captured;

  // Tier 1 says what kind of move to look for, in a few words, without naming the piece.
  let tier1: string;
  if (mateFor !== null) tier1 = `Mate in ${mateFor}.`;
  else if (threat?.kind === "check") tier1 = gap >= 0.15 ? "Only one good way out of check." : "You're in check.";
  else if (threat?.kind === "mate") tier1 = "They're threatening mate.";
  else if (forcing && gap >= 0.15 && mv.san.includes("+")) tier1 = "Look at your checks.";
  else if (forcing && gap >= 0.15) tier1 = "Something can be taken.";
  else if (threat?.kind === "material") tier1 = `Your ${PIECE_NAMES[threat.piece]} on ${threat.square} is under attack.`;
  else if (gap >= 0.3) tier1 = "Only one move holds.";
  else if (gap >= 0.15) tier1 = "One move stands out.";
  else if (mv.captured) tier1 = "Take something.";
  else if (mv.san.startsWith("O-O")) tier1 = "Think about your king.";
  else if (piece?.type === "p") tier1 = "Quiet position. Look at pawn moves.";
  else if ((piece?.type === "n" || piece?.type === "b") && from[1] === (color === "w" ? "1" : "8")) tier1 = "Quiet position. Develop a piece.";
  else tier1 = "Quiet position. Find a better square for a piece.";

  const pieceName = PIECE_NAMES[piece?.type ?? "p"] ?? "piece";
  const tier2 = mv.san.startsWith("O-O") ? "Castle." : piece?.type === "p" ? `The ${from} pawn.` : `The ${pieceName} on ${from}.`;

  return [
    { tier: 1, text: tier1 },
    { tier: 2, text: tier2, square: mv.from },
    { tier: 3, text: mv.san, uci: mv.from + mv.to + (mv.promotion ?? ""), line: best.pvSan.slice(1, 6).join(" ") },
  ];
}
