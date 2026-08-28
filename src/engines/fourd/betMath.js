// betMath — exact slip math for Singapore Pools 4D. History-free by design:
// every function answers "what does THIS slip cost, win, and risk", using only
// the official prize tables in constants.js. Historical data lives in
// drawStats/testBench; this module must never import it.

import { ORDINARY_PRIZES, IBET_PRIZES, NUMBERS_PER_DRAW, NUMBER_SPACE } from './constants.js';

// ---------- permutation structure ----------

// Digit multiset of a 4-digit string, e.g. "1231" -> {1: 2, 2: 1, 3: 1}.
function digitCounts(digits) {
  const counts = {};
  for (const d of digits) counts[d] = (counts[d] || 0) + 1;
  return counts;
}

// Number of distinct permutations of a 4-digit number: 24/12/6/4/1.
// 4! / (product of each repeated digit's factorial).
export function permCount(number) {
  const digits = String(number).padStart(4, '0').split('');
  const counts = digitCounts(digits);
  let divisor = 1;
  for (const c of Object.values(counts)) divisor *= factorial(c);
  return 24 / divisor;
}

function factorial(n) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

// Which iBet permutation group a number falls into (24/12/6/4), or null for
// one-permutation numbers (0000…9999): iBet/System are not offered on those
// (game rules clause 2.5).
export function ibetGroup(number) {
  const p = permCount(number);
  return p === 1 ? null : p;
}

// All distinct permutations of a 4-digit number, ascending (used for the
// System-entry breakdown and iBet explanations).
export function permutationsOf(number) {
  const digits = String(number).padStart(4, '0').split('');
  const seen = new Set();
  const build = (remaining, prefix) => {
    if (remaining.length === 0) {
      seen.add(prefix);
      return;
    }
    for (let i = 0; i < remaining.length; i++) {
      build(remaining.slice(0, i).concat(remaining.slice(i + 1)), prefix + remaining[i]);
    }
  };
  build(digits, '');
  return [...seen].sort();
}

// ---------- draw outcome (per draw, 23 distinct numbers) ----------

// Which prize tier (if any) a single number won in a draw. `draw` uses the
// app schema: { '1st', '2nd', '3rd', starter[10], consolation[10] } with
// zero-padded strings. Returns 'first'|'second'|'third'|'starter'|
// 'consolation'|null.
export function prizeTier(number, draw) {
  const n = String(number).padStart(4, '0');
  if (n === String(draw['1st']).padStart(4, '0')) return 'first';
  if (n === String(draw['2nd']).padStart(4, '0')) return 'second';
  if (n === String(draw['3rd']).padStart(4, '0')) return 'third';
  if ((draw.starter || []).some(s => String(s).padStart(4, '0') === n)) return 'starter';
  if ((draw.consolation || []).some(c => String(c).padStart(4, '0') === n)) return 'consolation';
  return null;
}

// All tiers a number's permutations won in a draw (for iBet/System payouts).
// Returns an array of tiers, one per distinct permutation that placed; a
// number cannot place twice in the same tier but its permutations can place
// across tiers.
export function tiersForNumber(number, draw) {
  return permutationsOf(number)
    .map(p => prizeTier(p, draw))
    .filter(t => t !== null);
}

// Total winnings of one number in one draw.
// - ordinary: the number itself, at the Ordinary table
// - system: every permutation, each at the Ordinary table
// - ibet: published iBet table for the number's perm group
export function payoutFor(number, draw, betType, stake, pool) {
  const s = Number(stake);
  if (betType === 'ordinary') return tierPayout(prizeTier(number, draw), pool, s);
  if (betType === 'system') {
    if (ibetGroup(number) === null) return 0; // clause 2.5: System not offered on one-perm numbers
    return permutationsOf(number)
      .reduce((sum, p) => sum + tierPayout(prizeTier(p, draw), pool, s), 0);
  }
  if (betType === 'ibet') {
    const group = ibetGroup(number);
    if (group === null) return 0; // iBet not offered on one-perm numbers
    const table = IBET_PRIZES[group][pool];
    return tiersForNumber(number, draw).reduce((sum, t) => sum + (table[t] || 0) * s, 0);
  }
  return 0;
}

function tierPayout(tier, pool, stake) {
  if (!tier) return 0;
  const table = ORDINARY_PRIZES[pool];
  return (table[tier] || 0) * stake;
}

// ---------- cost ----------

// Total cost of a slip. `drawDays` counts the draws the slip enters (System
// and Roll repeat the stake per draw; Ordinary/iBet stakes repeat per draw too).
export function slipCost({ betType, number, stake = 1, drawDays = 1 }) {
  const s = Number(stake);
  const days = Math.max(1, Math.round(drawDays));
  switch (betType) {
    case 'ordinary': return s * days;
    case 'system':
      if (ibetGroup(number) === null) return null; // clause 2.5: System not offered on one-perm numbers
      return permCount(number) * s * days;
    case 'ibet':
      if (ibetGroup(number) === null) return null; // not offered
      return s * days;
    case 'roll': return 10 * s * days; // 10 numbers at the chosen position
    default: return null;
  }
}

// The 10 concrete numbers a 4D Roll covers: any digit at `position` (0-3),
// the rest fixed.
export function rollNumbers(number, position) {
  const digits = String(number).padStart(4, '0').split('');
  const out = [];
  for (let d = 0; d <= 9; d++) {
    const copy = digits.slice();
    copy[position] = String(d);
    out.push(copy.join(''));
  }
  return out;
}

// ---------- exact per-draw probabilities (memoryless — same every draw) ----------

// Probability the exact number opens 1st / top-3 / any prize. These do not
// depend on history — draws are independent.
export function nextDrawProbabilities() {
  return {
    first: 1 / NUMBER_SPACE,
    top3: 3 / NUMBER_SPACE,
    anyBig: NUMBERS_PER_DRAW / NUMBER_SPACE,  // 23/10,000
    anySmall: 3 / NUMBER_SPACE,
  };
}

// P(a set of k DISTINCT numbers hits at least once among the 23 winning
// numbers, next draw). EXACT hypergeometric: the 23 winners are distinct, so
// P(miss) = C(10000-k, 23) / C(10000, 23), computed in log space.
// Verified anchors: k=10 -> 2.2800%, k=24 -> 5.3822%, k=100 -> 20.65%.
export function pAnyPrize(distinctCount, pool = 'big') {
  const k = Math.floor(Number(distinctCount));
  if (k <= 0) return 0;
  if (pool === 'small') {
    const winners = 3;
    return 1 - Math.exp(logChooseMiss(k, winners));
  }
  return 1 - Math.exp(logChooseMiss(k, NUMBERS_PER_DRAW));
}

// ln( C(N-k, w) / C(N, w) ) = sum_{i=0}^{w-1} ln((N-k-i)/(N-i))
function logChooseMiss(k, w) {
  let logP = 0;
  for (let i = 0; i < w; i++) logP += Math.log((NUMBER_SPACE - k - i) / (NUMBER_SPACE - i));
  return logP;
}

// ---------- expected value & variance (per $1, per draw) ----------

// EV per $1 staked. Ordinary/System/Roll share the Ordinary table (System
// just spreads $1-per-permutation; Roll is 10 Ordinary entries); iBet comes
// from the published table per perm group. Starter/Consolation table values
// are per winner — a Big draw has 10 of each, so they count ×10.
// Verified anchors: Big $0.659, Small $0.580, iBet-24 Big $0.6576.
export function expectedValue(betType, pool = 'big', permGroup = null) {
  if (betType === 'ibet') {
    const perms = permGroup || 24;
    const table = IBET_PRIZES[perms][pool];
    const sum = pool === 'big'
      ? table.first + table.second + table.third + 10 * table.starter + 10 * table.consolation
      : table.first + table.second + table.third;
    return (perms * sum) / NUMBER_SPACE;
  }
  const table = ORDINARY_PRIZES[pool];
  return pool === 'big'
    ? (table.first + table.second + table.third + 10 * table.starter + 10 * table.consolation) / NUMBER_SPACE
    : (table.first + table.second + table.third) / NUMBER_SPACE;
}

// Variance and SD of a single $1 entry's payout (per draw). Same ×10 rule
// for Starter/Consolation.
// Verified anchors: SD Big 24.28, Small 36.93, iBet-24 Big 4.87.
export function variance(betType, pool = 'big', permGroup = null) {
  if (betType === 'ibet') {
    const perms = permGroup || 24;
    const table = IBET_PRIZES[perms][pool];
    const ex2 = pool === 'big'
      ? perms * (table.first ** 2 + table.second ** 2 + table.third ** 2
        + 10 * table.starter ** 2 + 10 * table.consolation ** 2) / NUMBER_SPACE
      : perms * (table.first ** 2 + table.second ** 2 + table.third ** 2) / NUMBER_SPACE;
    const ev = expectedValue('ibet', pool, perms);
    return ex2 - ev * ev;
  }
  const table = ORDINARY_PRIZES[pool];
  const ex2 = pool === 'big'
    ? (table.first ** 2 + table.second ** 2 + table.third ** 2
       + 10 * table.starter ** 2 + 10 * table.consolation ** 2) / NUMBER_SPACE
    : (table.first ** 2 + table.second ** 2 + table.third ** 2) / NUMBER_SPACE;
  const ev = expectedValue('ordinary', pool);
  return ex2 - ev * ev;
}

export function standardDeviation(betType, pool = 'big', permGroup = null) {
  return Math.sqrt(variance(betType, pool, permGroup));
}

// ---------- portfolio summary ----------

// Aggregate stats for a list of entries: [{ betType, number, stake, pool }].
// P(any prize) uses the distinct-number union; EV/variance add per entry
// (entries are independent across positions within a draw).
export function portfolioStats(entries) {
  let ev = 0;
  let varianceSum = 0;
  let cost = 0;
  const numbers = new Set();
  for (const e of entries) {
    const stake = Number(e.stake);
    const group = e.betType === 'ibet' ? ibetGroup(e.number) : null;
    // Clause 2.5: iBet and System are not offered on one-permutation numbers
    // (0000–9999). slipCost returns null for such entries — they cannot be
    // placed, so they contribute zero cost, zero EV and no coverage (never
    // default the group to 24, which would grant a free bet).
    if ((e.betType === 'ibet' || e.betType === 'system')
      && ibetGroup(e.number) === null) continue;
    // How many $1 units of the reference table this entry contributes:
    // ordinary = 1, system = one per permutation, ibet = its group EV already
    // includes the permutations, roll = 10 Ordinary entries.
    const units = e.betType === 'system' ? permCount(e.number)
      : e.betType === 'roll' ? 10
      : 1;
    ev += expectedValue(e.betType === 'ibet' ? 'ibet' : 'ordinary', e.pool, group)
      * stake * (e.betType === 'ibet' ? 1 : units);
    varianceSum += variance(e.betType === 'ibet' ? 'ibet' : 'ordinary', e.pool, group)
      * stake * stake * units;
    cost += slipCost(e) ?? 0;
    // Distinct numbers the entry actually covers (drives P(any prize)):
    // ordinary covers its single number; system and iBet cover every
    // permutation; roll covers its 10 positional numbers.
    const covered = e.betType === 'roll' ? rollNumbers(e.number, e.position ?? 0)
      : e.betType === 'ordinary' ? [String(e.number).padStart(4, '0')]
      : permutationsOf(e.number);
    covered.forEach(n => numbers.add(n));
  }
  return {
    cost,
    ev,
    sd: Math.sqrt(varianceSum),
    pAnyPrize: pAnyPrize(numbers.size),
    distinctNumbers: numbers.size,
  };
}
