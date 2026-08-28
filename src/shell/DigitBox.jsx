// Small shared presentational helpers for the shell (Home + 4D views).
// Kept here so TotoAnalyzer.jsx stays byte-identical.

export function DigitBox({ digit, accent = 'emerald' }) {
  const styles = {
    emerald: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/40',
    slate: 'bg-slate-800/80 text-slate-200 border-slate-700',
  }[accent];
  return (
    <span className={`inline-flex items-center justify-center w-7 h-9 rounded-md border font-mono text-lg font-bold ${styles}`}>
      {digit}
    </span>
  );
}

// Renders a 4-digit number as positional digit boxes. Numbers arrive as
// zero-padded strings from the 4D database ("0715"); pad defensively anyway.
export function FourDigitNumber({ value, accent = 'emerald' }) {
  const digits = String(value).padStart(4, '0').split('');
  return (
    <span className="inline-flex gap-1">
      {digits.map((d, i) => <DigitBox key={i} digit={d} accent={accent} />)}
    </span>
  );
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Parse "DD Mon YYYY" (the database date format) or ISO "YYYY-MM-DD" into a
// local Date; null when unrecognised. Deliberately avoids `new Date(str)` —
// its "DD Mon YYYY" parsing is implementation-dependent and UTC-based, so a
// "01 Aug 2026" string can land on 31 Jul in negative-offset timezones.
function parseLocalDate(s) {
  let m = s.match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    return mo === undefined ? null : new Date(Number(m[3]), mo, Number(m[1]));
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

// True for Singapore Sweep days (first Wednesday of the month, since Apr 1993):
// 4D results on those days are the last 4 digits of Sweep prizes, not machine draws.
// The database's own `isSweepDay` field is authoritative where present; this
// derivation is the fallback for rows without the field.
export function isSweepDay(dateStr) {
  if (typeof dateStr !== 'string') return false;
  const d = parseLocalDate(dateStr.trim());
  if (!d || isNaN(d.getTime())) return false;
  return d.getDay() === 3 && d.getDate() <= 7;
}
