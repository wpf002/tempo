import type { EventEmitter } from "node:events";

/** A snapshot of the game being played, emitted by a source whenever it changes. */
export interface GameUpdate {
  source: "lichess" | "chessapp";
  /** Stable id for this game within Tempo. */
  gameId: string;
  externalId: string | null;
  startFen: string;
  /** Standard UCI moves (e1g1 castling), already validated by chess.js. */
  moves: string[];
  playerColor: "w" | "b";
  opponent: string;
  /** Lichess AI or Chess.app. Live hints only run when true. */
  vsComputer: boolean;
  finished: boolean;
  /** "1-0", "0-1", "1/2-1/2", or null while in progress. */
  result: string | null;
}

export interface SourceStatus {
  source: "lichess" | "chessapp";
  state: "off" | "connecting" | "watching" | "error";
  detail: string;
}

export interface Source extends EventEmitter {
  start(): void;
  stop(): void;
  status(): SourceStatus;
  on(event: "update", fn: (u: GameUpdate) => void): this;
  on(event: "status", fn: (s: SourceStatus) => void): this;
}
