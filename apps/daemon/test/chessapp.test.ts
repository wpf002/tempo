import { describe, expect, it } from "vitest";
import { ChessAppTracker, extractMoves } from "../src/sources/chessapp.js";
import type { GameUpdate } from "../src/sources/types.js";

describe("extractMoves", () => {
  it("picks the window with the move log", () => {
    const moves = extractMoves([
      { title: "Chess", texts: ["White to move", "a", "b"] },
      { title: "Game Log", texts: ["1.", "e4", "e5", "2.", "Nf3", "Nc6"] },
    ]);
    expect(moves).toEqual(["e2e4", "e7e5", "g1f3", "b8c6"]);
  });
});

describe("ChessAppTracker", () => {
  const setup = () => {
    const out: GameUpdate[] = [];
    let t = 1_700_000_000_000;
    const tr = new ChessAppTracker((u) => out.push(u), () => t++);
    return { out, tr };
  };

  it("extends, handles takebacks, and splits new games", () => {
    const { out, tr } = setup();
    tr.ingest(["e2e4"]);
    tr.ingest(["e2e4", "e7e5"]);
    tr.ingest(["e2e4", "e7e5"]); // no change
    tr.ingest(["e2e4"]); // takeback
    tr.ingest(["e2e4", "c7c5", "g1f3", "d7d6"]);
    expect(out).toHaveLength(4);
    expect(new Set(out.map((u) => u.gameId)).size).toBe(1);
    tr.ingest([]); // new game set up
    expect(out.at(-1)!.finished).toBe(true);
    tr.ingest(["e2e4"]); // same first move, new game
    expect(out.at(-1)!.gameId).not.toBe(out[0]!.gameId);
    expect(out.at(-1)!.finished).toBe(false);
  });

  it("finishes on mate and ignores the stale log", () => {
    const { out, tr } = setup();
    const mate = ["f2f3", "e7e5", "g2g4", "d8h4"];
    tr.ingest(mate);
    expect(out.at(-1)).toMatchObject({ finished: true, result: "0-1" });
    tr.ingest(mate);
    tr.ingest(mate.slice(0, 3));
    expect(out).toHaveLength(1);
  });
});
