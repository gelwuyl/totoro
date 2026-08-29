import React, { useEffect, useMemo, useState } from 'react';
import { FourDigitNumber, isSweepDay } from '../shell/DigitBox.jsx';
import { FOURD_SEED_DRAWS } from './seedDraws.js';
import { permCount } from '../engines/fourd/betMath.js';
import {
  slipSummary, slipReplay, legNotOffered, legEmpty, legCostPerDraw,
  legPayoutTable, LEG_TYPES,
} from '../engines/fourd/slip.js';
import { digitFrequencies, chiSquareByPosition } from '../engines/fourd/drawStats.js';
import { validateReport, verdictCopy, liftCopy } from '../engines/fourd/signalLab.js';

// 4D analyzer — full UI over the verified engines. Every displayed number is
// read straight out of an engine function (the quality bar: UI matches engines
// to the cent). House rules shown everywhere: fixed odds per $1 (Big 65.9¢ /
// Small 58.0¢), draws are independent, nothing here predicts the next draw.

const TABS = [
  { id: 'planner', label: '🎯 Bet & Planner' },
  { id: 'insights', label: '💠 Insights & Fairness' },
  { id: 'records', label: '📜 Records' },
  { id: 'data', label: '📂 Data & Sync' },
];

const BET_TYPE_LABELS = {
  ordinary: 'Ordinary',
  system: 'System Entry',
  ibet: 'iBet',
  roll: '4D Roll',
};

const POSITION_LABELS = ['1st digit', '2nd digit', '3rd digit', '4th digit'];

// ---------- formatting helpers (display only — values come from engines) ----

const money = (n) => '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2));
const pct = (p, dp = 2) => `${(p * 100).toFixed(dp)}%`;

function Stat({ label, value, sub, accent = 'text-white' }) {
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{label}</div>
      <div className={`text-lg font-bold ${accent} mt-0.5 font-mono`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function VerdictBadge({ kind, children, title }) {
  const styles = {
    good: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
    watch: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
    bad: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
    neutral: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
  };
  return (
    <span title={title} className={`text-[10px] border px-2 py-0.5 rounded-full font-semibold ${styles[kind] || styles.neutral}`}>
      {children}
    </span>
  );
}

// ---------- Draw card (Records + reused in Insights examples) ---------------

function DrawCard({ draw }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-lg">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-bold text-white">Draw {draw.drawNo}</span>
        <span className="text-xs text-slate-500">{draw.date}</span>
        {(draw.isSweepDay ?? isSweepDay(draw.date)) && (
          <span
            className="text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded-full font-semibold"
            title="Singapore Sweep day: these results are the last 4 digits of Sweep prizes, not machine draws — excluded from fairness statistics."
          >
            Sweep day
          </span>
        )}
      </div>
      <div className="mt-3 space-y-2">
        {[['1st', draw['1st'], 'emerald'], ['2nd', draw['2nd'], 'slate'], ['3rd', draw['3rd'], 'slate']].map(([label, val, accent]) => (
          <div key={label} className="flex items-center gap-3">
            <span className="text-xs text-slate-400 w-8 font-semibold">{label}</span>
            <FourDigitNumber value={val} accent={accent} />
          </div>
        ))}
      </div>
      <details className="mt-3 group">
        <summary className="text-xs text-slate-400 hover:text-slate-200 cursor-pointer select-none font-semibold">
          Starter &amp; Consolation
        </summary>
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Starter</div>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {draw.starter.map((n, i) => (
              <span key={`${n}-${i}`} className="font-mono text-xs bg-slate-800 text-slate-300 border border-slate-700 rounded px-1.5 py-0.5">{n}</span>
            ))}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mt-2">Consolation</div>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {draw.consolation.map((n, i) => (
              <span key={`${n}-${i}`} className="font-mono text-xs bg-slate-800/60 text-slate-400 border border-slate-700/70 rounded px-1.5 py-0.5">{n}</span>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}

// ---------- TAB 1: Bet & Planner (v2.1) --------------------------------------

// Ratified v2.1 shape: ONE number at a time; every bet on it is a "leg" with
// Big + Small amounts on the same slip; ONE combined summary card (cost +
// up-to + next draw + chances + honest-price line); per-leg payout tables; a
// combined archive replay; and a budget card that mirrors the bets live and
// rebalances money WITHOUT ever changing bet types. Every displayed figure is
// read from the engines (src/engines/fourd/slip.js → betMath/testBench) — the
// component performs no bet math of its own.

const STYLE_CHIPS = [
  { id: 'odds', label: 'Best odds of a win' },
  { id: 'swing', label: 'Biggest swing' },
  { id: 'smooth', label: 'Smoother ride' },
  { id: 'both', label: 'Both pools 2:1' },
];

function Chip({ on = false, add = false, onClick, title, children }) {
  const styles = on
    ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'
    : add
      ? 'border-dashed border-emerald-800 bg-slate-950/60 text-emerald-300 hover:bg-emerald-900/30'
      : 'border-slate-700 bg-slate-950/60 text-slate-400 hover:text-slate-200 hover:border-slate-500';
  return (
    <button type="button" onClick={onClick} title={title}
      className={`text-xs font-bold px-3 py-1.5 rounded-full border transition ${styles}`}>
      {children}
    </button>
  );
}

function DigitInputs({ digits, setDigits }) {
  const handle = (i, raw) => {
    const d = raw.replace(/\D/g, '').slice(-1);
    setDigits(ds => { const next = ds.slice(); next[i] = d; return next; });
    if (d && i < 3) {
      const el = document.getElementById(`planner-digit-${i + 1}`);
      if (el) { el.focus(); el.select(); }
    }
  };
  return (
    <div className="flex gap-2 mt-3">
      {digits.map((d, i) => (
        <input
          key={i}
          id={`planner-digit-${i}`}
          value={d}
          inputMode="numeric"
          autoComplete="off"
          aria-label={`Digit ${i + 1}`}
          onChange={(e) => handle(i, e.target.value)}
          onFocus={(e) => e.target.select()}
          className={`w-14 h-16 text-center text-3xl font-extrabold bg-slate-950 border-[1.5px] rounded-xl text-slate-100 outline-none transition focus:border-emerald-500 focus:ring-[3px] focus:ring-emerald-500/20 ${d ? 'border-emerald-600' : 'border-slate-700'}`}
        />
      ))}
    </div>
  );
}

// Next draw-day from the 4D cadence (Wed/Sat/Sun — matches the archive's
// dates). Deliberately NO cut-off time: the exact sales cut-off is not
// hardcoded anywhere in this app, so "today on a draw day" simply says today.
function nextDrawDate(from = new Date()) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY = 24 * 60 * 60 * 1000;
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getTime() + i * DAY);
    const wd = d.getDay(); // 0 Sun · 3 Wed · 6 Sat
    if (wd === 0 || wd === 3 || wd === 6) {
      const label = `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      return { label, today: i === 0, sweep: isSweepDay(label) };
    }
  }
  return null;
}

function PlannerTab({ draws }) {
  const [digits, setDigits] = useState(['8', '8', '8', '5']);
  const [days, setDays] = useState(1);
  const [legs, setLegs] = useState([
    { type: 'ordinary', big: 2, small: 1 },
    { type: 'ibet', big: 1, small: 0 },
  ]);
  const [budgetNote, setBudgetNote] = useState('');
  const [addIbetAmt, setAddIbetAmt] = useState(null); // null = button hidden

  // Partial input reads as its left-aligned digits (typing 8·8·8 prices 8880 —
  // the mockup's pad-right behaviour); a hint says how many digits are missing.
  const n = digits.map(d => d || '0').join('');
  const missingDigits = digits.filter(d => d === '').length;

  const legsKey = JSON.stringify(legs);
  const summary = useMemo(
    () => slipSummary({ number: n, legs, days }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [n, days, legsKey],
  );
  const activeLegs = legs.filter(l => !legNotOffered(l, n) && !legEmpty(l));
  const replayResult = useMemo(
    () => slipReplay({ number: n, legs, draws }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [n, legsKey, draws],
  );
  const next = nextDrawDate();

  const setPool = (i, pool, raw) => setLegs(ls => ls.map((l, j) => j === i
    ? { ...l, [pool]: Math.max(0, Math.floor(Number(raw) || 0)) }
    : l));
  const removeLeg = (i) => setLegs(ls => ls.filter((_, j) => j !== i));
  const addLeg = () => setLegs(ls => {
    const have = new Set(ls.map(l => l.type));
    return [...ls, { type: LEG_TYPES.find(t => !have.has(t)) || 'ordinary', big: 1, small: 0 }];
  });

  // Budget rebalance — moves the SAME money across the legs' Big/Small pools;
  // bet types are never changed (ratified points 4 + 7: no silent switching).
  const rebalance = (mode) => {
    setAddIbetAmt(null);
    const active = legs.filter(l => !legNotOffered(l, n) && !legEmpty(l));
    const total = active.reduce((a, l) => a + (Number(l.big) || 0) + (Number(l.small) || 0), 0);
    if (total === 0) { setBudgetNote('No money to rebalance — set an amount on a bet first.'); return; }
    setBudgetNote('');
    if (mode === 'odds') {
      const ibet = legs.find(l => l.type === 'ibet' && !legNotOffered(l, n));
      if (!ibet && legNotOffered({ type: 'ibet' }, n)) {
        setBudgetNote(`iBet isn't offered on ${n} (rule 2.5 — one arrangement). Your bets stay as they are.`);
      } else if (!ibet) {
        setAddIbetAmt(total);
        setBudgetNote(`Your ${money(total)} covers the most prize places as iBet — it sweeps every arrangement of ${n} in one bet. Add it below, or keep your current bets.`);
      } else {
        setLegs(ls => ls.map(l => (l.type === 'ibet' && !legNotOffered(l, n))
          ? { ...l, big: total, small: 0 }
          : { ...l, big: 0, small: 0 }));
        setBudgetNote(`Moved all ${money(total)} into the iBet bet — most prize places per dollar. Other bets zeroed (not removed).`);
      }
    } else if (mode === 'swing') {
      setLegs(ls => ls.map(l => ({ ...l, big: 0, small: (Number(l.big) || 0) + (Number(l.small) || 0) })));
      setBudgetNote(`All ${money(total)} moved to Small — top-3 only, biggest prizes, highest swing.`);
    } else if (mode === 'smooth') {
      setLegs(ls => ls.map(l => ({ ...l, big: (Number(l.big) || 0) + (Number(l.small) || 0), small: 0 })));
      setBudgetNote(`All ${money(total)} moved to Big — 23 prize places, small wins land more often.`);
    } else {
      setLegs(ls => ls.map(l => {
        const t = (Number(l.big) || 0) + (Number(l.small) || 0);
        const b = Math.round(t * 2 / 3);
        return { ...l, big: b, small: t - b };
      }));
      setBudgetNote('Split 2:1 Big:Small within each bet — frequent places plus a bigger top-3.');
    }
  };

  const hasActive = activeLegs.length > 0;
  const costLabel = summary.cost === 0
    ? '$0'
    : money(summary.cost) + (days > 1 ? ` (${days} draws)` : '');
  const upToLabel = summary.costPerDraw === 0 ? '—' : `up to ${money(summary.upTo)}`;
  const anyPct = summary.distinctNumbers > 0 && summary.costPerDraw > 0
    ? `${(summary.pAnyPrize * 100).toFixed(2).replace(/\.?0+$/, '')}%`
    : '—';
  const firstChance = summary.distinctNumbers > 0 && summary.costPerDraw > 0
    ? `1-in-${Math.round(10000 / summary.distinctNumbers).toLocaleString('en-SG')}`
    : '—';

  return (
    <div className="max-w-[30rem] mx-auto space-y-5 animate-in fade-in duration-300">

      {/* header */}
      <div>
        <span className="inline-block bg-amber-500/10 text-amber-300 border border-amber-700/60 text-[10px] font-extrabold tracking-[0.1em] uppercase px-2.5 py-1 rounded-full">
          Bet &amp; Planner · v2.1
        </span>
        <h1 className="text-2xl font-extrabold text-white mt-2">One number · every bet on it</h1>
        <p className="text-slate-400 text-sm leading-relaxed mt-1">
          Stack as many bet types as you like on the same 4 digits — <b className="text-sky-300">Big</b> and{' '}
          <b className="text-pink-300">Small</b> amounts per bet. Everything below is computed from the{' '}
          <b>combined slip</b>, and the budget mirrors your bets live.
        </p>
      </div>

      {/* THE NUMBER */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
        <h2 className="text-base font-bold text-white">Your number</h2>
        <DigitInputs digits={digits} setDigits={setDigits} />
        {missingDigits > 0 && (
          <p className="text-[11px] text-amber-300/90 mt-2">
            Pricing <span className="font-mono font-bold">{n}</span> — add {missingDigits} more digit{missingDigits === 1 ? '' : 's'}
          </p>
        )}
        <div className="flex items-center gap-1.5 flex-wrap mt-3">
          <span className="text-[10px] text-slate-500 font-bold tracking-wider uppercase">Enter for</span>
          {[1, 3, 5].map(d => (
            <Chip key={d} on={days === d} onClick={() => setDays(d)}>{d} draw{d > 1 ? 's' : ''}</Chip>
          ))}
        </div>
      </div>

      {/* THE BETS (legs) */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
        <h2 className="text-base font-bold text-white">Bets on this number</h2>
        <p className="text-slate-500 text-xs leading-relaxed mt-0.5">
          Mix bet types freely — e.g. $1 Big Ordinary <i>and</i> $1 Big iBet. Each bet's cost adds up; the
          chances below combine without double-counting.
        </p>

        <div className="space-y-2.5 mt-3">
          {legs.map((leg, i) => {
            const notOffered = legNotOffered(leg, n);
            const empty = legEmpty(leg);
            const perms = permCount(n);
            let note;
            if (notOffered) {
              note = <span>Not offered — <b className="text-slate-200">{n}</b> has one arrangement (rule 2.5). Costs $0 until you switch this bet to Ordinary or Roll.</span>;
            } else if (empty) {
              note = <span>Empty — set a Big or Small amount, or remove this bet.</span>;
            } else if (leg.type === 'system') {
              note = <span>Plays <b className="text-slate-200">all {perms} arrangements</b> at the Ordinary table · cost ×{perms}.</span>;
            } else if (leg.type === 'ibet') {
              note = <span>One bet covers <b className="text-slate-200">all {perms} arrangements</b> · published {perms}-perm group prizes.</span>;
            } else if (leg.type === 'roll') {
              note = <span>Covers <b className="text-slate-200">10 numbers</b> (rolling 4th digit) · each plays the Ordinary table.</span>;
            } else {
              note = <span>Straight bet on <b className="text-slate-200">{n}</b> · Big pays 23 places, Small the top 3.</span>;
            }
            return (
              <div key={i}
                className={`border rounded-xl p-3 bg-slate-950/50 ${i === 0 ? 'border-emerald-800' : 'border-slate-800'} ${notOffered ? 'border-amber-700' : ''}`}>
                <div className="flex items-center gap-2">
                  <select value={leg.type} aria-label={`Bet ${i + 1} type`}
                    onChange={(e) => setLegs(ls => ls.map((l, j) => j === i ? { ...l, type: e.target.value } : l))}
                    className="bg-slate-900 border border-slate-700 text-slate-100 text-xs font-extrabold px-2 py-1.5 rounded-lg focus:outline-none focus:border-emerald-500">
                    {LEG_TYPES.map(t => <option key={t} value={t}>{BET_TYPE_LABELS[t]}</option>)}
                  </select>
                  {legs.length > 1 && (
                    <button onClick={() => removeLeg(i)} title="Remove bet" aria-label={`Remove bet ${i + 1}`}
                      className="ml-auto text-slate-500 hover:text-rose-400 text-sm px-1.5 py-0.5 transition">✕</button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div className="border border-slate-800 border-l-[3px] border-l-sky-400 rounded-lg px-2.5 py-2">
                    <div className="text-[10px] font-extrabold tracking-wider uppercase text-sky-300">Big $</div>
                    <input type="number" min="0" step="1" value={leg.big} aria-label={`Bet ${i + 1} Big amount`}
                      onChange={(e) => setPool(i, 'big', e.target.value)}
                      className="w-full bg-slate-950 border-[1.5px] border-slate-700 rounded-md text-slate-100 text-base font-extrabold px-1.5 py-1 mt-1 outline-none focus:border-emerald-500" />
                  </div>
                  <div className="border border-slate-800 border-l-[3px] border-l-pink-400 rounded-lg px-2.5 py-2">
                    <div className="text-[10px] font-extrabold tracking-wider uppercase text-pink-300">Small $</div>
                    <input type="number" min="0" step="1" value={leg.small} aria-label={`Bet ${i + 1} Small amount`}
                      onChange={(e) => setPool(i, 'small', e.target.value)}
                      className="w-full bg-slate-950 border-[1.5px] border-slate-700 rounded-md text-slate-100 text-base font-extrabold px-1.5 py-1 mt-1 outline-none focus:border-emerald-500" />
                  </div>
                </div>
                <p className={`text-[11px] leading-relaxed mt-2 ${notOffered ? 'text-amber-300' : empty ? 'text-slate-400' : 'text-slate-300'}`}>
                  {note}
                </p>
              </div>
            );
          })}
        </div>
        <div className="mt-3">
          <Chip add onClick={addLeg}>＋ add a bet type</Chip>
        </div>
      </div>

      {/* COMBINED SUMMARY (merged: price + up-to + next draw + honest line) */}
      <div className="bg-gradient-to-br from-emerald-950 to-slate-900 border border-emerald-800 rounded-2xl p-4 shadow-xl">
        <div className="flex justify-between items-baseline gap-2">
          <span className="text-[11px] font-extrabold tracking-wider uppercase text-emerald-300">This slip</span>
          <span className="text-2xl font-extrabold text-emerald-300 text-right">{costLabel}</span>
        </div>
        <div className="flex justify-between items-baseline gap-2 mt-1">
          <span className="text-[11px] text-slate-400">
            next draw · <b className="text-emerald-300">{next ? next.label : '—'}</b>
            {next?.sweep && <span className="text-amber-300 font-semibold"> · sweep day</span>}
          </span>
          <span className="text-base font-extrabold text-emerald-200 text-right">{upToLabel}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 mt-3">
          <div className="bg-slate-950/50 border border-emerald-800/30 rounded-xl px-3 py-2">
            <div className="text-base font-extrabold text-slate-100">{anyPct}</div>
            <div className="text-[10px] font-bold tracking-wider uppercase text-slate-500 mt-0.5">any-prize chance</div>
            <div className="text-[10px] text-slate-600">
              covers {summary.distinctNumbers} number{summary.distinctNumbers === 1 ? '' : 's'} · per draw
            </div>
          </div>
          <div className="bg-slate-950/50 border border-emerald-800/30 rounded-xl px-3 py-2">
            <div className="text-base font-extrabold text-slate-100">{firstChance}</div>
            <div className="text-[10px] font-bold tracking-wider uppercase text-slate-500 mt-0.5">1st-prize chance</div>
            <div className="text-[10px] text-slate-600">same every draw</div>
          </div>
        </div>
        <div className="mt-3 border-t border-emerald-800/30 pt-3 text-xs leading-relaxed text-slate-400">
          {summary.costPerDraw === 0 || summary.rtp === null
            ? <>Fixed odds: <b className="text-slate-200">Big returns 65.9¢ per $1 · Small 58.0¢</b> — on average, whatever you bet.</>
            : <>Honest price: every $1 here returns about <b className="text-slate-200">{(summary.rtp * 100).toFixed(1)}¢</b> on
              average (Big 65.9¢ / Small 58.0¢). Expected loss ≈ <b className="text-slate-200">{money(Math.max(0, summary.cost - summary.ev * days))}</b> on
              this slip — <b className="text-slate-200">no bet changes it</b>.</>}
        </div>
      </div>

      {/* WHAT EACH BET PAYS */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
        <h2 className="text-base font-bold text-white">
          What each bet pays <span className="text-slate-500 font-semibold text-xs">— per draw, if the number places</span>
        </h2>
        {activeLegs.length === 0 ? (
          <p className="text-xs text-slate-500 mt-3">No active bets — add an amount above.</p>
        ) : (
          <div className="mt-1">
            {legs.map((leg, i) => {
              if (legNotOffered(leg, n) || legEmpty(leg)) return null;
              const rows = legPayoutTable(leg, n);
              const cost = legCostPerDraw(leg, n);
              const suffix = leg.type === 'system' ? ` · ×${permCount(n)} arrangements`
                : leg.type === 'roll' ? ' · ×10 numbers' : '';
              return (
                <div key={i} className="mt-4 first:mt-2">
                  <h3 className="text-sm font-bold text-slate-200">
                    Bet {i + 1} · {BET_TYPE_LABELS[leg.type]}{' '}
                    <span className="text-slate-500 font-semibold">· {money(cost)} per draw{suffix}</span>
                  </h3>
                  <table className="w-full text-xs mt-1.5">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400">
                        <th className="text-left py-1.5 font-extrabold tracking-wider uppercase text-[10px]">Prize</th>
                        <th className="text-right py-1.5 font-extrabold tracking-wider uppercase text-[10px] text-sky-300">Big win</th>
                        <th className="text-right py-1.5 font-extrabold tracking-wider uppercase text-[10px] text-pink-300">Small win</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.label} className="border-b border-slate-800/50 last:border-0">
                          <td className="py-1.5 text-slate-400 text-[11px] font-semibold">{r.label}</td>
                          <td className={`py-1.5 text-right font-mono font-bold ${leg.big > 0 && r.big != null ? 'text-sky-300' : 'text-slate-700'}`}>
                            {leg.big > 0 && r.big != null ? money(r.big * leg.big) : '—'}
                          </td>
                          <td className={`py-1.5 text-right font-mono font-bold ${leg.small > 0 && r.small != null ? 'text-pink-300' : 'text-slate-700'}`}>
                            {leg.small > 0 && r.small != null ? money(r.small * leg.small) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {leg.type === 'system' && (
                    <p className="text-[11px] text-slate-500 leading-relaxed mt-1">
                      Shown per arrangement-placing-1st: any one arrangement taking a tier pays the amount above.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* REPLAY */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
        <h2 className="text-base font-bold text-white">How this slip has done</h2>
        <p className="text-slate-500 text-xs leading-relaxed mt-0.5">
          All bets combined, replayed automatically against our archive{days > 1 ? ' — per-draw stakes' : ''}.
        </p>
        <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3.5 mt-3">
          <div className="flex justify-between items-baseline gap-2">
            <span className="text-[11px] font-extrabold tracking-wider uppercase text-slate-500">
              {replayResult.drawsPlayed} archived draws
            </span>
            <span className={`text-lg font-extrabold ${replayResult.net < 0 ? 'text-rose-400' : 'text-emerald-300'}`}>
              {replayResult.net < 0 ? '–' : '+'}{money(Math.abs(replayResult.net))}
            </span>
          </div>
          <div className="text-xs text-slate-400 leading-relaxed mt-1 border-t border-slate-800/60 pt-2">
            {hasActive
              ? <>staked <b className="text-slate-200">{money(replayResult.staked)}</b>{' '}
                ({money(replayResult.staked / replayResult.drawsPlayed)} × {replayResult.drawsPlayed}), would have
                won <b className="text-slate-200">{money(replayResult.won)}</b>.</>
              : 'Add an active bet to see the replay.'}
          </div>
        </div>
        {hasActive && (
          replayResult.perDraw.length ? (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {replayResult.perDraw.slice(0, 12).map(h => (
                <span key={h.drawNo} className="text-[11px] font-bold border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 px-2.5 py-1 rounded-full">
                  #{h.drawNo} · {money(h.won)}
                </span>
              ))}
              {replayResult.perDraw.length > 12 && (
                <span className="text-[11px] text-slate-500 self-center">+{replayResult.perDraw.length - 12} more winning draws</span>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-500 mt-3">
              No wins in the archive — typical: most slips don't hit. The archive grows to ~470 draws automatically.
            </p>
          )
        )}
        <p className="text-[11px] text-slate-500 leading-relaxed mt-3">{replayResult.honestLine}</p>
      </div>

      {/* BUDGET CHECK */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
        <h2 className="text-base font-bold text-white">Budget check</h2>
        <p className="text-slate-500 text-xs leading-relaxed mt-0.5">
          Mirrors your bets automatically — currently{' '}
          <b className="text-emerald-300">{money(summary.costPerDraw)} per draw</b>. Pick a style to rebalance
          the same money across your bets (bet types are never changed for you).
        </p>
        <div className="flex flex-wrap gap-1.5 mt-3">
          {STYLE_CHIPS.map(c => (
            <Chip key={c.id} onClick={() => rebalance(c.id)}>{c.label}</Chip>
          ))}
        </div>
        {budgetNote && <p className="text-xs text-slate-400 leading-relaxed mt-3">{budgetNote}</p>}
        {addIbetAmt != null && (
          <button
            onClick={() => { setLegs(ls => [...ls, { type: 'ibet', big: addIbetAmt, small: 0 }]); setAddIbetAmt(null); setBudgetNote('iBet bet added — amounts updated above.'); }}
            className="mt-3 text-xs font-bold text-emerald-300 border border-dashed border-emerald-800 bg-slate-950/60 hover:bg-emerald-900/30 px-3 py-1.5 rounded-full transition">
            ＋ add an iBet bet at ${addIbetAmt}
          </button>
        )}
      </div>

      {/* post-v1 placeholder */}
      <div className="border border-dashed border-slate-800 rounded-xl px-3 py-3 text-center text-xs text-slate-600">
        ＋ add another number — each number gets its own bets &amp; results (v2)
      </div>

    </div>
  );
}

// ---------- TAB 2: Insights & Fairness --------------------------------------

function FrequencyBars({ counts, accent }) {
  const max = Math.max(...counts, 1);
  return (
    <div className="flex items-end gap-1 h-20">
      {counts.map((c, d) => (
        <div key={d} className="flex-1 flex flex-col items-center gap-1 min-w-0">
          <div className="text-[9px] font-mono text-slate-500">{c}</div>
          <div
            className={`w-full rounded-t ${accent}`}
            style={{ height: `${Math.max(4, (c / max) * 56)}px` }}
            title={`digit ${d}: ${c}`}
          />
          <div className="text-[9px] font-mono text-slate-400">{d}</div>
        </div>
      ))}
    </div>
  );
}

function FunCard({ draws }) {
  // Explicitly-labelled entertainment. Labelled because it must never read as an edge.
  const rows = draws.filter(d => !d.isSweepDay);
  const tally = {};
  for (const d of rows) {
    for (const n of [d['1st'], d['2nd'], d['3rd'], ...(d.starter || []), ...(d.consolation || [])]) {
      tally[n] = (tally[n] || 0) + 1;
    }
  }
  const entries = Object.entries(tally);
  const [topNumber, topCount] = entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || ['—', 0];
  const freq = digitFrequencies(draws);
  const hottest = freq.first.indexOf(Math.max(...freq.first));
  const coldest = freq.first.indexOf(Math.min(...freq.first));
  return (
    <div className="bg-slate-900 border border-fuchsia-800/50 rounded-xl p-5 shadow-xl space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-bold text-white">🎯 Number outlook</h3>
        <VerdictBadge kind="watch" title="This card is entertainment. These patterns have no predictive power.">
          For fun — not prediction
        </VerdictBadge>
      </div>
      <p className="text-xs text-slate-400 leading-relaxed">
        The classic lottery-chat favourites, computed from the {rows.length} loaded non-sweep draws.
        They are patterns of the <em>past</em>: every number enters the next draw with exactly the same
        odds (1 in 10,000 for 1st prize), and these counts do not change that by a single cent.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Stat label="Most-seen number" value={topNumber} sub={`${topCount}× in the archive`} accent="text-fuchsia-300" />
        <Stat label="'Hottest' 1st digit" value={String(hottest)} sub="most often in 1st prize" accent="text-fuchsia-300" />
        <Stat label="'Coldest' 1st digit" value={String(coldest)} sub="least often in 1st prize" accent="text-fuchsia-300" />
      </div>
      <p className="text-[11px] text-slate-500 leading-relaxed">
        Labels in quotes because 'hot' and 'cold' are superstition, not statistics — a fair draw has no memory.
      </p>
    </div>
  );
}

function EdgeTesterPanel() {
  const [state, setState] = useState({ status: 'loading', report: null, errors: null });
  useEffect(() => {
    let cancelled = false;
    fetch('4d_signal_report.json')
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(report => { if (!cancelled) setState({ status: 'loaded', report }); })
      .catch(() => { if (!cancelled) setState({ status: 'missing', report: null }); });
    return () => { cancelled = true; };
  }, []);

  const verdictKind = { 'no-edge': 'good', inconclusive: 'watch', suspicious: 'bad' };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 md:p-6 shadow-xl space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-bold text-white">Edge Tester</h2>
        <span className="text-[10px] bg-slate-800 text-slate-400 border border-slate-700 px-2 py-0.5 rounded-full font-semibold">
          walk-forward only · uniform baseline · FDR-corrected
        </span>
      </div>
      <p className="text-xs text-slate-400 leading-relaxed max-w-3xl">
        Three models (digit frequencies, Markov transitions, a small neural net) are tested the only
        honest way: each draw is predicted using <em>only earlier draws</em>, scored against a uniform
        chance baseline, with calibration checks and multiple-testing correction. The fixed odds are
        unaffected by the result either way.
      </p>

      {state.status === 'loading' && <div className="text-xs text-slate-500">Checking for the latest battery report…</div>}

      {state.status === 'missing' && (
        <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-4 text-xs text-slate-400 leading-relaxed space-y-1.5">
          <div className="font-bold text-slate-300">No battery report published yet.</div>
          <div>
            The Edge Tester runs offline (<code className="bg-slate-800 px-1 rounded text-emerald-300">scripts/signal_lab.py</code>)
            after each data refresh in CI and publishes <code className="bg-slate-800 px-1 rounded text-emerald-300">4d_signal_report.json</code> here.
            With only the {FOURD_SEED_DRAWS.length} seeded draws the battery honestly reports
            “inconclusive — not enough data”; the full 470-draw archive gives it real power.
          </div>
        </div>
      )}

      {state.status === 'loaded' && (() => {
        const v = validateReport(state.report);
        if (!v.ok) {
          return (
            <div className="bg-rose-950/40 border border-rose-800/60 rounded-lg p-4 text-xs text-rose-200">
              The published report failed the contract check (walk-forward + uniform baseline + calibration +
              FDR mandatory) and is withheld: {v.errors.join('; ')}.
            </div>
          );
        }
        const r = state.report;
        return (
          <div className="space-y-4">
            <div className={`rounded-lg p-4 border ${r.overall.verdict === 'no-edge' ? 'bg-emerald-950/40 border-emerald-800/60' : r.overall.verdict === 'inconclusive' ? 'bg-amber-950/40 border-amber-800/60' : 'bg-rose-950/40 border-rose-800/60'}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <VerdictBadge kind={verdictKind[r.overall.verdict]}>Overall: {r.overall.verdict}</VerdictBadge>
                <span className="text-[10px] text-slate-500">
                  {r.drawsAnalyzed} draws · {Number.isFinite(Number(r.testSteps)) ? `tested ${r.testSteps} steps` : 'walk-forward'}
                  {' '}· generated {r.generatedAt || 'n/a'}
                </span>
              </div>
              <p className="text-xs text-slate-300 mt-2 leading-relaxed">{r.overall.note}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-800">
                    <th className="py-1.5 pr-3 font-semibold">Model</th>
                    <th className="py-1.5 pr-3 font-semibold text-right">Metric (model)</th>
                    <th className="py-1.5 pr-3 font-semibold text-right">Baseline</th>
                    <th className="py-1.5 pr-3 font-semibold text-right">Lift</th>
                    <th className="py-1.5 pr-3 font-semibold text-right">Accuracy</th>
                    <th className="py-1.5 pr-3 font-semibold text-right">ECE</th>
                    <th className="py-1.5 pr-3 font-semibold text-right">FDR q</th>
                    <th className="py-1.5 font-semibold">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {r.battery.map((b, i) => (
                    <tr key={i} className="border-b border-slate-800/50 text-slate-300">
                      <td className="py-1.5 pr-3 font-semibold text-white capitalize">{b.name}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{Number(b.metric.model).toFixed(4)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono text-slate-500">{Number(b.metric.baseline).toFixed(4)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{liftCopy(b.liftPct).replace(' vs uniform baseline', '')}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">
                        {Number.isFinite(Number(b.accuracy)) ? pct(b.accuracy, 1) : '—'}
                        {' '}<span className="text-slate-600">/ {Number.isFinite(Number(b.chanceAccuracy)) ? pct(b.chanceAccuracy, 0) : pct(0.1, 0)}</span>
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono">{Number(b.calibration.ece).toFixed(4)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{Number(b.fdrQ).toFixed(3)}</td>
                      <td className="py-1.5"><VerdictBadge kind={verdictKind[b.verdict]} title={verdictCopy(b.verdict)}>{b.verdict}</VerdictBadge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              How to read: log-loss <span className="text-slate-300">lower is better</span> (uniform chance = ln 10 ≈ 2.3026);
              accuracy is compared to the 10% chance rate; ECE near 0 means the model's confidence matches reality;
              FDR q is the corrected significance — <span className="text-slate-300">nothing below 0.05 should be trusted as an
              edge in a fixed-odds lottery</span>.
            </p>
          </div>
        );
      })()}
    </div>
  );
}

function InsightsTab({ draws }) {
  const stats = draws.filter(d => !d.isSweepDay);
  const freq = digitFrequencies(draws);
  const chi = chiSquareByPosition(draws);
  const buckets = [
    ['1st prize digits', freq.first, 'bg-emerald-500/70'],
    ['2nd prize digits', freq.second, 'bg-teal-500/70'],
    ['3rd prize digits', freq.third, 'bg-sky-500/70'],
    ['Starter digits', freq.starter, 'bg-slate-500/70'],
    ['Consolation digits', freq.consolation, 'bg-slate-600/70'],
  ];
  const verdictKind = { consistent: 'good', watch: 'watch', outlier: 'bad' };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 md:p-6 shadow-xl space-y-5">
        <div>
          <h2 className="text-xl font-bold text-white">Draw patterns</h2>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed">
            Digit frequencies across the {stats.length} loaded non-sweep draws — a description of what
            opened, nothing more. Sweep-day draws are excluded (they come from the Singapore Sweep, not
            the 4D machines).
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {buckets.map(([label, counts, accent]) => (
            <div key={label} className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
              <div className="text-xs font-bold text-slate-200 mb-2">{label}</div>
              <FrequencyBars counts={counts} accent={accent} />
            </div>
          ))}
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 md:p-6 shadow-xl space-y-4">
        <div>
          <h2 className="text-xl font-bold text-white">Fairness check — chi-square by digit position</h2>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed max-w-3xl">
            Under fair machines each digit position is uniform over 0–9. The chi-square test asks whether
            the loaded draws deviate more than chance would allow (9 degrees of freedom). A “consistent”
            verdict is the expected, boring result — which is exactly what a fair lottery should produce.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-800">
                <th className="py-1.5 pr-3 font-semibold">Position</th>
                <th className="py-1.5 pr-3 font-semibold text-right">Digits counted</th>
                <th className="py-1.5 pr-3 font-semibold text-right">χ²</th>
                <th className="py-1.5 pr-3 font-semibold text-right">df</th>
                <th className="py-1.5 pr-3 font-semibold text-right">p-value</th>
                <th className="py-1.5 font-semibold">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {chi.map(c => (
                <tr key={c.position} className="border-b border-slate-800/50 text-slate-300">
                  <td className="py-1.5 pr-3 font-semibold text-white">{POSITION_LABELS[c.position]}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{c.digitCount}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{c.chi2.toFixed(2)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{c.df}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{c.p >= 0.001 ? c.p.toFixed(4) : c.p.toExponential(2)}</td>
                  <td className="py-1.5">
                    <VerdictBadge kind={verdictKind[c.verdict]} title={`p ≥ 0.05 consistent · p ≥ 0.01 watch · p < 0.01 outlier`}>
                      {c.verdict}
                    </VerdictBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {stats.length < 30 && (
          <div className="text-[11px] text-amber-300/90 bg-amber-950/30 border border-amber-800/50 rounded-lg p-3">
            Only {stats.length} non-sweep draws are loaded — these tests are underpowered at this size and
            become meaningful with the full 470-draw archive.
          </div>
        )}
      </div>

      <FunCard draws={draws} />
      <EdgeTesterPanel />
    </div>
  );
}

// ---------- TAB 4: Data & Sync ----------------------------------------------

const FOURD_CSV_HEADER = ['drawNo', 'date', 'isSweepDay', 'd1st', 'd2nd', 'd3rd',
  ...Array.from({ length: 10 }, (_, i) => `s${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `c${i + 1}`)];

// Parse + validate rows in the parse_4d.py CSV schema. Returns
// { draws, skipped, error } — rows are validated (23 four-digit numbers, no
// duplicates off sweep days) and never silently accepted.
function parse4dCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) return { draws: [], skipped: 0, error: 'CSV needs a header and at least one draw row.' };
  const draws = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));
    if (cols.length !== FOURD_CSV_HEADER.length) { skipped++; continue; }
    const drawNo = parseInt(cols[0], 10);
    const date = cols[1];
    if (!Number.isInteger(drawNo) || !/^\d{2} [A-Za-z]{3} \d{4}$/.test(date)) { skipped++; continue; }
    const isSweepDay = cols[2] === 'true' ? true : cols[2] === 'false' ? false : isSweepDay(date);
    const nums = cols.slice(3);
    if (!nums.every(n => /^\d{4}$/.test(n))) { skipped++; continue; }
    if (!isSweepDay && new Set(nums).size !== 23) { skipped++; continue; }
    draws.push({
      drawNo, date, isSweepDay,
      '1st': nums[0], '2nd': nums[1], '3rd': nums[2],
      starter: nums.slice(3, 13), consolation: nums.slice(13, 23),
    });
  }
  if (draws.length === 0) return { draws, skipped, error: 'No valid 4D draw rows found. Expected the parse_4d.py schema: drawNo,date,isSweepDay,d1st,d2nd,d3rd,s1..s10,c1..c10.' };
  return { draws, skipped, error: null };
}

function DataTab({ customDraws, onImport, source = 'seed' }) {
  const fileRef = React.useRef(null);
  const [raw, setRaw] = useState('');
  const [message, setMessage] = useState(null); // { kind: 'ok'|'err', text }

  const active = customDraws ?? FOURD_SEED_DRAWS;
  const newest = [...active].sort((a, b) => b.drawNo - a.drawNo)[0];

  const importText = (text) => {
    const { draws, skipped, error } = parse4dCsv(text);
    if (error) { setMessage({ kind: 'err', text: error }); return; }
    onImport(draws);
    setMessage({
      kind: 'ok',
      text: `Merged ${draws.length} validated draw${draws.length === 1 ? '' : 's'}${skipped ? ` · ${skipped} invalid row${skipped === 1 ? '' : 's'} skipped` : ''}. Existing draws are never dropped.`,
    });
  };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setRaw(ev.target.result); importText(ev.target.result); };
    reader.readAsText(file);
    e.target.value = '';
  };

  const exportCsv = () => {
    const rows = [...active].sort((a, b) => b.drawNo - a.drawNo).map(d => [
      d.drawNo, d.date, (d.isSweepDay ?? isSweepDay(d.date)) ? 'true' : 'false',
      d['1st'], d['2nd'], d['3rd'],
      ...(d.starter || []), ...(d.consolation || []),
    ].join(','));
    const blob = new Blob([[FOURD_CSV_HEADER.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '4d_official.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">

      {message && (
        <div className={`p-3 rounded-lg text-xs border ${message.kind === 'err'
          ? 'bg-rose-950/40 border-rose-800 text-rose-300'
          : 'bg-emerald-950/40 border-emerald-800 text-emerald-300'}`}>
          {message.text}
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl">
        <h2 className="text-xl font-bold text-white">Database status</h2>
        <p className="text-xs text-slate-400 mt-1">The 4D archive this analyzer is currently running on.</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
          <Stat label="Draws loaded" value={String(active.length)} accent="text-emerald-300" />
          <Stat label="Newest draw" value={newest ? `#${newest.drawNo}` : '—'} sub={newest?.date} />
          <Stat label="Source" value={source === 'hosted' ? 'Hosted archive' : source === 'imported' ? 'Imported merge' : 'Seed snapshot'} sub={source === 'seed' ? 'build-time embed' : 'merged over embed'} />
          <Stat label="Sweep days" value={String(active.filter(d => d.isSweepDay ?? isSweepDay(d.date)).length)} sub="flagged in schema" />
        </div>
        <div className="mt-4 bg-slate-950/60 border border-slate-800 rounded-lg p-3 text-xs text-slate-400 leading-relaxed">
          The seeded snapshot holds the {FOURD_SEED_DRAWS.length} most recent draws at build time. On open, this page
          fetches the full official archive hosted by the scheduled pipeline below (rolling 3 years, currently
          5058 → 5527) and merges it over the embed; you can also import or paste CSV data and it merges with what is loaded.
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl space-y-5">
        <div>
          <h3 className="text-lg font-bold text-white">Import 4D data</h3>
          <p className="text-xs text-slate-400 mt-1">
            Load the <code className="bg-slate-800 px-1 py-0.5 rounded border border-slate-700 text-emerald-300 font-mono">4d_official.csv</code>{' '}
            produced by <code className="bg-slate-800 px-1 py-0.5 rounded border border-slate-700 text-emerald-300 font-mono">parse_4d.py</code>, or paste rows below.
            Every row is validated (23 four-digit numbers; duplicates only allowed on flagged sweep days).
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed border-slate-700 hover:border-emerald-500/80 rounded-xl p-8 text-center bg-slate-950/40 cursor-pointer transition flex flex-col items-center justify-center space-y-3">
            <input type="file" ref={fileRef} onChange={handleFile} accept=".csv,.txt" className="hidden" />
            <div className="w-12 h-12 bg-emerald-500/10 text-emerald-400 rounded-full flex items-center justify-center text-xl font-bold">📂</div>
            <div className="text-sm font-semibold text-slate-200">Click to select CSV file</div>
            <span className="text-xs text-slate-500">Schema: drawNo, date, isSweepDay, d1st, d2nd, d3rd, s1–s10, c1–c10</span>
          </div>
          <div className="space-y-2">
            <label className="text-xs text-slate-400 font-semibold uppercase">Or paste raw CSV data:</label>
            <textarea rows={6} value={raw} onChange={(e) => setRaw(e.target.value)}
              placeholder={`${FOURD_CSV_HEADER.join(',')}&#10;5519,12 Aug 2026,false,1234,5678,9012,…`}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs font-mono text-slate-300 focus:outline-none focus:border-emerald-500" />
            <button onClick={() => importText(raw)} disabled={!raw.trim()}
              className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-lg text-sm font-semibold transition">
              Validate &amp; merge pasted rows
            </button>
          </div>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl space-y-5">
        <div>
          <h3 className="text-lg font-bold text-white">Auto-refresh pipeline</h3>
          <p className="text-xs text-slate-400 mt-1">How this archive grows without anyone touching it.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-slate-950/50 border border-slate-800/80 p-5 rounded-xl flex flex-col items-start justify-between gap-4 h-full">
            <div>
              <h4 className="text-sm font-bold text-slate-200 flex items-center gap-2">🗓️ Scheduled fetch (CI)</h4>
              <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                GitHub Actions runs <code className="bg-slate-800 px-1 rounded text-emerald-300">parse_4d.py</code> on
                Wed/Sat/Sun evenings (Singapore time) after each draw, appending only new draws — old records are never
                rewritten. Sweep-day detection is built into the schema, and the Edge Tester battery re-runs on the
                grown archive automatically.
              </p>
            </div>
            <div className="text-[11px] text-slate-500 leading-relaxed">
              Draws live at one URL each on the official site; the browser cannot fetch them directly (CORS), so the
              pipeline runs server-side and commits the refreshed CSV/JSON.
            </div>
          </div>
          <div className="bg-slate-950/50 border border-slate-800/80 p-5 rounded-xl flex flex-col items-start justify-between gap-4 h-full">
            <div>
              <h4 className="text-sm font-bold text-slate-200 flex items-center gap-2">💾 Export dataset</h4>
              <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                Download the currently loaded database (seed + anything you imported) in the exact pipeline schema.
              </p>
            </div>
            <button onClick={exportCsv}
              className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-semibold shadow-lg shadow-emerald-600/30 transition flex justify-center items-center gap-2">
              <span>📥</span> Export to CSV
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- shell -----------------------------------------------------------

export default function FourDAnalyzer() {
  const [activeTab, setActiveTab] = useState('planner');
  const [customDraws, setCustomDraws] = useState(null); // null = seed snapshot
  const [source, setSource] = useState('seed'); // 'seed' | 'hosted' | 'imported'

  const mergeDraws = (incoming) => {
    setCustomDraws(prev => {
      const base = prev ?? FOURD_SEED_DRAWS;
      const byNo = new Map(base.map(d => [d.drawNo, d]));
      for (const d of incoming) byNo.set(d.drawNo, d); // imported rows win
      return [...byNo.values()].sort((a, b) => b.drawNo - a.drawNo);
    });
  };

  // Phase D: fetch-merge the CI-hosted official archive over the embed on
  // open (TOTO pattern; the embed stays as the offline/blocked fallback).
  useEffect(() => {
    let cancelled = false;
    fetch('4d_official.json')
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(rows => {
        if (cancelled || !Array.isArray(rows)) return;
        const valid = rows.filter(d => d && Number.isFinite(d.drawNo)
          && /^\d{4}$/.test(String(d['1st'])));
        if (valid.length) { mergeDraws(valid); setSource('hosted'); }
      })
      .catch(() => {}); // embed remains; Data & Sync explains manual import
    return () => { cancelled = true; };
  }, []);

  const activeDraws = customDraws ?? FOURD_SEED_DRAWS;
  const sweepCount = activeDraws.filter(d => d.isSweepDay ?? isSweepDay(d.date)).length;

  return (
    <div className="space-y-6">

      {/* Section header */}
      <header className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl md:text-3xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 to-teal-300">
            Singapore Pools 4D Analyzer
          </h1>
          <span className="bg-slate-800 text-slate-300 border border-slate-700 text-xs px-2.5 py-1 rounded-full font-semibold">
            {activeDraws.length} draws{sweepCount ? ` · ${sweepCount} sweep` : ''}{source === 'hosted' ? ' · hosted archive' : source === 'imported' ? ' · merged' : ' · seed snapshot'}
          </span>
        </div>
        <p className="mt-2 text-slate-400 text-sm max-w-3xl leading-relaxed">
          Exact bet math for every 4D bet type, fair-statistic insights, and a rigorously tested
          edge lab. Odds are fixed per $1 (Big 65.9¢ / Small 58.0¢ expected) and no draw
          remembers the last one. Nothing here predicts outcomes; the tools show you the true price of a bet.
        </p>
      </header>

      {/* Tab navigation: dropdown on mobile, tab row on >=sm (TOTO pattern) */}
      <div className="flex sm:hidden items-center gap-2 pb-0 w-full overflow-hidden">
        <select
          value={activeTab}
          onChange={(e) => setActiveTab(e.target.value)}
          aria-label="4D section"
          className="flex-1 min-w-0 w-full max-w-full text-center appearance-none bg-slate-900/80 border border-slate-700 rounded-xl px-4 py-3 text-base font-semibold text-slate-100 focus:outline-none focus:border-emerald-500"
        >
          {TABS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <span className="pointer-events-none -ml-8 text-slate-400 text-lg">▾</span>
      </div>
      <div className="hidden sm:flex border-b border-slate-800 gap-2 overflow-x-auto pb-1">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-5 py-3 font-semibold text-base rounded-t-xl transition-all border-b-2 flex items-center gap-2 whitespace-nowrap ${
              activeTab === t.id
                ? 'border-emerald-500 text-emerald-400 bg-slate-900/80'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900/40'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'planner' && <PlannerTab draws={activeDraws} />}
      {activeTab === 'insights' && <InsightsTab draws={activeDraws} />}
      {activeTab === 'records' && (
        <div className="space-y-4 animate-in fade-in duration-300">
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 text-xs text-slate-400">
            Showing all {activeDraws.length} loaded draws (newest first){customDraws ? ', including merged rows' : ''}. Amber badges mark
            Singapore Sweep days, whose results are Sweep-prize endings rather than machine draws; the
            official public archive (rolling 3 years, no gaps) is fetched automatically on open from the
            pipeline-hosted database.
          </div>
          {[...activeDraws].sort((a, b) => b.drawNo - a.drawNo).map(d => <DrawCard key={d.drawNo} draw={d} />)}
        </div>
      )}
      {activeTab === 'data' && <DataTab customDraws={customDraws} onImport={mergeDraws} source={source} />}

    </div>
  );
}
