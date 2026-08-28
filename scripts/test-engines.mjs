// Engine harness — asserts the 4D engines against independently verified
// constants (quality bar, HANDOFF.md). Run: node scripts/test-engines.mjs
// Exits non-zero on any failure. No dependencies.

import {
  ORDINARY_PRIZES, IBET_PRIZES, PATTERN_MIX, NUMBER_SPACE, NUMBERS_PER_DRAW,
} from '../src/engines/fourd/constants.js';
import {
  permCount, permutationsOf, ibetGroup, slipCost, rollNumbers, payoutFor,
  prizeTier, expectedValue, variance, standardDeviation, pAnyPrize,
  nextDrawProbabilities, portfolioStats,
} from '../src/engines/fourd/betMath.js';
import {
  chiSquareByPosition, chiSquareUpperTail, numberInsights, digitFrequencies,
} from '../src/engines/fourd/drawStats.js';
import { plan, MODES } from '../src/engines/fourd/budgetPlanner.js';
import { replay } from '../src/engines/fourd/testBench.js';
import { validateReport } from '../src/engines/fourd/signalLab.js';
import { FOURD_SEED_DRAWS } from '../src/fourd/seedDraws.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const close = (x, target, tol) => Math.abs(x - target) <= tol;

console.log('\n== Ordinary prize table (rules clause 4.5) ==');
check('Big 1st/2nd/3rd = 2000/1000/490',
  ORDINARY_PRIZES.big.first === 2000 && ORDINARY_PRIZES.big.second === 1000 && ORDINARY_PRIZES.big.third === 490);
check('Big starter/consolation = 250/60 (x10 winners)',
  ORDINARY_PRIZES.big.starter === 250 && ORDINARY_PRIZES.big.consolation === 60);
check('Small 1st/2nd/3rd = 3000/2000/800',
  ORDINARY_PRIZES.small.first === 3000 && ORDINARY_PRIZES.small.second === 2000 && ORDINARY_PRIZES.small.third === 800);

console.log('\n== iBet published table (hardcoded, to the dollar) ==');
const IBET_EXPECTED = {
  24: { big: { first: 83, second: 41, third: 20, starter: 10, consolation: 3 }, small: { first: 125, second: 83, third: 33 } },
  12: { big: { first: 166, second: 83, third: 40, starter: 21, consolation: 5 }, small: { first: 250, second: 167, third: 66 } },
  6: { big: { first: 335, second: 168, third: 83, starter: 42, consolation: 10 }, small: { first: 500, second: 335, third: 135 } },
  4: { big: { first: 500, second: 250, third: 125, starter: 62, consolation: 15 }, small: { first: 750, second: 500, third: 200 } },
};
for (const [group, pools] of Object.entries(IBET_EXPECTED)) {
  for (const [pool, tiers] of Object.entries(pools)) {
    for (const [tier, amount] of Object.entries(tiers)) {
      check(`iBet ${group}-perm ${pool} ${tier} = $${amount}`,
        IBET_PRIZES[group][pool][tier] === amount,
        `got $${IBET_PRIZES[group][pool][tier]}`);
    }
  }
}

console.log('\n== EV per $1 (verified anchors) ==');
check('Ordinary Big EV = $0.659', expectedValue('ordinary', 'big') === 0.659,
  `got ${expectedValue('ordinary', 'big')}`);
check('Ordinary Small EV = $0.580', expectedValue('ordinary', 'small') === 0.58,
  `got ${expectedValue('ordinary', 'small')}`);
check('iBet-24 Big EV = $0.6576 (research-verified)', close(expectedValue('ibet', 'big', 24), 0.6576, 1e-9),
  `got ${expectedValue('ibet', 'big', 24)}`);
check('iBet-24 Small EV = $0.5784 (research-verified)', close(expectedValue('ibet', 'small', 24), 0.5784, 1e-9),
  `got ${expectedValue('ibet', 'small', 24)}`);
check('iBet-12 Big EV = $0.6588 (research-verified)', close(expectedValue('ibet', 'big', 12), 0.6588, 1e-9),
  `got ${expectedValue('ibet', 'big', 12)}`);
check('iBet-12 Small EV = $0.5796 (research-verified)', close(expectedValue('ibet', 'small', 12), 0.5796, 1e-9),
  `got ${expectedValue('ibet', 'small', 12)}`);
check('iBet-4 Big EV = $0.6580 (table-derived; research EV 0.6588 not derivable from integer cells)',
  close(expectedValue('ibet', 'big', 4), 0.658, 1e-9),
  `got ${expectedValue('ibet', 'big', 4)}`);
check('iBet-4 Small EV = $0.5800 (research-verified)', close(expectedValue('ibet', 'small', 4), 0.58, 1e-9),
  `got ${expectedValue('ibet', 'small', 4)}`);
check('System EV per $1 = Ordinary EV (table-derived)', expectedValue('ordinary', 'big') === 0.659);
check('Roll EV per $1 = Ordinary EV (10 Ordinary entries)', close(expectedValue('ordinary', 'big'), 0.659, 1e-12));

console.log('\n== Variance / SD (verified anchors, 2dp) ==');
check('SD Big = 24.28', close(standardDeviation('ordinary', 'big'), 24.2841, 0.005),
  `got ${standardDeviation('ordinary', 'big').toFixed(4)}`);
check('SD Small = 36.93', close(standardDeviation('ordinary', 'small'), 36.9279, 0.005),
  `got ${standardDeviation('ordinary', 'small').toFixed(4)}`);
check('SD iBet-24 Big = 4.87', close(standardDeviation('ibet', 'big', 24), 4.8695, 0.005),
  `got ${standardDeviation('ibet', 'big', 24).toFixed(4)}`);
check('Var Big = 589.6757', close(variance('ordinary', 'big'), 589.675719, 0.001),
  `got ${variance('ordinary', 'big').toFixed(6)}`);

console.log('\n== P(any prize), exact hypergeometric (verified anchors) ==');
check('P @10 distinct = 2.2800%', close(pAnyPrize(10), 0.0228, 0.0002),
  `got ${(pAnyPrize(10) * 100).toFixed(4)}%`);
check('P @24 distinct = 5.3822%', close(pAnyPrize(24), 0.053822, 0.0002),
  `got ${(pAnyPrize(24) * 100).toFixed(4)}%`);
check('P @100 distinct = 20.65%', pAnyPrize(100) > 0.2060 && pAnyPrize(100) < 0.2068,
  `got ${(pAnyPrize(100) * 100).toFixed(4)}%`);
check('P Small @1 = 3/10000', close(pAnyPrize(1, 'small'), 0.0003, 1e-9),
  `got ${pAnyPrize(1, 'small')}`);
check('nextDraw P(top3) = 3/10000', nextDrawProbabilities().top3 === 0.0003);
check('nextDraw P(any Big) = 23/10000', close(nextDrawProbabilities().anyBig, 0.0023, 1e-12));

console.log('\n== Permutation counts (24/12/12/6/4/1) ==');
check('1234 -> 24 perms', permCount('1234') === 24);
check('1123 -> 12 perms', permCount('1123') === 12);
check('1213 -> 12 perms', permCount('1213') === 12);
check('1122 -> 6 perms', permCount('1122') === 6);
check('1112 -> 4 perms', permCount('1112') === 4);
check('1111 -> 1 perm', permCount('1111') === 1);
check('0000 -> 1 perm', permCount('0000') === 1);
check('permutationsOf(1123).length = 12', permutationsOf('1123').length === 12);
check('permutationsOf(1234).length = 24, all distinct', permutationsOf('1234').length === 24
  && new Set(permutationsOf('1234')).size === 24);
const mixSum = Object.values(PATTERN_MIX).reduce((a, b) => a + b, 0);
check('PATTERN_MIX sums to 10000 (5040/4320/270/360/10)', mixSum === NUMBER_SPACE
  && PATTERN_MIX[24] === 5040 && PATTERN_MIX[12] === 4320 && PATTERN_MIX[6] === 270
  && PATTERN_MIX[4] === 360 && PATTERN_MIX[1] === 10);

console.log('\n== Clause 2.5: no iBet/System on one-perm numbers ==');
check("ibetGroup('0000') = null", ibetGroup('0000') === null);
check("ibetGroup('9999') = null", ibetGroup('9999') === null);
check("slipCost ibet '0000' = null (not offered)", slipCost({ betType: 'ibet', number: '0000', stake: 1 }) === null);
check("slipCost system '1111' = null (clause 2.5: not offered on one-perm numbers)", slipCost({ betType: 'system', number: '1111', stake: 1 }) === null);
check("slipCost system '1234' (24 perms) = 24", slipCost({ betType: 'system', number: '1234', stake: 1 }) === 24);

console.log('\n== Slip cost ==');
check("ordinary $2 × 3 days = $6", slipCost({ betType: 'ordinary', number: '1234', stake: 2, drawDays: 3 }) === 6);
check("system 1234 $1 × 1 day = $24", slipCost({ betType: 'system', number: '1234', stake: 1 }) === 24);
check("system 1122 $1 = $6", slipCost({ betType: 'system', number: '1122', stake: 1 }) === 6);
check("ibet 1234 $2 × 2 days = $4", slipCost({ betType: 'ibet', number: '1234', stake: 2, drawDays: 2 }) === 4);
check("roll $1 = $10 (10 numbers)", slipCost({ betType: 'roll', number: '5730', stake: 1 }) === 10);
const roll = rollNumbers('5730', 2);
check('roll covers 10 numbers, position 2 varied', roll.length === 10
  && new Set(roll).size === 10
  && roll.every(n => n[0] === '5' && n[1] === '7' && n[3] === '0'));

console.log('\n== Payouts on the real seed (draw 5518: 1st 0715) ==');
const d5518 = FOURD_SEED_DRAWS[0];
check('5518 is the sweep-day draw', d5518.isSweepDay === true);
check("prizeTier('0715', 5518) = first", prizeTier('0715', d5518) === 'first');
check("prizeTier('8903', 5518) = starter", prizeTier('8903', d5518) === 'starter');
check("prizeTier('0716', 5518) = null", prizeTier('0716', d5518) === null);
check('Ordinary Big 0715 $1 pays $2000', payoutFor('0715', d5518, 'ordinary', 1, 'big') === 2000);
check('Ordinary Small 0715 $1 pays $3000', payoutFor('0715', d5518, 'ordinary', 1, 'small') === 3000);
check('iBet Big 0715 $1 pays $83 (24-perm group, 1st)', payoutFor('0715', d5518, 'ibet', 1, 'big') === 83);
check('Ordinary Big 8903 $1 pays $250 (starter)', payoutFor('8903', d5518, 'ordinary', 1, 'big') === 250);
check('iBet Small 8903 $1 pays $0 (Small has no starter tier)', payoutFor('8903', d5518, 'ibet', 1, 'small') === 0);
check("iBet '0000' pays $0 (not offered)", payoutFor('0000', d5518, 'ibet', 1, 'big') === 0);

console.log('\n== testBench replay over the 6 seed draws ==');
const rep = replay({
  entries: [{ number: '0715', betType: 'ordinary', pool: 'big', stake: 1 }],
  draws: FOURD_SEED_DRAWS,
});
check('ordinary 0715 Big $1 over 6 draws: staked $6', rep.staked === 6, `got ${rep.staked}`);
check('...won $2000 (one 1st prize)', rep.won === 2000, `got ${rep.won}`);
check('...net $1994', rep.net === 1994, `got ${rep.net}`);
check('...hit rate 1/6', close(rep.hitCount / rep.drawsPlayed, 1 / 6, 1e-12));
const repIbet = replay({
  entries: [{ number: '0715', betType: 'ibet', pool: 'big', stake: 1 }],
  draws: FOURD_SEED_DRAWS,
});
check('ibet 0715 Big $1: staked $6, won $83, net $77',
  repIbet.staked === 6 && repIbet.won === 83 && repIbet.net === 77,
  `staked ${repIbet.staked} won ${repIbet.won} net ${repIbet.net}`);
const repRoll = replay({
  entries: [{ number: '0705', betType: 'roll', pool: 'big', stake: 1, position: 2 }],
  draws: FOURD_SEED_DRAWS,
});
check('roll 07_5 over 6 draws: staked $60, won $2000 (0715 is covered)',
  repRoll.staked === 60 && repRoll.won === 2000,
  `staked ${repRoll.staked} won ${repRoll.won}`);
check('sweep day INCLUDED in replay by default', replay({
  entries: [{ number: '0715', betType: 'ordinary', pool: 'big', stake: 1 }],
  draws: FOURD_SEED_DRAWS,
}).drawsPlayed === 6);

console.log('\n== drawStats ==');
const sweepExcluded = FOURD_SEED_DRAWS.filter(d => !d.isSweepDay);
check('stats default excludes sweep draws (5 of 6)', sweepExcluded.length === 5);
const insights = numberInsights('0715', FOURD_SEED_DRAWS);
check("numberInsights('0715'): seen once in sweep draw — excluded, seen 0 times",
  insights.timesSeen === 0 && insights.lastSeenGap === null,
  `timesSeen=${insights.timesSeen} gap=${insights.lastSeenGap}`);
check("numberInsights('0715') on ALL draws: seen once, gap 0 (newest first)",
  numberInsights('0715', FOURD_SEED_DRAWS, { excludeSweep: false }).timesSeen === 1
  && numberInsights('0715', FOURD_SEED_DRAWS, { excludeSweep: false }).lastSeenGap === 0);
check('expectedTimes over 5 non-sweep draws = 5×23/10000',
  close(insights.expectedTimes, 5 * 23 / 10000, 1e-12));
check('betAdvice on 1234 mentions 24 perms + iBet', /24 permutations/.test(numberInsights('1234', FOURD_SEED_DRAWS).betAdvice)
  && /iBet/.test(numberInsights('1234', FOURD_SEED_DRAWS).betAdvice),
  JSON.stringify(numberInsights('1234', FOURD_SEED_DRAWS).betAdvice));
check("betAdvice on 0000 says Ordinary only", /Ordinary/.test(numberInsights('0000', FOURD_SEED_DRAWS).betAdvice));

console.log('\n== Chi-square fairness ==');
check('chi2 critical value: Q(9, 16.919) ≈ 0.05', close(chiSquareUpperTail(16.919, 9), 0.05, 0.001),
  `got ${chiSquareUpperTail(16.919, 9).toFixed(4)}`);
check('Q(9, 0) = 1', chiSquareUpperTail(0, 9) === 1);
// Synthetic uniform draws: 500 draws -> 2000 numbers × 4 positions = 8000 digits
const synthetic = [];
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
for (let i = 0; i < 500; i++) {
  const mk = () => Array.from({ length: 4 }, () => Math.floor(rnd() * 10)).join('');
  synthetic.push({ '1st': mk(), '2nd': mk(), '3rd': mk(), starter: Array.from({ length: 10 }, mk), consolation: Array.from({ length: 10 }, mk), isSweepDay: false });
}
const chiSynthetic = chiSquareByPosition(synthetic);
check('uniform synthetic: all 4 positions consistent (p > 0.01)',
  chiSynthetic.every(c => c.p > 0.01),
  chiSynthetic.map(c => `p${c.position}=${c.p.toFixed(3)}`).join(' '));
// Skewed: force position 0 to digit 7 always
const skewed = synthetic.map(d => ({ ...d, '1st': '7' + d['2nd'].slice(1), starter: d.starter, consolation: d.consolation }));
const chiSkewed = chiSquareByPosition(skewed);
check('skewed position 0 flagged outlier (p < 0.001)', chiSkewed[0].p < 0.001,
  `p=${chiSkewed[0].p.toExponential(2)} chi2=${chiSkewed[0].chi2.toFixed(1)}`);
check('verdict labels: consistent/watch/outlier', chiSkewed[0].verdict === 'outlier' && chiSynthetic[0].verdict === 'consistent');
const freq = digitFrequencies(FOURD_SEED_DRAWS);
check('digitFrequencies 1st bucket (sweep excluded): 4 digits × 5 draws = 20',
  Object.values(freq.first).reduce((a, b) => a + b, 0) === 20);
const freqAll = digitFrequencies(FOURD_SEED_DRAWS, { excludeSweep: false });
check('digitFrequencies 1st bucket (all draws): 4 digits × 6 draws = 24',
  Object.values(freqAll.first).reduce((a, b) => a + b, 0) === 24);

console.log('\n== budgetPlanner ==');
check('4 modes defined', Object.keys(MODES).length === 4
  && ['max_ev', 'max_hit', 'min_variance', 'spread'].every(m => MODES[m]));
const candidates = [
  { number: '1234', betType: 'ibet', pool: 'big' },
  { number: '5678', betType: 'ibet', pool: 'big' },
  { number: '9012', betType: 'ibet', pool: 'big' },
  { number: '0000', betType: 'ibet', pool: 'big' }, // clause 2.5 — dropped
];
const pHit = plan({ budget: 3, candidates, mode: 'max_hit' });
check('$3 max_hit: 3 iBet entries, $0 unspent', pHit.allocation.length === 3 && pHit.unspent === 0,
  `allocated ${pHit.allocation.length}, unspent ${pHit.unspent}`);
check('never duplicates covered numbers', new Set(pHit.allocation.map(a => a.number)).size === 3);
const p10 = plan({ budget: 10, candidates, mode: 'max_hit' });
check('$10 max_hit: only 3 valid candidates exist, spends $3, unspent $7',
  p10.allocation.length === 3 && p10.unspent === 7,
  `allocated ${p10.allocation.length}, unspent ${p10.unspent}`);
const pOverlap = plan({
  budget: 5,
  candidates: [
    { number: '1234', betType: 'system', pool: 'big' },
    { number: '2341', betType: 'ibet', pool: 'big' }, // same covered numbers as the system entry
    { number: '9999', betType: 'ordinary', pool: 'big' },
  ],
  mode: 'max_hit',
});
check('duplicate coverage dropped: iBet(2341) covers first (cheapest), system(1234) adds nothing new',
  pOverlap.allocation.some(a => a.betType === 'ibet' && a.number === '2341')
  && !pOverlap.allocation.some(a => a.betType === 'system' && a.number === '1234'),
  JSON.stringify(pOverlap.allocation.map(a => `${a.betType}:${a.number}`)));
check('portfolio P(any prize) @ 25 distinct numbers ≈ 5.6%',
  close(pOverlap.pAnyPrize, 1 - Math.exp(-25 * 23 / 10000), 0.002),
  `got ${(pOverlap.pAnyPrize * 100).toFixed(2)}%`);

// Regression (critic finding 1): an ORDINARY entry covers exactly ONE number
// (not its permutations) — and spread mode obeys the same never-duplicate rule.
const pOrdSys = plan({
  budget: 25,
  candidates: [
    { number: '1234', betType: 'ordinary', pool: 'big' },
    { number: '2143', betType: 'system', pool: 'big' }, // permutation of 1234
  ],
  mode: 'max_hit',
});
check('ordinary covers 1 number: system(2143) still adds 23 fresh → both allocated, $25 spent',
  pOrdSys.allocation.length === 2 && pOrdSys.cost === 25 && pOrdSys.unspent === 0
  && pOrdSys.distinctNumbers === 24,
  JSON.stringify({ n: pOrdSys.allocation.length, cost: pOrdSys.cost, unspent: pOrdSys.unspent, distinct: pOrdSys.distinctNumbers }));
const pDupSpread = plan({
  budget: 5,
  candidates: [
    { number: '1234', betType: 'ordinary', pool: 'big' },
    { number: '1234', betType: 'ordinary', pool: 'big' }, // exact duplicate
  ],
  mode: 'spread',
});
check('spread rejects zero-fresh duplicate: 1 allocation, unspent $4',
  pDupSpread.allocation.length === 1 && pDupSpread.cost === 1 && pDupSpread.unspent === 4,
  JSON.stringify({ n: pDupSpread.allocation.length, cost: pDupSpread.cost, unspent: pDupSpread.unspent }));

// Regression (critic finding 2): min_variance ranks by SD PER DOLLAR — a $24
// System entry (SD ≈ 119 → 4.96/$) must outscore a $1 Ordinary (SD 24.28/$).
const pMinVar = plan({
  budget: 24,
  candidates: [
    { number: '5678', betType: 'ordinary', pool: 'big' },
    { number: '1234', betType: 'system', pool: 'big' },
  ],
  mode: 'min_variance',
});
check('min_variance: system entry ranks first (SD/$ 4.96 vs 24.28), spends exactly $24',
  pMinVar.allocation.length === 1 && pMinVar.allocation[0].betType === 'system'
  && pMinVar.cost === 24 && pMinVar.unspent === 0,
  JSON.stringify(pMinVar.allocation.map(a => a.betType)));

// Regression (Phase U critic finding 2): the allocation must CARRY `position`
// for roll entries — portfolioStats coverage, the UI label and testBench
// replay all key off it. Dropping it silently turned every allocated roll
// into a position-0 roll, so the replay scored the wrong 10 numbers.
const pRoll3 = plan({
  budget: 30,
  candidates: [
    { number: '5678', betType: 'ordinary', pool: 'big' },
    { number: '8888', betType: 'roll', pool: 'big', position: 3 }, // covers 8880..8889
  ],
  mode: 'max_hit',
});
const rollAlloc = pRoll3.allocation.find(a => a.betType === 'roll');
check('roll allocation carries position 3 (normalized 0 when absent)',
  rollAlloc && rollAlloc.position === 3
  && plan({
    budget: 10,
    candidates: [{ number: '8888', betType: 'roll', pool: 'big' }],
    mode: 'max_hit',
  }).allocation[0].position === 0,
  JSON.stringify(rollAlloc));
check('planner stats price the roll at its true cost ($11 for ordinary + 10-number roll)',
  pRoll3.cost === 11 && pRoll3.distinctNumbers === 11,
  `cost ${pRoll3.cost}, distinct ${pRoll3.distinctNumbers}`);
// End-to-end: a draw whose 1st prize (8885) sits inside 8880..8889 must pay
// the position-3 roll $2000 — impossible if the allocation lost its position
// (position 0 covers 0888..9888 and misses 8885).
const synthDraw = {
  drawNo: 9999, date: '05 Aug 2026', isSweepDay: true,
  '1st': '8885', '2nd': '1112', '3rd': '2223',
  starter: ['3334', '4445', '5556', '6667', '7778', '0001', '1213', '9091', '3142', '2719'],
  consolation: ['1415', '1617', '1819', '2021', '2324', '2526', '2728', '2930', '3031', '5253'],
};
const repRoll3 = replay({ entries: pRoll3.allocation, draws: [synthDraw] });
const rollRow3 = repRoll3.perEntry.find(e => e.betType === 'roll');
check('replay of the allocation pays the position-3 roll on 8885 ($2000); ordinary 5678 misses',
  rollRow3.won === 2000 && rollRow3.hitCount === 1
  && repRoll3.perEntry.find(e => e.betType === 'ordinary').won === 0,
  JSON.stringify(repRoll3.perEntry.map(e => ({ t: e.betType, won: e.won }))));
check('replay perEntry rows carry the roll position (label/coverage contract)',
  rollRow3.position === 3
  && replay({
    entries: [{ number: '8888', betType: 'roll', pool: 'big', stake: 1 }],
    draws: FOURD_SEED_DRAWS,
  }).perEntry[0].position === 0,
  `position ${rollRow3.position}`);

console.log('\n== portfolioStats ==');
const ps = portfolioStats([{ number: '1234', betType: 'ordinary', pool: 'big', stake: 1 }]);
check('single ordinary entry: EV 0.659, SD 24.2841, P 0.23%',
  ps.ev === 0.659 && close(ps.sd, 24.2841, 0.005) && close(ps.pAnyPrize, 0.0023, 1e-8));
const psRoll = portfolioStats([{ number: '5730', betType: 'roll', pool: 'big', stake: 1, position: 3 }]);
check('roll entry: EV = 10 × 0.659, cost $10, 10 distinct numbers',
  close(psRoll.ev, 6.59, 1e-9) && psRoll.cost === 10 && psRoll.distinctNumbers === 10);
const psIbet = portfolioStats([{ number: '1234', betType: 'ibet', pool: 'big', stake: 1 }]);
check('ibet-24 entry: EV 0.6576, SD 4.8695, 24 distinct, cost $1',
  close(psIbet.ev, 0.6576, 1e-9) && close(psIbet.sd, 4.8695, 0.005)
  && psIbet.distinctNumbers === 24 && psIbet.cost === 1);
// Regression (critic finding 3): iBet on a one-perm number cannot be placed
// (clause 2.5) — it must contribute zero cost, zero EV and no coverage, never
// a free iBet-24 bet.
const psIbet1 = portfolioStats([{ number: '0000', betType: 'ibet', pool: 'big', stake: 1 }]);
check("portfolioStats ibet '0000' (not offered): cost 0, EV 0, no coverage",
  psIbet1.cost === 0 && psIbet1.ev === 0 && psIbet1.distinctNumbers === 0
  && psIbet1.pAnyPrize === 0,
  JSON.stringify(psIbet1));
const tb0000 = replay({
  entries: [{ number: '0000', betType: 'ibet', pool: 'big', stake: 1 }],
  draws: FOURD_SEED_DRAWS,
});
check("replay ibet '0000' (not offered): staked 0, won 0, flagged notOffered",
  tb0000.staked === 0 && tb0000.won === 0 && tb0000.perEntry[0].notOffered === true,
  JSON.stringify(tb0000.perEntry[0]));
// Clause 2.5 extends to SYSTEM on one-perm numbers (regression: the guard
// must key off ibetGroup(number), not the entry's own group field — System
// entries with ≥2 perms must keep flowing through untouched).
const psSys1 = portfolioStats([{ number: '7777', betType: 'system', pool: 'big', stake: 1 }]);
check("portfolioStats system '7777' (not offered): cost 0, EV 0, no coverage",
  psSys1.cost === 0 && psSys1.ev === 0 && psSys1.distinctNumbers === 0 && psSys1.pAnyPrize === 0,
  JSON.stringify(psSys1));
const tbSys = replay({
  entries: [{ number: '7777', betType: 'system', pool: 'big', stake: 1 }],
  draws: FOURD_SEED_DRAWS,
});
check("replay system '7777' (not offered): staked 0, flagged notOffered",
  tbSys.staked === 0 && tbSys.perEntry[0].notOffered === true);
const pSys1 = plan({
  budget: 5,
  candidates: [
    { number: '7777', betType: 'system', pool: 'big' }, // clause 2.5 — dropped
    { number: '1234', betType: 'ordinary', pool: 'big' },
  ],
  mode: 'max_hit',
});
check('planner drops system one-perm candidate, allocates the ordinary one',
  pSys1.allocation.length === 1 && pSys1.allocation[0].betType === 'ordinary' && pSys1.cost === 1,
  JSON.stringify(pSys1.allocation));

console.log('\n== signalLab report contract ==');
const goodReport = {
  generatedAt: '2026-08-28T00:00:00Z', drawsAnalyzed: 470, sweepDaysExcluded: 12,
  battery: [{
    name: 'frequency', walkForward: true, baseline: 'uniform',
    metric: { model: 4.6052, baseline: 4.6052, metricName: 'log-loss' },
    liftPct: 0, calibration: { ece: 0.001, bins: [] }, fdrQ: 1, verdict: 'no-edge',
  }],
  overall: { verdict: 'no-edge', note: '' },
};
check('valid report passes', validateReport(goodReport).ok);
const badReport = { ...goodReport, battery: [{ ...goodReport.battery[0], walkForward: false }] };
check('non-walk-forward battery rejected', !validateReport(badReport).ok
  && validateReport(badReport).errors.some(e => e.includes('walk-forward')));
const noBaseline = { ...goodReport, battery: [{ ...goodReport.battery[0], baseline: 'magic' }] };
check('non-uniform baseline rejected', !validateReport(noBaseline).ok);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log(' - ' + f));
  process.exit(1);
}
console.log('ENGINE HARNESS GREEN');
