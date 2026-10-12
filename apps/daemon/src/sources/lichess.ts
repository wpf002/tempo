import { EventEmitter } from "node:events";
import { Chess } from "chess.js";
import { z } from "zod";
import { START_FEN, applyUci, replay, toUci, tokenize } from "@tempo/core";
import type { GameUpdate, Source, SourceStatus } from "./types.js";

const BASE = "https://lichess.org";

const Opponent = z.object({ username: z.string().optional(), ai: z.number().int().optional() }).passthrough();
const GameInfo = z
  .object({
    gameId: z.string().regex(/^[A-Za-z0-9]{8}$/),
    color: z.enum(["white", "black"]),
    opponent: Opponent.optional(),
    variant: z.object({ key: z.string() }).passthrough().optional(),
    compat: z.object({ board: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough();
const Event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("gameStart"), game: GameInfo }),
  z.object({ type: z.literal("gameFinish"), game: GameInfo }),
  z.object({ type: z.literal("challenge") }).passthrough(),
  z.object({ type: z.literal("challengeCanceled") }).passthrough(),
  z.object({ type: z.literal("challengeDeclined") }).passthrough(),
]);

const State = z
  .object({ moves: z.string(), status: z.string(), winner: z.enum(["white", "black"]).optional() })
  .passthrough();
const BoardLine = z.discriminatedUnion("type", [
  z.object({ type: z.literal("gameFull"), initialFen: z.string(), state: State }).passthrough(),
  z.object({ type: z.literal("gameState") }).merge(State),
  z.object({ type: z.literal("chatLine") }).passthrough(),
  z.object({ type: z.literal("opponentGone") }).passthrough(),
]);

const Export = z
  .object({
    moves: z.string().default(""),
    initialFen: z.string().optional(),
    status: z.string(),
    winner: z.enum(["white", "black"]).optional(),
  })
  .passthrough();

const LIVE = new Set(["created", "started"]);

async function* ndjson(res: Response): AsyncGenerator<unknown> {
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    if (buf.length > 1_000_000) throw new Error("ndjson line too long");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue; // keepalive
      try {
        yield JSON.parse(line);
      } catch {
        /* skip malformed line */
      }
    }
  }
}

function resultOf(status: string, winner?: "white" | "black"): string | null {
  if (LIVE.has(status)) return null;
  if (winner === "white") return "1-0";
  if (winner === "black") return "0-1";
  if (status === "aborted" || status === "noStart") return "*";
  return "1/2-1/2";
}

/** Normalize Lichess UCI (may use king-to-rook castling) into standard UCI via chess.js. */
function normalizeMoves(startFen: string, moves: string): string[] {
  const chess = new Chess(startFen);
  const out: string[] = [];
  for (const u of moves.split(" ").filter(Boolean)) {
    const mv = applyUci(chess, u);
    if (!mv) break;
    out.push(toUci(mv));
  }
  return out;
}

interface Meta {
  playerColor: "w" | "b";
  opponent: string;
  vsComputer: boolean;
}

export class LichessSource extends EventEmitter implements Source {
  private abort = new AbortController();
  private st: SourceStatus = { source: "lichess", state: "off", detail: "" };
  private games = new Map<string, Meta>();
  private boardStreams = new Set<string>();
  private finished = new Set<string>();

  constructor(private readonly token: string) {
    super();
  }

  status(): SourceStatus {
    return this.st;
  }

  private setStatus(state: SourceStatus["state"], detail: string) {
    this.st = { source: "lichess", state, detail };
    this.emit("status", this.st);
  }

  private headers(accept = "application/x-ndjson"): HeadersInit {
    return { Authorization: `Bearer ${this.token}`, Accept: accept };
  }

  start(): void {
    if (!this.token) {
      this.setStatus("off", "LICHESS_TOKEN not set");
      return;
    }
    void this.runEvents();
  }

  stop(): void {
    this.abort.abort();
    this.setStatus("off", "stopped");
  }

  private async runEvents(): Promise<void> {
    let backoff = 2000;
    while (!this.abort.signal.aborted) {
      this.setStatus("connecting", "opening event stream");
      try {
        const res = await fetch(`${BASE}/api/stream/event`, { headers: this.headers(), signal: this.abort.signal });
        if (res.status === 401 || res.status === 403) {
          this.setStatus("error", "Lichess rejected the token. It needs the board:play scope.");
          await this.sleep(60_000);
          continue;
        }
        if (res.status === 429) {
          this.setStatus("error", "Rate limited by Lichess. Waiting a minute.");
          await this.sleep(61_000);
          continue;
        }
        if (!res.ok) throw new Error(`event stream HTTP ${res.status}`);
        this.setStatus("watching", "waiting for a game");
        backoff = 2000;
        for await (const raw of ndjson(res)) {
          const ev = Event.safeParse(raw);
          if (!ev.success) continue;
          if (ev.data.type === "gameStart") this.onGameStart(ev.data.game);
          else if (ev.data.type === "gameFinish") void this.onGameFinish(ev.data.game.gameId);
        }
      } catch (e) {
        if (this.abort.signal.aborted) return;
        this.setStatus("error", `event stream: ${(e as Error).message}`);
      }
      await this.sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  private onGameStart(g: z.infer<typeof GameInfo>): void {
    const variant = g.variant?.key ?? "standard";
    if (variant !== "standard" && variant !== "fromPosition") return;
    const ai = g.opponent?.ai;
    this.games.set(g.gameId, {
      playerColor: g.color === "white" ? "w" : "b",
      opponent: ai ? `Lichess AI level ${ai}` : (g.opponent?.username ?? "opponent"),
      vsComputer: typeof ai === "number",
    });
    if (g.compat?.board !== false) void this.runBoardStream(g.gameId);
    else this.setStatus("watching", `game ${g.gameId}: not Board API compatible, will review when it ends`);
  }

  private async runBoardStream(gameId: string): Promise<void> {
    if (this.boardStreams.has(gameId)) return;
    this.boardStreams.add(gameId);
    try {
      const res = await fetch(`${BASE}/api/board/game/stream/${gameId}`, { headers: this.headers(), signal: this.abort.signal });
      if (!res.ok) {
        this.setStatus("watching", `game ${gameId}: live stream unavailable (HTTP ${res.status}), will review when it ends`);
        return;
      }
      this.setStatus("watching", `game ${gameId}`);
      let startFen = START_FEN;
      for await (const raw of ndjson(res)) {
        const line = BoardLine.safeParse(raw);
        if (!line.success) continue;
        let state: z.infer<typeof State>;
        if (line.data.type === "gameFull") {
          startFen = line.data.initialFen === "startpos" ? START_FEN : line.data.initialFen;
          try {
            startFen = new Chess(startFen).fen();
          } catch {
            return;
          }
          state = line.data.state;
        } else if (line.data.type === "gameState") {
          state = line.data;
        } else continue;
        this.emitUpdate(gameId, startFen, normalizeMoves(startFen, state.moves), resultOf(state.status, state.winner));
      }
    } catch (e) {
      if (!this.abort.signal.aborted) this.setStatus("error", `game ${gameId}: ${(e as Error).message}`);
    } finally {
      this.boardStreams.delete(gameId);
    }
  }

  /** Fallback for games we couldn't stream: fetch the final PGN moves and emit a finished update. */
  private async onGameFinish(gameId: string): Promise<void> {
    await this.sleep(1500); // let the board stream deliver its final state first
    if (this.finished.has(gameId)) return;
    try {
      const res = await fetch(`${BASE}/game/export/${gameId}?moves=true&clocks=false&evals=false&opening=false`, {
        headers: this.headers("application/json"),
        signal: this.abort.signal,
      });
      if (!res.ok) return;
      const g = Export.parse(await res.json());
      const startFen = g.initialFen ? new Chess(g.initialFen).fen() : START_FEN;
      const r = replay(tokenize([g.moves]), startFen);
      this.emitUpdate(gameId, startFen, r.uci, resultOf(g.status, g.winner) ?? "*");
    } catch {
      /* best-effort */
    }
  }

  private emitUpdate(gameId: string, startFen: string, moves: string[], result: string | null): void {
    const meta = this.games.get(gameId);
    if (!meta || this.finished.has(gameId)) return;
    const finished = result !== null;
    if (finished) this.finished.add(gameId);
    const u: GameUpdate = {
      source: "lichess",
      gameId: `lichess-${gameId}`,
      externalId: gameId,
      startFen,
      moves,
      playerColor: meta.playerColor,
      opponent: meta.opponent,
      vsComputer: meta.vsComputer,
      finished,
      result,
    };
    this.emit("update", u);
    if (finished) this.setStatus("watching", "waiting for a game");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.abort.signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }
}
