import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

const expandHome = (p: string) => (p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p));

const Env = z.object({
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  ANTHROPIC_WORKSPACE_ID: z.string().optional().default(""),
  TEMPO_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  STOCKFISH_PATH: z.string().min(1).default("stockfish"),
  STOCKFISH_THREADS: z.coerce.number().int().min(1).max(64).default(2),
  STOCKFISH_HASH_MB: z.coerce.number().int().min(16).max(4096).default(256),
  TEMPO_LIVE_MOVETIME_MS: z.coerce.number().int().min(100).max(30_000).default(1000),
  TEMPO_REVIEW_MOVETIME_MS: z.coerce.number().int().min(100).max(30_000).default(600),
  LICHESS_TOKEN: z.string().optional().default(""),
  TEMPO_WATCH_PATH: z.string().default("./native/tempo-watch/.build/release/tempo-watch"),
  TEMPO_OVERLAY_PATH: z.string().default("./native/tempo-watch/.build/release/tempo-overlay"),
  TEMPO_OVERLAY: z.enum(["0", "1"]).default("1"),
  TEMPO_SOURCES: z.string().default("lichess,chessapp"),
  TEMPO_PORT: z.coerce.number().int().min(1024).max(65535).default(4848),
  TEMPO_WEB_ORIGIN: z.string().url().default("http://localhost:3100"),
  TEMPO_DB_PATH: z.string().default("~/.tempo/tempo.db"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = Env.parse(env);
  const sources = new Set(e.TEMPO_SOURCES.split(",").map((s) => s.trim()).filter(Boolean));
  // TEMPO_WATCH_PATH is relative to the repo root; the daemon runs from apps/daemon.
  const repoRoot = resolve(import.meta.dirname, "../../..");
  return {
    anthropicKey: e.ANTHROPIC_API_KEY,
    anthropicWorkspace: e.ANTHROPIC_WORKSPACE_ID,
    model: e.TEMPO_MODEL,
    stockfishPath: e.STOCKFISH_PATH,
    threads: e.STOCKFISH_THREADS,
    hashMb: e.STOCKFISH_HASH_MB,
    liveMovetimeMs: e.TEMPO_LIVE_MOVETIME_MS,
    reviewMovetimeMs: e.TEMPO_REVIEW_MOVETIME_MS,
    lichessToken: e.LICHESS_TOKEN,
    watchPath: e.TEMPO_WATCH_PATH.startsWith("/") ? e.TEMPO_WATCH_PATH : resolve(repoRoot, e.TEMPO_WATCH_PATH),
    overlayPath: e.TEMPO_OVERLAY_PATH.startsWith("/") ? e.TEMPO_OVERLAY_PATH : resolve(repoRoot, e.TEMPO_OVERLAY_PATH),
    overlay: e.TEMPO_OVERLAY === "1",
    lichess: sources.has("lichess"),
    chessapp: sources.has("chessapp"),
    port: e.TEMPO_PORT,
    webOrigin: new URL(e.TEMPO_WEB_ORIGIN).origin,
    dbPath: expandHome(e.TEMPO_DB_PATH),
  };
}
