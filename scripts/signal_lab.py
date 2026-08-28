#!/usr/bin/env python3
"""
signal_lab — the offline Edge Tester battery for 4D.

Consumes public/4d_official.csv and publishes public/4d_signal_report.json
(see src/engines/fourd/signalLab.js for the rendering contract — a report
that is not walk-forward with a uniform baseline is rejected by the UI).

Honest frame: draws are memoryless. This battery EXISTS to test — rigorously
and publishably — whether any signal beats chance. The expected, correct
outcome is "no edge", and the report says so either way.

Battery
-------
- frequency : trailing-window per-position digit frequencies
- markov    : per-position previous-digit -> next-digit transitions (Laplace)
- mlp       : small feedforward net on one-hot recent history (numpy)

Method (mandatory for every model)
----------------------------------
- Walk-forward only: at each test draw the model sees ONLY earlier draws.
- Uniform baseline (1/10 per digit per position) evaluated on the same steps.
- Metric: mean log-loss (lower is better) + top-1 accuracy.
- Calibration: expected calibration error (ECE) over decile bins.
- Multiple testing: Benjamini-Hochberg q-values over per-model x per-position
  exact binomial tests of top-1 hits vs chance (p0 = 1/10).
- Sweep-day draws excluded.

Verdicts: 'no-edge' (not distinguishable from chance), 'inconclusive'
(underpowered), 'suspicious' (beats chance after FDR — treat with heavy
skepticism; a genuine edge in a fixed-odds lottery is essentially impossible).

Usage
-----
  python scripts/signal_lab.py                 # reads public/, writes public/
  python scripts/signal_lab.py --csv PATH --out PATH
"""
import argparse
import csv
import json
import math
import os

import numpy as np

WINDOW = 150        # trailing draws a model may train on at each step
TRAIN_MIN = 60      # minimum history before the walk-forward test begins
HIDDEN = 24         # mlp hidden units
EPOCHS = 6          # mlp passes over the trailing window at each step
BINS = 10           # calibration bins


def load_draws(path):
    """Oldest-first list of {drawNo, digits: [4][4]} with sweep days dropped."""
    rows = []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            if r["isSweepDay"] == "true":
                continue
            nums = [r["d1st"], r["d2nd"], r["d3rd"],
                    *[r[f"s{i}"] for i in range(1, 11)],
                    *[r[f"c{i}"] for i in range(1, 11)]]
            digits = [[int(c) for c in n.zfill(4)] for n in nums]
            rows.append({"drawNo": int(r["drawNo"]), "digits": digits})
    rows.sort(key=lambda x: x["drawNo"])
    return rows


# ---------------- models: predict P(digit) for each of the 4 positions -----

class Frequency:
    name = "frequency"

    def fit(self, history):
        counts = np.ones((4, 10))  # Laplace
        for d in history[-WINDOW:]:
            for pos in range(4):
                for k in range(4):
                    counts[k, d[k][pos]] += 1
        self.p = counts / counts.sum(axis=1, keepdims=True)

    def predict(self, prev_draw):
        return self.p


class Markov:
    name = "markov"

    def __init__(self):
        self.trans = None

    def fit(self, history):
        t = np.ones((4, 10, 10))  # [pos][prev][next], Laplace
        for a, b in zip(history[-WINDOW - 1:], history[-WINDOW:]):
            for pos in range(4):
                for k in range(4):
                    t[pos, a[k][pos], b[k][pos]] += 1
        self.trans = t / t.sum(axis=2, keepdims=True)

    def predict(self, prev_draw):
        # position k of each number depends on the same position of that
        # number in the previous draw
        out = np.empty((4, 10))
        for k in range(4):
            out[k] = self.trans[k, prev_draw[k][k]]
        return out


def onehot(draw):
    """Flattened one-hot of one draw: 23 numbers x 4 positions x 10."""
    v = np.zeros(23 * 4 * 10)
    for i, num in enumerate(draw):
        for k in range(4):
            v[(i * 4 + k) * 10 + num[k]] = 1.0
    return v


class MLP:
    name = "mlp"

    def __init__(self, seed=7):
        self.rng = np.random.default_rng(seed)
        din = 23 * 4 * 10
        self.w1 = self.rng.normal(0, 0.05, (din, HIDDEN))
        self.b1 = np.zeros(HIDDEN)
        self.w2 = self.rng.normal(0, 0.05, (HIDDEN, 40))  # 4 positions x 10
        self.b2 = np.zeros(40)

    def _forward(self, x):
        h = np.tanh(x @ self.w1 + self.b1)
        z = h @ self.w2 + self.b2
        z = z.reshape(4, 10)
        z -= z.max(axis=1, keepdims=True)
        e = np.exp(z)
        return e / e.sum(axis=1, keepdims=True), h

    def fit(self, history):
        # a few quiet epochs over the trailing window: input = draw t-1
        # one-hot, target = draw t positional digits
        for _ in range(EPOCHS):
            for a, b in zip(history[-WINDOW - 1:], history[-WINDOW:]):
                x = onehot(a)
                target = np.array([num[k] for k in range(4) for num in [b[k % 23]]])
                p, h = self._forward(x)
                # gradient of CE wrt logits
                dz = p.reshape(-1).copy()
                for k in range(4):
                    dz[k * 10 + target[k]] -= 1.0
                dz /= 4
                gw2 = np.outer(h, dz)
                dh = dz @ self.w2.T * (1 - h ** 2)
                gw1 = np.outer(x, dh)
                lr = 0.02
                self.w2 -= lr * gw2
                self.b2 -= lr * dz
                self.w1 -= lr * gw1
                self.b1 -= lr * dh

    def predict(self, prev_draw):
        p, _ = self._forward(onehot(prev_draw))
        return p


# ---------------- scoring --------------------------------------------------

def logloss(probs, targets):
    """Mean log-loss; probs is (4,10) or (1,10), targets are digit indices."""
    return float(np.mean([-math.log(max(probs[k, t], 1e-12))
                          for k, t in enumerate(targets)]))


def binomial_sf_ge(k, n, p):
    """Exact P(X >= k), X~Bin(n,p), via lgamma."""
    if k <= 0:
        return 1.0
    if k > n:
        return 0.0
    sf = 0.0
    for i in range(k, n + 1):
        sf += math.exp(math.lgamma(n + 1) - math.lgamma(i + 1)
                       - math.lgamma(n - i + 1) + i * math.log(p)
                       + (n - i) * math.log(1 - p))
    return min(1.0, sf)


def benjamini_hochberg(pvals):
    """BH q-values (returns q in [0,1], capped at 1)."""
    n = len(pvals)
    order = sorted(range(n), key=lambda i: pvals[i])
    qs = [0.0] * n
    prev = 1.0
    for rank, i in enumerate(reversed(order), start=1):
        r = n - rank + 1
        q = min(prev, pvals[i] * n / r)
        qs[i] = q
        prev = q
    return qs


def run_battery(draws, test_model):
    """Walk-forward over draws[TRAIN_MIN:], returns per-position metrics."""
    per_pos = [{"ll": [], "hits": 0, "n": 0,
                "conf": [], "correct": []} for _ in range(4)]
    base_ll = []
    for i in range(TRAIN_MIN, len(draws)):
        history = [d["digits"] for d in draws[:i]]
        prev = draws[i]["digits"]
        # Walk-forward target: the 1st-prize number's digits. Using only the
        # 1st prize keeps the prediction problem well-defined per position.
        targets = [draws[i]["digits"][0][k] for k in range(4)]
        test_model.fit(history)
        p = test_model.predict(prev)
        ll = logloss(p, targets)
        for k in range(4):
            per_pos[k]["ll"].append(logloss(p[k:k + 1], targets[k:k + 1]))
            per_pos[k]["n"] += 1
            per_pos[k]["hits"] += int(int(np.argmax(p[k])) == targets[k])
            per_pos[k]["conf"].append(float(p[k, targets[k]]))
            per_pos[k]["correct"].append(float(int(np.argmax(p[k])) == targets[k]))
        base_ll.append(math.log(10))
    return per_pos, float(np.mean(base_ll)) if base_ll else float("nan")


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--csv", default=os.path.join(here, "..", "public", "4d_official.csv"))
    ap.add_argument("--out", default=os.path.join(here, "..", "public", "4d_signal_report.json"))
    args = ap.parse_args()

    draws = load_draws(args.csv)
    n_draws = len(draws)
    n_test = max(0, n_draws - TRAIN_MIN)
    print(f"signal_lab: {n_draws} draws loaded, walk-forward testing {n_test} "
          f"steps (window {WINDOW})")

    if n_test < 30:
        report = {
            "generatedAt": os.environ.get("RUN_STAMP", ""),
            "drawsAnalyzed": n_draws,
            "sweepDaysExcluded": "schema flag; excluded by loader",
            "trainWindow": WINDOW,
            "testSteps": n_test,
            "battery": [],
            "overall": {
                "verdict": "inconclusive",
                "note": (f"Only {n_draws} draws in the archive — at least "
                         f"{TRAIN_MIN + 30} are needed for a walk-forward test. "
                         "No verdict either way. The fixed odds are unaffected: "
                         "Big 65.9¢ / Small 58.0¢ expected per $1."),
            },
        }
        with open(args.out, "w") as f:
            json.dump(report, f, indent=2)
        print(f"report -> {args.out}  overall: inconclusive (not enough data)")
        return

    battery = []
    raw_p = []
    raw_meta = []
    for model in (Frequency(), Markov(), MLP()):
        per_pos, base_ll = run_battery(draws, model)
        m_ll = float(np.mean([x for k in range(4) for x in per_pos[k]["ll"]]))
        hits = sum(per_pos[k]["hits"] for k in range(4))
        n = sum(per_pos[k]["n"] for k in range(4))
        all_conf = [c for k in range(4) for c in per_pos[k]["conf"]]
        all_corr = [c for k in range(4) for c in per_pos[k]["correct"]]
        ece_all = 0.0
        edges = np.linspace(0, 1, BINS + 1)
        conf_arr = np.array(all_conf)
        corr_arr = np.array(all_corr)
        for i in range(BINS):
            m = (conf_arr > edges[i]) & (conf_arr <= edges[i + 1])
            if m.sum():
                ece_all += m.sum() / len(conf_arr) * abs(corr_arr[m].mean() - conf_arr[m].mean())
        # per-position binomial p vs chance, pooled into one list for BH
        for k in range(4):
            raw_p.append(binomial_sf_ge(per_pos[k]["hits"], per_pos[k]["n"], 0.1))
            raw_meta.append((model.name, k))
        lift = (base_ll - m_ll) / base_ll * 100.0
        entry = {
            "name": model.name,
            "walkForward": True,
            "baseline": "uniform",
            "metric": {
                "metricName": "log-loss",
                "model": round(m_ll, 5),
                "baseline": round(base_ll, 5),
            },
            "liftPct": round(lift, 3),
            "accuracy": round(hits / n, 5) if n else 0.0,
            "chanceAccuracy": 0.1,
            "calibration": {"ece": round(float(ece_all), 5)},
            "fdrQ": 1.0,  # replaced after BH below
            "verdict": "no-edge",
        }
        battery.append(entry)
        print(f"  {model.name:<9} log-loss {m_ll:.4f} vs uniform {base_ll:.4f} "
              f"(lift {lift:+.2f}%), accuracy {hits}/{n} = {hits / n:.3f}, "
              f"ECE {ece_all:.4f}")

    # BH across all model x position tests; a model's fdrQ = its best (min) q.
    qs = benjamini_hochberg(raw_p)
    best_q = {}
    for (name, _k), q in zip(raw_meta, qs):
        best_q[name] = min(best_q.get(name, 1.0), q)
    for entry in battery:
        q = best_q.get(entry["name"], 1.0)
        entry["fdrQ"] = round(q, 5)
        beats = entry["liftPct"] > 0
        if not beats:
            entry["verdict"] = "no-edge"
        elif q < 0.05:
            entry["verdict"] = "suspicious"
        else:
            entry["verdict"] = "inconclusive"

    overall = "no-edge"
    if any(e["verdict"] == "suspicious" for e in battery):
        overall = "suspicious"
    elif all(e["verdict"] == "inconclusive" for e in battery) and battery:
        overall = "inconclusive"

    report = {
        "generatedAt": os.environ.get("RUN_STAMP", ""),
        "drawsAnalyzed": n_draws,
        "sweepDaysExcluded": "schema flag; excluded by loader",
        "trainWindow": WINDOW,
        "testSteps": n_test,
        "battery": battery,
        "overall": {
            "verdict": overall,
            "note": ("No model predicts 4D. The expected return per $1 stays "
                     "Big 65.9¢ / Small 58.0¢ regardless of this report."
                     if overall == "no-edge" else
                     "Flagged anomalies are far more likely to be artifacts "
                     "than edges. Nothing here changes the fixed odds."),
        },
    }
    with open(args.out, "w") as f:
        json.dump(report, f, indent=2)
    print(f"report -> {args.out}  overall: {overall}")


if __name__ == "__main__":
    main()
