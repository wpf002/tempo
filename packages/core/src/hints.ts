import { Chess, type Square } from "chess.js";
import type { Analysis } from "./engine.js";
import { applyUci } from "./notation.js";
import { formatScore, povChances } from "./grade.js";

export interface Hint {
  tier: 1 | 2 | 3;
  text: string;
  /** Tier 2: the square of the piece to move, so the panel can highlight it. */
  square?: string;
  /** Tier 3: the move in UCI, so the panel can draw it. */
  uci?: string;
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

  let tier1: string;
  if (mateFor !== null) tier1 = `There's a forced mate in ${mateFor}. Look at every check.`;
  else if (threat?.kind === "check") tier1 = "You're in check. Compare all three ways out: move the king, block, or capture.";
  else if (threat?.kind === "mate") tier1 = "Your opponent is threatening mate. Find the threat and stop it.";
  else if (forcing && gap >= 0.15 && mv.san.includes("+")) tier1 = "A check here does real damage. Look at your forcing moves.";
  else if (forcing && gap >= 0.15) tier1 = "Something can be taken, and it matters. Check what's undefended.";
  else if (threat?.kind === "material") tier1 = `Your ${PIECE_NAMES[threat.piece]} on ${threat.square} is in trouble. Deal with it or create a bigger threat.`;
  else if (gap >= 0.3) tier1 = "Only one move keeps your position together. Look at what your opponent wants to do.";
  else if (gap >= 0.15) tier1 = "One move is clearly better than the rest. Look for a tactic.";
  else if (mv.captured) tier1 = "A capture is the cleanest move here.";
  else if (mv.san.startsWith("O-O")) tier1 = "Get your king safe.";
  else tier1 = "No tactic. It's a quiet position. Improve your worst-placed piece.";

  const pieceName = PIECE_NAMES[piece?.type ?? "p"] ?? "piece";
  const tier2 = mv.san.startsWith("O-O") ? "Castle." : `Move your ${pieceName} on ${from}.`;

  const line = best.pvSan.slice(0, 5).join(" ");
  const tier3 = `${mv.san} (${formatScore(best.score)}). Main line: ${line}`;

  return [
    { tier: 1, text: tier1 },
    { tier: 2, text: tier2, square: mv.from },
    { tier: 3, text: tier3, uci: mv.from + mv.to + (mv.promotion ?? "") },
  ];
}
