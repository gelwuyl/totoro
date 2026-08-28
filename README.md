# TOTO-RO — Singapore Pools TOTO + 4D Analyzer

One React app, two games, deployed to GitHub Pages. The **TOTO** analyzer ships the complete draw history
embedded in the build — a snapshot continuously extended as new draws are scraped — then auto-refreshes from
the hosted `toto_official.csv` on load. The **4D** analyzer adds exact bet math (Ordinary, System Entry, iBet,
4D Roll), a budget planner, a historical replay bench, fairness statistics, and an offline "Edge Tester" battery
whose report is published only if it passes a strict honesty contract (walk-forward + uniform baseline +
calibration + FDR correction).

Everything here is deliberately honest: draws are independent, the odds never change, and no tool can predict
the next draw. The apps show you the true price of a bet — expected return per $1 (TOTO varies with jackpot;
4D Big 65.9¢ / Small 58.0¢), outcome swings, and never any "hot numbers". Help: National Problem Gambling
Service (NCPG) 1800-6-668-668.

A scheduled GitHub Action re-scrapes the latest draws and redeploys — no server, no container, no cost
(GitHub Actions free tier).

## Local dev
```
npm install
npm run dev        # http://localhost:5173
```

## Engine test harness
```
node scripts/test-engines.mjs   # 130 assertions against independently verified constants
```

## Build / preview
```
npm run build
npm run preview
```

## How the data stays live
- `parse_toto.py` scrapes Singapore Pools and writes `public/toto_official.csv`;
  `parse_4d.py` does the same for 4D (`public/4d_official.csv`, incremental by default,
  `--full` for the rolling 3-year backfill, `--verify` for a read-only integrity check).
- `deploy.yml` refreshes the TOTO database at every build, then builds and publishes the site.
- `update-data.yml` runs after each TOTO draw (Mon/Thu evenings + Fri late) and commits any
  new draws, which re-triggers the deploy.
- `refresh-4d.yml` runs after each 4D draw (Wed/Sat/Sun evenings), appends the new draws,
  re-runs the Edge Tester battery (`scripts/signal_lab.py` → `public/4d_signal_report.json`),
  and commits — the 4D archive and its published report grow themselves.
- If a scrape is ever blocked from CI, the apps fall back to their embedded bases — they never break.

## Layout
- `src/TotoAnalyzer.jsx`  -- the TOTO analyzer (embedded 314-draw base + hosted-data refresh)
- `src/shell/`            -- combined-app shell: hash router `#/home | #/toto | #/4d`, Home dashboard, shared digit helpers
- `src/fourd/`            -- the 4D analyzer UI + its seed-draw snapshot
- `src/engines/fourd/`    -- verified 4D engines: betMath (exact cost/EV/variance/P(any prize)), drawStats
                            (frequencies + per-position chi-square), budgetPlanner, testBench, signalLab
- `scripts/test-engines.mjs`  -- the engine harness (exact prize-table/EV/SD/probability anchors)
- `scripts/signal_lab.py`     -- offline walk-forward Edge Tester battery
- `parse_toto.py` / `parse_4d.py`  -- the scrapers used by the Actions
- `public/toto_official.csv` / `public/4d_official.csv`  -- the growing databases
- `.github/workflows/*`  -- deploy + data-refresh pipelines (TOTO and 4D)
