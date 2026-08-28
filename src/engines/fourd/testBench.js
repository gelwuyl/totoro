// testBench — "Test My Numbers": replays a slip against real historical
// draws. Answers "what WOULD this have returned" — a description of the past,
// not a prediction of the next draw (draws are independent; the replayed net
// has no bearing on future odds).

import { payoutFor, slipCost, rollNumbers, ibetGroup } from './betMath.js';
import { statsDraws } from './drawStats.js';

// Replay entries [{ number, betType, pool, stake, position? }] over draws
// (newest-first per app convention; order only affects per-draw listing).
// Sweep-day draws are INCLUDED by default here (they are real draws you could
// have bet on) but can be excluded to match the stats engine's default view.
export function replay({ entries, draws, excludeSweep = false }) {
  const rows = statsDraws(draws, { excludeSweep });
  const perEntry = entries.map(e => {
    const costPerDraw = entryCostPerDraw(e);
    // Clause 2.5: iBet and System are not offered on one-permutation numbers —
    // the slip cannot be placed, so it stakes and wins nothing. Flagged so the
    // UI can say so instead of silently showing $0.
    const notOffered = (e.betType === 'ibet' || e.betType === 'system')
      && ibetGroup(e.number) === null;
    let won = 0;
    const hits = [];
    for (const d of rows) {
      const drawWin = notOffered ? 0 : drawPayout(e, d);
      if (drawWin > 0) hits.push({ drawNo: d.drawNo, date: d.date, amount: drawWin });
      won += drawWin;
    }
    const staked = notOffered ? 0 : costPerDraw * rows.length;
    return {
      number: e.number,
      betType: e.betType,
      pool: e.pool,
      stake: e.stake,
      // Carry the roll's position so consumers label/re-derive the covered
      // numbers from the row itself (same contract as plan() allocations).
      ...(e.betType === 'roll' ? { position: e.position ?? 0 } : {}),
      notOffered,
      drawsPlayed: rows.length,
      costPerDraw: notOffered ? 0 : costPerDraw,
      staked,
      won,
      net: won - staked,
      hitCount: hits.length,
      hitRate: rows.length ? hits.length / rows.length : 0,
      hits: hits.slice(0, 20), // cap for display; counts above stay exact
    };
  });

  const staked = perEntry.reduce((a, e) => a + e.staked, 0);
  const won = perEntry.reduce((a, e) => a + e.won, 0);
  const hitCount = perEntry.reduce((a, e) => a + e.hitCount, 0);
  return {
    drawsPlayed: rows.length,
    staked,
    won,
    net: won - staked,
    rtp: staked ? won / staked : 0,
    hitCount,
    perEntry,
    honestLine: 'A replay of past draws. It describes what would have happened — it does not change what happens next.',
  };
}

// One entry's winnings in one draw, via betMath.payoutFor semantics:
// ordinary pays the exact number; system pays every permutation at the
// Ordinary table; ibet pays the published group table across permutations;
// roll pays its 10 covered numbers as Ordinary entries.
function drawPayout(entry, draw) {
  if (entry.betType === 'roll') {
    return rollNumbers(entry.number, entry.position ?? 0)
      .reduce((sum, n) => sum + payoutFor(n, draw, 'ordinary', entry.stake, entry.pool), 0);
  }
  return payoutFor(entry.number, draw, entry.betType, entry.stake, entry.pool);
}

function entryCostPerDraw(entry) {
  const cost = slipCost({ betType: entry.betType, number: entry.number, stake: entry.stake, drawDays: 1 });
  return cost === null ? 0 : cost;
}
