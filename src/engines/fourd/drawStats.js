// drawStats — descriptive statistics and fairness tests over the historical
// draw database. Descriptive, never predictive: nothing here changes the odds
// of the next draw, and every function says so where it matters.
//
// Sweep-day draws (results derived from Singapore Sweep prize endings) are
// excluded from all statistics by default — flagged `isSweepDay: true` in the
// schema.

import { NUMBERS_PER_DRAW, NUMBER_SPACE } from './constants.js';

const POSITIONS = ['1st', '2nd', '3rd', 'starter', 'consolation'];

// All 23 numbers of a draw as an array (zero-padded strings).
export function drawNumbers(draw) {
  return [
    draw['1st'], draw['2nd'], draw['3rd'],
    ...(draw.starter || []), ...(draw.consolation || []),
  ].map(n => String(n).padStart(4, '0'));
}

// Non-sweep draws, newest-first input expected but order-agnostic.
export function statsDraws(draws, { excludeSweep = true } = {}) {
  return excludeSweep ? draws.filter(d => !d.isSweepDay) : draws;
}

// Per-position digit frequency: counts[digit] per bucket across draws.
// Top-3 buckets count the 4 positional digits of that prize; starter and
// consolation aggregate all 10 numbers × 4 positions.
export function digitFrequencies(draws, { excludeSweep = true } = {}) {
  const rows = statsDraws(draws, { excludeSweep });
  const freq = { first: zeros(10), second: zeros(10), third: zeros(10),
    starter: zeros(10), consolation: zeros(10) };
  const add = (bucket, number) => {
    String(number).padStart(4, '0').split('').forEach(dig => freq[bucket][Number(dig)]++);
  };
  for (const d of rows) {
    add('first', d['1st']);
    add('second', d['2nd']);
    add('third', d['3rd']);
    for (const n of d.starter || []) add('starter', n);
    for (const n of d.consolation || []) add('consolation', n);
  }
  return freq;
}

function zeros(n) { return Array.from({ length: n }, () => 0); }

// Chi-square test per digit position (0..3) across ALL 23 numbers (clause
// 4.1(a): digits are drawn positionally, so positional uniformity is the
// right fairness question). Sweep days excluded by default.
// Returns [{ position, chi2, df: 9, p, verdict }].
export function chiSquareByPosition(draws, { excludeSweep = true } = {}) {
  const rows = statsDraws(draws, { excludeSweep });
  const counts = [zeros(10), zeros(10), zeros(10), zeros(10)];
  for (const d of rows) {
    for (const n of drawNumbers(d)) {
      String(n).padStart(4, '0').split('').forEach((dig, idx) => counts[idx][Number(dig)]++);
    }
  }
  return counts.map((obs, position) => {
    const total = obs.reduce((a, b) => a + b, 0);
    const expected = total / 10;
    const chi2 = expected > 0
      ? obs.reduce((sum, o) => sum + (o - expected) ** 2 / expected, 0)
      : 0;
    const p = chiSquareUpperTail(chi2, 9);
    return {
      position,
      drawsCounted: rows.length,
      digitCount: total,
      chi2,
      df: 9,
      p,
      verdict: verdictFor(p),
    };
  });
}

// Plain-language verdict: p >= 0.05 means "consistent with a fair draw".
export function verdictFor(p) {
  if (p >= 0.05) return 'consistent';
  if (p >= 0.01) return 'watch';
  return 'outlier';
}

// Upper-tail p-value of chi-square: Q(df/2, x/2) via the regularized upper
// incomplete gamma (continued fraction for the upper region, series for the
// lower — the standard Numerical Recipes split).
export function chiSquareUpperTail(x, df) {
  if (x <= 0) return 1;
  const a = df / 2;
  const xx = x / 2;
  if (xx < a + 1) return 1 - lowerGammaSeries(a, xx);
  return upperGammaCF(a, xx);
}

function lowerGammaSeries(a, x) {
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 1; n < 200; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function upperGammaCF(a, x) {
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 200; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

function logGamma(x) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp0 = x + 5.5;
  const tmp = tmp0 - (x + 0.5) * Math.log(tmp0);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

// ---------- archive context for the Next Draw card (descriptive only) ----------

// Times a number appeared in the archive vs expected (draws × 23/10000 on
// non-sweep days), the last-seen gap, and its perm/bet-type profile.
export function numberInsights(number, draws, { excludeSweep = true } = {}) {
  const n = String(number).padStart(4, '0');
  const rows = statsDraws(draws, { excludeSweep });
  // rows are newest-first per app convention.
  let lastSeenIndex = -1;
  let timesSeen = 0;
  let lastSeenDrawNo = null;
  let lastSeenTier = null;
  rows.forEach((d, idx) => {
    if (drawNumbers(d).includes(n)) {
      timesSeen++;
      if (lastSeenIndex === -1) {
        lastSeenIndex = idx;
        lastSeenDrawNo = d.drawNo;
        lastSeenTier = tierOf(d, n);
      }
    }
  });
  return {
    number: n,
    drawsAnalyzed: rows.length,
    timesSeen,
    expectedTimes: rows.length * NUMBERS_PER_DRAW / NUMBER_SPACE,
    lastSeenDrawNo,
    lastSeenGap: lastSeenIndex === -1 ? null : lastSeenIndex,
    permCount: permCountOf(n),
    betAdvice: betAdviceFor(n),
  };
}

const TIER_LABELS = { 1: 'first', 2: 'second', 3: 'third' };
function tierOf(draw, n) {
  if (n === String(draw['1st']).padStart(4, '0')) return 'first';
  if (n === String(draw['2nd']).padStart(4, '0')) return 'second';
  if (n === String(draw['3rd']).padStart(4, '0')) return 'third';
  if ((draw.starter || []).some(s => String(s).padStart(4, '0') === n)) return 'starter';
  return 'consolation';
}

function permCountOf(n) {
  const counts = {};
  for (const d of n) counts[d] = (counts[d] || 0) + 1;
  let divisor = 1;
  for (const c of Object.values(counts)) divisor *= factorialOf(c);
  return 24 / divisor;
}

function factorialOf(x) { let f = 1; for (let i = 2; i <= x; i++) f *= i; return f; }

// Honest, rule-based (not predictive) bet-type notes.
export function betAdviceFor(number) {
  const n = String(number).padStart(4, '0');
  if (/^(\d)\1{3}$/.test(n)) {
    return `${n} has a single permutation — iBet and System entries are not offered on it. Bet it Ordinary.`;
  }
  const perms = permCountOf(n);
  if (perms === 24) return `${n} has all four digits different — 24 permutations. An iBet covers all 24 for one stake's cost, at the same expected return per $1.`;
  if (perms === 12) return `${n} has one repeated pair — 12 permutations. iBet prices it in the 12-permutation group.`;
  if (perms === 6) return `${n} has two pairs — 6 permutations, the most favourable published iBet pricing.`;
  return `${n} has three of a kind — 4 permutations, iBet group 4.`;
}
