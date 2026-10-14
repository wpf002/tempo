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
    windows: z
      .array(
        z.object({
          title: z.string().max(500),
          texts: z.array(z.string().max(20_000)).max(5000),
          // FEN piece placement read from the board's own squares (game windows only).
          placement: z.string().regex(/^[pnbrqkPNBRQK1-8/]{15,71}$/).nullish(),
        }),
      )
      .max(50),
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

const START_PLACEMENT = START_FEN.split(" ")[0]!;
const placementOf = (c: Chess) => c.fen().split(" ")[0]!;

/** Who is playing, from a Chess.app game window title: "Game 1 | Will Foti - Computer   (White to Move)". */
export function parseTitle(title: string): { white: string; black: string; turn: "w" | "b" | null } | null {
  const m = /\|\s*(.+?)\s+-\s+(.+?)\s*(?:\(|$)/.exec(title);
  if (!m) return null;
  const t = /\((White|Black) to Move\)/i.exec(title);
  return { white: m[1]!, black: m[2]!, turn: t ? (t[1]!.toLowerCase() === "white" ? "w" : "b") : null };
}

/**
 * FEN for a position picked up mid-game, when the moves that led to it are unknown.
 * Castling rights are assumed wherever king and rook still stand on their home squares, and en passant is
 * assumed unavailable. Both can be wrong for one move; the engine line is still sound after that.
 */
export function fenFromBoard(placement: string, turn: "w" | "b"): string | null {
  const rows = placement.split("/");
  const at = (rank: number, file: number): string => {
    let f = 0;
    for (const ch of rows[8 - rank] ?? "") {
      if (/\d/.test(ch)) f += Number(ch);
      else if (f++ === file) return ch;
      if (f > file) break;
    }
    return "";
  };
  let rights = "";
  if (at(1, 4) === "K") rights += (at(1, 7) === "R" ? "K" : "") + (at(1, 0) === "R" ? "Q" : "");
  if (at(8, 4) === "k") rights += (at(8, 7) === "r" ? "k" : "") + (at(8, 0) === "r" ? "q" : "");
  try {
    return new Chess(`${placement} ${turn} ${rights || "-"} - 0 1`).fen();
  } catch {
    return null;
  }
}

function squaresOf(placement: string): string[] {
  const out: string[] = [];
  for (const ch of placement.replace(/\//g, "")) {
    if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) out.push("");
    else out.push(ch);
  }
  return out;
}

/**
 * Whose move it is after the board changed from `before` to `after`: the opposite of whoever's pieces arrived
 * on new squares. Null when it can't tell (nothing arrived, or both sides moved between polls).
 */
export function turnAfter(before: string, after: string): "w" | "b" | null {
  const a = squaresOf(before);
  const b = squaresOf(after);
  if (a.length !== 64 || b.length !== 64) return null;
  const movers = new Set<"w" | "b">();
  for (let i = 0; i < 64; i++) if (b[i] && b[i] !== a[i]) movers.add(b[i] === b[i]!.toUpperCase() ? "w" : "b");
  if (movers.size !== 1) return null;
  return movers.has("w") ? "b" : "w";
}

export interface Followed {
  startFen: string;
  moves: string[];
}

/**
 * Rebuilds the move list from successive board positions, so the Game Log window doesn't have to be open.
 * Follows from the starting position, or from wherever the game stands when Tempo first sees it (given whose
 * move it is). Returns null when the board can't be explained and the side to move is unknown.
 */
export class BoardFollower {
  private startFen = START_FEN;
  private chess = new Chess();
  private moves: string[] = [];
  private synced = false;
  private lastSeen: string | null = null;

  private out(): Followed {
    return { startFen: this.startFen, moves: [...this.moves] };
  }

  private restart(fen: string): Followed {
    this.startFen = fen;
    this.chess = new Chess(fen);
    this.moves = [];
    this.synced = true;
    return this.out();
  }

  ingest(placement: string, titleTurn: "w" | "b" | null = null): Followed | null {
    const before = this.lastSeen;
    this.lastSeen = placement;
    // Chess.app's title lags the board by a moment after each move, so when the board just changed, the move itself
    // says whose turn it is. The title is only used when there's nothing to compare against.
    const turn = (before && before !== placement ? turnAfter(before, placement) : null) ?? titleTurn;
    if (placement === START_PLACEMENT) return this.startFen === START_FEN && this.synced && !this.moves.length ? this.out() : this.restart(START_FEN);
    if (this.synced) {
      if (placement === placementOf(this.chess)) return this.out();

      // One move, or two when the computer's reply landed between polls.
      for (const a of this.chess.moves({ verbose: true })) {
        this.chess.move(a);
        if (placementOf(this.chess) === placement) return this.push(a);
        for (const b of this.chess.moves({ verbose: true })) {
          this.chess.move(b);
          const hit = placementOf(this.chess) === placement;
          this.chess.undo();
          if (hit) {
            this.chess.move(b);
            return this.push(a, b);
          }
        }
        this.chess.undo();
      }

      // Takeback: the board matches an earlier position of this game.
      const replayed = new Chess(this.startFen);
      for (let k = 0; k < this.moves.length; k++) {
        if (placementOf(replayed) === placement) {
          this.chess = replayed;
          this.moves = this.moves.slice(0, k);
          return this.out();
        }
        applyUci(replayed, this.moves[k]!);
      }
    }

    // Joined mid-game, or a different game was loaded: pick it up from here.
    const fen = turn && fenFromBoard(placement, turn);
    if (fen) return this.restart(fen);
    this.synced = false;
    return null;
  }

  private push(...mvs: { from: string; to: string; promotion?: string }[]): Followed {
    for (const m of mvs) this.moves.push(m.from + m.to + (m.promotion ?? ""));
    return this.out();
  }
}

function isPrefix(a: string[], b: string[]): boolean {
  return a.length <= b.length && a.every((m, i) => b[i] === m);
}

function resultFor(moves: string[], startFen: string): string | null {
  const c = new Chess(startFen);
  for (const m of moves) applyUci(c, m);
  if (c.isCheckmate()) return c.turn() === "w" ? "0-1" : "1-0";
  if (c.isDraw() || c.isStalemate()) return "1/2-1/2";
  return null;
}

/** Turns successive Chess.app move lists into game updates: extends, takebacks, and new games. */
export class ChessAppTracker {
  private current: { id: string; startFen: string; moves: string[]; finished: boolean; cleared: boolean } | null = null;
  playerColor: "w" | "b" = "w";
  opponent = "Chess.app computer";
  /** False for Game Center and two-player games, which keeps live hints off. */
  vsComputer = true;

  constructor(private readonly emit: (u: GameUpdate) => void, private readonly now: () => number = Date.now) {}

  private update(finished: boolean, result: string | null): void {
    if (!this.current) return;
    this.emit({
      source: "chessapp",
      gameId: this.current.id,
      externalId: null,
      startFen: this.current.startFen,
      moves: [...this.current.moves],
      playerColor: this.playerColor,
      opponent: this.opponent,
      vsComputer: this.vsComputer,
      finished,
      result,
    });
  }

  /** Close the current game (new game started, or the user asked for a review). */
  finishCurrent(): void {
    if (!this.current || this.current.finished) return;
    this.current.finished = true;
    if (this.current.moves.length >= 4) this.update(true, resultFor(this.current.moves, this.current.startFen) ?? "*");
  }

  /**
   * `atStart` means the board itself is being followed and shows `startFen` with nothing played yet, so a game
   * can be opened before its first move. `startFen` is the starting position unless Tempo joined mid-game.
   */
  ingest(moves: string[], atStart = false, startFen: string = START_FEN): void {
    const cur = this.current;
    if (moves.length === 0) {
      if (cur && !cur.finished && cur.moves.length === 0 && cur.startFen === startFen) return; // already waiting on the first move
      // Empty log: a new game was set up. Close the old one.
      if (cur) {
        this.finishCurrent();
        cur.cleared = true;
      }
      if (atStart) {
        this.current = { id: `chessapp-${this.now()}`, startFen, moves: [], finished: false, cleared: false };
        this.update(false, null);
      }
      return;
    }
    if (cur && !cur.cleared && cur.startFen === startFen) {
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
    this.current = { id: `chessapp-${this.now()}`, startFen, moves, finished: false, cleared: false };
    this.emitProgress();
  }

  private emitProgress(): void {
    const moves = this.current!.moves;
    const result = resultFor(moves, this.current!.startFen);
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
  private follower = new BoardFollower();
  private lastTitle = "";

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
    const game = snap.data.windows.find((w) => w.placement);
    if (game) this.readPlayers(game.title);
    // The Game Log has the whole history, so it wins when it's open. Otherwise follow the board.
    const fromLog = extractMoves(snap.data.windows);
    const fromBoard = game ? this.follower.ingest(game.placement!, parseTitle(game.title)?.turn ?? null) : null;
    const moves = fromLog.length ? fromLog : (fromBoard?.moves ?? []);
    const startFen = fromLog.length || !fromBoard ? START_FEN : fromBoard.startFen;
    const atStart = !fromLog.length && fromBoard?.moves.length === 0;
    this.setStatus(
      "watching",
      moves.length
        ? `${moves.length} plies read`
        : atStart
          ? startFen === START_FEN
            ? "new game on the board"
            : "joined a game in progress"
          : game
            ? "Can't tell whose move it is. Open the Game Log window, or start a new game."
            : "Chess.app open, no game window found.",
    );
    this.tracker.ingest(moves, atStart, startFen);
  }

  /** Set color and opponent from the window title. Only on change, so a manual color pick in the panel sticks. */
  private readPlayers(title: string): void {
    const key = title.replace(/\(.*$/, "").trim();
    if (key === this.lastTitle) return;
    this.lastTitle = key;
    const p = parseTitle(title);
    if (!p) return;
    const whiteIsComputer = p.white === "Computer";
    const blackIsComputer = p.black === "Computer";
    this.tracker.vsComputer = whiteIsComputer !== blackIsComputer;
    if (this.tracker.vsComputer) {
      this.tracker.playerColor = whiteIsComputer ? "b" : "w";
      this.tracker.opponent = "Chess.app computer";
    } else {
      this.tracker.opponent = whiteIsComputer ? "Chess.app (computer vs computer)" : `${p.white} vs ${p.black}`;
    }
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
    this.setStatus("off", "stopped");
  }
}
