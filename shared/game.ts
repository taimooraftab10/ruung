import { makeDeck, shuffle, cardEq } from "./deck";
import { computeScore, decideRound, isWastedTrick } from "./scoring";
import {
  Bid,
  Card,
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

  // play
  turnSeat: number | null;
  leadSeat: number | null;
  trickNumber: number;
  currentTrick: PlayedCard[];
  trickResults: TrickResult[];
  lastTrick: { plays: PlayedCard[]; winnerSeat: number } | null;

  // results
  matchScore: [number, number];
  roundResult: ClientView["roundResult"] | null;
}

const emptySeat = (): SeatState => ({ connId: null, name: "", connected: false });

export function createGame(roomId: string): GameState {
  return {
    roomId,
    phase: "lobby",
    round: 0,
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
    turnSeat: null,
    leadSeat: null,
    trickNumber: 0,
    currentTrick: [],
    trickResults: [],
    lastTrick: null,
    matchScore: [0, 0],
    roundResult: null,
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
    return reclaim;
  }

  // Take the first free seat (only while in the lobby).
  if (g.phase === "lobby") {
    const free = g.seats.findIndex((s) => s.connId === null && s.name === "");
    if (free !== -1) {
      g.seats[free] = { connId, name, connected: true };
      return free;
    }
  }

  return null; // spectator / full
}

/** Move to another seat in the lobby. If the seat is taken, swap the two players. */
export function takeSeat(g: GameState, connId: string, seat: number) {
  if (g.phase !== "lobby") throw new GameError("You can only change seats in the lobby.");
  if (seat < 0 || seat > 3) throw new GameError("Invalid seat.");
  const cur = seatOfConn(g, connId);
  if (cur === null) throw new GameError("Join the game first.");
  if (cur === seat) return;
  const tmp = g.seats[seat];
  g.seats[seat] = g.seats[cur];
  g.seats[cur] = tmp; // if the target was empty this just moves; otherwise it swaps
}

export function disconnect(g: GameState, connId: string) {
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

export function startGame(g: GameState) {
  if (g.phase !== "lobby") throw new GameError("Game already started.");
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

function advanceAuction(g: GameState) {
  g.auctionTurnSeat = ((g.auctionTurnSeat! + 1) % 4) as number;
}

function finalizeContract(g: GameState) {
  const b = g.currentBid!;
  g.trump = b.suit;
  g.contract = b.count;
  g.contractTeam = teamOfSeat(b.seat);

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
    resolveTrick(g);
  } else {
    g.turnSeat = (seat + 1) % 4;
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

function resolveTrick(g: GameState) {
  const trump = g.trump;
  const leadSuit = g.currentTrick[0].card.suit;
  let best = g.currentTrick[0];
  for (const play of g.currentTrick.slice(1)) {
    if (beats(play.card, best.card, trump, leadSuit)) best = play;
  }

  const result: TrickResult = {
    trickNumber: g.trickNumber,
    winnerSeat: best.seat,
    winnerTeam: teamOfSeat(best.seat),
    wonByAce: best.card.rank === 14,
    wasted: isWastedTrick(g.trickNumber),
  };
  g.trickResults.push(result);
  g.lastTrick = { plays: [...g.currentTrick], winnerSeat: best.seat };
  g.currentTrick = [];

  if (g.trickNumber >= 13) {
    endRound(g);
    return;
  }

  g.trickNumber += 1;
  g.leadSeat = best.seat;
  g.turnSeat = best.seat;
}

function endRound(g: GameState) {
  const outcome = decideRound(g.trickResults, g.contract!, g.contractTeam!);
  g.matchScore[outcome.winnerTeam] += 1;
  g.roundResult = {
    winnerTeam: outcome.winnerTeam,
    contractTeam: g.contractTeam!,
    contract: g.contract!,
    credited: outcome.credited,
    contractMade: outcome.contractMade,
  };

  // Winner of the round calls Ruung next: pick the winning-team member who
  // took the most tricks this round (ties -> lower seat).
  const winTeam = outcome.winnerTeam;
  const seatsOfTeam = [0, 1, 2, 3].filter((s) => teamOfSeat(s) === winTeam);
  const tricksBySeat = (seat: number) =>
    g.trickResults.filter((t) => t.winnerSeat === seat).length;
  seatsOfTeam.sort((a, b) => tricksBySeat(b) - tricksBySeat(a) || a - b);
  g.callerSeat = seatsOfTeam[0];

  g.phase = "roundOver";
  g.turnSeat = null;
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const SUIT_ORDER: Record<Suit, number> = { S: 0, H: 1, C: 2, D: 3 };

function sortHand(hand: Card[]) {
  hand.sort((a, b) => SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit] || b.rank - a.rank);
}

// ---------------------------------------------------------------------------
//  Build the per-player view (hides other hands)
// ---------------------------------------------------------------------------

export function viewFor(g: GameState, connId: string): ClientView {
  const youSeat = seatOfConn(g, connId);

  const view: ClientView = {
    phase: g.phase,
    roomId: g.roomId,
    round: g.round,
    youSeat,
    players: g.seats.map((s, seat) => ({
      seat,
      name: s.name,
      connected: s.connected,
      handCount: g.hands[seat].length,
    })),
    drawReveal: g.drawReveal ?? undefined,
    hand: youSeat !== null ? g.hands[youSeat] : [],
    callerSeat: g.callerSeat,
    auctionTurnSeat: g.auctionTurnSeat,
    currentBid: g.currentBid,
    auctionActions: g.auctionActions,
    auctionLog: g.auctionLog,
    trump: g.trump,
    contract: g.contract,
    contractTeam: g.contractTeam,
    turnSeat: g.turnSeat,
    leadSeat: g.leadSeat,
    trickNumber: g.trickNumber,
    currentTrick: g.currentTrick,
    lastTrick: g.lastTrick,
    trickResults: g.trickResults,
    score: computeScore(g.trickResults),
    matchScore: g.matchScore,
    roundResult: g.roundResult ?? undefined,
  };

  if (g.phase === "playing" && youSeat !== null && g.turnSeat === youSeat) {
    view.legalCards = legalCards(g, youSeat);
  }

  return view;
}
