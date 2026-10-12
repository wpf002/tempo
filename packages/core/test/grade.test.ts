import { describe, expect, it } from "vitest";
import { formatScore, gradeMove, phaseOf, winningChances } from "../src/grade.js";
import { START_FEN } from "../src/notation.js";

const cp = (v: number) => ({ cp: v, mate: null });

describe("grading", () => {
  it("is symmetric and bounded", () => {
    expect(winningChances(cp(0))).toBeCloseTo(0);
    expect(winningChances(cp(300))).toBeCloseTo(-winningChances(cp(-300)));
    expect(winningChances({ cp: null, mate: 3 })).toBe(1);
  });
  it("grades by winning-chance loss for the mover", () => {
    expect(gradeMove(cp(50), cp(30), "w", false).grade).toBe("good");
    expect(gradeMove(cp(0), cp(-500), "w", false).grade).toBe("blunder");
    // Black dropping from -200 to +100 is a mistake-or-worse for Black.
    expect(["mistake", "blunder"]).toContain(gradeMove(cp(-200), cp(100), "b", false).grade);
    expect(gradeMove(cp(0), cp(-500), "w", true).grade).toBe("best");
  });
  it("formats scores", () => {
    expect(formatScore(cp(134))).toBe("+1.3");
    expect(formatScore({ cp: null, mate: -2 })).toBe("-M2");
  });
  it("detects phase", () => {
    expect(phaseOf(START_FEN, 1)).toBe("opening");
    expect(phaseOf("8/5k2/8/8/3R4/8/5K2/8 w - - 0 50", 50)).toBe("endgame");
  });
});
