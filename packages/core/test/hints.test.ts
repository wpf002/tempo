import { describe, expect, it } from "vitest";
import { opponentThreat } from "../src/hints.js";
import { pickLines, type EngineLine } from "../src/engine.js";

describe("opponentThreat", () => {
  it("spots a mate threat (Qxf7#)", () => {
    expect(opponentThreat("r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3")).toEqual({ kind: "mate" });
  });
  it("spots a loose piece", () => {
    // Black knight on e5 attacked by the f4 pawn... use a hanging knight attacked by a bishop instead.
    const t = opponentThreat("rnbqkb1r/pppppppp/8/8/4n3/3B4/PPPPPPPP/RNBQK1NR b KQkq - 0 1");
    expect(t).toMatchObject({ kind: "material", square: "e4", piece: "n" });
  });
  it("returns null in a calm position", () => {
    expect(opponentThreat("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1")).toBeNull();
  });
  it("reports check", () => {
    expect(opponentThreat("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3")).toEqual({ kind: "check" });
  });
});

describe("pickLines", () => {
  const L = (depth: number, multipv: number, first: string): EngineLine => ({ depth, multipv, score: { cp: 0, mate: null }, pv: [first], pvSan: [] });
  it("drops stale lower PVs that repeat the new best move", () => {
    const m = new Map([
      [11, new Map([[1, L(11, 1, "e7e6")], [2, L(11, 2, "g7g6")], [3, L(11, 3, "d8f6")]])],
      [12, new Map([[1, L(12, 1, "g7g6")]])],
    ]);
    const lines = pickLines(m, 3);
    expect(lines.map((l) => l.pv[0])).toEqual(["g7g6", "d8f6"]);
    expect(lines[0]!.depth).toBe(12);
  });
});
