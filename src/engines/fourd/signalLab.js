// signalLab — Edge Tester. The models themselves (frequency/chi-square,
// Markov transitions, MLP) run OFFLINE in Python (scripts/) and publish a
// JSON report into public/. This module is the JS-side contract: it validates
// the report shape and provides display helpers. A report that fails
// validation is never rendered as data.
//
// Report contract (produced by the Python battery):
// {
//   generatedAt, drawsAnalyzed, sweepDaysExcluded,
//   battery: [{
//     name,                       // 'frequency' | 'markov' | 'mlp'
//     walkForward: true,          // mandatory
//     baseline: 'uniform',        // mandatory comparison
//     metric: { model: x, baseline: y, metricName },   // log-loss / accuracy
//     liftPct,                    // model vs baseline, negative = worse
//     calibration: { ece, bins: [{ bin, predicted, observed, n }] },
//     fdrQ,                       // Benjamini-Hochberg q-value
//     verdict                     // 'no-edge' | 'inconclusive' | 'suspicious'
//   }],
//   overall: { verdict, note }
// }

export function validateReport(report) {
  const errors = [];
  if (!report || typeof report !== 'object') return { ok: false, errors: ['report is not an object'] };
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(typeof report.generatedAt === 'string', 'missing generatedAt');
  need(Number.isFinite(report.drawsAnalyzed), 'missing drawsAnalyzed');
  need(Array.isArray(report.battery) && report.battery.length > 0, 'battery missing/empty');
  for (const [i, b] of (report.battery || []).entries()) {
    need(b.walkForward === true, `battery[${i}] ${b.name}: walk-forward is mandatory`);
    need(b.baseline === 'uniform', `battery[${i}] ${b.name}: uniform baseline is mandatory`);
    need(b.metric && Number.isFinite(b.metric.model) && Number.isFinite(b.metric.baseline),
      `battery[${i}] ${b.name}: metric.model/baseline missing`);
    need(b.calibration && Number.isFinite(b.calibration.ece), `battery[${i}] ${b.name}: calibration ECE missing`);
    need(Number.isFinite(b.fdrQ), `battery[${i}] ${b.name}: FDR q-value missing`);
    need(['no-edge', 'inconclusive', 'suspicious'].includes(b.verdict), `battery[${i}] ${b.name}: invalid verdict`);
  }
  need(report.overall && ['no-edge', 'inconclusive', 'suspicious'].includes(report.overall.verdict),
    'overall.verdict missing/invalid');
  return { ok: errors.length === 0, errors };
}

const VERDICT_COPY = {
  'no-edge': 'No predictive edge found — performance indistinguishable from chance.',
  'inconclusive': 'Result inconclusive — not enough evidence either way.',
  'suspicious': 'Anomaly flagged — treat with heavy scepticism; single backtests mislead.',
};

export function verdictCopy(v) { return VERDICT_COPY[v] || v; }

// Formatted lift for display: "−0.02% vs uniform baseline".
export function liftCopy(liftPct) {
  if (!Number.isFinite(liftPct)) return 'n/a';
  const sign = liftPct > 0 ? '+' : liftPct < 0 ? '−' : '';
  return `${sign}${Math.abs(liftPct).toFixed(2)}% vs uniform baseline`;
}
