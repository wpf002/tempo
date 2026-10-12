import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Chess } from "chess.js";
import { z } from "zod";
import { START_FEN, applyUci, replay, tokenize } from "@tempo/core";
import type { GameUpdate, Source, SourceStatus } from "./types.js";

const Snapshot = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    windows: z.array(z.object({ title: z.string().max(500), texts: z.array(z.string().max(20_000)).max(5000) })).max(50),
  }),
  z.object({ ok: z.literal(false), error: z.string().max(500) }),
]);

const ERRORS: Record<string, string> = {
  not_trusted: "Grant Accessibility access to your terminal: System Settings > Privacy & Security > Accessibility.",
  not_running: "Chess.app isn't open.",
};

/** Pick the longest legal move sequence found in any Chess.app window. */
export function extractMoves(windows: { title: string; texts: string[] }[]): string[] {
  let best: string[] = [];
  for (const w of windows) {
    const r = replay(tokenize(w.texts), START_FEN);
    if (r.uci.length > best.length) best = r.uci;
  }
  return best;
}

function isPrefix(a: string[], b: string[]): boolean {
  return a.length <= b.length && a.every((m, i) => b[i] === m);
}

function resultFor(moves: string[]): string | null {
  const c = new Chess();
  for (const m of moves) applyUci(c, m);
  if (c.isCheckmate()) return c.turn() === "w" ? "0-1" : "1-0";
  if (c.isDraw() || c.isStalemate()) return "1/2-1/2";
  return null;
}

/** Turns successive Chess.app move lists into game updates: extends, takebacks, and new games. */
export class ChessAppTracker {
  private current: { id: string; moves: string[]; finished: boolean; cleared: boolean } | null = null;
  playerColor: "w" | "b" = "w";

  constructor(private readonly emit: (u: GameUpdate) => void, private readonly now: () => number = Date.now) {}

  private update(finished: boolean, result: string | null): void {
    if (!this.current) return;
    this.emit({
      source: "chessapp",
      gameId: this.current.id,
      externalId: null,
      startFen: START_FEN,
      moves: [...this.current.moves],
      playerColor: this.playerColor,
      opponent: "Chess.app computer",
      vsComputer: true,
      finished,
      result,
    });
  }

  /** Close the current game (new game started, or the user asked for a review). */
  finishCurrent(): void {
    if (!this.current || this.current.finished) return;
    this.current.finished = true;
    if (this.current.moves.length >= 4) this.update(true, resultFor(this.current.moves) ?? "*");
  }

  ingest(moves: string[]): void {
    const cur = this.current;
    if (moves.length === 0) {
      // Empty log: a new game was set up. Close the old one.
      if (cur) {
        this.finishCurrent();
        cur.cleared = true;
      }
      return;
    }
    if (cur && !cur.cleared) {
      if (moves.length === cur.moves.length && isPrefix(moves, cur.moves)) return; // no change
      if (isPrefix(cur.moves, moves) || isPrefix(moves, cur.moves)) {
        if (cur.finished) return; // finished game's log still on screen
        cur.moves = moves; // next move or takeback
        this.emitProgress();
        return;
      }
    }
    // Unrelated move list: a new game.
    this.finishCurrent();
    this.current = { id: `chessapp-${this.now()}`, moves, finished: false, cleared: false };
    this.emitProgress();
  }

  private emitProgress(): void {
    const moves = this.current!.moves;
    const result = resultFor(moves);
    if (result) {
      this.current!.finished = true;
      this.update(true, result);
    } else {
      this.update(false, null);
    }
  }
}

export class ChessAppSource extends EventEmitter implements Source {
  private proc: ChildProcess | null = null;
  private stopped = false;
  private st: SourceStatus = { source: "chessapp", state: "off", detail: "" };
  readonly tracker = new ChessAppTracker((u) => this.emit("update", u));

  constructor(private readonly watchPath: string) {
    super();
  }

  status(): SourceStatus {
    return this.st;
  }

  private setStatus(state: SourceStatus["state"], detail: string) {
    if (this.st.state === state && this.st.detail === detail) return;
    this.st = { source: "chessapp", state, detail };
    this.emit("status", this.st);
  }

  start(): void {
    if (process.platform !== "darwin") {
      this.setStatus("off", "Chess.app reader needs macOS");
      return;
    }
    if (!existsSync(this.watchPath)) {
      this.setStatus("error", "tempo-watch isn't built. Run: pnpm watch:build");
      return;
    }
    this.spawnWatcher(2000);
  }

  private spawnWatcher(backoff: number): void {
    if (this.stopped) return;
    this.setStatus("connecting", "starting reader");
    // Fixed binary and fixed args. No shell.
    const proc = spawn(this.watchPath, ["--watch", "--interval-ms", "400"], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    this.proc = proc;
    createInterface({ input: proc.stdout! }).on("line", (line) => this.onLine(line));
    proc.on("exit", () => {
      this.proc = null;
      if (this.stopped) return;
      this.setStatus("error", "reader exited, restarting");
      setTimeout(() => this.spawnWatcher(Math.min(backoff * 2, 30_000)), backoff);
    });
    proc.on("error", (e) => this.setStatus("error", `reader: ${e.message}`));
  }

  private onLine(line: string): void {
    if (line.length > 2_000_000) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const snap = Snapshot.safeParse(raw);
    if (!snap.success) return;
    if (!snap.data.ok) {
      this.setStatus("error", ERRORS[snap.data.error] ?? snap.data.error);
      return;
    }
    const moves = extractMoves(snap.data.windows);
    this.setStatus("watching", moves.length ? `${moves.length} plies read` : "Chess.app open, no moves found. Open the Game Log window.");
    this.tracker.ingest(moves);
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
    this.setStatus("off", "stopped");
  }
}
