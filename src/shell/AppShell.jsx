import React, { useEffect, useState } from 'react';
import TotoAnalyzer from '../TotoAnalyzer.jsx';
import HomePage from './HomePage.jsx';
import FourDAnalyzer from '../fourd/FourDAnalyzer.jsx';

// Game-level hash routes. Per-tab state stays inside each analyzer, so
// #/toto always reopens TOTO on its default tab (documented shell decision).
// Matches the exact first path segment — "#/toto" ≠ "#/totofoo".
function parseHash() {
  const seg = (window.location.hash || '').toLowerCase().replace(/^#\/?/, '').split('/')[0];
  if (seg === 'toto') return 'toto';
  if (seg === '4d') return '4d';
  return 'home';
}

const GAMES = [
  { id: 'home', label: 'Home', icon: '⬡' },
  { id: 'toto', label: 'TOTO', icon: '🎱' },
  { id: '4d', label: '4D', icon: '🔢' },
];

const SEGMENT_ACTIVE = {
  home: 'bg-slate-700/70 text-white shadow',
  toto: 'bg-blue-600/20 text-blue-300 border border-blue-500/40',
  '4d': 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/40',
};

class ShellErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="bg-slate-900 border border-rose-800/50 rounded-2xl p-6 text-center">
          <div className="text-2xl mb-2">⚠️</div>
          <p className="text-slate-200 font-semibold">Something broke in this view.</p>
          <p className="text-xs text-slate-400 mt-1">{String(this.state.error)}</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-4 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm font-semibold text-slate-200 transition"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function AppShell() {
  const [route, setRoute] = useState(parseHash);

  useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, '', '#/home');
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (id) => { window.location.hash = `#/${id}`; };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans p-3 sm:p-6 md:p-8 overflow-x-hidden">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* Global shell bar: brand + game switcher */}
        <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900/90 border border-slate-800 rounded-2xl px-5 py-3.5 shadow-2xl backdrop-blur-md">
          <button
            onClick={() => go('home')}
            className="text-lg font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 via-indigo-400 to-emerald-400 text-left hover:opacity-80 transition"
          >
            ⬡ SG Pools Analyzer
          </button>
          <nav className="flex items-center gap-1 bg-slate-950/60 border border-slate-800 rounded-xl p-1 self-start sm:self-auto">
            {GAMES.map(g => (
              <button
                key={g.id}
                onClick={() => go(g.id)}
                aria-current={route === g.id ? 'page' : undefined}
                className={`px-3.5 py-2 rounded-lg text-sm font-semibold transition-all flex items-center gap-1.5 ${
                  route === g.id ? SEGMENT_ACTIVE[g.id] : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border border-transparent'
                }`}
              >
                <span>{g.icon}</span>{g.label}
              </button>
            ))}
          </nav>
        </header>

        {route === 'home' && (
          <ShellErrorBoundary>
            <HomePage onNavigate={go} />
          </ShellErrorBoundary>
        )}
        {route === 'toto' && (
          <ShellErrorBoundary>
            <TotoAnalyzer />
          </ShellErrorBoundary>
        )}
        {route === '4d' && (
          <ShellErrorBoundary>
            <FourDAnalyzer />
          </ShellErrorBoundary>
        )}

        <footer className="pt-2 pb-4 text-center text-xs text-slate-500 leading-relaxed">
          Odds are fixed and every draw is independent — no tool can predict outcomes.
          Expected return per $1: 4D Big 65.9¢ · 4D Small 58.0¢ · TOTO varies with jackpot.
          Help: National Problem Gambling Service (NCPG) 1800-6-668-668.
        </footer>

      </div>
    </div>
  );
}
