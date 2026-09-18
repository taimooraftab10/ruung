import { Card, Suit, SUITS } from "./types";

export function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank++) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

// Fisher-Yates shuffle (in place), returns the same array.
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export const cardEq = (a: Card, b: Card) => a.suit === b.suit && a.rank === b.rank;

const RANK_LABEL: Record<number, string> = {
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
};

export const rankLabel = (rank: number) => RANK_LABEL[rank] ?? String(rank);

export const SUIT_LABEL: Record<Suit, string> = {
  H: "♥", // ♥
  D: "♦", // ♦
  C: "♣", // ♣
  S: "♠", // ♠
};

export const SUIT_NAME: Record<Suit, string> = {
  H: "Hearts",
  D: "Diamonds",
  C: "Clubs",
  S: "Spades",
};

export const cardLabel = (c: Card) => `${rankLabel(c.rank)}${SUIT_LABEL[c.suit]}`;
