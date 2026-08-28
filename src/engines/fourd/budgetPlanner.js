// budgetPlanner — splits a per-draw budget across numbers × bet types under
// one of four objective modes. Every mode is honest: in a fixed-odds lottery
// no allocation changes the expected return per $1 (Big 65.9¢ / Small 58.0¢;
// every bet type lands within ±0.7% of those — whole-dollar rounding in the
// published tables). What the modes legitimately change is the SHAPE of the
// outcome distribution — how often you win something, and how big the swings
// are.

import { slipCost, portfolioStats, expectedValue, variance, ibetGroup, permCount, rollNumbers, permutationsOf } from './betMath.js';

export const MODES = {
  max_ev: {
    id: 'max_ev',
    label: 'Max expected value',
    blurb: 'Ranks entries by expected value per $1. In 4D every bet type lands within ±0.7% of the same EV (whole-dollar rounding in the published tables), so this mode mostly confirms parity — and steers the last dollars to the top of the ranking.',
  },
  max_hit: {
    id: 'max_hit',
    label: 'Max chance of any prize',
    blurb: 'Maximises P(≥1 prize) for the budget: cover as many DISTINCT numbers as possible — iBet entries cover their permutations cheaply; never spend two entries on the same number.',
  },
  min_variance: {
    id: 'min_variance',
    label: 'Min variance (smoother ride)',
    blurb: 'Prefers entries whose payouts are small-but-frequent (iBet on 24-permutation numbers) over longshot-style single-number Ordinary entries, trimming the swing of the outcome distribution.',
  },
  spread: {
    id: 'spread',
    label: 'Max spread',
    blurb: 'Evenly spreads the budget across the widest set of distinct numbers — same EV, broader coverage, softer dependence on any single draw.',
  },
};

// Candidate entries: [{ number, betType, pool, stake? }]. The planner never
// invents numbers — it allocates the given pool (user picks, or UI passes its
// generated set). `budget` is per draw, whole dollars.
export function plan({ budget, candidates, mode = 'max_hit' }) {
  const b = Math.max(0, Math.round(Number(budget)));
  const scored = candidates
    .map(c => ({ ...c, stake: 1, cost: slipCost({ ...c, stake: 1, drawDays: 1 }) }))
    .filter(c => c.cost !== null) // drops iBet on one-perm numbers (clause 2.5)
    .map(c => ({ ...c, score: scoreEntry(c, mode) }));

  // Rank: best first. Ties broken by cheaper cost, then number (deterministic).
  scored.sort((a, b2) => b2.score - a.score || a.cost - b2.cost
    || String(a.number).localeCompare(String(b2.number)));

  const allocation = [];
  let left = b;
  const seenNumbers = new Set();
  for (const c of scored) {
    if (left < c.cost) continue;
    // Never buy coverage you already have: P(any prize) is linear in DISTINCT
    // numbers, so a zero-fresh entry adds cost and nothing else. An Ordinary
    // entry covers exactly its one number; System/iBet cover their perms;
    // Roll covers its 10 positional numbers.
    const covered = c.betType === 'roll' ? rollNumbers(c.number, c.position ?? 0)
      : c.betType === 'ordinary' ? [String(c.number).padStart(4, '0')]
      : permutationsOf(c.number);
    if (covered.every(n => seenNumbers.has(n))) continue;
    covered.forEach(n => seenNumbers.add(n));
    // Carry `position` through: downstream consumers (portfolioStats coverage,
    // the UI label, testBench replay) all key off it — dropping it would replay
    // a position-3 roll as a position-0 roll and score the wrong 10 numbers.
    allocation.push({
      number: c.number, betType: c.betType, pool: c.pool, stake: 1, cost: c.cost,
      ...(c.betType === 'roll' ? { position: c.position ?? 0 } : {}),
    });
    left -= c.cost;
    if (left === 0) break;
  }

  const stats = portfolioStats(allocation);
  return {
    mode,
    budget: b,
    unspent: left,
    allocation,
    ...stats,
    note: MODES[mode].blurb,
    honestLine: 'Every mode has the same expected return per $1 — this only changes the shape of your outcomes, never the house edge.',
  };
}

function scoreEntry(entry, mode) {
  const group = entry.betType === 'ibet' ? ibetGroup(entry.number) : null;
  const ev = expectedValue(entry.betType === 'ibet' ? 'ibet' : 'ordinary', entry.pool, group);
  const perDollarCost = entry.cost; // stake 1, drawDays 1
  switch (mode) {
    case 'max_ev': {
      // EV per dollar spent; iBet group EVs vary by at most ±0.7% from
      // rounding in the published table.
      const evTotal = entry.betType === 'ibet' ? ev
        : ev * (entry.betType === 'system' ? permCount(entry.number)
          : entry.betType === 'roll' ? 10 : 1);
      return evTotal / perDollarCost;
    }
    case 'max_hit': {
      // Marginal P(≥1 prize) added per dollar: proportional to distinct
      // numbers covered (P is linear in k for small k·23/10000) ÷ cost.
      const k = entry.betType === 'ibet' ? group
        : entry.betType === 'system' ? permCount(entry.number)
        : entry.betType === 'roll' ? 10 : 1;
      return k / perDollarCost;
    }
    case 'min_variance': {
      // Reward smoothness PER DOLLAR. An entry's $1 units are independent, so
      // its total variance scales linearly with units (SD with √units); the
      // iBet variance is already whole-entry. Normalising SD by cost means a
      // $24 System ticket (SD ≈ 119, ≈ 4.96 per dollar) correctly outscores a
      // $1 Ordinary entry (SD 24.28 per dollar).
      const units = entry.betType === 'system' ? permCount(entry.number)
        : entry.betType === 'roll' ? 10 : 1;
      const sd = Math.sqrt(
        variance(entry.betType === 'ibet' ? 'ibet' : 'ordinary', entry.pool, group) * units);
      const evTotal = entry.betType === 'ibet' ? ev
        : ev * (entry.betType === 'system' ? permCount(entry.number)
          : entry.betType === 'roll' ? 10 : 1);
      const sdPerDollar = sd / perDollarCost;
      return evTotal / perDollarCost / (1 + sdPerDollar / 10);
    }
    case 'spread': {
      // Distinct numbers covered per dollar (like max_hit but indifferent to
      // duplicates and friendly to cheap coverage).
      const k = entry.betType === 'ibet' ? group
        : entry.betType === 'system' ? permCount(entry.number)
        : entry.betType === 'roll' ? 10 : 1;
      return k / perDollarCost;
    }
    default:
      return 0;
  }
}
