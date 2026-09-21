import { makeDeck, shuffle, cardEq } from "./deck";
import { computeScore, decideRound, isWastedTrick } from "./scoring";
import {
  ACE,
  Bid,
  Card,
  ChatMessage,
  ClientView,
  PlayedCard,
  SeatAuction,
  Suit,
  Team,
  TrickResult,
  teamOfSeat,
} from "./types";

// ---------------------------------------------------------------------------
//  Server-side full game state (never sent whole to a client)
// ---------------------------------------------------------------------------

interface SeatState {
  connId: string | null;
  name: string;
  connected: boolean;
}

export interface GameState {
  roomId: string;
  phase: ClientView["phase"];
  round: number;
  hostConnId: string | null; // the connId of whoever created the room; only they may start it
  seats: SeatState[]; // length 4
  hands: Card[][]; // by seat
  deck: Card[]; // leftover during a deal
  drawReveal: { seat: number; card: Card }[] | null;

  callerSeat: number | null;

  // auction
  auctionTurnSeat: number | null;
  currentBid: Bid | null;
  auctionActions: SeatAuction[];
  auctionTurnsTaken: number; // each player gets exactly one chance (max 4)
  auctionLog: string[];

  // contract
  trump: Suit | null;
  contract: number | null;
  contractTeam: Team | null;
  contractSeat: number | null;

  // per-turn countdown (epoch ms when the active player is auto-played); the
  // server owns the actual timer, this is only the deadline it broadcasts.
  turnDeadline: number | null;

  // play
  turnSeat: number | null;
  leadSeat: number | null;
  trickNumber: number;
  currentTrick: PlayedCard[];
  trickResults: TrickResult[];
  lastTrick: { plays: PlayedCard[]; winnerSeat: number } | null;

  // results
  matchScore: [number, number];
  targetScore: number;
  seriesWinner: Team | null;
  roundResult: ClientView["roundResult"] | null;

  // spectators (connected but not seated) and shared chat
  spectatorNames: Record<string, string>; // connId -> name
  chat: ChatMessage[];
  chatSeq: number;
}

const emptySeat = (): SeatState => ({ connId: null, name: "", connected: false });

export function createGame(roomId: string): GameState {
  return {
    roomId,
    phase: "lobby",
    round: 0,
    hostConnId: null,
    seats: [emptySeat(), emptySeat(), emptySeat(), emptySeat()],
    hands: [[], [], [], []],
    deck: [],
    drawReveal: null,
    callerSeat: null,
    auctionTurnSeat: null,
    currentBid: null,
    auctionActions: [null, null, null, null],
    auctionTurnsTaken: 0,
    auctionLog: [],
    trump: null,
    contract: null,
    contractTeam: null,
    contractSeat: null,
    turnDeadline: null,
    turnSeat: null,
    leadSeat: null,
    trickNumber: 0,
    currentTrick: [],
    trickResults: [],
    lastTrick: null,
    matchScore: [0, 0],
    targetScore: 10,
    seriesWinner: null,
    roundResult: null,
    spectatorNames: {},
    chat: [],
    chatSeq: 0,
  };
}

export class GameError extends Error {}

// ---------------------------------------------------------------------------
//  Connection management
// ---------------------------------------------------------------------------

export function seatOfConn(g: GameState, connId: string): number | null {
  const i = g.seats.findIndex((s) => s.connId === connId);
  return i === -1 ? null : i;
}

/** Join or reclaim a seat. Returns the seat index, or null if the table is full. */
export function joinGame(g: GameState, connId: string, rawName: string): number | null {
  const name = (rawName || "Player").trim().slice(0, 16) || "Player";

  // Whoever's join message the server processes first owns the room — only
  // they can start the game, and the room closes if they leave.
  if (g.hostConnId === null) g.hostConnId = connId;

  // Already seated on this connection?
  const existing = seatOfConn(g, connId);
  if (existing !== null) {
    g.seats[existing].name = name;
    return existing;
  }

  // Reclaim a disconnected seat with the same name (mid-game reconnect).
  const reclaim = g.seats.findIndex(
    (s) => !s.connected && s.name.toLowerCase() === name.toLowerCase() && s.name !== "",
  );
  if (reclaim !== -1) {
    g.seats[reclaim].connId = connId;
    g.seats[reclaim].connected = true;
    delete g.spectatorNames[connId];
    return reclaim;
  }

  // Take the first free seat (only while in the lobby).
  if (g.phase === "lobby") {
    const free = g.seats.findIndex((s) => s.connId === null && s.name === "");
    if (free !== -1) {
      g.seats[free] = { connId, name, connected: true };
      delete g.spectatorNames[connId];
      return free;
    }
  }

  // Otherwise you watch: only four seats play, everyone else spectates (and can
  // still chat and see every hand).
  g.spectatorNames[connId] = name;
  return null;
}

/** Append a chat message from a player or spectator (kept to the last 100). */
export function chatSend(g: GameState, connId: string, rawText: string) {
  const text = (rawText || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!text) return;
  const seat = seatOfConn(g, connId);
  const name =
    seat !== null ? g.seats[seat].name : g.spectatorNames[connId] || "Spectator";
  g.chat.push({
    id: ++g.chatSeq,
    name,
    seat,
    team: seat !== null ? teamOfSeat(seat) : null,
    text,
    ts: Date.now(),
  });
  if (g.chat.length > 100) g.chat.splice(0, g.chat.length - 100);
}

/** Set the series target (points to win) — lobby only. */
export function setTarget(g: GameState, target: number) {
  if (g.phase !== "lobby") throw new GameError("You can only set the target in the lobby.");
  if (!Number.isFinite(target)) throw new GameError("Invalid target.");
  g.targetScore = Math.max(1, Math.min(50, Math.round(target)));
}

/** Move to another seat in the lobby. If the seat is taken, swap the two players. */
export function takeSeat(g: GameState, connId: string, seat: number) {
  if (g.phase !== "lobby") throw new GameError("You can only change seats in the lobby.");
  if (seat < 0 || seat > 3) throw new GameError("Invalid seat.");
  const cur = seatOfConn(g, connId);
  if (cur === null) {
    // A spectator claiming a free seat in the lobby.
    if (g.seats[seat].connId !== null) throw new GameError("That seat is taken.");
    g.seats[seat] = {
      connId,
      name: g.spectatorNames[connId] || "Player",
      connected: true,
    };
    delete g.spectatorNames[connId];
    return;
  }
  if (cur === seat) return;
  const tmp = g.seats[seat];
  g.seats[seat] = g.seats[cur];
  g.seats[cur] = tmp; // if the target was empty this just moves; otherwise it swaps
}

export function disconnect(g: GameState, connId: string) {
  delete g.spectatorNames[connId];
  const seat = seatOfConn(g, connId);
  if (seat === null) return;
  g.seats[seat].connected = false;
  g.seats[seat].connId = null;
  // In the lobby, free the seat entirely so someone else can take it.
  if (g.phase === "lobby") g.seats[seat] = emptySeat();
}

const seatedCount = (g: GameState) => g.seats.filter((s) => s.connId !== null).length;

// ---------------------------------------------------------------------------
//  Start / rounds
// ---------------------------------------------------------------------------

export function startGame(g: GameState, connId: string) {
  if (g.phase !== "lobby") throw new GameError("Game already started.");
  if (g.hostConnId !== connId) throw new GameError("Only the host can start the game.");
  if (seatedCount(g) < 4) throw new GameError("Need 4 players to start.");

  g.round = 1;

  // First round only: draw one card each to decide the first caller.
  let caller = 0;
  let reveal: { seat: number; card: Card }[] = [];
  // Reshuffle until there's a unique highest card (no tie for top rank).
  for (;;) {
    const d = shuffle(makeDeck());
    reveal = [0, 1, 2, 3].map((seat) => ({ seat, card: d.pop()! }));
    const top = Math.max(...reveal.map((r) => r.card.rank));
    const winners = reveal.filter((r) => r.card.rank === top);
    if (winners.length === 1) {
      caller = winners[0].seat;
      break;
    }
  }
  g.drawReveal = reveal;
  g.callerSeat = caller;

  beginAuction(g);
}

export function nextRound(g: GameState) {
  if (g.phase !== "roundOver") throw new GameError("Round is not over.");
  g.round += 1;
  g.drawReveal = null; // draw only mattered for round 1
  beginAuction(g);
}

function beginAuction(g: GameState) {
  const deck = shuffle(makeDeck());
  g.hands = [[], [], [], []];
  // Deal the first 5 cards to each player for the auction.
  for (let n = 0; n < 5; n++) {
    for (let seat = 0; seat < 4; seat++) g.hands[seat].push(deck.pop()!);
  }
  g.deck = deck; // remaining 32 cards, dealt after the contract is set

  g.phase = "auction";
  g.auctionTurnSeat = g.callerSeat;
  g.currentBid = null;
  g.auctionActions = [null, null, null, null];
  g.auctionTurnsTaken = 0;
  g.auctionLog = [];
  g.trump = null;
  g.contract = null;
  g.contractTeam = null;
  g.contractSeat = null;
  g.turnDeadline = null;
  g.turnSeat = null;
  g.leadSeat = null;
  g.trickNumber = 0;
  g.currentTrick = [];
  g.trickResults = [];
  g.lastTrick = null;
  g.roundResult = null;

  for (let seat = 0; seat < 4; seat++) sortHand(g.hands[seat]);
}

// ---------------------------------------------------------------------------
//  Auction
// ---------------------------------------------------------------------------

export function bid(g: GameState, seat: number, count: 7 | 10 | 13, suit: Suit) {
  if (g.phase !== "auction") throw new GameError("Not bidding right now.");
  if (g.auctionTurnSeat !== seat) throw new GameError("Not your turn to bid.");
  if (![7, 10, 13].includes(count)) throw new GameError("Bid must be 7, 10 or 13.");
  if (g.currentBid && count <= g.currentBid.count)
    throw new GameError("Your bid must be higher than the current bid.");

  g.currentBid = { seat, count, suit };
  g.auctionActions[seat] = { count, suit };
  g.auctionTurnsTaken += 1;
  g.auctionLog.push(`${g.seats[seat].name} bid ${count} on ${suit}`);

  // 13 is the top call — nobody can beat it, so the auction ends at once.
  // Otherwise the auction ends once every player has had their single turn.
  if (count === 13 || g.auctionTurnsTaken >= 4) {
    finalizeContract(g);
    return;
  }
  advanceAuction(g);
}

export function pass(g: GameState, seat: number) {
  if (g.phase !== "auction") throw new GameError("Not bidding right now.");
  if (g.auctionTurnSeat !== seat) throw new GameError("Not your turn.");
  if (!g.currentBid && seat === g.callerSeat)
    throw new GameError("As the caller you must open the bidding.");

  g.auctionActions[seat] = "pass";
  g.auctionTurnsTaken += 1;
  g.auctionLog.push(`${g.seats[seat].name} passed`);

  // Each player gets exactly one chance; the auction ends after the last one.
  if (g.auctionTurnsTaken >= 4) {
    finalizeContract(g);
    return;
  }
  advanceAuction(g);
}

// Play rotates anti-clockwise: the next seat is (seat + 3) % 4.
const nextSeat = (seat: number) => (seat + 3) % 4;

function advanceAuction(g: GameState) {
  g.auctionTurnSeat = nextSeat(g.auctionTurnSeat!);
}

function finalizeContract(g: GameState) {
  const b = g.currentBid!;
  g.trump = b.suit;
  g.contract = b.count;
  g.contractTeam = teamOfSeat(b.seat);
  g.contractSeat = b.seat;

  // Deal the remaining cards so everyone holds 13.
  while (g.deck.length > 0) {
    for (let seat = 0; seat < 4; seat++) {
      if (g.deck.length === 0) break;
      g.hands[seat].push(g.deck.pop()!);
    }
  }
  for (let seat = 0; seat < 4; seat++) sortHand(g.hands[seat]);

  g.phase = "playing";
  g.trickNumber = 1;
  g.leadSeat = b.seat; // auction winner leads the first trick
  g.turnSeat = b.seat;
  g.currentTrick = [];
  g.auctionTurnSeat = null;
}

// ---------------------------------------------------------------------------
//  Trick play
// ---------------------------------------------------------------------------

export function legalCards(g: GameState, seat: number): Card[] {
  const hand = g.hands[seat];
  if (g.currentTrick.length === 0) return [...hand];
  const leadSuit = g.currentTrick[0].card.suit;
  const inSuit = hand.filter((c) => c.suit === leadSuit);
  return inSuit.length > 0 ? inSuit : [...hand];
}

export function playCard(g: GameState, seat: number, card: Card) {
  if (g.phase !== "playing") throw new GameError("Not in play.");
  if (g.turnSeat !== seat) throw new GameError("Not your turn.");

  const hand = g.hands[seat];
  const idx = hand.findIndex((c) => cardEq(c, card));
  if (idx === -1) throw new GameError("You don't have that card.");

  const legal = legalCards(g, seat);
  if (!legal.some((c) => cardEq(c, card)))
    throw new GameError("You must follow the led suit.");

  hand.splice(idx, 1);
  g.currentTrick.push({ seat, card });

  if (g.currentTrick.length === 4) {
    // Trick complete: record it, but pause (turnSeat = null). The server waits
    // ~1s so everyone sees all four cards, then calls advanceTrick().
    completeTrick(g);
  } else {
    g.turnSeat = nextSeat(seat);
  }
}

function beats(a: Card, best: Card, trump: Suit | null, leadSuit: Suit): boolean {
  const aT = a.suit === trump;
  const bT = best.suit === trump;
  if (aT !== bT) return aT; // a trump beats a non-trump
  if (aT && bT) return a.rank > best.rank;
  const aL = a.suit === leadSuit;
  const bL = best.suit === leadSuit;
  if (aL !== bL) return aL; // led suit beats an off-suit discard
  if (aL && bL) return a.rank > best.rank;
  return false; // both off-suit discards: cannot beat the standing best
}

// Rule: an Ace played in TWO consecutive tricks by the SAME player is "dead" —
// but only when that player was made SENIOR by the first Ace, i.e. they WON
// the previous trick with it. If someone else won the previous trick (you
// weren't senior), your Ace last time doesn't taint this one — it's fully live.
function isDeadAce(g: GameState, play: PlayedCard): boolean {
  if (play.card.rank !== ACE) return false;
  const prev = g.trickResults[g.trickResults.length - 1];
  return !!prev && prev.winnerSeat === play.seat && prev.wonByAce;
}

function completeTrick(g: GameState) {
  const trump = g.trump;
  const leadSuit = g.currentTrick[0].card.suit;

  // Dead aces are removed from contention (they're the weakest cards). If every
  // card in the trick is a dead ace, fall back to the whole trick so someone wins.
  const contenders = g.currentTrick.filter((p) => !isDeadAce(g, p));
  const pool = contenders.length > 0 ? contenders : g.currentTrick;
  let best = pool[0];
  for (const play of pool.slice(1)) {
    if (beats(play.card, best.card, trump, leadSuit)) best = play;
  }

  const result: TrickResult = {
    trickNumber: g.trickNumber,
    winnerSeat: best.seat,
    winnerTeam: teamOfSeat(best.seat),
    wonByAce: best.card.rank === ACE,
    wasted: isWastedTrick(g.trickNumber),
  };
  g.trickResults.push(result);
  g.lastTrick = { plays: [...g.currentTrick], winnerSeat: best.seat };
  g.currentTrick = [];
  g.turnSeat = null; // pause until advanceTrick()
}

/** Called by the server after the ~1s pause: start the next trick or end the round. */
export function advanceTrick(g: GameState) {
  if (g.phase !== "playing" || g.turnSeat !== null) return;
  const winner = g.lastTrick ? g.lastTrick.winnerSeat : g.leadSeat ?? 0;
  if (g.trickNumber >= 13) {
    endRound(g);
    return;
  }
  g.trickNumber += 1;
  g.leadSeat = winner;
  g.turnSeat = winner; // trick winner leads next (the "crown")
}

function endRound(g: GameState) {
  const outcome = decideRound(g.trickResults, g.contract!, g.contractTeam!);
  g.matchScore[outcome.winnerTeam] += outcome.points;
  g.roundResult = {
    winnerTeam: outcome.winnerTeam,
    contractTeam: g.contractTeam!,
    contract: g.contract!,
    credited: outcome.credited,
    contractMade: outcome.contractMade,
    sweep: outcome.sweep,
    kind: outcome.kind,
    points: outcome.points,
  };

  // Winner of the round calls Ruung next: pick the winning-team member who
  // took the most tricks this round (ties -> lower seat).
  const winTeam = outcome.winnerTeam;
  const seatsOfTeam = [0, 1, 2, 3].filter((s) => teamOfSeat(s) === winTeam);
  const tricksBySeat = (seat: number) =>
    g.trickResults.filter((t) => t.winnerSeat === seat).length;
  seatsOfTeam.sort((a, b) => tricksBySeat(b) - tricksBySeat(a) || a - b);
  g.callerSeat = seatsOfTeam[0];

  g.turnSeat = null;

  // Series over?
  if (g.matchScore[winTeam] >= g.targetScore) {
    g.seriesWinner = winTeam;
    g.phase = "gameOver";
  } else {
    g.phase = "roundOver";
  }
}

/** Start a fresh series after one ends; the series winner calls first. */
export function newSeries(g: GameState) {
  if (g.phase !== "gameOver") throw new GameError("The series is not over.");
  g.matchScore = [0, 0];
  g.seriesWinner = null;
  g.round = 1;
  g.drawReveal = null; // series winner already holds the call, no draw needed
  beginAuction(g);
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const SUIT_ORDER: Record<Suit, number> = { S: 0, H: 1, C: 2, D: 3 };

function sortHand(hand: Card[]) {
  hand.sort((a, b) => SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit] || b.rank - a.rank);
}

// ---------------------------------------------------------------------------
//  Auto-move (played by the server when a player's turn clock runs out)
// ---------------------------------------------------------------------------

/** The weakest legal card to play: lowest rank, keeping trumps back if possible. */
export function worstCard(g: GameState, seat: number): Card {
  const legal = legalCards(g, seat);
  const trump = g.trump;
  return [...legal].sort((a, b) => {
    const at = a.suit === trump ? 1 : 0;
    const bt = b.suit === trump ? 1 : 0;
    if (at !== bt) return at - bt; // prefer non-trump (don't waste a trump)
    return a.rank - b.rank; // then the lowest card
  })[0];
}

const longestSuit = (hand: Card[]): Suit => {
  const count: Record<Suit, number> = { H: 0, D: 0, C: 0, S: 0 };
  for (const c of hand) count[c.suit] += 1;
  return (["S", "H", "C", "D"] as Suit[]).sort((a, b) => count[b] - count[a])[0];
};

/**
 * Make the automatic move for a seat whose clock expired. In play it dumps the
 * weakest card; in the auction it passes, unless it's the caller who still has
 * to open — then it makes the smallest possible call (7) on their longest suit.
 */
export function autoMove(g: GameState, seat: number) {
  if (g.phase === "playing" && g.turnSeat === seat) {
    playCard(g, seat, worstCard(g, seat));
    return;
  }
  if (g.phase === "auction" && g.auctionTurnSeat === seat) {
    if (!g.currentBid && seat === g.callerSeat) {
      bid(g, seat, 7, longestSuit(g.hands[seat]));
    } else {
      pass(g, seat);
    }
  }
}

// ---------------------------------------------------------------------------
//  Build the per-player view (hides other hands)
// ---------------------------------------------------------------------------

export function viewFor(g: GameState, connId: string): ClientView {
  const youSeat = seatOfConn(g, connId);
  const hostSeatIdx = g.seats.findIndex((s) => s.connId !== null && s.connId === g.hostConnId);

  const view: ClientView = {
    phase: g.phase,
    roomId: g.roomId,
    round: g.round,
    youSeat,
    isHost: g.hostConnId === connId,
    hostSeat: hostSeatIdx === -1 ? null : hostSeatIdx,
    players: g.seats.map((s, seat) => ({
      seat,
      name: s.name,
      connected: s.connected,
      handCount: g.hands[seat].length,
    })),
    spectators: Object.values(g.spectatorNames).filter(Boolean),
    chat: g.chat,
    drawReveal: g.drawReveal ?? undefined,
    hand: youSeat !== null ? g.hands[youSeat] : [],
    // Spectators watch with everything face-up; seated players never see other hands.
    allHands: youSeat === null ? g.hands.map((h) => [...h]) : undefined,
    callerSeat: g.callerSeat,
    auctionTurnSeat: g.auctionTurnSeat,
    currentBid: g.currentBid,
    auctionActions: g.auctionActions,
    auctionLog: g.auctionLog,
    trump: g.trump,
    contract: g.contract,
    contractTeam: g.contractTeam,
    contractSeat: g.contractSeat,
    turnMsLeft: g.turnDeadline ? Math.max(0, g.turnDeadline - Date.now()) : null,
    turnSeat: g.turnSeat,
    leadSeat: g.leadSeat,
    trickNumber: g.trickNumber,
    currentTrick: g.currentTrick,
    lastTrick: g.lastTrick,
    trickResults: g.trickResults,
    score: computeScore(g.trickResults),
    matchScore: g.matchScore,
    targetScore: g.targetScore,
    seriesWinner: g.seriesWinner ?? undefined,
    roundResult: g.roundResult ?? undefined,
  };

  if (g.phase === "playing" && youSeat !== null && g.turnSeat === youSeat) {
    view.legalCards = legalCards(g, youSeat);
  }

  return view;
}
