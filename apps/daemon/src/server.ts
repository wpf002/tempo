import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { Socket } from "node:net";
import { z } from "zod";
import { checkDrillAnswer, type Engine, type Store } from "@tempo/core";
import type { Hub, HubMessage } from "./hub.js";
import type { ChessAppSource } from "./sources/chessapp.js";

const ClientMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hint") }),
  z.object({ type: z.literal("explain") }),
  z.object({ type: z.literal("setColor"), color: z.enum(["w", "b"]) }),
  z.object({ type: z.literal("chessappHints"), on: z.boolean() }),
  z.object({ type: z.literal("endChessAppGame") }),
]);

const GameId = z.object({ id: z.string().regex(/^(lichess-[A-Za-z0-9]{8}|chessapp-\d{10,16})$/) });
const DrillId = z.object({ id: z.coerce.number().int().positive() });
const DrillAttempt = z.object({ uci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/) });

export async function buildServer(opts: {
  port: number;
  webOrigin: string;
  hub: Hub;
  store: Store;
  drillEngine: Engine;
  chessapp: ChessAppSource | null;
}): Promise<FastifyInstance> {
  const { hub, store, webOrigin, port } = opts;
  const app = Fastify({ logger: { level: "info" }, bodyLimit: 16 * 1024, forceCloseConnections: true });

  // Track raw sockets (including upgraded and rejected-upgrade ones) so shutdown never hangs on a stray client.
  const sockets = new Set<Socket>();
  app.server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  app.addHook("preClose", async () => {
    for (const s of sockets) s.destroy();
  });

  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);

  // Block DNS rebinding and cross-site requests. Only the panel's origin may talk to the daemon.
  app.addHook("onRequest", async (req, reply) => {
    if (!allowedHosts.has(String(req.headers.host ?? ""))) return reply.code(403).send({ error: "bad host" });
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== webOrigin) return reply.code(403).send({ error: "bad origin" });
    const isWs = req.url === "/ws";
    // Browsers always send Origin on WebSocket upgrades; require it so other local pages can't connect.
    if (isWs && origin !== webOrigin) return reply.code(403).send({ error: "origin required" });
  });

  await app.register(cors, { origin: [webOrigin], methods: ["GET", "POST"] });
  await app.register(websocket, { options: { maxPayload: 4096 } });

  app.get("/ws", { websocket: true }, (socket) => {
    const send = (msg: HubMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    send({ type: "state", state: hub.snapshot() });
    hub.on("message", send);
    socket.on("close", () => hub.off("message", send));
    socket.on("message", (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        return;
      }
      const msg = ClientMsg.safeParse(raw);
      if (!msg.success) return;
      switch (msg.data.type) {
        case "hint":
          hub.requestHint();
          break;
        case "explain":
          void hub.explain();
          break;
        case "setColor":
          if (opts.chessapp) opts.chessapp.tracker.playerColor = msg.data.color;
          hub.setPlayerColor(msg.data.color);
          break;
        case "chessappHints":
          hub.setChessappHints(msg.data.on);
          break;
        case "endChessAppGame":
          opts.chessapp?.tracker.finishCurrent();
          break;
      }
    });
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/games", async () => store.listGames(100));

  app.get("/api/games/:id", async (req, reply) => {
    const p = GameId.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "bad id" });
    const game = store.getGame(p.data.id);
    if (!game) return reply.code(404).send({ error: "not found" });
    return { game, moves: store.getMoves(game.id), mistakes: store.getMistakes(game.id) };
  });

  app.post("/api/games/:id/review", async (req, reply) => {
    const p = GameId.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "bad id" });
    if (!store.getGame(p.data.id)) return reply.code(404).send({ error: "not found" });
    hub.enqueueReview(p.data.id);
    return reply.code(202).send({ queued: true });
  });

  app.get("/api/stats", async () => store.stats());

  app.get("/api/drills", async () => store.dueDrills(20));

  app.post("/api/drills/:id/attempt", async (req, reply) => {
    const p = DrillId.safeParse(req.params);
    const b = DrillAttempt.safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: "bad request" });
    const drill = store.getDrill(p.data.id);
    if (!drill) return reply.code(404).send({ error: "not found" });
    const r = await checkDrillAnswer(opts.drillEngine, drill.fen, b.data.uci, drill.bestUci);
    store.recordAttempt(drill.id, r.correct);
    return { correct: r.correct, bestSan: drill.bestSan, explanation: drill.explanation, takeaway: drill.takeaway };
  });

  await app.listen({ host: "127.0.0.1", port });
  return app;
}
