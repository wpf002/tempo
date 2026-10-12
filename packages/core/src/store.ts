import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Score } from "./engine.js";
import type { Grade, Phase } from "./grade.js";

export interface GameRow {
  id: string;
  source: "lichess" | "chessapp";
  externalId: string | null;
  playerColor: "w" | "b";
  opponent: string;
  vsComputer: boolean;
  startFen: string;
  moves: string[];
  result: string | null;
  startedAt: number;
  endedAt: number | null;
  accuracy: number | null;
  summary: string | null;
  focus: string[];
  reviewedAt: number | null;
}

export interface MoveRow {
  gameId: string;
  ply: number;
  fenBefore: string;
  uci: string;
  san: string;
  color: "w" | "b";
  evalBefore: Score;
  evalAfter: Score;
  bestUci: string | null;
  bestSan: string | null;
  grade: Grade;
  loss: number;
  phase: Phase;
}

export interface MistakeRow {
  id: number;
  gameId: string;
  ply: number;
  fen: string;
  playedSan: string;
  bestUci: string;
  bestSan: string;
  grade: Grade;
  motif: string;
  explanation: string;
  takeaway: string;
  phase: Phase;
  createdAt: number;
}

export interface DrillRow extends MistakeRow {
  attempts: number;
  solved: number;
  dueAt: number;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('lichess','chessapp')),
  external_id TEXT,
  player_color TEXT NOT NULL CHECK (player_color IN ('w','b')),
  opponent TEXT NOT NULL,
  vs_computer INTEGER NOT NULL,
  start_fen TEXT NOT NULL,
  moves TEXT NOT NULL DEFAULT '',
  result TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  accuracy REAL,
  summary TEXT,
  focus TEXT NOT NULL DEFAULT '[]',
  reviewed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS games_external ON games(source, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS moves (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply INTEGER NOT NULL,
  fen_before TEXT NOT NULL,
  uci TEXT NOT NULL,
  san TEXT NOT NULL,
  color TEXT NOT NULL,
  eval_before TEXT NOT NULL,
  eval_after TEXT NOT NULL,
  best_uci TEXT,
  best_san TEXT,
  grade TEXT NOT NULL,
  loss REAL NOT NULL,
  phase TEXT NOT NULL,
  PRIMARY KEY (game_id, ply)
);
CREATE TABLE IF NOT EXISTS mistakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply INTEGER NOT NULL,
  fen TEXT NOT NULL,
  played_san TEXT NOT NULL,
  best_uci TEXT NOT NULL,
  best_san TEXT NOT NULL,
  grade TEXT NOT NULL,
  motif TEXT NOT NULL,
  explanation TEXT NOT NULL,
  takeaway TEXT NOT NULL,
  phase TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (game_id, ply)
);
CREATE TABLE IF NOT EXISTS drills (
  mistake_id INTEGER PRIMARY KEY REFERENCES mistakes(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  solved INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL
);
`;

type Row = Record<string, unknown>;

function gameFromRow(r: Row): GameRow {
  return {
    id: String(r.id),
    source: r.source as GameRow["source"],
    externalId: (r.external_id as string | null) ?? null,
    playerColor: r.player_color as "w" | "b",
    opponent: String(r.opponent),
    vsComputer: Number(r.vs_computer) === 1,
    startFen: String(r.start_fen),
    moves: String(r.moves || "").split(" ").filter(Boolean),
    result: (r.result as string | null) ?? null,
    startedAt: Number(r.started_at),
    endedAt: r.ended_at == null ? null : Number(r.ended_at),
    accuracy: r.accuracy == null ? null : Number(r.accuracy),
    summary: (r.summary as string | null) ?? null,
    focus: JSON.parse(String(r.focus || "[]")) as string[],
    reviewedAt: r.reviewed_at == null ? null : Number(r.reviewed_at),
  };
}

function mistakeFromRow(r: Row): MistakeRow {
  return {
    id: Number(r.id),
    gameId: String(r.game_id),
    ply: Number(r.ply),
    fen: String(r.fen),
    playedSan: String(r.played_san),
    bestUci: String(r.best_uci),
    bestSan: String(r.best_san),
    grade: r.grade as Grade,
    motif: String(r.motif),
    explanation: String(r.explanation),
    takeaway: String(r.takeaway),
    phase: r.phase as Phase,
    createdAt: Number(r.created_at),
  };
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  upsertGame(g: Omit<GameRow, "accuracy" | "summary" | "focus" | "reviewedAt">): void {
    this.db
      .prepare(
        `INSERT INTO games (id, source, external_id, player_color, opponent, vs_computer, start_fen, moves, result, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET moves = excluded.moves, result = excluded.result, ended_at = excluded.ended_at,
           opponent = excluded.opponent, player_color = excluded.player_color, vs_computer = excluded.vs_computer`,
      )
      .run(g.id, g.source, g.externalId, g.playerColor, g.opponent, g.vsComputer ? 1 : 0, g.startFen, g.moves.join(" "), g.result, g.startedAt, g.endedAt);
  }

  getGame(id: string): GameRow | null {
    const r = this.db.prepare(`SELECT * FROM games WHERE id = ?`).get(id) as Row | undefined;
    return r ? gameFromRow(r) : null;
  }

  listGames(limit = 50): GameRow[] {
    return (this.db.prepare(`SELECT * FROM games ORDER BY started_at DESC LIMIT ?`).all(limit) as Row[]).map(gameFromRow);
  }

  saveReview(gameId: string, moves: MoveRow[], accuracy: number, summary: string, focus: string[]): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM moves WHERE game_id = ?`).run(gameId);
      const ins = this.db.prepare(
        `INSERT INTO moves (game_id, ply, fen_before, uci, san, color, eval_before, eval_after, best_uci, best_san, grade, loss, phase)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const m of moves) {
        ins.run(gameId, m.ply, m.fenBefore, m.uci, m.san, m.color, JSON.stringify(m.evalBefore), JSON.stringify(m.evalAfter), m.bestUci, m.bestSan, m.grade, m.loss, m.phase);
      }
      this.db
        .prepare(`UPDATE games SET accuracy = ?, summary = ?, focus = ?, reviewed_at = ? WHERE id = ?`)
        .run(accuracy, summary, JSON.stringify(focus), Date.now(), gameId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getMoves(gameId: string): MoveRow[] {
    return (this.db.prepare(`SELECT * FROM moves WHERE game_id = ? ORDER BY ply`).all(gameId) as Row[]).map((r) => ({
      gameId: String(r.game_id),
      ply: Number(r.ply),
      fenBefore: String(r.fen_before),
      uci: String(r.uci),
      san: String(r.san),
      color: r.color as "w" | "b",
      evalBefore: JSON.parse(String(r.eval_before)) as Score,
      evalAfter: JSON.parse(String(r.eval_after)) as Score,
      bestUci: (r.best_uci as string | null) ?? null,
      bestSan: (r.best_san as string | null) ?? null,
      grade: r.grade as Grade,
      loss: Number(r.loss),
      phase: r.phase as Phase,
    }));
  }

  addMistake(m: Omit<MistakeRow, "id" | "createdAt">): number {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO mistakes (game_id, ply, fen, played_san, best_uci, best_san, grade, motif, explanation, takeaway, phase, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_id, ply) DO UPDATE SET motif = excluded.motif, explanation = excluded.explanation, takeaway = excluded.takeaway,
           grade = excluded.grade, best_uci = excluded.best_uci, best_san = excluded.best_san`,
      )
      .run(m.gameId, m.ply, m.fen, m.playedSan, m.bestUci, m.bestSan, m.grade, m.motif, m.explanation, m.takeaway, m.phase, now);
    const row = this.db.prepare(`SELECT id FROM mistakes WHERE game_id = ? AND ply = ?`).get(m.gameId, m.ply) as Row;
    const id = Number(row.id);
    this.db.prepare(`INSERT OR IGNORE INTO drills (mistake_id, due_at) VALUES (?, ?)`).run(id, now);
    return id;
  }

  getMistakes(gameId: string): MistakeRow[] {
    return (this.db.prepare(`SELECT * FROM mistakes WHERE game_id = ? ORDER BY ply`).all(gameId) as Row[]).map(mistakeFromRow);
  }

  motifCounts(): { motif: string; count: number }[] {
    return (this.db.prepare(`SELECT motif, COUNT(*) AS count FROM mistakes GROUP BY motif ORDER BY count DESC`).all() as Row[]).map((r) => ({
      motif: String(r.motif),
      count: Number(r.count),
    }));
  }

  stats(): {
    games: number;
    avgAccuracy: number | null;
    byMotif: { motif: string; count: number }[];
    byPhase: { phase: string; grade: string; count: number }[];
    accuracyTrend: { id: string; startedAt: number; accuracy: number }[];
  } {
    const g = this.db.prepare(`SELECT COUNT(*) AS n, AVG(accuracy) AS acc FROM games WHERE reviewed_at IS NOT NULL`).get() as Row;
    const byPhase = (this.db
      .prepare(`SELECT phase, grade, COUNT(*) AS count FROM mistakes GROUP BY phase, grade ORDER BY phase`)
      .all() as Row[]).map((r) => ({ phase: String(r.phase), grade: String(r.grade), count: Number(r.count) }));
    const trend = (this.db
      .prepare(`SELECT id, started_at, accuracy FROM games WHERE accuracy IS NOT NULL ORDER BY started_at DESC LIMIT 30`)
      .all() as Row[])
      .map((r) => ({ id: String(r.id), startedAt: Number(r.started_at), accuracy: Number(r.accuracy) }))
      .reverse();
    return {
      games: Number(g.n),
      avgAccuracy: g.acc == null ? null : Number(g.acc),
      byMotif: this.motifCounts(),
      byPhase,
      accuracyTrend: trend,
    };
  }

  dueDrills(limit = 20, now = Date.now()): DrillRow[] {
    return (this.db
      .prepare(
        `SELECT m.*, d.attempts, d.solved, d.due_at FROM drills d JOIN mistakes m ON m.id = d.mistake_id
         WHERE d.due_at <= ? ORDER BY d.due_at ASC, m.created_at DESC LIMIT ?`,
      )
      .all(now, limit) as Row[]).map((r) => ({
      ...mistakeFromRow(r),
      attempts: Number(r.attempts),
      solved: Number(r.solved),
      dueAt: Number(r.due_at),
    }));
  }

  getDrill(mistakeId: number): DrillRow | null {
    const r = this.db
      .prepare(`SELECT m.*, d.attempts, d.solved, d.due_at FROM drills d JOIN mistakes m ON m.id = d.mistake_id WHERE m.id = ?`)
      .get(mistakeId) as Row | undefined;
    return r ? { ...mistakeFromRow(r), attempts: Number(r.attempts), solved: Number(r.solved), dueAt: Number(r.due_at) } : null;
  }

  /** Simple spaced repetition: solved → due in 2^solved days; missed → due again in 10 minutes. */
  recordAttempt(mistakeId: number, correct: boolean, now = Date.now()): void {
    const d = this.getDrill(mistakeId);
    if (!d) return;
    const solved = correct ? d.solved + 1 : 0;
    const due = correct ? now + 2 ** solved * 86_400_000 : now + 10 * 60_000;
    this.db.prepare(`UPDATE drills SET attempts = attempts + 1, solved = ?, due_at = ? WHERE mistake_id = ?`).run(solved, due, mistakeId);
  }
}
