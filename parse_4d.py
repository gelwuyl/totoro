#!/usr/bin/env python3
"""
Singapore Pools 4D results -> local accumulating database.

Behaviour
--------
DEFAULT (incremental / append mode):
  * Reads existing 4d_official.csv (if present) to learn the highest stored
    draw number.
  * Fetches ONLY draws newer than that (stored_max+1 .. latest on site).
  * Appends the new rows to the existing file. Old records are NEVER deleted,
    so the file is a self-contained growing history.

FULL mode (--full):
  * Ignores the existing file and re-fetches the entire window
    (--start floor .. latest), rewriting both CSV and JSON. Use this once to
    backfill (official archive floor is 5058: a rolling 3 years), or to
    reconcile against site corrections.

Output shape (matches the React app's 4D schema, draw-descending):
  CSV : drawNo,date,isSweepDay,d1st,d2nd,d3rd,s1..s10,c1..c10
  JSON: [{ drawNo, date, isSweepDay,
           "1st","2nd","3rd", starter[10], consolation[10] }, ...]
Dates are "DD Mon YYYY"; all numbers zero-padded 4-digit strings.

Sweep-day rule: 4D results on the first Wednesday of a month are the last 4
digits of Singapore Sweep prizes (game rules clause 4.1(b)). Those draws may
contain duplicate 4-digit numbers; the isSweepDay flag marks them so the app
can exclude them from statistics.

Mechanism
--------
Each draw lives at:
  /en/4d/Pages/Results.aspx?sppl=<base64("DrawNumber=N")>
The newest draw number comes from the static draw-list archive (the bare
results page renders empty through the browser-render fallback). Fetches
go through a strategy chain: direct urllib (browser headers + cookies),
then curl_cffi Chrome-TLS impersonation if installed, then r.jina.ai
with X-Return-Format: html (real headless browser — defeats the empty
SPA shell served to datacenter IPs; ~20 req/min, self-throttled).
Markup regexes accept both server-rendered single quotes and the
browser-DOM double quotes.

Usage
-----
  python parse_4d.py                 # append any new draws since last run
  python parse_4d.py --full          # regenerate whole history (floor 5058)
  python parse_4d.py --start 5058    # floor for --full backfill
  python parse_4d.py --out DIR       # output directory (default: script dir)
  python parse_4d.py --verify        # read-only integrity check, no network
"""
import argparse
import base64
import csv
import http.cookiejar
import json
import os
import re
import time
import urllib.error
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
PAGE = "https://www.singaporepools.com.sg/en/4d/Pages/Results.aspx"
DRAW_LIST = ("https://www.singaporepools.com.sg/DataFileArchive/Lottery/"
             "Output/fourd_result_draw_list_en.html")

# CI runners receive HTTP 200 with NO result markup from /en/4d/ (the TOTO
# page serves fine to the same IPs — the site applies per-path bot rules).
# Fetch chain: full browser headers + cookie jar first, then curl_cffi with
# Chrome TLS impersonation if the package is installed (the CI workflow
# pip-installs it). Locally the first strategy typically succeeds.
HEADERS = {
    "User-Agent": UA,
    "Accept": ("text/html,application/xhtml+xml,application/xml;q=0.9,"
               "image/avif,image/webp,*/*;q=0.8"),
    "Accept-Language": "en-SG,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
}

_opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
_curl_session = None
_logged_strategies = set()
_preferred = ""  # strategy that last succeeded — tried first afterwards

CSV_HEADER = (["drawNo", "date", "isSweepDay", "d1st", "d2nd", "d3rd"]
              + [f"s{i}" for i in range(1, 11)] + [f"c{i}" for i in range(1, 11)])

date_re = re.compile(r"drawDate[\"']>(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Za-z]+) (\d{4})<")
num_re = re.compile(r"drawNumber[\"']>Draw No\.\s*(\d+)<")
first_re = re.compile(r"tdFirstPrize[\"']>(\d{4})<")
second_re = re.compile(r"tdSecondPrize[\"']>(\d{4})<")
third_re = re.compile(r"tdThirdPrize[\"']>(\d{4})<")
option_re = re.compile(r"<option value=[\"'](\d+)[\"']")


def _fetch_urllib(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with _opener.open(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def _fetch_curl(url):
    global _curl_session
    if _curl_session is None:
        from curl_cffi import requests as creq
        _curl_session = creq.Session(impersonate="chrome")
    r = _curl_session.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.text


_jina_last = [0.0]


def _fetch_jina(url):
    # r.jina.ai renders the page in a real headless browser, which gets the
    # full server/client content the raw /en/4d/ page withholds from
    # datacenter IPs (runners receive an empty SPA shell). Free tier is
    # ~20 requests/min — self-throttle and back off on 429.
    wait = 3.2 - (time.time() - _jina_last[0])
    if wait > 0:
        time.sleep(wait)
    last_err = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                "https://r.jina.ai/" + url,
                headers={**HEADERS, "X-Return-Format": "html"})
            with _opener.open(req, timeout=90) as r:
                _jina_last[0] = time.time()
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            _jina_last[0] = time.time()
            last_err = e
            if e.code in (429, 403) and attempt < 2:
                time.sleep(35)
                continue
            raise
    raise last_err


def _has_result_markup(html):
    return (re.search(r"drawDate[\"']>", html) is not None
            and re.search(r"tdFirstPrize[\"']>", html) is not None)


def _has_draw_list_markup(html):
    return option_re.search(html) is not None


def fetch_html(draw):
    tok = base64.b64encode(f"DrawNumber={draw}".encode()).decode()
    url = PAGE + ("?sppl=" + tok if draw else "")
    return _fetch_with_fallback(url, _has_result_markup)


def _strategy_chain():
    strategies = [("urllib+cookies", _fetch_urllib)]
    try:
        import curl_cffi  # noqa: F401
        strategies.append(("curl_cffi-chrome", _fetch_curl))
    except ImportError:
        pass
    strategies.append(("jina-browser", _fetch_jina))
    if _preferred:
        strategies.sort(key=lambda s: s[0] != _preferred)
    return strategies


def _fetch_with_fallback(url, marker):
    global _preferred
    problems = []
    for name, fn in _strategy_chain():
        try:
            html = fn(url)
        except Exception as e:
            problems.append(f"{name}: {e!r}")
            continue
        if marker(html):
            _preferred = name
            if name not in _logged_strategies:
                print(f"  fetch strategy in use: {name}")
                _logged_strategies.add(name)
            return html
        problems.append(f"{name}: HTTP 200 but expected markup missing "
                        f"(head {html[:200]!r})")
    raise ValueError("; ".join(problems))


def cell_numbers(section):
    """All 4-digit numbers inside one prize-table section, in page order."""
    return re.findall(r"<td>(\d{4})</td>", section)


def split_sections(html):
    """Split the page into the starter and consolation table sections."""
    s = html.split("tbodyStarterPrizes", 1)
    if len(s) != 2:
        raise ValueError("no starter prizes section")
    rest = s[1].split("tbodyConsolationPrizes", 1)
    if len(rest) != 2:
        raise ValueError("no consolation prizes section")
    # multi-draw pages (jina renders the history list): stop at the NEXT
    # draw's starter table so cell_numbers sees exactly 10 consolation rows
    consolation = rest[1].split("tbodyStarterPrizes", 1)[0]
    return rest[0], consolation


def parse(draw):
    html = fetch_html(draw)
    dm = date_re.search(html)
    nm = num_re.search(html)
    fm = first_re.search(html)
    sm = second_re.search(html)
    tm = third_re.search(html)
    if not (dm and nm and fm and sm and tm):
        raise ValueError(f"draw {draw}: incomplete parse "
                         f"(date={bool(dm)} no={bool(nm)} "
                         f"1st={bool(fm)} 2nd={bool(sm)} 3rd={bool(tm)})")
    starter_sec, consol_sec = split_sections(html)
    starter = cell_numbers(starter_sec)
    consolation = cell_numbers(consol_sec)
    if len(starter) != 10 or len(consolation) != 10:
        raise ValueError(f"draw {draw}: expected 10 starter + 10 consolation, "
                         f"got {len(starter)}/{len(consolation)}")
    _, dd, mon, yyyy = dm.groups()
    return {
        "drawNo": int(nm.group(1)),
        "date": f"{dd} {mon} {yyyy}",
        "isSweepDay": is_sweep_day(f"{dd} {mon} {yyyy}"),
        "1st": fm.group(1),
        "2nd": sm.group(1),
        "3rd": tm.group(1),
        "starter": starter,
        "consolation": consolation,
    }


MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def is_sweep_day(date_str):
    """First Wednesday of the month (Singapore Sweep tie-in, clause 4.1(b))."""
    dd, mon, yyyy = date_str.split()
    import datetime
    dt = datetime.date(int(yyyy), MONTHS.index(mon) + 1, int(dd))
    return dt.weekday() == 2 and dt.day <= 7


def get_latest():
    """Newest draw number, read from the static draw-list archive.

    The bare results page renders empty through the browser-render
    fallback (verified), so the probe uses the draw list instead; its
    options are draw-descending, newest first."""
    last_err = None
    for attempt in range(3):
        try:
            html = _fetch_with_fallback(DRAW_LIST, _has_draw_list_markup)
            nums = [int(m) for m in option_re.findall(html)]
            if nums:
                return max(nums)
            last_err = ValueError("draw list contained no options")
        except Exception as e:
            last_err = e
        print(f"  ! latest-draw probe attempt {attempt + 1}/3: {last_err}")
        time.sleep(5)
    raise SystemExit(
        f"FATAL: could not fetch the draw list after 3 attempts "
        f"({last_err!r}).")


def load_existing(path):
    d = {}
    if os.path.exists(path):
        with open(path, newline="") as f:
            for r in csv.DictReader(f):
                d[int(r["drawNo"])] = {
                    "drawNo": int(r["drawNo"]),
                    "date": r["date"],
                    "isSweepDay": r["isSweepDay"] == "true",
                    "1st": r["d1st"],
                    "2nd": r["d2nd"],
                    "3rd": r["d3rd"],
                    "starter": [r[f"s{i}"] for i in range(1, 11)],
                    "consolation": [r[f"c{i}"] for i in range(1, 11)],
                }
    return d


def self_check(records):
    bad = 0
    for r in records:
        nums = [r["1st"], r["2nd"], r["3rd"], *r["starter"], *r["consolation"]]
        if len(nums) != 23 or any(not re.fullmatch(r"\d{4}", n) for n in nums):
            bad += 1
            print("SANITY: shape", r["drawNo"])
        if not r["isSweepDay"] and len(set(nums)) != 23:
            bad += 1
            print("SANITY: duplicates on non-sweep draw", r["drawNo"])
    prev = None
    for r in sorted(records, key=lambda x: -x["drawNo"]):
        if prev is not None and r["drawNo"] != prev - 1:
            bad += 1
            print("SANITY: drawNo gap", r["drawNo"], prev)
        prev = r["drawNo"]
    return bad


def write_outputs(records, csv_path, json_path):
    recs = sorted(records, key=lambda x: -x["drawNo"])  # draw-descending
    with open(csv_path, "w", newline="") as f:
        f.write(",".join(CSV_HEADER) + "\n")
        for r in recs:
            f.write(",".join(
                [str(r["drawNo"]), r["date"], "true" if r["isSweepDay"] else "false",
                 r["1st"], r["2nd"], r["3rd"],
                 *r["starter"], *r["consolation"]]) + "\n")
    with open(json_path, "w") as f:
        json.dump(recs, f, indent=2)


def verify_database(out_dir):
    """Read-only integrity check of the 4D CSV (+ JSON). No network.

    Validates schema (exact 26-column header), zero-padded 4-digit numbers,
    23 numbers per draw, no duplicate numbers on non-sweep draws, draw-number
    contiguity, sweep-flag correctness (first-Wednesday rule), date validity,
    and CSV/JSON parity.
    """
    import datetime
    from collections import Counter

    csv_path = os.path.join(out_dir, "4d_official.csv")
    json_path = os.path.join(out_dir, "4d_official.json")
    problems = []
    if not os.path.exists(csv_path):
        return False, [f"MISSING: {csv_path}"]

    with open(csv_path, newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if header != CSV_HEADER:
            problems.append(f"HEADER: expected {CSV_HEADER}, got {header}")
        raw = [r for r in reader if any(c.strip() for c in r)]

    draws = {}
    sweep_flags = Counter()
    for i, r in enumerate(raw, start=2):
        if len(r) != len(CSV_HEADER):
            problems.append(f"LINE {i}: expected {len(CSV_HEADER)} cols, got {len(r)} -> {r}")
            continue
        dn = int(r[0])
        nums = r[3:3 + 23]
        if any(not re.fullmatch(r"\d{4}", n) for n in nums):
            problems.append(f"DRAW {dn}: non-4-digit field -> {nums}")
        if r[2] not in ("true", "false"):
            problems.append(f"DRAW {dn}: bad isSweepDay '{r[2]}'")
        if r[2] == "false" and len(set(nums)) != 23:
            problems.append(f"DRAW {dn}: duplicate numbers on non-sweep draw")
        if r[2] == "true" and len(set(nums)) != 23:
            pass  # duplicates allowed on sweep days
        try:
            dd, mon, yyyy = r[1].split()
            dt = datetime.date(int(yyyy), MONTHS.index(mon) + 1, int(dd))
            expect_sweep = dt.weekday() == 2 and dt.day <= 7
            if (r[2] == "true") != expect_sweep:
                problems.append(f"DRAW {dn}: sweep flag {r[2]} but date says "
                                f"{expect_sweep} ({r[1]})")
            sweep_flags[dt.strftime("%a")] += 1
        except (ValueError, IndexError):
            problems.append(f"DRAW {dn}: invalid date '{r[1]}'")
        if dn in draws:
            problems.append(f"DRAW {dn}: DUPLICATE row")
        draws[dn] = r[1]

    if draws:
        lo, hi = min(draws), max(draws)
        missing = [d for d in range(lo, hi + 1) if d not in draws]
        if missing:
            problems.append(f"DRAW GAP: missing {len(missing)} draws in "
                            f"{lo}..{hi} (e.g. {missing[:10]})")

    weird = {k: v for k, v in sweep_flags.items() if k not in ("Wed", "Sat", "Sun")}
    if weird:
        problems.append(f"WEEKDAY: unexpected draw weekdays {weird}")

    if os.path.exists(json_path):
        try:
            with open(json_path) as f:
                j = json.load(f)
            jnos = sorted(x["drawNo"] for x in j)
            if jnos != sorted(draws):
                problems.append(f"JSON/CSV mismatch: {len(jnos)} json vs "
                                f"{len(draws)} csv draws")
        except Exception as e:
            problems.append(f"JSON: unreadable ({e})")

    n = len(draws)
    summary = [f"verified {n} draws, contiguous window {lo}..{hi}" if draws
               else "verified 0 draws",
               f"weekdays: {dict(sweep_flags)}",
               f"problems: {len(problems)}"]
    if problems:
        return False, summary + problems
    return True, summary + ["OK: rows + columns intact"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true",
                    help="regenerate entire history (ignore existing file)")
    ap.add_argument("--start", type=int, default=5058,
                    help="floor draw number for --full backfill (default 5058)")
    ap.add_argument("--out", default=os.path.dirname(os.path.abspath(__file__)),
                    help="output directory (default: script folder)")
    ap.add_argument("--verify", action="store_true",
                    help="read-only integrity check of existing 4d_official.csv (+json), no network")
    args = ap.parse_args()

    if args.verify:
        ok, report = verify_database(args.out)
        print("\n".join(report))
        raise SystemExit(0 if ok else 1)

    os.makedirs(args.out, exist_ok=True)
    csv_path = os.path.join(args.out, "4d_official.csv")
    json_path = os.path.join(args.out, "4d_official.json")

    existing = {} if args.full else load_existing(csv_path)
    latest = get_latest()

    if existing and not args.full:
        floor = max(existing) + 1
        mode = "INCREMENTAL"
    else:
        floor = args.start
        mode = "FULL"

    new_records = []
    failed_fetch = False
    if floor <= latest:
        print(f"[{mode}] fetching draws {latest} -> {floor} ...")
        for d in range(latest, floor - 1, -1):
            for attempt in range(3):
                try:
                    rec = parse(d)
                    new_records.append(rec)
                    print(f"  +{rec['drawNo']}  {rec['date']}  "
                          f"1st {rec['1st']}"
                          f"{'  SWEEP' if rec['isSweepDay'] else ''}")
                    break
                except Exception as e:
                    print(f"  ! draw {d}: {e}")
                    time.sleep(1.5)
            else:
                print(f"  !! draw {d} FAILED after retries - stopping")
                failed_fetch = True
                break
            time.sleep(0.2)  # be polite to the site
    else:
        print(f"[{mode}] already up to date (latest={latest}, "
              f"stored_max={max(existing) if existing else 'none'})")

    # merge: existing records win on conflict, new appended
    merged = dict(existing)
    for r in new_records:
        merged[r["drawNo"]] = r

    sanity = self_check(list(merged.values()))
    write_outputs(list(merged.values()), csv_path, json_path)

    print(f"\nDONE: mode={mode}  added={len(new_records)}  "
          f"total={len(merged)}  sanity_violations={sanity}")
    print(f"CSV  -> {csv_path}")
    print(f"JSON -> {json_path}")
    if failed_fetch:
        # outputs are written above for inspection, but a gappy archive must
        # never be committed + deployed — fail the CI step instead
        raise SystemExit("FATAL: some draws failed after retries — "
                         "archive would be incomplete; not publishing.")


if __name__ == "__main__":
    main()
