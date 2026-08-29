// slip — the multi-leg slip model for the v2.1 Bet & Planner tab.
//
// A LEG is one bet type on one number with BOTH pools on the same slip:
//   { type: 'ordinary'|'system'|'ibet'|'roll', big: <$/draw>, small: <$/draw> }
// Each leg lowers onto the existing betMath entries — { pool:'big', stake:big }
// and { pool:'small', stake:small } — so every combined figure (cost, EV, SD,
// union-of-perms coverage, replay) comes straight from the harness-pinned
// functions. This module holds ONLY the lowering and per-leg pricing; it
// invents no prize amounts and no odds of its own.

import { ORDINARY_PRIZES, IBET_PRIZES, BET_TYPES } from './constants.js';
import {
  ibetGroup, coveredNumbers, portfolioStats, slipCost, pAnyPrize,
} from './betMath.js';
import { replay } from './testBench.js';

export const LEG_TYPES = [...BET_TYPES]; // ['ordinary','system','ibet','roll']

// The rolled digit of a 4D Roll leg: the 4th digit (mockup v2.1 simplification;
// betMath keeps full position support underneath).
export const ROLL_POSITION = 3;

// Clause 2.5: iBet and System are not offered on one-permutation numbers
// (0000…9999). Such a leg prices at $0 and renders a warning instead of a
// payout table.
export function legNotOffered(leg, number) {
  return (leg.type === 'ibet' || leg.type === 'system') && ibetGroup(number) === null;
}

// True when the leg carries no money — it shows an "empty" hint and costs $0.
export function legEmpty(leg) {
  return (Number(leg.big) || 0) + (Number(leg.small) || 0) === 0;
}

// Lower one leg to its betMath entries (pool-specific, stake = the pool's $).
// A not-offered or empty leg lowers to NO entries (costs and wins nothing).
export function legEntries(leg, number, position = ROLL_POSITION) {
  const big = Math.max(0, Math.floor(Number(leg.big) || 0));
  const small = Math.max(0, Math.floor(Number(leg.small) || 0));
  if (legNotOffered(leg, number) || big + small === 0) return [];
  const n = String(number).padStart(4, '0');
  const entries = [];
  if (big > 0) entries.push({ betType: leg.type, number: n, pool: 'big', stake: big, position });
  if (small > 0) entries.push({ betType: leg.type, number: n, pool: 'small', stake: small, position });
  return entries;
}

// Per-draw cost of one leg ($0 for empty or not-offered legs). Never null —
// clause-2.5 legs are real UI objects that simply price at zero.
export function legCostPerDraw(leg, number, position = ROLL_POSITION) {
  return legEntries(leg, number, position).reduce((sum, e) => sum + slipCost(e), 0);
}

// The distinct numbers a leg covers (unioned across pools — pools never
// duplicate coverage).
export function legCoveredNumbers(leg, number, position = ROLL_POSITION) {
  const out = new Set();
  legEntries(leg, number, position).forEach(e => coveredNumbers(e).forEach(x => out.add(x)));
  return [...out];
}

// Up-to payout of one leg, per draw: a covered number placing 1st, summed
// over the leg's active pools (Big and Small are independent slips). Only one
// covered number can take 1st in a draw, so System/Roll/iBet pay their table's
// 1st prize once — never ×perms/×10.
export function legUpTo(leg, number) {
  const big = Math.max(0, Math.floor(Number(leg.big) || 0));
  const small = Math.max(0, Math.floor(Number(leg.small) || 0));
  if (legNotOffered(leg, number) || big + small === 0) return 0;
  if (leg.type === 'ibet') {
    const t = IBET_PRIZES[ibetGroup(number)]; // group != null: not-offered filtered above
    return t.big.first * big + t.small.first * small;
  }
  return ORDINARY_PRIZES.big.first * big + ORDINARY_PRIZES.small.first * small;
}

// The published prize table one leg plays, with both pools: rows
// [{ label, big, small }] where null = tier absent (Small has no
// starter/consolation) and amounts are per $1 stake. System legs play the
// Ordinary table (per arrangement); iBet legs the published group table.
export function legPayoutTable(leg, number) {
  const n = String(number).padStart(4, '0');
  const table = leg.type === 'ibet' && ibetGroup(n) !== null
    ? IBET_PRIZES[ibetGroup(n)]
    : ORDINARY_PRIZES;
  return [
    { label: '1st prize', big: table.big.first ?? null, small: table.small.first ?? null },
    { label: '2nd prize', big: table.big.second ?? null, small: table.small.second ?? null },
    { label: '3rd prize', big: table.big.third ?? null, small: table.small.third ?? null },
    { label: 'Starter (×10)', big: table.big.starter ?? null, small: table.small.starter ?? null },
    { label: 'Consolation (×10)', big: table.big.consolation ?? null, small: table.small.consolation ?? null },
  ];
}

// Combined slip summary for a list of legs on one number, entered for `days`
// draws. Every figure is engine-derived:
// - cost: sum of per-leg costs × days; costPerDraw stays per draw
// - any-prize chance over the UNION of covered numbers (a number with
//   Ordinary + iBet legs covers its perms once, not twice); slips with no Big
//   money can only win on the 3 top prizes, so they get the Small figure
// - upTo: every covered number placing 1st simultaneously at its leg's table
// - rtp: exact expected return per $1 (ev ÷ cost, engine figures — iBet's
//   slightly different table EVs are included, not approximated)
export function slipSummary({ number, legs, days = 1 }) {
  const n = String(number).padStart(4, '0');
  const d = Math.max(1, Math.round(Number(days)) || 1);
  const entries = legs.flatMap(leg => legEntries(leg, n));
  const stats = portfolioStats(entries);

  const costPerDraw = legs.reduce((sum, leg) => sum + legCostPerDraw(leg, n), 0);
  const upTo = legs.reduce((sum, leg) => sum + legUpTo(leg, n), 0);
  const hasBigMoney = legs.some(leg => !legNotOffered(leg, n) && (Number(leg.big) || 0) > 0);

  return {
    ...stats,
    pAnyPrize: stats.distinctNumbers > 0 && !hasBigMoney
      ? pAnyPrize(stats.distinctNumbers, 'small') // no Big money → only top-3 can win
      : stats.pAnyPrize,
    cost: stats.cost * d,
    costPerDraw: stats.cost,
    upTo,
    days: d,
    rtp: stats.cost > 0 ? stats.ev / stats.cost : null,
  };
}

// Replay the whole slip against the archive, combined: reuses
// testBench.replay on the lowered entries, then merges per-draw winnings
// across legs (the hit chips show what a draw paid ALL bets together).
export function slipReplay({ number, legs, draws, excludeSweep = false }) {
  const n = String(number).padStart(4, '0');
  const entries = legs.flatMap(leg => legEntries(leg, n));
  const result = replay({ entries, draws, excludeSweep });
  const perDrawMap = new Map();
  for (const e of result.perEntry) {
    for (const h of e.hits) {
      const cur = perDrawMap.get(h.drawNo) || { drawNo: h.drawNo, date: h.date, won: 0 };
      cur.won += h.amount;
      perDrawMap.set(h.drawNo, cur);
    }
  }
  const perDraw = [...perDrawMap.values()].sort((a, b) => b.drawNo - a.drawNo);
  return { ...result, perDraw };
}
