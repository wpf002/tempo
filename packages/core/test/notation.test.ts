import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { applyUci, normalizeToken, replay, tokenize, toUci } from "../src/notation.js";

describe("tokenize + replay", () => {
  it("reads a SAN game log with move numbers", () => {
    const t = tokenize(["1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7"]);
    const r = replay(t);
    expect(r.rejected).toBe(0);
    expect(r.san).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7"]);
    expect(r.uci[8]).toBe("e1g1");
  });

  it("reads glued numbers, one move per cell, and figurines", () => {
    const t = tokenize(["1.e4", "c5", "2.♘f3", "d6", "3.d4", "cxd4", "4.♘xd4", "♞f6"]);
    expect(replay(t).san).toEqual(["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6"]);
  });

  it("reads coordinate notation like e2-e4 and Ng1-f3", () => {
    const t = tokenize(["1. e2-e4 e7-e5", "2. Ng1-f3 Nb8-c6", "3. Bf1-c4 Ng8-f6 4. 0-0"]);
    const r = replay(t);
    expect(r.rejected).toBe(0);
    expect(r.san.at(-1)).toBe("O-O");
  });

  it("ignores UI noise and results", () => {
    const t = tokenize(["White", "Black", "Game Log", "10:00", "1. d4 d5", "1-0"]);
    expect(t).toEqual(["d4", "d5"]);
  });

  it("keeps the longest legal prefix", () => {
    const r = replay(["e4", "e5", "Ke3", "Qh4"]);
    expect(r.san).toEqual(["e4", "e5"]);
    expect(r.rejected).toBe(2);
  });

  it("handles promotion in both notations", () => {
    const fen = "8/P7/8/8/8/8/8/k6K w - - 0 1";
    expect(replay(["a8=Q"], fen).uci).toEqual(["a7a8q"]);
    expect(replay(["a7a8n"], fen).uci).toEqual(["a7a8n"]);
  });

  it("strips annotations", () => {
    expect(normalizeToken("Nf3!?")).toBe("Nf3");
    expect(normalizeToken("Qxf7#")).toBe("Qxf7#");
    expect(normalizeToken("Black")).toBeNull();
  });
});

describe("applyUci", () => {
  it("accepts Lichess king-to-rook castling", () => {
    const c = new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    const m = applyUci(c, "e1h1");
    expect(m?.san).toBe("O-O");
    expect(toUci(m!)).toBe("e1g1");
  });
  it("rejects junk", () => {
    expect(applyUci(new Chess(), "position startpos")).toBeNull();
  });
});
