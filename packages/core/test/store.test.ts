import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { START_FEN } from "../src/notation.js";

describe("store", () => {
  it("round-trips games, mistakes, and drill scheduling", () => {
    const s = new Store(":memory:");
    s.upsertGame({ id: "g1", source: "lichess", externalId: "abc", playerColor: "w", opponent: "AI level 3", vsComputer: true, startFen: START_FEN, moves: ["e2e4"], result: null, startedAt: 1, endedAt: null });
    s.upsertGame({ id: "g1", source: "lichess", externalId: "abc", playerColor: "w", opponent: "AI level 3", vsComputer: true, startFen: START_FEN, moves: ["e2e4", "e7e5"], result: "1-0", startedAt: 1, endedAt: 2 });
    expect(s.getGame("g1")?.moves).toEqual(["e2e4", "e7e5"]);
    const id = s.addMistake({ gameId: "g1", ply: 1, fen: START_FEN, playedSan: "a4", bestUci: "e2e4", bestSan: "e4", grade: "mistake", motif: "development", explanation: "x", takeaway: "y", phase: "opening" });
    expect(s.dueDrills(10, Date.now() + 1)).toHaveLength(1);
    s.recordAttempt(id, true, 1000);
    expect(s.getDrill(id)?.dueAt).toBe(1000 + 2 * 86_400_000);
    s.recordAttempt(id, false, 1000);
    expect(s.getDrill(id)?.solved).toBe(0);
    expect(s.motifCounts()).toEqual([{ motif: "development", count: 1 }]);
    s.close();
  });
});
