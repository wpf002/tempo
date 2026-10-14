import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine, parseInfo } from "../src/engine.js";
import { buildHints } from "../src/hints.js";
import { reviewGame, checkDrillAnswer } from "../src/review.js";
import { Store } from "../src/store.js";
import { Coach } from "../src/coach.js";
import { START_FEN } from "../src/notation.js";

describe("parseInfo", () => {
  it("flips score to White POV when Black is to move", () => {
    const l = parseInfo("info depth 12 seldepth 18 multipv 2 score cp 45 nodes 1 pv e7e5 g1f3", false);
    expect(l?.score.cp).toBe(-45);
    expect(l?.multipv).toBe(2);
    expect(l?.pv).toEqual(["e7e5", "g1f3"]);
  });
  it("skips bound scores", () => {
    expect(parseInfo("info depth 10 score cp 20 lowerbound pv e2e4", true)).toBeNull();
  });
});

// Integration tests run when Stockfish is available (STOCKFISH_PATH or on PATH).
const SF = process.env.STOCKFISH_PATH || (() => {
  try {
    return execSync("command -v stockfish", { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
})();
describe.skipIf(!SF)("engine integration", () => {
  let engine: Engine;
  beforeAll(async () => {
    engine = new Engine({ path: SF!, threads: 1, hashMb: 32 });
    await engine.start();
  });
  afterAll(() => engine.stop());

  it("finds mate in one and the hint says so", async () => {
    // Scholar's mate setup: Qxf7#
    const fen = "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4";
    const a = await engine.analyse(fen, { movetimeMs: 300, multipv: 3 });
    expect(a.bestMove).toBe("h5f7");
    expect(a.lines[0]!.score.mate).toBe(1);
    const hints = buildHints(a);
    expect(hints[0]!.text).toBe("Mate in 1.");
    expect(hints[1]!.text).toMatch(/queen on h5/);
    expect(hints[2]!.text).toBe("Qxf7#");
  });

  it("reviews a game, grades the blunder, and stores a drill", async () => {
    const store = new Store(":memory:");
    // 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7#  (player is Black)
    const moves = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"];
    store.upsertGame({ id: "t1", source: "chessapp", externalId: null, playerColor: "b", opponent: "Computer", vsComputer: true, startFen: START_FEN, moves, result: "1-0", startedAt: Date.now(), endedAt: Date.now() });
    const fake = {
      beta: {
        messages: {
          parse: async (req: { messages: { content: string }[] }) => ({
            stop_reason: "end_turn",
            parsed_output: req.messages[0]!.content.includes("game summary")
              ? { summary: "Lost to Scholar's mate.", focus: ["Check f7 before every move"] }
              : { motif: "missed mate", explanation: "Nf6 leaves f7 defended only by the king.", takeaway: "When the queen and bishop both hit f7, defend it." },
          }),
        },
      },
    };
    const coach = new Coach({ apiKey: "x", model: "test", client: fake as never });
    const r = await reviewGame({ engine, store, coach }, store.getGame("t1")!, { movetimeMs: 150 });
    const nf6 = r.moves.find((m) => m.san === "Nf6")!;
    expect(nf6.grade).toBe("blunder");
    expect(r.mistakes.some((m) => m.playedSan === "Nf6" && m.motif === "missed mate")).toBe(true);
    expect(r.summary).toMatch(/Scholar/);
    expect(store.dueDrills(10, Date.now() + 1).length).toBeGreaterThan(0);
    const drill = r.mistakes.find((m) => m.playedSan === "Nf6")!;
    const wrong = await checkDrillAnswer(engine, drill.fen, "g8f6", drill.bestUci, 150);
    expect(wrong.correct).toBe(false);
    const right = await checkDrillAnswer(engine, drill.fen, drill.bestUci, drill.bestUci, 150);
    expect(right.correct).toBe(true);
  });
});
