"use client";

import type { Explanation, Grade, SourceStatus } from "./api";

const GLYPH: Partial<Record<Grade, string>> = { inaccuracy: "?!", mistake: "?", blunder: "??" };

/** Chess annotation for a grade ("?!", "?", "??"), so a grade never reads by color alone. */
export function glyph(grade: Grade): string {
  return GLYPH[grade] ?? "";
}

export function isError(grade: Grade): boolean {
  return grade === "inaccuracy" || grade === "mistake" || grade === "blunder";
}

/**
 * Squares shown with capital files: g4 reads G4, Nf3 reads NF3, exd5 reads ExD5. Display only; moves are stored and
 * sent in standard lowercase notation.
 */
export function sq(text: string): string {
  return text.replace(/\b([KQRBN]?)([a-h]?)(x?)([a-h])([1-8])/g, (_m, p: string, f: string, x: string, file: string, rank: string) => `${p}${f.toUpperCase()}${x}${file.toUpperCase()}${rank}`);
}

const MINOR = new Set(["a", "an", "the", "of", "in", "on", "to", "and", "or", "by", "for", "vs"]);

/** Title Case for labels that come from data: grades, motifs, phases, outcomes. */
export function titleCase(s: string): string {
  return s.replace(/[A-Za-z]+/g, (w, i: number) => (i > 0 && MINOR.has(w.toLowerCase()) ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1)));
}

const PLURAL: Record<Grade, string> = { best: "best", good: "good", inaccuracy: "inaccuracies", mistake: "mistakes", blunder: "blunders" };

export function GradeTag({ grade, count }: { grade: Grade; count?: number }) {
  return (
    <span className="tag">
      <span className={`mark ${grade}`} />
      {titleCase(count === undefined ? grade : `${count} ${count === 1 ? grade : PLURAL[grade]}`)}
    </span>
  );
}

const DOT: Record<SourceStatus["state"], string> = { off: "", connecting: "pending", watching: "ok", error: "bad" };

export function StatusDot({ state }: { state: SourceStatus["state"] }) {
  return <span className={`dot ${DOT[state]}`} />;
}

export function sourceName(source: SourceStatus["source"]): string {
  return source === "chessapp" ? "Chess.app" : "Lichess";
}

/** Result from the player's side of the board. */
export function outcome(result: string | null, playerColor: "w" | "b"): string {
  if (result === null) return "In Progress";
  if (result === "1/2-1/2") return "Draw";
  if (result === "1-0") return playerColor === "w" ? "Won" : "Lost";
  if (result === "0-1") return playerColor === "b" ? "Won" : "Lost";
  return "Unfinished";
}

export function ExplainBody({ e }: { e: Explanation }) {
  return (
    <div className="explain">
      <div>
        <span className="tag">{titleCase(e.motif)}</span>
      </div>
      <p className="prose">{sq(e.explanation)}</p>
      {e.takeaway && (
        <div className="rule">
          <span className="label">Rule</span>
          <p className="prose">{sq(e.takeaway)}</p>
        </div>
      )}
    </div>
  );
}

export function Logo() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="4" fill="var(--text)" />
      <circle cx="12" cy="8" r="3" fill="var(--bg)" />
      <path d="M9.5 11h5l-1 5h2.5l1 3H7l1-3h2.5z" fill="var(--bg)" />
    </svg>
  );
}

const PATHS = {
  first: "M7 6v12M18 6l-7 6 7 6z",
  prev: "M15 6l-7 6 7 6z",
  next: "M9 6l7 6-7 6z",
  last: "M17 6v12M6 6l7 6-7 6z",
};

export function Icon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
