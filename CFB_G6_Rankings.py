"""
CFB_G6_Rankings.py

Reads g6_players_2026.csv, pulls each player's 2025 season stats from ESPN,
scores them with Walk-On Fantasy Football rules, and writes
g6_players_2026_ranked.csv with three new columns:

    pts2025   - total fantasy points scored in 2025 (blank if no data)
    posRank   - rank within position (1 = best); blank if no data
    ovrRank   - overall rank across all scored players; blank if no data

USAGE
-----
    python3 CFB_G6_Rankings.py --probe    # inspect a few athletes
    python3 CFB_G6_Rankings.py            # full run, ~15 min, caches to disk

NOTES ON DATA LIMITS
--------------------
- Fumbles lost are not exposed in ESPN's season category list, so the -2
  fumble penalty is never applied. Slightly overvalues turnover-prone backs.
- ESPN reports one combined 50+ FG bucket, so 50-59 (5 pts) and 60+ (6 pts)
  can't be separated. All 50+ makes score 5.
- Return TDs are available but NOT scored by default, matching the league's
  scoring table, which lists return TDs only under D/ST. Flip
  SCORE_RETURN_TDS to True to credit them to individual players instead.
"""

import requests
import csv
import json
import time
import os
import sys

INPUT_CSV = "g6_players_2026.csv"
OUTPUT_CSV = "g6_players_2026_ranked.csv"
CACHE_FILE = "espn_stats_cache_2025.json"

SEASON = 2025
REQUEST_DELAY = 0.35
TIMEOUT = 15

SCORE_RETURN_TDS = True

# Maddux Madsen (QB), Jaylin Lucas (RB), Makai Jackson (WR), Colton Boomer (K)
PROBE_IDS = ["5153885"]

STATS_URL = (
    "https://site.web.api.espn.com/apis/common/v3/sports/football/"
    "college-football/athletes/{athlete_id}/stats"
)


# ─────────────────────────────────────────────────────────────────────────
# Parsing
# ─────────────────────────────────────────────────────────────────────────

def _to_float(raw):
    try:
        return float(str(raw).replace(",", "").strip())
    except (ValueError, TypeError, AttributeError):
        return None


def extract_season_stats(payload, season=SEASON):
    """
    Returns a NESTED dict: {categoryName: {statName: float}}

    Nesting matters because ESPN reuses stat names across categories --
    'interceptions' means thrown in `passing` but caught in `defensive`,
    and 'sacks' means taken in `passing` but recorded in `defensive`.
    A flat dict lets one clobber the other.

    Also splits ESPN's compound fields, where a single name like
    'fieldGoalsMade40_49-fieldGoalAttempts40_49' carries a value like '3-4'.
    """
    if not payload:
        return {}

    out = {}

    for category in payload.get("categories", []):
        cat_name = category.get("name") or "unknown"
        names = category.get("names") or []
        if not names:
            continue

        for entry in category.get("statistics", []):
            raw_season = entry.get("season")
            entry_season = (
                raw_season.get("year") if isinstance(raw_season, dict) else raw_season
            )
            if entry_season != season:
                continue

            values = entry.get("stats") or []
            bucket = out.setdefault(cat_name, {})

            for name, value in zip(names, values):
                if "-" in name:
                    sub_names = name.split("-")
                    sub_values = str(value).split("-")
                    if len(sub_names) == len(sub_values):
                        for sn, sv in zip(sub_names, sub_values):
                            f = _to_float(sv)
                            if f is not None:
                                bucket[sn] = f
                    continue

                f = _to_float(value)
                if f is not None:
                    bucket[name] = f

    return out


# ─────────────────────────────────────────────────────────────────────────
# Scoring — mirrors the Scoring System table on myteam.html
# ─────────────────────────────────────────────────────────────────────────

def score_player(stats):
    """stats: nested {category: {statName: float}} from extract_season_stats."""

    def g(category, name, default=0.0):
        return stats.get(category, {}).get(name, default)

    pts = 0.0

    # ── Passing ──────────────────────────────────────────────────────────
    pts += g("passing", "passingYards") / 25.0
    pts += g("passing", "passingTouchdowns") * 4
    pts += g("passing", "interceptions") * -2   # thrown, not caught

    # ── Rushing ──────────────────────────────────────────────────────────
    pts += g("rushing", "rushingYards") / 10.0
    pts += g("rushing", "rushingTouchdowns") * 6

    # ── Receiving (half PPR) ─────────────────────────────────────────────
    pts += g("receiving", "receivingYards") / 10.0
    pts += g("receiving", "receivingTouchdowns") * 6
    pts += g("receiving", "receptions") * 0.5

    # ── Two-point conversions ────────────────────────────────────────────
    pts += g("scoring", "totalTwoPointConvs") * 2

    # ── Return TDs (off by default; see notes at top) ─────────────────────
    if SCORE_RETURN_TDS:
        pts += g("returning", "puntReturnTouchdowns") * 6
        pts += g("returning", "kickReturnTouchdowns") * 6

    # ── Kicking ──────────────────────────────────────────────────────────
    k = stats.get("kicking", {})
    if k:
        made_short = (
            k.get("fieldGoalsMade1_19", 0)
            + k.get("fieldGoalsMade20_29", 0)
            + k.get("fieldGoalsMade30_39", 0)
        )
        att_short = (
            k.get("fieldGoalAttempts1_19", 0)
            + k.get("fieldGoalAttempts20_29", 0)
            + k.get("fieldGoalAttempts30_39", 0)
        )
        made_40s = k.get("fieldGoalsMade40_49", 0)
        att_40s = k.get("fieldGoalAttempts40_49", 0)
        made_50s = k.get("fieldGoalsMade50", 0)
        att_50s = k.get("fieldGoalAttempts50", 0)

        if (att_short + att_40s + att_50s) > 0:
            pts += made_short * 3
            pts += made_40s * 4
            pts += made_50s * 5
            pts += max(0, att_short - made_short) * -2
            pts += max(0, att_40s - made_40s) * -1
            pts += max(0, att_50s - made_50s) * -0.5
        else:
            # No bucket data: flat 3 per make, -2 per miss
            made = k.get("fieldGoalsMade", 0)
            att = k.get("fieldGoalAttempts", 0)
            pts += made * 3
            pts += max(0, att - made) * -2

        xp_made = k.get("extraPointsMade", 0)
        xp_att = k.get("extraPointAttempts", 0)
        pts += xp_made * 1
        pts += max(0, xp_att - xp_made) * -1

    return pts


# ─────────────────────────────────────────────────────────────────────────
# Fetching + cache
# ─────────────────────────────────────────────────────────────────────────

def fetch_raw(athlete_id):
    url = STATS_URL.format(athlete_id=athlete_id)
    try:
        res = requests.get(url, timeout=TIMEOUT)
        if res.status_code != 200:
            return None
        return res.json()
    except Exception:
        return None


def load_cache():
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_cache(cache):
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f)


# ─────────────────────────────────────────────────────────────────────────
# Probe mode
# ─────────────────────────────────────────────────────────────────────────

def probe():
    print("PROBE MODE — nested parse + compound field splitting.\n")
    print("=" * 70)

    for aid in PROBE_IDS:
        print(f"\n--- Athlete ID {aid} ---")
        payload = fetch_raw(aid)
        if not payload:
            print("  REQUEST FAILED")
            time.sleep(REQUEST_DELAY)
            continue

        ath = payload.get("athlete") or {}
        print(f"  Name: {ath.get('displayName', '(not in payload)')}")

        stats = extract_season_stats(payload)
        if not stats:
            print(f"  No {SEASON} data")
            time.sleep(REQUEST_DELAY)
            continue

        for cat, vals in stats.items():
            print(f"\n  [{cat}]")
            for name, v in vals.items():
                print(f"    {name:<42} {v}")

        print(f"\n  >> Fantasy points: {round(score_player(stats), 2)}")
        time.sleep(REQUEST_DELAY)

    print("\n" + "=" * 70)


# ─────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────

def main():
    if not os.path.exists(INPUT_CSV):
        print(f"ERROR: {INPUT_CSV} not found in this directory.")
        sys.exit(1)

    with open(INPUT_CSV, "r", encoding="utf-8") as f:
        players = list(csv.DictReader(f))

    print(f"Loaded {len(players)} players from {INPUT_CSV}")

    cache = load_cache()
    print(f"Cache holds {len(cache)} previously fetched athletes\n")

    fetched = 0
    for i, p in enumerate(players, 1):
        aid = (p.get("id") or "").strip()

        # Punters aren't draftable in this league
        if p.get("position") == "P" or not aid:
            p["pts2025"] = ""
            continue

        if aid in cache:
            stats = cache[aid]
        else:
            stats = extract_season_stats(fetch_raw(aid))
            cache[aid] = stats
            fetched += 1
            time.sleep(REQUEST_DELAY)

            if fetched % 50 == 0:
                save_cache(cache)
                print(f"  [{i}/{len(players)}] fetched {fetched} new, cache saved")

        p["pts2025"] = round(score_player(stats), 2) if stats else ""

    save_cache(cache)
    print(f"\nFetched {fetched} new athletes. Scoring complete.")

    # ── Rankings ────────────────────────────────────────────────────────
    scored = [p for p in players if p.get("pts2025") not in ("", None)]
    unscored = [p for p in players if p.get("pts2025") in ("", None)]

    print(f"  {len(scored)} players with 2025 production")
    print(f"  {len(unscored)} players with none (freshmen, transfers, backups)")

    scored.sort(key=lambda p: float(p["pts2025"]), reverse=True)
    for rank, p in enumerate(scored, 1):
        p["ovrRank"] = rank

    by_pos = {}
    for p in scored:
        by_pos.setdefault(p["position"], []).append(p)
    for group in by_pos.values():
        for rank, p in enumerate(group, 1):
            p["posRank"] = rank

    for p in unscored:
        p["ovrRank"] = ""
        p["posRank"] = ""

    # ── Write ───────────────────────────────────────────────────────────
    fieldnames = list(players[0].keys())
    for col in ("pts2025", "posRank", "ovrRank"):
        if col not in fieldnames:
            fieldnames.append(col)

    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for p in players:
            p.setdefault("posRank", "")
            p.setdefault("ovrRank", "")
            writer.writerow(p)

    print(f"\nWrote {OUTPUT_CSV}")

    print("\nTop 25 overall by 2025 fantasy points:")
    for p in scored[:25]:
        print(
            f"  {p['ovrRank']:>3}. {p['firstName']} {p['lastName']:<22} "
            f"{p['position']:<3} {p['team'][:28]:<28} {p['pts2025']:>7}"
        )

    print("\nTop 5 at each position:")
    for pos in ("QB", "RB", "WR", "TE", "K"):
        group = by_pos.get(pos, [])[:5]
        if not group:
            continue
        print(f"\n  {pos}")
        for p in group:
            print(
                f"    {p['posRank']}. {p['firstName']} {p['lastName']:<22} "
                f"{p['team'][:28]:<28} {p['pts2025']:>7}"
            )


if __name__ == "__main__":
    if "--probe" in sys.argv:
        probe()
    else:
        main()