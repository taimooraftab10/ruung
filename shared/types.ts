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

// ---- Scoring snapshot (recomputed each trick) ------------------------------

export interface ScoreState {
  credited: [number, number]; // credited tricks per team
  brokenThrough: [boolean, boolean]; // has team had its first "consecutive 2" breakthrough
  seniorTeam: Team | null; // current streak owner
  streakLen: number; // current consecutive-trick streak length
}

// ---- What a single client sees (its own hand + public state) ---------------

export interface ClientView {
  phase: Phase;
  roomId: string;
  round: number;
  youSeat: number | null; // null if you are a spectator / not seated
  players: PlayerPublic[];

  // draw phase
  drawReveal?: { seat: number; card: Card }[];

  // your private hand
  hand: Card[];

  // auction
  callerSeat: number | null;
  auctionTurnSeat: number | null;
  currentBid: Bid | null;
  auctionLog: string[];

  // contract
  trump: Suit | null;
  contract: number | null;
  contractTeam: Team | null;

  // play
  turnSeat: number | null;
  leadSeat: number | null;
  trickNumber: number; // 1..13 (0 before play)
  currentTrick: PlayedCard[];
  lastTrick: { plays: PlayedCard[]; winnerSeat: number } | null;
  trickResults: TrickResult[];

  // scoring
  score: ScoreState;

  // running match score (rounds won)
  matchScore: [number, number];

  // round result
  roundResult?: {
    winnerTeam: Team;
    contractTeam: Team;
    contract: number;
    credited: [number, number];
    contractMade: boolean;
  };

  // legal moves for you right now (client convenience)
  legalCards?: Card[];
}

// ---- Messages: client -> server -------------------------------------------

export type ClientMessage =
  | { type: "join"; name: string }
  | { type: "startGame" }
  | { type: "bid"; count: 7 | 10 | 13; suit: Suit }
  | { type: "pass" }
  | { type: "playCard"; card: Card }
  | { type: "nextRound" };

// ---- Messages: server -> client -------------------------------------------

export type ServerMessage =
  | { type: "view"; view: ClientView }
  | { type: "error"; message: string };
