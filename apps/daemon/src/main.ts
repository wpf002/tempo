import { Coach, Engine, Store } from "@tempo/core";
import { loadConfig } from "./config.js";
import { Hub } from "./hub.js";
import { buildServer } from "./server.js";
import { ChessAppSource } from "./sources/chessapp.js";
import { LichessSource } from "./sources/lichess.js";
import type { Source } from "./sources/types.js";

const cfg = loadConfig();
const log = (msg: string, err?: unknown) => console.error(`[tempo] ${msg}`, err instanceof Error ? err.message : (err ?? ""));

// Two engines so a post-game review never blocks live analysis of the next game.
const liveThreads = Math.max(1, Math.ceil(cfg.threads / 2));
const reviewThreads = Math.max(1, cfg.threads - liveThreads);
const liveEngine = new Engine({ path: cfg.stockfishPath, threads: liveThreads, hashMb: cfg.hashMb });
const reviewEngine = new Engine({ path: cfg.stockfishPath, threads: reviewThreads, hashMb: cfg.hashMb });

try {
  await liveEngine.start();
  await reviewEngine.start();
} catch (e) {
  log(`couldn't start Stockfish at ${cfg.stockfishPath}. Install it (brew install stockfish) and set STOCKFISH_PATH.`, e);
  process.exit(1);
}

const store = new Store(cfg.dbPath);
const coach = cfg.anthropicKey ? new Coach({ apiKey: cfg.anthropicKey, model: cfg.model }) : null;
if (!coach) log("ANTHROPIC_API_KEY not set. Grading and hints work; explanations are off.");

const hub = new Hub({
  liveEngine,
  reviewEngine,
  store,
  coach,
  liveMovetimeMs: cfg.liveMovetimeMs,
  reviewMovetimeMs: cfg.reviewMovetimeMs,
  log,
});

const sources: Source[] = [];
let chessapp: ChessAppSource | null = null;
if (cfg.lichess) sources.push(new LichessSource(cfg.lichessToken));
if (cfg.chessapp) {
  chessapp = new ChessAppSource(cfg.watchPath);
  sources.push(chessapp);
}
for (const s of sources) {
  s.on("update", (u) => hub.onUpdate(u));
  s.on("status", (st) => hub.setSourceStatus(st));
  hub.setSourceStatus(s.status());
  s.start();
}

const app = await buildServer({ port: cfg.port, webOrigin: cfg.webOrigin, hub, store, drillEngine: reviewEngine, chessapp });

const shutdown = async () => {
  // Never hang on exit: a stray open socket shouldn't keep Stockfish processes alive.
  setTimeout(() => process.exit(0), 3000).unref();
  for (const s of sources) s.stop();
  await app.close();
  await Promise.all([liveEngine.stop(), reviewEngine.stop()]);
  store.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
