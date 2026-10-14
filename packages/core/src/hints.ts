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
  /** Tier 3: why the move works, when the coach has explained it. */
  why?: string;
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

  // Tier 1 says what to aim for, without naming the piece. The coach replaces this with a grandmaster's plan when it's
  // available; this is the fallback, built only from facts about the position so it never reads as filler.
  const homeRank = color === "w" ? "1" : "8";
  const undeveloped = (["b1", "g1", "c1", "f1"] as const)
    .map((sq) => (color === "w" ? sq : (sq.replace("1", "8") as Square)))
    .filter((sq) => {
      const p = chess.get(sq as Square);
      return p && p.color === color && (p.type === "n" || p.type === "b");
    }).length;
  const kingHome = chess.get((color === "w" ? "e1" : "e8") as Square)?.type === "k";
  const targetRank = Number(mv.to[1]);
  const deepSquare = color === "w" ? targetRank >= 5 : targetRank <= 4;

  let tier1: string;
  if (mateFor !== null) tier1 = `You can checkmate in ${mateFor}. Start with checks.`;
  else if (threat?.kind === "check") tier1 = gap >= 0.15 ? "You're in check, and only one way out keeps you in the game." : "You're in check. Pick the way out that leaves your pieces safest.";
  else if (threat?.kind === "mate") tier1 = "They're threatening checkmate. Stop that first.";
  else if (forcing && gap >= 0.15 && mv.san.includes("+")) tier1 = "A check wins something here. Try every check.";
  else if (forcing && gap >= 0.15) tier1 = "One of their pieces isn't protected well enough. Look for it.";
  else if (threat?.kind === "material") tier1 = `Your ${PIECE_NAMES[threat.piece]} on ${threat.square} is under attack. Save it or hit back harder.`;
  else if (gap >= 0.3) tier1 = "Careful: most moves here make things worse. Check what they're threatening first.";
  else if (gap >= 0.15) tier1 = "One move is much better than the rest. Look at what their last move left unprotected.";
  else if (mv.captured) tier1 = "Take back the piece.";
  else if (mv.san.startsWith("O-O")) tier1 = "Get your king to safety.";
  else if (undeveloped >= 2 && kingHome) tier1 = `${["", "", "Two", "Three", "Four"][undeveloped]} of your knights and bishops haven't moved yet, and your king hasn't castled. Get them out toward the middle.`;
  else if (piece?.type === "p" && "de".includes(from[0]!)) tier1 = "Push a pawn into the middle of the board.";
  else if (piece?.type === "p") tier1 = "A pawn move helps here. It makes room for your other pieces.";
  else if (piece?.type === "r") tier1 = "Move a rook to a column with no pawns blocking it.";
  else if (piece?.type === "n" && deepSquare) tier1 = "Your knight has a strong square further up the board.";
  else if ((piece?.type === "n" || piece?.type === "b") && from[1] === homeRank) tier1 = "Bring another knight or bishop into the game.";
  else tier1 = "One of your pieces isn't doing anything. Find it a better square.";

  const pieceName = PIECE_NAMES[piece?.type ?? "p"] ?? "piece";
  const tier2 = mv.san.startsWith("O-O") ? "Castle." : piece?.type === "p" ? `The ${from} pawn.` : `The ${pieceName} on ${from}.`;

  return [
    { tier: 1, text: tier1 },
    { tier: 2, text: tier2, square: mv.from },
    { tier: 3, text: mv.san, uci: mv.from + mv.to + (mv.promotion ?? ""), line: best.pvSan.slice(1, 6).join(" ") },
  ];
}
