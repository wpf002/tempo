"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const DAEMON = process.env.NEXT_PUBLIC_TEMPO_DAEMON ?? "http://localhost:4848";
export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export type Grade = "best" | "good" | "inaccuracy" | "mistake" | "blunder";
export interface Score { cp: number | null; mate: number | null }
export interface Explanation { motif: string; explanation: string; takeaway: string }
export interface SourceStatus { source: "lichess" | "chessapp"; state: "off" | "connecting" | "watching" | "error"; detail: string }

export interface LiveState {
  sources: SourceStatus[];
  game: null | {
    id: string;
    source: "lichess" | "chessapp";
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
  lastGrade: { san: string; grade: Grade; before: string; after: string; bestSan: string | null } | null;
  hints: { tier: number; text: string; square?: string; uci?: string }[];
  review: { gameId: string; done: number; total: number } | null;
}

export type HubMessage =
  | { type: "state"; state: LiveState }
  | { type: "explain"; explanation: Explanation; about: string }
  | { type: "error"; message: string }
  | { type: "reviewDone"; gameId: string };

export type ClientMessage =
  | { type: "hint" }
  | { type: "explain" }
  | { type: "setColor"; color: "w" | "b" }
  | { type: "chessappHints"; on: boolean }
  | { type: "endChessAppGame" };

export interface GameRow {
  id: string;
  source: "lichess" | "chessapp";
  playerColor: "w" | "b";
  opponent: string;
  startFen: string;
  moves: string[];
  result: string | null;
  startedAt: number;
  accuracy: number | null;
  summary: string | null;
  focus: string[];
  reviewedAt: number | null;
}
export interface MoveRow {
  ply: number; fenBefore: string; uci: string; san: string; color: "w" | "b";
  evalBefore: Score; evalAfter: Score; bestUci: string | null; bestSan: string | null; grade: Grade; loss: number; phase: string;
}
export interface MistakeRow {
  id: number; gameId: string; ply: number; fen: string; playedSan: string; bestUci: string; bestSan: string;
  grade: Grade; motif: string; explanation: string; takeaway: string; phase: string;
}
export interface DrillRow extends MistakeRow { attempts: number; solved: number }
export interface Stats {
  games: number;
  avgAccuracy: number | null;
  byMotif: { motif: string; count: number }[];
  byPhase: { phase: string; grade: string; count: number }[];
  accuracyTrend: { id: string; startedAt: number; accuracy: number }[];
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${DAEMON}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as T;
}

/** WebSocket to the daemon with auto-reconnect. */
export function useHub(onMessage: (m: HubMessage) => void) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    const connect = () => {
      const ws = new WebSocket(`${DAEMON.replace(/^http/, "ws")}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        delay = 500;
        setConnected(true);
      };
      ws.onmessage = (e) => {
        try {
          handler.current(JSON.parse(String(e.data)) as HubMessage);
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) retry = setTimeout(connect, (delay = Math.min(delay * 2, 8000)));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((m: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }, []);

  return { connected, send };
}

/** White-POV winning chances 0..1 for an eval bar. */
export function whiteShare(s: Score): number {
  if (s.mate !== null) return s.mate > 0 ? 1 : 0;
  const cp = Math.max(-1000, Math.min(1000, s.cp ?? 0));
  return 1 / (1 + Math.exp(-0.00368208 * cp));
}

export function fmt(s: Score): string {
  if (s.mate !== null) return `${s.mate < 0 ? "-" : ""}M${Math.abs(s.mate)}`;
  const v = (s.cp ?? 0) / 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}
