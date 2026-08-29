import React, { useEffect, useMemo, useState } from 'react';
import { FourDigitNumber, isSweepDay } from '../shell/DigitBox.jsx';
import { FOURD_SEED_DRAWS } from './seedDraws.js';
import { ORDINARY_PRIZES, IBET_PRIZES } from '../engines/fourd/constants.js';
import {
  permCount, ibetGroup, permutationsOf, rollNumbers,
  slipCost, nextDrawProbabilities,
  portfolioStats,
} from '../engines/fourd/betMath.js';
import { digitFrequencies, chiSquareByPosition, numberInsights } from '../engines/fourd/drawStats.js';
import { MODES, plan } from '../engines/fourd/budgetPlanner.js';
import { replay } from '../engines/fourd/testBench.js';
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

const POOL_LABELS = { big: 'Big', small: 'Small' };
const POSITION_LABELS = ['1st digit', '2nd digit', '3rd digit', '4th digit'];
const TIER_LABELS = { first: '1st prize', second: '2nd prize', third: '3rd prize', starter: 'Starter', consolation: 'Consolation' };

// ---------- formatting helpers (display only — values come from engines) ----

const money = (n) => '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2));
const cents = (n) => `${(n * 100).toFixed(1)}¢`;
const pct = (p, dp = 2) => `${(p * 100).toFixed(dp)}%`;
const pad4 = (s) => String(s || '').padStart(4, '0');

function RtpBanner({ ev, cost, absoluteLoss }) {
  // The house-edge banner the quality bar requires on every calculator screen.
  // Both inputs come from engine functions. `cost` is the per-draw (or whole-
  // plan) outlay the RTP is measured against; the per-$1 loss is 1 − RTP, and
  // the absolute expected loss is passed separately when the caller wants the
  // whole-slip figure shown too.
  if (!(cost > 0) || !Number.isFinite(ev)) return null;
  const rtp = ev / cost;
  const lossPerDollar = 1 - rtp;
  return (
    <div className="bg-amber-950/40 border border-amber-800/70 rounded-xl p-3 text-xs text-amber-200 leading-relaxed">
      <span className="font-bold">Fixed odds:</span> expected return {cents(rtp)} per $1 staked
      (RTP {pct(rtp, 1)}) · expected loss {cents(lossPerDollar)} per $1 per draw
      {Number.isFinite(absoluteLoss) && absoluteLoss > 0.005
        ? <> · {money(absoluteLoss)} on this slip</>
        : null}. Every 4D bet type prices within ±0.7% of its pool's figure — the house edge
      does not move.
    </div>
  );
}

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

// ---------- inputs ----------------------------------------------------------

function NumberInput({ value, onChange, label = '4-digit number', id }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{label}</span>
      <input
        id={id}
        value={value}
        inputMode="numeric"
        autoComplete="off"
        placeholder="0000"
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 4))}
        className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 font-mono text-lg tracking-[0.35em] text-white focus:outline-none focus:border-emerald-500"
      />
      {value.length > 0 && value.length < 4 && (
        <span className="text-[10px] text-amber-300/80 mt-0.5 block">
          pricing {pad4(value)} — add {4 - value.length} more digit{4 - value.length === 1 ? '' : 's'}
        </span>
      )}
    </label>
  );
}

function Select({ label, value, onChange, options, id }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{label}</span>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
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

// ---------- TAB 1: Bet & Planner --------------------------------------------

const DEFAULT_CANDIDATES = [
  { number: '1234', betType: 'ibet', pool: 'big' },
  { number: '5678', betType: 'ordinary', pool: 'big' },
  { number: '9012', betType: 'system', pool: 'big' },
];

function PlannerTab({ draws }) {
  // The plan → price → test journey, all fed by the engines.
  const [budget, setBudget] = useState(10);
  const [mode, setMode] = useState('max_hit');
  const [candidates, setCandidates] = useState(DEFAULT_CANDIDATES);
  const [draft, setDraft] = useState({ number: '', betType: 'ordinary', pool: 'big', position: '0' });
  const [result, setResult] = useState(null);

  // Bet Calculator state (section 2)
  const [calc, setCalc] = useState({ number: '1234', betType: 'ibet', pool: 'big', stake: 1, drawDays: 1, position: '0' });

  // Replay scope: the latest allocation, or the raw candidates if none yet.
  const [replayExcludeSweep, setReplayExcludeSweep] = useState(false);

  const addCandidate = () => {
    if (draft.number.length !== 4) return;
    const entry = draft.betType === 'roll'
      ? { number: draft.number, betType: 'roll', pool: draft.pool, position: Number(draft.position) }
      : { number: draft.number, betType: draft.betType, pool: draft.pool };
    setCandidates(cs => [...cs, entry]);
    setDraft(d => ({ ...d, number: '' }));
  };

  const runPlan = () => {
    setResult(plan({ budget, candidates, mode }));
  };

  const replaySource = (result?.allocation?.length ? result.allocation : candidates)
    .map(e => ({ ...e, stake: 1 }));
  const replayResult = useMemo(
    () => replay({ entries: replaySource, draws, excludeSweep: replayExcludeSweep }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(replaySource), draws, replayExcludeSweep],
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-300">

      {/* --- Budget allocator hero --- */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 md:p-6 shadow-xl space-y-5">
        <div>
          <h2 className="text-xl font-bold text-white">Budget Planner</h2>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed">
            Split a per-draw budget across your numbers and bet types. Every mode has the same
            expected return per $1 — they change the <em>shape</em> of the outcome (hit frequency vs
            swing size), never the odds.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="space-y-4">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Budget per draw ($)</span>
              <input
                type="number" min={1} step={1} value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-lg font-mono text-white focus:outline-none focus:border-emerald-500"
              />
            </label>

            <div className="grid grid-cols-2 gap-2">
              {Object.values(MODES).map(m => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={`text-left rounded-lg border p-2.5 transition ${mode === m.id
                    ? 'border-emerald-500 bg-emerald-500/10'
                    : 'border-slate-800 bg-slate-950/50 hover:border-slate-600'}`}
                >
                  <div className={`text-xs font-bold ${mode === m.id ? 'text-emerald-300' : 'text-slate-200'}`}>{m.label}</div>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed -mt-1">{MODES[mode].blurb}</p>
          </div>

          <div className="space-y-3">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Your numbers × bet types</div>
            <div className="flex flex-wrap gap-1.5 min-h-8">
              {candidates.length === 0 && <span className="text-xs text-slate-600">Add at least one entry below.</span>}
              {candidates.map((c, i) => (
                <span key={`${c.number}-${c.betType}-${c.pool}-${c.position ?? 'x'}-${i}`}
                  className="inline-flex items-center gap-1.5 bg-slate-800 border border-slate-700 rounded-full pl-2.5 pr-1.5 py-1 text-xs text-slate-200">
                  <span className="font-mono tracking-wider">{pad4(c.number)}</span>
                  <span className="text-slate-400">{BET_TYPE_LABELS[c.betType]} · {POOL_LABELS[c.pool]}</span>
                  <button
                    onClick={() => setCandidates(cs => cs.filter((_, j) => j !== i))}
                    aria-label={`Remove ${c.number} ${c.betType}`}
                    className="w-4 h-4 rounded-full bg-slate-700 hover:bg-rose-600 text-slate-300 hover:text-white text-[10px] leading-none"
                  >×</button>
                </span>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumberInput label="Number" value={draft.number} onChange={(v) => setDraft(d => ({ ...d, number: v }))} />
              <Select label="Bet type" value={draft.betType} onChange={(v) => setDraft(d => ({ ...d, betType: v }))}
                options={Object.entries(BET_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
              <Select label="Pool" value={draft.pool} onChange={(v) => setDraft(d => ({ ...d, pool: v }))}
                options={Object.entries(POOL_LABELS).map(([value, label]) => ({ value, label }))} />
              {draft.betType === 'roll' && (
                <Select label="Roll position" value={draft.position} onChange={(v) => setDraft(d => ({ ...d, position: v }))}
                  options={POSITION_LABELS.map((label, i) => ({ value: String(i), label: `${label} varies` }))} />
              )}
            </div>
            <button
              onClick={addCandidate}
              disabled={draft.number.length !== 4}
              className="w-full py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white rounded-lg text-sm font-semibold transition"
            >
              + Add entry
            </button>
          </div>
        </div>

        <button
          onClick={runPlan}
          className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-sm font-bold shadow-lg shadow-emerald-600/30 transition"
        >
          Allocate ${Number(budget) || 0} · {MODES[mode].label}
        </button>

        {result && (
          <div className="border-t border-slate-800 pt-4 space-y-4">
            {result.allocation.length === 0 ? (
              <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/60 rounded-lg p-3">
                Nothing could be allocated — the budget is smaller than every entry's cost (e.g. a
                $24 System Entry needs $24). Raise the budget or pick cheaper entries.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                  <Stat label="Spent" value={money(result.cost)} sub={`unspent ${money(result.unspent)}`} accent="text-emerald-300" />
                  <Stat label="Expected return" value={money(result.ev)} sub={`${cents(result.cost ? result.ev / result.cost : 0)} per $1`} />
                  <Stat label="Outcome swing (SD)" value={money(result.sd)} sub="per draw" />
                  <Stat label="Chance of any prize" value={pct(result.pAnyPrize)} sub={`${result.distinctNumbers} distinct numbers`} accent="text-sky-300" />
                  <Stat label="Entries" value={String(result.allocation.length)} sub={MODES[result.mode].label} />
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-slate-800">
                        <th className="py-1.5 pr-3 font-semibold">Number</th>
                        <th className="py-1.5 pr-3 font-semibold">Bet type</th>
                        <th className="py-1.5 pr-3 font-semibold">Pool</th>
                        <th className="py-1.5 pr-3 font-semibold text-right">Cost</th>
                        <th className="py-1.5 font-semibold text-right">Covers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.allocation.map((a, i) => {
                        const covered = a.betType === 'roll' ? 10 : a.betType === 'system' ? permCount(a.number) : a.betType === 'ibet' ? ibetGroup(a.number) : 1;
                        return (
                          <tr key={i} className="border-b border-slate-800/50 text-slate-300">
                            <td className="py-1.5 pr-3 font-mono tracking-wider text-white">{pad4(a.number)}</td>
                            <td className="py-1.5 pr-3">{BET_TYPE_LABELS[a.betType]}{a.betType === 'roll' ? ` (${POSITION_LABELS[a.position ?? 0]})` : ''}</td>
                            <td className="py-1.5 pr-3">{POOL_LABELS[a.pool]}</td>
                            <td className="py-1.5 pr-3 text-right font-mono">{money(a.cost)}</td>
                            <td className="py-1.5 text-right font-mono text-slate-400">{covered}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <RtpBanner ev={result.ev} cost={result.cost} absoluteLoss={result.cost - result.ev} />
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  {result.note} {result.honestLine}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {/* --- Bet Calculator --- */}
      <BetCalculator calc={calc} setCalc={setCalc} />

      {/* --- Next Draw card (chosen bet priced for the next draw + archive context) --- */}
      <NextDrawCard number={calc.number} draws={draws} calc={calc} />

      {/* --- Test My Numbers --- */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 md:p-6 shadow-xl space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-xl font-bold text-white">Test My Numbers</h2>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed max-w-2xl">
              Replays {result?.allocation?.length ? 'your allocated plan' : 'your entry list'} against the{' '}
              {replayResult.drawsPlayed} loaded draws. This describes the past — it has no bearing on the next draw.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
            <input type="checkbox" checked={replayExcludeSweep} onChange={(e) => setReplayExcludeSweep(e.target.checked)}
              className="accent-emerald-500 w-4 h-4" />
            Exclude sweep-day draws
          </label>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          <Stat label="Draws replayed" value={String(replayResult.drawsPlayed)} />
          <Stat label="Total staked" value={money(replayResult.staked)} />
          <Stat label="Total won" value={money(replayResult.won)} accent="text-emerald-300" />
          <Stat label="Net result" value={money(replayResult.net)}
            accent={replayResult.net >= 0 ? 'text-emerald-300' : 'text-rose-300'} />
          <Stat label="Historical RTP" value={replayResult.staked ? pct(replayResult.rtp, 1) : '—'}
            sub="won ÷ staked" />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-800">
                <th className="py-1.5 pr-3 font-semibold">Number</th>
                <th className="py-1.5 pr-3 font-semibold">Bet type</th>
                <th className="py-1.5 pr-3 font-semibold text-right">Staked</th>
                <th className="py-1.5 pr-3 font-semibold text-right">Won</th>
                <th className="py-1.5 pr-3 font-semibold text-right">Net</th>
                <th className="py-1.5 pr-3 font-semibold text-right">Hits</th>
                <th className="py-1.5 font-semibold">Best hit</th>
              </tr>
            </thead>
            <tbody>
              {replayResult.perEntry.map((e, i) => (
                <tr key={i} className="border-b border-slate-800/50 text-slate-300">
                  <td className="py-1.5 pr-3 font-mono tracking-wider text-white">{pad4(e.number)}</td>
                  <td className="py-1.5 pr-3">
                    {BET_TYPE_LABELS[e.betType]}
                    {e.betType === 'roll' ? ` (${POSITION_LABELS[e.position ?? 0]})` : ''}
                    {e.notOffered && (
                      <span className="ml-1.5 text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/40 rounded px-1.5 py-0.5">
                        not offered on this number (clause 2.5)
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono">{money(e.staked)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{money(e.won)}</td>
                  <td className={`py-1.5 pr-3 text-right font-mono ${e.net >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{money(e.net)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{e.hitCount}</td>
                  <td className="py-1.5 text-slate-400">
                    {e.hits[0] ? <>#{e.hits[0].drawNo} · {money(e.hits[0].amount)}</> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-500 leading-relaxed">{replayResult.honestLine}</p>
      </div>
    </div>
  );
}

// The calculator: exact cost, prize table, EV/SD and probabilities for one
// entry — every figure read from an engine function.
function BetCalculator({ calc, setCalc }) {
  const number = pad4(calc.number); // partial input prices its padded value ('567' -> '0567')
  const position = Number(calc.position) || 0;
  const entry = {
    number,
    betType: calc.betType,
    pool: calc.pool,
    stake: Math.max(1, Math.round(Number(calc.stake) || 1)),
    position,
  };
  const days = Math.max(1, Math.round(Number(calc.drawDays) || 1));
  const cost = slipCost({ ...entry, drawDays: days });
  const notOffered = cost === null;
  const stats = notOffered ? null : portfolioStats([entry]);

  const prizeTable = calc.betType === 'ibet' && ibetGroup(number) !== null
    ? IBET_PRIZES[ibetGroup(number)][calc.pool]
    : ORDINARY_PRIZES[calc.pool];

  const tierNote = {
    ordinary: 'Pays the published prize if your exact number places.',
    system: 'Pays the Ordinary prize once per placing permutation.',
    ibet: 'Pays the published iBet table when any permutation places.',
    roll: 'Ten Ordinary entries — every digit at the chosen position.',
  }[calc.betType];

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 md:p-6 shadow-xl space-y-5">
      <div>
        <h2 className="text-xl font-bold text-white">Bet Calculator</h2>
        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
          Exact pricing for a single slip — cost, full prize table, expected value and outcome swing.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <NumberInput label="Number" value={calc.number} onChange={(v) => setCalc(c => ({ ...c, number: v }))} />
        <Select label="Bet type" value={calc.betType} onChange={(v) => setCalc(c => ({ ...c, betType: v }))}
          options={Object.entries(BET_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
        <Select label="Pool" value={calc.pool} onChange={(v) => setCalc(c => ({ ...c, pool: v }))}
          options={Object.entries(POOL_LABELS).map(([value, label]) => ({ value, label }))} />
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Stake ($/draw)</span>
          <input type="number" min={1} step={1} value={calc.stake}
            onChange={(e) => setCalc(c => ({ ...c, stake: e.target.value }))}
            className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 font-mono text-sm text-white focus:outline-none focus:border-emerald-500" />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Draws entered</span>
          <input type="number" min={1} step={1} value={calc.drawDays}
            onChange={(e) => setCalc(c => ({ ...c, drawDays: e.target.value }))}
            className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 font-mono text-sm text-white focus:outline-none focus:border-emerald-500" />
        </label>
      </div>

      {calc.betType === 'roll' && (
        <Select label="4D Roll position (the digit that varies)" value={calc.position}
          onChange={(v) => setCalc(c => ({ ...c, position: v }))}
          options={POSITION_LABELS.map((label, i) => ({ value: String(i), label: `${label} varies` }))} />
      )}

      {notOffered ? (
        <div className="bg-rose-950/40 border border-rose-800/60 rounded-xl p-4 text-xs text-rose-200 leading-relaxed space-y-1">
          <div className="font-bold text-rose-100">{BET_TYPE_LABELS[calc.betType]} is not offered on {number}.</div>
          <div>{numberInsights(number, [FOURD_SEED_DRAWS[0]]).betAdvice}</div>
          <div className="text-rose-300/80">Game rules clause 2.5: iBet and System Entry are unavailable on
            single-permutation numbers (0000–9999). Bet it Ordinary instead.</div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            <Stat label="Slip cost" value={money(cost)} accent="text-emerald-300"
              sub={`${entry.stake} × ${calc.drawDays} draw${Number(calc.drawDays) > 1 ? 's' : ''}${calc.betType === 'system' ? ` × ${permCount(number)} perms` : calc.betType === 'roll' ? ' × 10 numbers' : ''}`} />
            <Stat label="Expected value" value={money(stats.ev)} sub="per draw" />
            <Stat label="Outcome swing (SD)" value={money(stats.sd)} sub="per draw" />
            <Stat label="Any-prize chance" value={pct(stats.pAnyPrize)} sub={`${stats.distinctNumbers} distinct numbers`} accent="text-sky-300" />
            <Stat label="1st-prize chance" value="1 in 10,000" sub="same every draw" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-4">
              <div className="text-xs font-bold text-slate-200">{BET_TYPE_LABELS[calc.betType]} prize table — {POOL_LABELS[calc.pool]} pool, {money(entry.stake)} stake</div>
              <div className="text-[10px] text-slate-500 mt-0.5">{tierNote}</div>
              <table className="w-full text-xs mt-2">
                <tbody>
                  {['first', 'second', 'third', 'starter', 'consolation'].map(tier => (
                    <tr key={tier} className="border-b border-slate-800/50 last:border-0">
                      <td className="py-1.5 text-slate-400">{TIER_LABELS[tier]}</td>
                      <td className="py-1.5 text-right font-mono text-white">{money((prizeTable[tier] || 0) * entry.stake)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-3">
              <RtpBanner ev={stats.ev} cost={cost / days} absoluteLoss={cost - stats.ev * days} />
              {calc.betType === 'roll' && (
                <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Numbers covered ({POSITION_LABELS[position]} varies)</div>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {rollNumbers(number, position).map(n => (
                      <span key={n} className="font-mono text-[11px] bg-slate-800 text-slate-300 border border-slate-700 rounded px-1.5 py-0.5">{n}</span>
                    ))}
                  </div>
                </div>
              )}
              {calc.betType === 'system' && (
                <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Permutations covered ({permCount(number)})</div>
                  <div className="flex flex-wrap gap-1.5 mt-1.5 max-h-24 overflow-y-auto">
                    {permutationsOf(number).map(n => (
                      <span key={n} className="font-mono text-[11px] bg-slate-800 text-slate-300 border border-slate-700 rounded px-1.5 py-0.5">{n}</span>
                    ))}
                  </div>
                </div>
              )}
              {calc.betType === 'ibet' && (
                <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3 text-[11px] text-slate-400 leading-relaxed">
                  iBet prices {number} in the <span className="text-slate-200 font-semibold">{ibetGroup(number)}-permutation</span> group.
                  The published table is not prize ÷ permutations — some groups round up. One iBet stake covers all{' '}
                  {ibetGroup(number)} permutations.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
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

// Next Draw card: exact (memoryless) odds for the next draw, the chosen bet's
// exact next-draw price (engine figures), and honest descriptive archive
// context. No prediction — the odds are identical for every draw regardless
// of history.
function NextDrawCard({ number, draws, calc }) {
  const n = pad4(number); // partial input reads as its padded value
  const betType = calc?.betType || 'ordinary';
  const pool = calc?.pool || 'big';
  const stake = Math.max(1, Math.round(Number(calc?.stake) || 1));
  const position = Number(calc?.position) || 0;
  const probs = nextDrawProbabilities();
  const insights = numberInsights(n, draws);
  const expectedTxt = insights.expectedTimes < 0.1
    ? insights.expectedTimes.toFixed(3)
    : insights.expectedTimes.toFixed(2);
  const next = nextDrawDate();

  // Exact next-draw price of the calculator's chosen bet — same engine
  // functions the calculator uses (clause 2.5: slipCost is null for iBet /
  // System on one-perm numbers, and the card says so instead of quoting EV).
  const costNext = slipCost({ betType, number: n, stake, drawDays: 1 });
  const notOffered = costNext === null;
  const nextStats = notOffered
    ? null
    : portfolioStats([{ number: n, betType, pool, stake, position }]);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 md:p-6 shadow-xl space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-bold text-white">Next Draw — {n}</h2>
        <span className="text-[10px] bg-slate-800 text-slate-400 border border-slate-700 px-2 py-0.5 rounded-full font-semibold">
          exact odds · identical every draw
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="1st prize" value="1 in 10,000" sub={pct(probs.first, 4)} />
        <Stat label="Top 3 prizes" value="3 in 10,000" sub={pct(probs.top3, 4)} />
        <Stat label="Any prize (Big)" value="23 in 10,000" sub={pct(probs.anyBig)} accent="text-sky-300" />
        <Stat label="Any prize (Small)" value="3 in 10,000" sub={pct(probs.anySmall, 4)} />
      </div>

      <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-4 space-y-2 text-xs leading-relaxed">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Your bet on the next draw</div>
        {next && (
          <div className="text-slate-300">
            Draws run <span className="text-slate-200 font-semibold">Wed · Sat · Sun</span> — next draw day{' '}
            <span className="text-slate-200 font-semibold">{next.label}</span>{next.today ? ' (today)' : ''}.
            {next.sweep && (
              <> <span className="text-amber-300 font-semibold">It's a Singapore Sweep day</span> — 4D results will be
              the last 4 digits of Sweep prizes, and the draw is excluded from fairness statistics.</>
            )}
          </div>
        )}
        {notOffered ? (
          <div className="text-amber-300/90">
            {BET_TYPE_LABELS[betType]} is not offered on {n} (clause 2.5 — one-permutation number); price it
            Ordinary in the calculator above.
          </div>
        ) : (
          <div className="text-slate-300">
            A {POOL_LABELS[pool]}-pool {BET_TYPE_LABELS[betType]} on {n} at {money(stake)} per draw costs{' '}
            <span className="font-mono">{money(nextStats.cost)}</span> next draw and returns{' '}
            <span className="font-mono">{money(nextStats.ev)}</span> on average — the same fixed odds as every
            draw, whatever the history says.
          </div>
        )}
      </div>

      <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-4 space-y-2 text-xs leading-relaxed">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Archive context — descriptive, not predictive</div>
        <div className="text-slate-300">
          {n} has appeared <span className="font-bold text-white">{insights.timesSeen}×</span> in the{' '}
          {insights.drawsAnalyzed} loaded non-sweep draws. Chance expectation over that many draws is ≈{' '}
          <span className="font-mono">{expectedTxt}</span> appearances — small counts are the norm, not a signal.
        </div>
        <div className="text-slate-400">
          {insights.lastSeenDrawNo !== null
            ? <>Last seen in <span className="text-slate-200 font-semibold">draw {insights.lastSeenDrawNo}</span> ({insights.lastSeenGap === 0 ? 'the newest draw' : `${insights.lastSeenGap} draw${insights.lastSeenGap === 1 ? '' : 's'} ago`}).</>
            : 'Not among the loaded draws.'}
          {' '}Draws are independent — a long gap changes nothing about the next draw.
        </div>
        <div className="text-slate-400 border-t border-slate-800/60 pt-2">{insights.betAdvice}</div>
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
