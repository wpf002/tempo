import { EventEmitter } from "node:events";
import { Chess } from "chess.js";
import {
  applyUci,
  buildHints,
  formatScore,
  gradeMove,
  phaseOf,
  reviewGame,
  type Analysis,
  type Coach,
  type Engine,
  type Explanation,
  type Grade,
  type Hint,
  type Score,
  type Store,
} from "@tempo/core";
import type { GameUpdate, SourceStatus } from "./sources/types.js";

export interface LastGrade {
  san: string;
  grade: Grade;
  before: string;
  after: string;
  bestSan: string | null;
}

export interface LiveState {
  sources: SourceStatus[];
  game: null | {
    id: string;
    source: GameUpdate["source"];
    opponent: string;
    playerColor: "w" | "b";
    fen: string;
    san: string[];
    lastMove: string | null;
    finished: boolean;
    result: string | null;
    yourTurn: boolean;
  };
  live: { allowed: boolean; reason: string };
  chessappHints: boolean;
  eval: { score: Score; text: string } | null;
  thinking: boolean;
  lastGrade: LastGrade | null;
  hints: Hint[];
  review: { gameId: string; done: number; total: number } | null;
}

export type HubMessage =
  | { type: "state"; state: LiveState }
  | { type: "explain"; explanation: Explanation; about: string }
  | { type: "error"; message: string }
  | { type: "reviewDone"; gameId: string };

const MIN_REVIEW_PLIES = 4;

export class Hub extends EventEmitter {
  private game: GameUpdate | null = null;
  private sources = new Map<string, SourceStatus>();
  private analyses = new Map<string, Analysis>(); // fen → analysis, current game only
  private pendingFen: string | null = null;
  private working = false;
  private hintTier = 0;
  private hintFen: string | null = null;
  private lastGrade: LastGrade | null = null;
  private reviewQueue: string[] = [];
  private reviewing: LiveState["review"] = null;
  chessappHints = true;

  constructor(
    private readonly deps: {
      liveEngine: Engine;
      reviewEngine: Engine;
      store: Store;
      coach: Coach | null;
      liveMovetimeMs: number;
      reviewMovetimeMs: number;
      log: (msg: string, err?: unknown) => void;
    },
  ) {
    super();
  }

  private broadcast(msg: HubMessage): void {
    this.emit("message", msg);
  }

  setSourceStatus(s: SourceStatus): void {
    this.sources.set(s.source, s);
    this.pushState();
  }

  private currentFen(): string | null {
    if (!this.game) return null;
    const c = new Chess(this.game.startFen);
    for (const m of this.game.moves) applyUci(c, m);
    return c.fen();
  }

  private liveCheck(): { allowed: boolean; reason: string } {
    const g = this.game;
    if (!g) return { allowed: false, reason: "No game in progress." };
    if (g.finished) return { allowed: false, reason: "Game over. Review is in the Review tab." };
    if (!g.vsComputer) return { allowed: false, reason: "Playing a human. Tempo stays quiet until the game ends." };
    if (g.source === "chessapp" && !this.chessappHints) return { allowed: false, reason: "Live hints are off for Chess.app." };
    return { allowed: true, reason: "" };
  }

  snapshot(): LiveState {
    const g = this.game;
    const fen = this.currentFen();
    const live = this.liveCheck();
    let game: LiveState["game"] = null;
    if (g && fen) {
      const c = new Chess(g.startFen);
      const san: string[] = [];
      for (const m of g.moves) {
        const mv = applyUci(c, m);
        if (mv) san.push(mv.san);
      }
      game = {
        id: g.gameId,
        source: g.source,
        opponent: g.opponent,
        playerColor: g.playerColor,
        fen,
        san,
        lastMove: g.moves.at(-1) ?? null,
        finished: g.finished,
        result: g.result,
        yourTurn: c.turn() === g.playerColor,
      };
    }
    const a = fen ? this.analyses.get(fen) : undefined;
    const score = a?.lines[0]?.score;
    return {
      sources: [...this.sources.values()],
      game,
      live,
      chessappHints: this.chessappHints,
      eval: live.allowed && score ? { score, text: formatScore(score) } : null,
      thinking: live.allowed && !!fen && !a,
      lastGrade: live.allowed ? this.lastGrade : null,
      hints: live.allowed && this.hintFen === fen && a ? buildHints(a).slice(0, this.hintTier) : [],
      review: this.reviewing,
    };
  }

  private pushState(): void {
    this.broadcast({ type: "state", state: this.snapshot() });
  }

  onUpdate(u: GameUpdate): void {
    const isNew = !this.game || this.game.gameId !== u.gameId;
    if (isNew) {
      this.analyses.clear();
      this.lastGrade = null;
      void this.deps.liveEngine.newGame().catch((e) => this.deps.log("engine newGame failed", e));
    }
    this.game = u;
    // A board sitting on the starting position isn't a game worth keeping yet.
    if (u.moves.length) {
      this.deps.store.upsertGame({
        id: u.gameId,
        source: u.source,
        externalId: u.externalId,
        playerColor: u.playerColor,
        opponent: u.opponent,
        vsComputer: u.vsComputer,
        startFen: u.startFen,
        moves: u.moves,
        result: u.result,
        startedAt: this.deps.store.getGame(u.gameId)?.startedAt ?? Date.now(),
        endedAt: u.finished ? Date.now() : null,
      });
    }

    if (u.finished && u.moves.length >= MIN_REVIEW_PLIES) this.enqueueReview(u.gameId);
    if (this.liveCheck().allowed) {
      this.pendingFen = this.currentFen();
      void this.work();
    }
    this.pushState();
  }

  setPlayerColor(color: "w" | "b"): void {
    if (this.game?.source === "chessapp") {
      this.game = { ...this.game, playerColor: color };
      this.lastGrade = null;
      this.pushState();
    }
  }

  setChessappHints(on: boolean): void {
    this.chessappHints = on;
    if (on && this.liveCheck().allowed) {
      this.pendingFen = this.currentFen();
      void this.work();
    }
    this.pushState();
  }

  /** Live analysis worker. Always analyses the newest position; stale ones are skipped. */
  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.pendingFen) {
        const fen = this.pendingFen;
        this.pendingFen = null;
        if (this.analyses.has(fen)) {
          this.afterAnalysis();
          continue;
        }
        const a = await this.deps.liveEngine.analyse(fen, { movetimeMs: this.deps.liveMovetimeMs, multipv: 3 });
        this.analyses.set(fen, a);
        if (this.analyses.size > 400) this.analyses.delete(this.analyses.keys().next().value!);
        this.afterAnalysis();
      }
    } catch (e) {
      this.deps.log("live analysis failed", e);
      this.broadcast({ type: "error", message: "Engine error. Check STOCKFISH_PATH." });
    } finally {
      this.working = false;
    }
  }

  /** Grade the player's last move once both positions are analysed. */
  private afterAnalysis(): void {
    const g = this.game;
    if (!g || !g.moves.length) return this.pushState();
    const c = new Chess(g.startFen);
    // Find the player's most recent move and the positions around it.
    let lastPlayerIdx = -1;
    const fens: string[] = [c.fen()];
    const colors: ("w" | "b")[] = [];
    const sans: string[] = [];
    for (const m of g.moves) {
      colors.push(c.turn());
      const mv = applyUci(c, m);
      sans.push(mv?.san ?? m);
      fens.push(c.fen());
    }
    for (let i = g.moves.length - 1; i >= 0; i--) {
      if (colors[i] === g.playerColor) {
        lastPlayerIdx = i;
        break;
      }
    }
    if (lastPlayerIdx >= 0) {
      const before = this.analyses.get(fens[lastPlayerIdx]!);
      const after = this.analyses.get(fens[lastPlayerIdx + 1]!);
      const afterScore = after?.lines[0]?.score ?? (after && terminal(fens[lastPlayerIdx + 1]!));
      if (before?.lines[0] && afterScore) {
        const { grade } = gradeMove(before.lines[0].score, afterScore, g.playerColor, before.bestMove === g.moves[lastPlayerIdx]);
        this.lastGrade = {
          san: sans[lastPlayerIdx]!,
          grade,
          before: formatScore(before.lines[0].score),
          after: formatScore(afterScore),
          bestSan: before.lines[0].pvSan[0] ?? null,
        };
      } else if (!this.pendingFen) {
        // A position around the player's move was skipped (fast reply, or joined mid-game). Analyse it next.
        this.pendingFen = !before ? fens[lastPlayerIdx]! : !after ? fens[lastPlayerIdx + 1]! : null;
      }
    }
    this.pushState();
  }

  requestHint(): void {
    const live = this.liveCheck();
    if (!live.allowed) return this.broadcast({ type: "error", message: live.reason });
    const snap = this.snapshot();
    if (!snap.game?.yourTurn) return this.broadcast({ type: "error", message: "Hints are for your move. Wait for the computer." });
    const fen = snap.game.fen;
    if (!this.analyses.has(fen)) return this.broadcast({ type: "error", message: "Still analysing. Try again in a second." });
    if (this.hintFen !== fen) {
      this.hintFen = fen;
      this.hintTier = 0;
    }
    this.hintTier = Math.min(3, this.hintTier + 1);
    this.pushState();
  }

  /** Explain your last graded move, or the current position once the full hint is revealed. */
  async explain(): Promise<void> {
    const { coach } = this.deps;
    if (!coach) return this.broadcast({ type: "error", message: "Set ANTHROPIC_API_KEY to turn on explanations." });
    const live = this.liveCheck();
    if (!live.allowed) return this.broadcast({ type: "error", message: live.reason });
    const g = this.game!;
    const fen = this.currentFen()!;
    try {
      if (this.hintFen === fen && this.hintTier >= 3) {
        const a = this.analyses.get(fen);
        if (!a) return;
        const explanation = await coach.explainPosition({ fen, lines: a.lines });
        return this.broadcast({ type: "explain", explanation, about: "the best move here" });
      }
      const lg = this.lastGrade;
      if (!lg) return this.broadcast({ type: "error", message: "Nothing to explain yet. Make a move, or reveal the full hint first." });
      // Rebuild the position before the player's last move.
      const c = new Chess(g.startFen);
      let fenBefore = c.fen();
      let moveNumber = 1;
      for (const m of g.moves) {
        const color = c.turn();
        const n = c.moveNumber();
        const before = c.fen();
        const mv = applyUci(c, m);
        if (color === g.playerColor && mv?.san === lg.san) {
          fenBefore = before;
          moveNumber = n;
        }
      }
      const a = this.analyses.get(fenBefore);
      if (!a?.lines[0]) return;
      const afterFen = (() => {
        const t = new Chess(fenBefore);
        t.move(lg.san);
        return t.fen();
      })();
      const after = this.analyses.get(afterFen);
      const explanation = await coach.explainMove({
        fenBefore,
        playedSan: lg.san,
        playedScore: after?.lines[0]?.score ?? a.lines[0].score,
        grade: lg.grade,
        bestLines: a.lines,
        playerColor: g.playerColor,
        phase: phaseOf(fenBefore, moveNumber),
        moveNumber,
      });
      this.broadcast({ type: "explain", explanation, about: `your move ${lg.san}` });
    } catch (e) {
      this.deps.log("coach failed", e);
      this.broadcast({ type: "error", message: "Coach request failed. Check ANTHROPIC_API_KEY and TEMPO_MODEL." });
    }
  }

  enqueueReview(gameId: string): void {
    if (this.reviewQueue.includes(gameId) || this.reviewing?.gameId === gameId) return;
    this.reviewQueue.push(gameId);
    void this.runReviews();
  }

  private async runReviews(): Promise<void> {
    if (this.reviewing) return;
    while (this.reviewQueue.length) {
      const id = this.reviewQueue.shift()!;
      const game = this.deps.store.getGame(id);
      if (!game || game.moves.length < MIN_REVIEW_PLIES) continue;
      this.reviewing = { gameId: id, done: 0, total: game.moves.length + 1 };
      this.pushState();
      try {
        await reviewGame(
          { engine: this.deps.reviewEngine, store: this.deps.store, coach: this.deps.coach },
          game,
          {
            movetimeMs: this.deps.reviewMovetimeMs,
            onProgress: (done, total) => {
              this.reviewing = { gameId: id, done, total };
              if (done % 4 === 0 || done === total) this.pushState();
            },
          },
        );
        this.broadcast({ type: "reviewDone", gameId: id });
      } catch (e) {
        this.deps.log(`review ${id} failed`, e);
        this.broadcast({ type: "error", message: `Review failed for ${id}.` });
      }
      this.reviewing = null;
      this.pushState();
    }
  }
}

function terminal(fen: string): Score | null {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { cp: null, mate: c.turn() === "w" ? -1 : 1 };
  if (c.isGameOver()) return { cp: 0, mate: null };
  return null;
}
