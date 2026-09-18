import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import {
  GameError,
  GameState,
  bid,
  createGame,
  disconnect,
  joinGame,
  nextRound,
  pass,
  playCard,
  seatOfConn,
  startGame,
  viewFor,
} from "../shared/game";
import { ClientMessage } from "../shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "..", "dist");
const PORT = Number(process.env.PORT) || 8787;

// ---- HTTP: serve the built client -----------------------------------------

const app = express();
app.get("/healthz", (_req, res) => res.send("ok"));
app.use(express.static(DIST));
// SPA fallback (rooms live in the URL hash, so this just serves index.html).
app.get("*", (_req, res) => res.sendFile(path.join(DIST, "index.html")));

const server = http.createServer(app);

// ---- WebSocket game rooms --------------------------------------------------

interface Conn {
  id: string;
  ws: WebSocket;
  roomId: string;
  alive: boolean;
}

const games = new Map<string, GameState>();
const roomConns = new Map<string, Set<Conn>>();

function getGame(roomId: string): GameState {
  let g = games.get(roomId);
  if (!g) {
    g = createGame(roomId);
    games.set(roomId, g);
    roomConns.set(roomId, new Set());
  }
  return g;
}

function broadcast(roomId: string) {
  const g = games.get(roomId);
  const conns = roomConns.get(roomId);
  if (!g || !conns) return;
  for (const c of conns) {
    if (c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify({ type: "view", view: viewFor(g, c.id) }));
    }
  }
}

function handle(g: GameState, connId: string, msg: ClientMessage) {
  const seat = seatOfConn(g, connId);
  switch (msg.type) {
    case "join":
      joinGame(g, connId, msg.name);
      break;
    case "startGame":
      startGame(g);
      break;
    case "bid":
      if (seat === null) throw new GameError("You are not seated.");
      bid(g, seat, msg.count, msg.suit);
      break;
    case "pass":
      if (seat === null) throw new GameError("You are not seated.");
      pass(g, seat);
      break;
    case "playCard":
      if (seat === null) throw new GameError("You are not seated.");
      playCard(g, seat, msg.card);
      break;
    case "nextRound":
      nextRound(g);
      break;
  }
}

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "", "http://localhost");
  const roomId = (url.searchParams.get("room") || "LOBBY").toUpperCase().slice(0, 8);

  const g = getGame(roomId);
  const conn: Conn = { id: randomUUID(), ws, roomId, alive: true };
  roomConns.get(roomId)!.add(conn);

  ws.on("pong", () => (conn.alive = true));

  // Send the current view immediately.
  ws.send(JSON.stringify({ type: "view", view: viewFor(g, conn.id) }));

  ws.on("message", (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    try {
      handle(g, conn.id, msg);
      broadcast(roomId);
    } catch (err) {
      const message = err instanceof GameError ? err.message : "Something went wrong.";
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "error", message }));
    }
  });

  ws.on("close", () => {
    disconnect(g, conn.id);
    const set = roomConns.get(roomId);
    set?.delete(conn);
    if (set && set.size === 0) {
      // Everyone left: drop the room so memory is freed / a fresh game starts.
      games.delete(roomId);
      roomConns.delete(roomId);
    } else {
      broadcast(roomId);
    }
  });
});

// Heartbeat: drop dead sockets so idle hosts don't leak connections.
const heartbeat = setInterval(() => {
  for (const conns of roomConns.values()) {
    for (const c of conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      if (c.ws.readyState === WebSocket.OPEN) c.ws.ping();
    }
  }
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Ruung server listening on http://localhost:${PORT}`);
});
