import React, { useEffect, useState } from 'react';
import { FourDigitNumber, isSweepDay } from './DigitBox.jsx';

// Home dashboard: latest draw from each game + entry cards.
// Reads the hosted JSON databases (same pattern as the analyzers: relative
// fetch, graceful fallback) — deliberately NO imports from TotoAnalyzer.jsx.

function useLatestDraws() {
  const [state, setState] = useState({ toto: null, fourd: null, loading: true });
  useEffect(() => {
    let cancelled = false;
    const get = (url) =>
      fetch(url)
        .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
        .catch(() => null);
    Promise.all([get('toto_official.json'), get('4d_official.json')]).then(([t, f]) => {
      if (cancelled) return;
      const newest = (arr) => (Array.isArray(arr) && arr.length
        ? [...arr].filter(Boolean).sort((a, b) => b.drawNo - a.drawNo)
        : null);
      setState({ toto: newest(t), fourd: newest(f), loading: false });
    });
    return () => { cancelled = true; };
  }, []);
  return state;
}

function SkeletonCard() {
  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl animate-pulse">
      <div className="h-4 w-32 bg-slate-800 rounded" />
      <div className="h-10 w-48 bg-slate-800 rounded mt-4" />
      <div className="h-16 bg-slate-800/70 rounded mt-4" />
      <div className="h-10 bg-slate-800/70 rounded mt-4" />
    </div>
  );
}

function TotoBalls({ draw }) {
  return (
    <div className="flex items-center gap-2 flex-wrap mt-3">
      {draw.numbers.map(n => (
        <span key={n} className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-white font-bold flex items-center justify-center text-sm shadow-lg shadow-blue-900/40">
          {n}
        </span>
      ))}
      <span className="w-9 h-9 rounded-full bg-slate-800 border-2 border-amber-400/80 text-amber-300 font-bold flex items-center justify-center text-sm" title="Additional number">
        {draw.additional}
      </span>
    </div>
  );
}

function GameCard({ game }) {
  const isToto = game.id === 'toto';
  const accentText = isToto ? 'text-blue-300' : 'text-emerald-300';
  const accentBorder = isToto ? 'hover:border-blue-500/60' : 'hover:border-emerald-500/60';
  const ctaClass = isToto
    ? 'bg-blue-600 hover:bg-blue-500 shadow-blue-600/30'
    : 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/30';
  const d = game.latest;
  return (
    <div className={`bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl transition ${accentBorder}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className={`text-lg font-bold ${accentText}`}>{isToto ? '🎱 TOTO Analyzer' : '🔢 4D Analyzer'}</h2>
        {game.count > 0 && (
          <span className="text-xs bg-slate-800 text-slate-300 px-2.5 py-1 rounded-full border border-slate-700">
            {game.count} draws
          </span>
        )}
      </div>

      {d ? (
        <div className="mt-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Latest</span>
            <span className="text-sm font-bold text-white">Draw {d.drawNo}</span>
            <span className="text-xs text-slate-500">{d.date}</span>
            {!isToto && (d.isSweepDay ?? isSweepDay(d.date)) && (
              <span
                className="text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded-full font-semibold"
                title="Singapore Sweep day: these results are the last 4 digits of Sweep prizes, not machine draws — excluded from fairness statistics."
              >
                Sweep day
              </span>
            )}
          </div>
          {isToto ? (
            <TotoBalls draw={d} />
          ) : (
            <div className="mt-3 space-y-2">
              {[['1st', d['1st'], 'emerald'], ['2nd', d['2nd'], 'slate'], ['3rd', d['3rd'], 'slate']].map(([label, val, accent]) => (
                <div key={label} className="flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-8 font-semibold">{label}</span>
                  <FourDigitNumber value={val} accent={accent} />
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="mt-4 text-sm text-slate-500">Hosted database unavailable (offline or fetch blocked).</p>
      )}

      <button
        onClick={() => game.onOpen()}
        className={`mt-5 w-full py-2.5 text-white rounded-xl text-sm font-semibold shadow-lg transition ${ctaClass}`}
      >
        Open {isToto ? 'TOTO' : '4D'} Analyzer →
      </button>
    </div>
  );
}

export default function HomePage({ onNavigate }) {
  const { toto, fourd, loading } = useLatestDraws();

  const totoLatest = toto ? toto[0] : null;
  const fourdLatest = fourd ? fourd[0] : null;
  const offline = !loading && !totoLatest && !fourdLatest;

  return (
    <div className="space-y-6 animate-in fade-in duration-300">

      {offline && (
        <div className="p-3 rounded-xl text-xs border bg-rose-950/40 border-rose-800 text-rose-300">
          Could not load the hosted databases. The analyzers still work from their embedded snapshots.
        </div>
      )}

      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <h1 className="text-2xl md:text-3xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 via-indigo-400 to-emerald-400">
          Singapore Pools Analyzer
        </h1>
        <p className="mt-2 text-slate-400 text-sm max-w-3xl leading-relaxed">
          One analyzer, two games. Exact bet math, historical records, and honest statistics —
          no prediction, no tips: draws are independent and the odds never change.
        </p>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SkeletonCard /><SkeletonCard />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <GameCard game={{ id: 'toto', latest: totoLatest, count: toto ? toto.length : 0, onOpen: () => onNavigate('toto') }} />
          <GameCard game={{ id: '4d', latest: fourdLatest, count: fourd ? fourd.length : 0, onOpen: () => onNavigate('4d') }} />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-lg">
          <span className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Bet Calculator</span>
          <p className="text-sm text-slate-300 mt-1">Exact cost, prize, probability, EV and variance for any slip — Ordinary, System, iBet, 4D Roll.</p>
        </div>
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-lg">
          <span className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Honest statistics</span>
          <p className="text-sm text-slate-300 mt-1">Fairness-audited patterns and a rigorous edge tester — walk-forward, baseline-compared, published either way.</p>
        </div>
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-lg">
          <span className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Real records</span>
          <p className="text-sm text-slate-300 mt-1">Official draw databases that refresh themselves — no fabricated numbers, ever.</p>
        </div>
      </div>

      <p className="text-xs text-slate-500 text-center">
        Both analyzers are live: exact bet math, fair-statistic insights and an edge lab that publishes its
        (empty) findings. The 4D archive grows itself — official draws fetch in on schedule after every draw.
      </p>

    </div>
  );
}
