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
No sppl returns the LATEST draw, so we first fetch latest to learn the top
draw number, then walk downward selecting exact draws.

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
import json
import os
import re
import time
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
PAGE = "https://www.singaporepools.com.sg/en/4d/Pages/Results.aspx"

CSV_HEADER = (["drawNo", "date", "isSweepDay", "d1st", "d2nd", "d3rd"]
              + [f"s{i}" for i in range(1, 11)] + [f"c{i}" for i in range(1, 11)])

date_re = re.compile(r"drawDate'>(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Za-z]+) (\d{4})<")
num_re = re.compile(r"drawNumber'>Draw No\.\s*(\d+)<")
first_re = re.compile(r"tdFirstPrize'>(\d{4})<")
second_re = re.compile(r"tdSecondPrize'>(\d{4})<")
third_re = re.compile(r"tdThirdPrize'>(\d{4})<")


def fetch_html(draw):
    tok = base64.b64encode(f"DrawNumber={draw}".encode()).decode()
    url = PAGE + ("?sppl=" + tok if draw else "")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


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
    return rest[0], rest[1]


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
    return parse(0)["drawNo"]


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


if __name__ == "__main__":
    main()
