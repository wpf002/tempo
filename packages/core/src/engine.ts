import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Chess } from "chess.js";
import { pvToSan } from "./notation.js";

export interface Score {
  /** Centipawns from White's point of view. Null when mate is set. */
  cp: number | null;
  /** Moves to mate from White's point of view (+ White mates, - Black mates). */
  mate: number | null;
}

export interface EngineLine {
  multipv: number;
  depth: number;
  score: Score;
  pv: string[];
  pvSan: string[];
}

export interface Analysis {
  fen: string;
  lines: EngineLine[];
  bestMove: string | null;
}

export interface EngineOptions {
  path: string;
  threads?: number;
  hashMb?: number;
  /** Max time to wait for engine startup, ms. */
  startupTimeoutMs?: number;
}

export interface AnalyseOptions {
  movetimeMs?: number;
  depth?: number;
  multipv?: number;
  /** Restrict search to these UCI moves (used to score a move that was actually played). */
  searchMoves?: string[];
}

const INFO_RE = /\bmultipv (\d+)\b/;

/** Minimal UCI client. One search at a time; calls are queued. */
export class Engine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private listeners = new Set<(line: string) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private currentMultiPv = 0;
  private closed = false;

  constructor(private readonly opts: EngineOptions) {}

  async start(): Promise<void> {
    if (this.proc) return;
    // Fixed binary path, no shell, no user-controlled args.
    const proc = spawn(this.opts.path, [], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    this.proc = proc;
    proc.on("exit", () => {
      this.proc = null;
    });
    proc.on("error", () => {
      this.proc = null;
    });
    createInterface({ input: proc.stdout }).on("line", (line) => {
      for (const l of this.listeners) l(line);
    });
    const timeout = this.opts.startupTimeoutMs ?? 15_000;
    this.send("uci");
    await this.waitFor((l) => l === "uciok", timeout);
    this.send(`setoption name Threads value ${Math.max(1, Math.floor(this.opts.threads ?? 1))}`);
    this.send(`setoption name Hash value ${Math.max(16, Math.floor(this.opts.hashMb ?? 128))}`);
    await this.ready(timeout);
  }

  private send(cmd: string): void {
    if (!this.proc) throw new Error("engine not running");
    this.proc.stdin.write(cmd + "\n");
  }

  private waitFor(pred: (line: string) => boolean, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(fn);
        reject(new Error("engine timeout"));
      }, timeoutMs);
      const fn = (line: string) => {
        if (pred(line)) {
          clearTimeout(timer);
          this.listeners.delete(fn);
          resolve(line);
        }
      };
      this.listeners.add(fn);
    });
  }

  private async ready(timeoutMs = 10_000): Promise<void> {
    this.send("isready");
    await this.waitFor((l) => l === "readyok", timeoutMs);
  }

  /** Analyse a position. FEN must already be validated by the caller (chess.js). */
  analyse(fen: string, opts: AnalyseOptions = {}): Promise<Analysis> {
    const run = async (): Promise<Analysis> => {
      if (this.closed) throw new Error("engine closed");
      if (!this.proc) await this.start();
      // Validate again here so nothing unchecked ever reaches the engine's stdin.
      const chess = new Chess(fen);
      const normalized = chess.fen();
      const whiteToMove = chess.turn() === "w";
      const legal = new Set(chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? "")));

      if (legal.size === 0) {
        // Mate or stalemate: nothing to search.
        return { fen: normalized, lines: [], bestMove: null };
      }

      const multipv = Math.min(Math.max(opts.multipv ?? 1, 1), 5);
      if (multipv !== this.currentMultiPv) {
        this.send(`setoption name MultiPV value ${multipv}`);
        this.currentMultiPv = multipv;
      }
      await this.ready();
      this.send(`position fen ${normalized}`);

      let go = "go";
      if (opts.depth) go += ` depth ${Math.floor(opts.depth)}`;
      else go += ` movetime ${Math.floor(opts.movetimeMs ?? 1000)}`;
      const search = (opts.searchMoves ?? []).filter((m) => legal.has(m));
      if (search.length) go += ` searchmoves ${search.join(" ")}`;

      // Keep lines per depth. When time runs out mid-iteration, the lower PVs are from an older depth
      // and can repeat the new best move, so we pick a depth where every PV finished.
      const byDepth = new Map<number, Map<number, EngineLine>>();
      const onInfo = (line: string) => {
        if (!line.startsWith("info ") || !line.includes(" pv ")) return;
        const parsed = parseInfo(line, whiteToMove);
        if (!parsed) return;
        const d = byDepth.get(parsed.depth) ?? new Map<number, EngineLine>();
        d.set(parsed.multipv, parsed);
        byDepth.set(parsed.depth, d);
      };
      this.listeners.add(onInfo);
      try {
        this.send(go);
        const budget = opts.depth ? 120_000 : (opts.movetimeMs ?? 1000) + 10_000;
        const best = await this.waitFor((l) => l.startsWith("bestmove"), budget);
        const bestMove = best.split(/\s+/)[1] ?? null;
        const ordered = pickLines(byDepth, Math.min(multipv, legal.size)).map((l) => ({ ...l, pvSan: pvToSan(normalized, l.pv) }));
        return { fen: normalized, lines: ordered, bestMove: bestMove === "(none)" ? null : bestMove };
      } finally {
        this.listeners.delete(onInfo);
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Clear the hash between unrelated games. */
  newGame(): Promise<void> {
    const run = async () => {
      if (!this.proc) await this.start();
      this.send("ucinewgame");
      await this.ready();
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (!this.proc) return;
    try {
      this.send("quit");
    } catch {
      /* already gone */
    }
    const proc = this.proc;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.proc = null;
  }
}

/** Choose a consistent set of PVs: the deepest depth with all `want` lines, with the deepest line 1 on top, no repeated first moves. */
export function pickLines(byDepth: Map<number, Map<number, EngineLine>>, want: number): EngineLine[] {
  const depths = [...byDepth.keys()].sort((a, b) => b - a);
  if (!depths.length) return [];
  const complete = depths.find((d) => byDepth.get(d)!.size >= want) ?? depths[0]!;
  const chosen = [...byDepth.get(complete)!.values()].sort((a, b) => a.multipv - b.multipv);
  const deepestFirst = depths.map((d) => byDepth.get(d)!.get(1)).find((l): l is EngineLine => !!l);
  if (deepestFirst && (!chosen[0] || deepestFirst.depth > chosen[0].depth)) chosen[0] = deepestFirst;
  const seen = new Set<string>();
  return chosen.filter((l) => {
    const first = l.pv[0] ?? "";
    if (!first || seen.has(first)) return false;
    seen.add(first);
    return true;
  });
}

/** Parse a UCI info line into a line with White-POV score. */
export function parseInfo(line: string, whiteToMove: boolean): EngineLine | null {
  const tokens = line.split(/\s+/);
  const get = (key: string) => {
    const i = tokens.indexOf(key);
    return i >= 0 ? tokens[i + 1] : undefined;
  };
  if (tokens.includes("lowerbound") || tokens.includes("upperbound")) return null;
  const depth = Number(get("depth"));
  const multipv = Number(INFO_RE.exec(line)?.[1] ?? 1);
  const scoreIdx = tokens.indexOf("score");
  const pvIdx = tokens.indexOf("pv");
  if (scoreIdx < 0 || pvIdx < 0 || !Number.isFinite(depth)) return null;
  const kind = tokens[scoreIdx + 1];
  const raw = Number(tokens[scoreIdx + 2]);
  if (!Number.isFinite(raw)) return null;
  const sign = whiteToMove ? 1 : -1;
  const score: Score =
    kind === "mate" ? { cp: null, mate: raw * sign } : { cp: raw * sign, mate: null };
  return { multipv, depth, score, pv: tokens.slice(pvIdx + 1), pvSan: [] };
}
