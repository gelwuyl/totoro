// Official Singapore Pools 4D prize tables, per $1 stake.
//
// SOURCES & PROVENANCE
// - ORDINARY_PRIZES: 4D Game Rules PDF (eff. 2025-01-01), clause 4.5. Fixed
//   per $1 since Nov 2015. Verified by two independent research passes
//   (2026-08-28) against the official PDF.
// - IBET_PRIZES: Singapore Pools' published iBet table. iBet prizes are NOT
//   exactly Ordinary÷perms — the published table rounds each cell its own way
//   (e.g. Big 6-perm 1st is $335 vs the exact $333.33; Small 12-perm 2nd is
//   $167 vs $166.67). Per the ratified decision the table is HARDCODED, never
//   derived. Cells marked [A] are doubly attested (ratified quality bar +
//   research EV/SD reconciliation); the remaining cells reproduce the
//   research-verified per-row EVs to 4 decimals (24p/12p/4p rows match
//   exactly), and should be re-pinned against the live published table during
//   the Phase D pipeline work.

export const ORDINARY_PRIZES = {
  big: { first: 2000, second: 1000, third: 490, starter: 250, consolation: 60 },
  small: { first: 3000, second: 2000, third: 800 },
};

export const IBET_PRIZES = {
  24: {
    big: { first: 83, second: 41, third: 20, starter: 10, consolation: 3 }, // 1st [A]
    small: { first: 125, second: 83, third: 33 },                            // 1st [A]
  },
  12: {
    big: { first: 166, second: 83, third: 40, starter: 21, consolation: 5 }, // 1st [A]
    small: { first: 250, second: 167, third: 66 },                           // 1st + 2nd [A]
  },
  6: {
    big: { first: 335, second: 168, third: 83, starter: 42, consolation: 10 }, // 1st [A]
    small: { first: 500, second: 335, third: 135 },                            // 1st [A]
  },
  4: {
    big: { first: 500, second: 250, third: 125, starter: 62, consolation: 15 }, // 1st [A]
    small: { first: 750, second: 500, third: 200 },                             // 1st [A]
  },
};

// Numbers per draw: 1st, 2nd, 3rd, 10 Starter, 10 Consolation — 23 distinct
// numbers on machine draws (Sweep-derived draws can repeat; excluded from
// stats by default).
export const NUMBERS_PER_DRAW = 23;
export const NUMBER_SPACE = 10000;

// Bet types.
export const BET_TYPES = ['ordinary', 'system', 'ibet', 'roll'];

// Pattern mix over the 10,000 numbers (research-verified): how many numbers
// have each permutation count.
export const PATTERN_MIX = { 24: 5040, 12: 4320, 6: 270, 4: 360, 1: 10 };

// Published minimum stake is $1; bets are in whole dollars per entry.
export const MIN_STAKE = 1;
