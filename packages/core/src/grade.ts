import type { Score } from "./engine.js";

export type Grade = "best" | "good" | "inaccuracy" | "mistake" | "blunder";

/** Lichess's winning-chances curve. Returns -1..1 from White's POV. */
export function winningChances(score: Score): number {
  if (score.mate !== null) return score.mate > 0 ? 1 : -1;
  const cp = Math.max(-1000, Math.min(1000, score.cp ?? 0));
  return 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
}

/** Score from the mover's POV, as winning chances (-1..1). */
export function povChances(score: Score, color: "w" | "b"): number {
  const wc = winningChances(score);
  return color === "w" ? wc : -wc;
}

/**
 * Grade a move by how much winning chance it gave up.
 * Thresholds match Lichess: 0.1 inaccuracy, 0.2 mistake, 0.3 blunder (on the -1..1 scale).
 */
export function gradeMove(before: Score, after: Score, color: "w" | "b", playedWasBest: boolean): { grade: Grade; loss: number } {
  const loss = Math.max(0, povChances(before, color) - povChances(after, color));
  if (playedWasBest) return { grade: "best", loss: 0 };
  if (loss >= 0.3) return { grade: "blunder", loss };
  if (loss >= 0.2) return { grade: "mistake", loss };
  if (loss >= 0.1) return { grade: "inaccuracy", loss };
  return { grade: "good", loss };
}

/** Human-readable eval: "+1.3", "-0.4", "M3", "-M2". White POV. */
export function formatScore(score: Score): string {
  if (score.mate !== null) return `${score.mate < 0 ? "-" : ""}M${Math.abs(score.mate)}`;
  const v = (score.cp ?? 0) / 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

/** Accuracy per move (Lichess formula) from win% before/after, both 0..100 from mover POV. */
export function moveAccuracy(winBefore: number, winAfter: number): number {
  const diff = Math.max(0, winBefore - winAfter);
  const acc = 103.1668 * Math.exp(-0.04354 * diff) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

export function toWinPercent(chances: number): number {
  return 50 + 50 * chances;
}

export type Phase = "opening" | "middlegame" | "endgame";

/** Rough phase: opening by move number, endgame by non-pawn material. */
export function phaseOf(fen: string, fullmove: number): Phase {
  const board = fen.split(" ")[0] ?? "";
  const values: Record<string, number> = { q: 9, r: 5, b: 3, n: 3 };
  let material = 0;
  for (const ch of board.toLowerCase()) material += values[ch] ?? 0;
  if (material <= 26) return "endgame"; // roughly: queens off plus a minor or two, or equivalent
  if (fullmove <= 12) return "opening";
  return "middlegame";
}
