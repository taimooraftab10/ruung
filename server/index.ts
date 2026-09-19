import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import {
  GameError,
  GameState,
  advanceTrick,
  autoMove,
  bid,
  chatSend,
  createGame,
  disconnect,
  joinGame,
  newSeries,
  nextRound,
  pass,
  playCard,
  seatOfConn,
  setTarget,
  startGame,
  takeSeat,
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
const pendingAdvance = new Set<string>();
interface TurnTimer {
  timer: ReturnType<typeof setTimeout>;
  actor: number;
  phase: GameState["phase"];
}
const turnTimers = new Map<string, TurnTimer>();

// How long each player has to act before the server moves for them.
const PLAY_MS = 10_000; // 10s to play a card
const BID_MS = 20_000; // 20s to bid / pass

function clearTurnTimer(roomId: string) {
  const t = turnTimers.get(roomId);
  if (t) {
    clearTimeout(t.timer);
    turnTimers.delete(roomId);
  }
}

// Arm (or re-arm) the countdown for whoever must act now. Sets g.turnDeadline so
// clients can render the clock, and schedules the server's auto-move. Called
// after every state change; a no-op when nobody is on the clock. If the same
// player is already on the clock (e.g. someone just chatted) the existing
// deadline is kept, so unrelated messages never reset the timer.
function armTurnTimer(roomId: string) {
  const g = games.get(roomId);
  if (!g) return;

  let seat: number | null = null;
  let ms = 0;
  if (g.phase === "playing" && g.turnSeat !== null) {
    seat = g.turnSeat;
    ms = PLAY_MS;
  } else if (g.phase === "auction" && g.auctionTurnSeat !== null) {
    seat = g.auctionTurnSeat;
    ms = BID_MS;
  }

  if (seat === null) {
    clearTurnTimer(roomId);
    g.turnDeadline = null; // pause / lobby / round over — no clock
    return;
  }

  // Already ticking for this exact turn? Leave it running.
  const existing = turnTimers.get(roomId);
  if (existing && existing.actor === seat && existing.phase === g.phase) return;

  clearTurnTimer(roomId);
  g.turnDeadline = Date.now() + ms;
  const actor = seat;
  const phase = g.phase;
  const timer = setTimeout(() => {
    turnTimers.delete(roomId);
    const cur = games.get(roomId);
    if (!cur || cur !== g) return;
    const stillTheirTurn =
      (phase === "playing" && cur.phase === "playing" && cur.turnSeat === actor) ||
      (phase === "auction" && cur.phase === "auction" && cur.auctionTurnSeat === actor);
    if (stillTheirTurn) {
      try {
        autoMove(cur, actor);
      } catch {
        /* ignore — state moved on */
      }
    }
    armTurnTimer(roomId);
    broadcast(roomId);
    scheduleAdvanceIfNeeded(roomId);
  }, ms);
  turnTimers.set(roomId, { timer, actor, phase });
}

// After a trick completes the game pauses (turnSeat === null). Wait ~1s so
// everyone sees all four cards, then advance to the next trick / round.
function scheduleAdvanceIfNeeded(roomId: string) {
  const g = games.get(roomId);
  if (!g || g.phase !== "playing" || g.turnSeat !== null) return;
  if (pendingAdvance.has(roomId)) return;
  pendingAdvance.add(roomId);
  setTimeout(() => {
    pendingAdvance.delete(roomId);
    const cur = games.get(roomId);
    if (cur && cur === g) {
      advanceTrick(cur);
      armTurnTimer(roomId);
      broadcast(roomId);
    }
  }, 1000);
}

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
    case "takeSeat":
      takeSeat(g, connId, msg.seat);
      break;
    case "setTarget":
      setTarget(g, msg.target);
      break;
    case "newSeries":
      newSeries(g);
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
    case "chat":
      chatSend(g, connId, msg.text);
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
      armTurnTimer(roomId);
      broadcast(roomId);
      scheduleAdvanceIfNeeded(roomId);
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
      clearTurnTimer(roomId);
      games.delete(roomId);
      roomConns.delete(roomId);
    } else {
      armTurnTimer(roomId);
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
