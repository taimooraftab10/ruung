// ---- Core card types -------------------------------------------------------

export type Suit = "H" | "D" | "C" | "S"; // Hearts, Diamonds, Clubs, Spades

// rank: 2..14, where 11=J, 12=Q, 13=K, 14=A (Ace is highest)
export type Rank = number;

export interface Card {
  suit: Suit;
  rank: Rank;
}

export const SUITS: Suit[] = ["H", "D", "C", "S"];
export const ACE = 14;

export type Team = 0 | 1; // team 0 = seats 0 & 2, team 1 = seats 1 & 3
export const teamOfSeat = (seat: number): Team => (seat % 2) as Team;

// A round's result kind and the points it is worth.
export type RoundKind = "normal" | "court" | "goon-court";

// ---- Game phases -----------------------------------------------------------

export type Phase =
  | "lobby" // waiting for 4 players
  | "draw" // (first round only) each player drew one card, deciding first caller
  | "auction" // bidding for the contract + trump (Ruung)
  | "playing" // 13 tricks
  | "roundOver" // round finished, showing result
  | "gameOver"; // (not currently used; play continues indefinitely)

export interface Bid {
  seat: number;
  count: 7 | 10 | 13;
  suit: Suit;
}

// Per-seat action during the (single-lap) auction.
export type SeatAuction = { count: 7 | 10 | 13; suit: Suit } | "pass" | null;

export interface PlayedCard {
  seat: number;
  card: Card;
}

export interface TrickResult {
  trickNumber: number; // 1..13
  winnerSeat: number;
  winnerTeam: Team;
  wonByAce: boolean; // winning card was an Ace
  wasted: boolean; // tricks 1,2,3,12 do not score
}

export interface PlayerPublic {
  seat: number;
  name: string;
  connected: boolean;
  handCount: number; // number of cards still in hand (public)
}

// ---- Chat ------------------------------------------------------------------

export interface ChatMessage {
  id: number;
  name: string;
  seat: number | null; // null = spectator
  team: Team | null; // team colour for seated players
  text: string;
  ts: number;
}

// ---- Scoring snapshot (recomputed each trick) ------------------------------

export interface ScoreState {
  credited: [number, number]; // tricks claimed per team
  claimed: number; // total tricks claimed by either team so far (rest are "on the board")
  seniorSeat: number | null; // the PLAYER currently on a consecutive-win streak
  streakLen: number; // current consecutive-trick streak length (same player)
}

// ---- What a single client sees (its own hand + public state) ---------------

export interface ClientView {
  phase: Phase;
  roomId: string;
  round: number;
  youSeat: number | null; // null if you are a spectator / not seated
  isHost: boolean; // true if YOU are the host (created the room; only you can start it)
  hostSeat: number | null; // which seat the host currently occupies (for everyone to see)
  players: PlayerPublic[];
  spectators: string[]; // names of connected, unseated watchers
  chat: ChatMessage[];

  // draw phase
  drawReveal?: { seat: number; card: Card }[];

  // your private hand
  hand: Card[];
  // spectators see EVERY hand (by seat); undefined for seated players
  allHands?: Card[][];

  // auction
  callerSeat: number | null;
  auctionTurnSeat: number | null;
  currentBid: Bid | null;
  auctionActions: SeatAuction[]; // by seat: their one bid, "pass", or null (not yet)
  auctionLog: string[];

  // contract
  trump: Suit | null;
  contract: number | null;
  contractTeam: Team | null;
  contractSeat: number | null; // the player who won the auction (called Ruung)

  // play
  turnSeat: number | null;
  leadSeat: number | null;
  trickNumber: number; // 1..13 (0 before play)
  currentTrick: PlayedCard[];
  lastTrick: { plays: PlayedCard[]; winnerSeat: number } | null;
  trickResults: TrickResult[];

  // per-turn countdown clock (ms remaining for the active player to act; the
  // server auto-plays the weakest move / auto-passes when it hits zero).
  turnMsLeft?: number | null;

  // scoring
  score: ScoreState;

  // running match score (points in the current series)
  matchScore: [number, number];
  targetScore: number; // points needed to win the series
  seriesWinner?: Team; // set when phase === "gameOver"

  // round result
  roundResult?: {
    winnerTeam: Team;
    contractTeam: Team;
    contract: number;
    credited: [number, number];
    contractMade: boolean;
    sweep: boolean; // winner took all 13 tricks
    kind: RoundKind;
    points: number; // points this round awarded to winnerTeam
  };

  // legal moves for you right now (client convenience)
  legalCards?: Card[];
}

// ---- Messages: client -> server -------------------------------------------

export type ClientMessage =
  | { type: "join"; name: string }
  | { type: "takeSeat"; seat: number }
  | { type: "setTarget"; target: number }
  | { type: "startGame" }
  | { type: "bid"; count: 7 | 10 | 13; suit: Suit }
  | { type: "pass" }
  | { type: "playCard"; card: Card }
  | { type: "nextRound" }
  | { type: "newSeries" }
  | { type: "chat"; text: string };

// ---- Messages: server -> client -------------------------------------------

export type ServerMessage =
  | { type: "view"; view: ClientView }
  | { type: "error"; message: string }
  | { type: "roomClosed"; message: string };
