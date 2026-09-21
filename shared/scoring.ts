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
 *  Rule 4 — Wasted rounds & trick 12:
 *      Tricks 1, 2, 3 are wasted: they never score on their own (they only get
 *      swept in by a later breakthrough). Trick 12 is NOT wasted — it keeps the
 *      streak alive and counts normally — BUT the first breakthrough ("win all
 *      the rounds below") cannot COMPLETE on trick 12. So winning 11 & 12 does
 *      not clinch; carrying the streak to trick 13 does.
 *
 *  Rule 5 — Seniority / "consecutive 2" as an ON-BOARD pile:
 *      Think of every played trick as sitting "on the board" until someone
 *      claims it. Seniority is PER PLAYER: the SAME player must win TWO
 *      CONSECUTIVE tricks (earliest = 4th & 5th, so the earliest trick a
 *      clinch can LAND on is the 5th) to CLINCH, which sweeps ALL
 *      tricks currently on the board to that player's team. (Partner winning
 *      the next trick resets the streak — must be the same person twice.)
 *      While the streak continues, each further win sweeps the one new trick.
 *      If the streak breaks with the board unclaimed, those tricks stay on the
 *      board until the next clinch — by either team — sweeps them.
 *
 *  Rule 6 — The Ace (wins the trick, but doesn't score):
 *      A trick physically won with an Ace keeps the streak ALIVE (seniority),
 *      but does NOT count as a scoring trick — EXCEPT on the final trick (13),
 *      where the Ace both wins and scores.
 *
 *  Rule 7 — The last trick sweeps the board:
 *      On trick 13 the consecutive-2 requirement is waived. Whoever wins the
 *      last trick (strongest card — trump beats all, else the Ace) sweeps every
 *      trick still ON THE BOARD. If 7 were already claimed, the last trick wins
 *      the remaining 6; if none were claimed, it wins all 13.
 *
 *  NOTE (open edge case, flagged with the user):
 *      When an Ace "bridges" a streak (e.g. win 4 with K, 5 with A, 6 with a
 *      normal card), we treat the bridging Ace trick as keeping the streak
 *      alive but not itself crediting; the next non-Ace scoring win in the
 *      streak credits normally. Adjust `isScoringWin` / streak handling below
 *      if the table plays it differently.
 */

const WASTED_TRICKS = new Set([1, 2, 3]);

export const isWastedTrick = (trickNumber: number) => WASTED_TRICKS.has(trickNumber);

// The first breakthrough (retroactively "winning all the rounds below") may not
// complete on trick 12, though the streak still carries through it to trick 13.
export const NO_CLINCH_TRICK = 12;

// The earliest trick a clinch can land on. Tricks 1-3 are wasted, so the first
// pair of consecutive wins that can break through is 4 & 5 — landing on 5.
// Without this, winning the wasted trick 3 plus trick 4 would clinch on 4,
// because wasted tricks still build the seniority streak.
export const FIRST_CLINCH_TRICK = 5;

/** A trick that can contribute to the score (not wasted; Ace only on trick 13). */
export function isScoringWin(t: TrickResult): boolean {
  if (t.wasted) return false;
  if (t.wonByAce && t.trickNumber !== 13) return false; // Ace doesn't score (except last)
  return true;
}

export function emptyScore(): ScoreState {
  return {
    credited: [0, 0],
    claimed: 0,
    seniorSeat: null,
    streakLen: 0,
  };
}

/** Recompute the whole score from the ordered trick results (deterministic). */
export function computeScore(results: TrickResult[]): ScoreState {
  const s = emptyScore();

  for (const t of results) {
    const team = t.winnerTeam;

    // ---- streak (seniority) is PER PLAYER: the same seat must win in a row.
    // Ace-won tricks by that same player DO keep the streak alive; a partner
    // winning instead resets it to that partner (length 1).
    if (s.seniorSeat === t.winnerSeat) {
      s.streakLen += 1;
    } else {
      s.seniorSeat = t.winnerSeat;
      s.streakLen = 1;
    }

    // ---- can this trick CLINCH (sweep the board)? --------------------------
    let canClinch: boolean;
    if (t.trickNumber === 13) {
      canClinch = s.streakLen >= 1; // last trick: just winning it sweeps the board
    } else if (t.trickNumber === NO_CLINCH_TRICK) {
      canClinch = false; // trick 12 never clinches (streak still carries on)
    } else {
      // 2-in-a-row; Ace/wasted don't clinch; and never before trick 5.
      canClinch =
        t.trickNumber >= FIRST_CLINCH_TRICK && s.streakLen >= 2 && isScoringWin(t);
    }

    // ---- sweep everything still on the board to the winner's team ----------
    if (canClinch) {
      const gain = t.trickNumber - s.claimed; // tricks played but not yet claimed
      if (gain > 0) {
        s.credited[team] += gain;
        s.claimed = t.trickNumber;
      }
      // A clinch consumes the streak: to win more you must earn a NEW 2-in-a-row.
      // (Winning 6 & 7 sweeps the board; winning 8 next does NOT — you need 8 & 9.)
      s.streakLen = 0;
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
 *   - Contract team wins ALL 13 rounds ............... "court"      → 2
 *   - Other team wins ALL 13 rounds .................. "goon-court" → 4
 *   - Any other winning margin ....................... "normal"     → 1
 *
 * "All 13 rounds" means credited === 13 (the winning team claimed every round),
 * not merely taking every physical trick.
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

  const allThirteen = score.credited[winnerTeam] === 13;

  let kind: RoundKind = "normal";
  let points = 1;
  if (allThirteen) {
    if (winnerTeam === contractTeam) {
      kind = "court";
      points = 2;
    } else {
      kind = "goon-court";
      points = 4;
    }
  }

  return { winnerTeam, contractMade, credited: score.credited, sweep: allThirteen, kind, points };
}
