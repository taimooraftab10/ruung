import { RoundKind, ScoreState, Team, TrickResult } from "./types";

/**
 * ============================================================================
 *  RUUNG SCORING ENGINE  (custom rules)
 * ============================================================================
 *
 * This is the ONE place the custom scoring lives. It is a pure function:
 * give it the ordered list of trick results, it returns the tally. If the
 * numbers ever differ from what you expect at the table, we only touch this
 * file.
 *
 * Rules encoded here (from our rules doc):
 *
 *  Rule 4 — Wasted rounds:
 *      Tricks 1, 2, 3 and 12 never score on their own.
 *
 *  Rule 5 — Seniority / "consecutive 2":
 *      Scoring begins from trick 4. When a team wins TWO CONSECUTIVE tricks
 *      (earliest = 4th & 5th), they become "senior". The FIRST such
 *      breakthrough retroactively credits that team with ALL tricks so far
 *      (e.g. breaking through on trick 5 => credited 5). After the first
 *      breakthrough, each further trick won while the streak continues adds 1.
 *      Losing a trick breaks the streak; the team must win 2-in-a-row again
 *      before crediting resumes (no second retroactive bonus).
 *
 *  Rule 6 — The Ace (wins the trick, but doesn't score):
 *      A trick physically won with an Ace keeps the streak ALIVE (seniority),
 *      but does NOT count as a scoring trick — EXCEPT on the final trick (13),
 *      where the Ace both wins and scores.
 *
 *  NOTE (open edge case, flagged with the user):
 *      When an Ace "bridges" a streak (e.g. win 4 with K, 5 with A, 6 with a
 *      normal card), we treat the bridging Ace trick as keeping the streak
 *      alive but not itself crediting; the next non-Ace scoring win in the
 *      streak credits normally. Adjust `isScoringWin` / streak handling below
 *      if the table plays it differently.
 */

const WASTED_TRICKS = new Set([1, 2, 3, 12]);

export const isWastedTrick = (trickNumber: number) => WASTED_TRICKS.has(trickNumber);

/** A trick that can contribute to the score (not wasted; Ace only on trick 13). */
export function isScoringWin(t: TrickResult): boolean {
  if (t.wasted) return false;
  if (t.wonByAce && t.trickNumber !== 13) return false; // Ace doesn't score (except last)
  return true;
}

export function emptyScore(): ScoreState {
  return {
    credited: [0, 0],
    brokenThrough: [false, false],
    seniorTeam: null,
    streakLen: 0,
  };
}

/** Recompute the whole score from the ordered trick results (deterministic). */
export function computeScore(results: TrickResult[]): ScoreState {
  const s = emptyScore();

  for (const t of results) {
    const team = t.winnerTeam;

    // ---- streak (seniority): Ace-won tricks DO keep the streak alive --------
    if (s.seniorTeam === team) {
      s.streakLen += 1;
    } else {
      s.seniorTeam = team;
      s.streakLen = 1;
    }

    // ---- crediting ---------------------------------------------------------
    if (s.streakLen >= 2 && isScoringWin(t)) {
      if (!s.brokenThrough[team]) {
        // First breakthrough: retroactively credit all tricks so far.
        s.credited[team] += t.trickNumber;
        s.brokenThrough[team] = true;
      } else {
        s.credited[team] += 1;
      }
    }
  }

  return s;
}

export interface RoundOutcome {
  winnerTeam: Team;
  contractMade: boolean;
  credited: [number, number];
  sweep: boolean; // the winning team took all 13 tricks
  kind: RoundKind;
  points: number; // points awarded to the winning team
}

/**
 * Decide the round winner and its point value once all 13 tricks are played.
 *
 * The contract team must reach `contract` credited tricks to make it; otherwise
 * the opposing team wins the round. Point values (custom rules):
 *   - Contract team wins, took all 13 tricks .......... "court"      → 2
 *   - Contract team wins, fewer than 13 .............. "normal"     → 1
 *   - Other team wins, took all 13 tricks ............ "goon-court" → 4
 *   - Other team wins, fewer than 13 ................. "normal"     → 1
 */
export function decideRound(
  results: TrickResult[],
  contract: number,
  contractTeam: Team,
): RoundOutcome {
  const score = computeScore(results);
  const contractMade = score.credited[contractTeam] >= contract;
  const winnerTeam: Team = contractMade
    ? contractTeam
    : ((contractTeam === 0 ? 1 : 0) as Team);

  const sweep =
    results.length === 13 && results.every((t) => t.winnerTeam === winnerTeam);

  let kind: RoundKind = "normal";
  let points = 1;
  if (winnerTeam === contractTeam) {
    if (sweep) {
      kind = "court";
      points = 2;
    }
  } else if (sweep) {
    kind = "goon-court";
    points = 4;
  }

  return { winnerTeam, contractMade, credited: score.credited, sweep, kind, points };
}
