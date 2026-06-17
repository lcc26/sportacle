"""
Entry point: build the live Round-of-32 projection and write
web/data/predictions.json.

Run with:
    python3 engine/run.py
(no arguments; standard library only)

Pipeline:
  1. ESPN: pull group membership, played results, scheduled fixtures,
     and the most-recently-finished match (for the real timestamp).
  2. Elo: seed every team, replay played results to update ratings.
  3. Monte Carlo: simulate the rest of the group stage many times and
     tally, for each of the 16 R32 ties, the opponent distribution and
     each team's advance probability.
  4. For each tie, pick the "more-determined" side (the host slot, i.e.
     a group winner or runner-up) as `team`, its most-likely concrete
     opponent as `opponent`, and up to two `alternates`.
  5. Write predictions.json in the exact site schema, with a REAL
     updated_iso (end time of the most recent finished match).
"""

import json
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import espn
import model
import bracket
import simulate
from teams import TEAMS, meta

N_SIMS = 30000

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "web", "data", "predictions.json"))


def build_ratings(played):
    """Seed Elo from teams.py and update with the finished results."""
    ratings = {name: rec["elo"] for name, rec in TEAMS.items()}
    # apply in chronological order
    for m in sorted(played, key=lambda x: x["iso"]):
        if m["home"] in ratings and m["away"] in ratings:
            model.apply_result(
                ratings, m["home"], m["away"], m["home_goals"], m["away_goals"]
            )
    return ratings


def _team_obj(name, note=None):
    m = meta(name) or {}
    obj = {"name": name, "code": m.get("code", ""), "color": m.get("color", "#444444")}
    if note:
        obj["note"] = note
    return obj


# Which side of a slot is the "more-determined" host. Group winners are
# more determined than runners-up; runners-up more than thirds.
def _determinacy(code):
    if code.startswith("1"):
        return 3
    if code.startswith("2"):
        return 2
    return 1   # "3:..." third-place


SLOT_BY_MATCH = {s["match"]: s for s in bracket.R32_SLOTS}


def _slot_note(code):
    pos = code[0]
    grp = code[1] if len(code) > 1 else "?"
    if pos == "1":
        return "Projected winner, Group %s" % grp
    if pos == "2":
        return "Projected runner-up, Group %s" % grp
    return "Projected best third place"


def build_matchups(results):
    slot_opponents = results["slot_opponents"]
    feasible = results["feasible_sims"] or 1
    matchups = []

    for s in bracket.R32_SLOTS:
        m = s["match"]
        # Decide which placeholder is the "team" (host) side.
        if _determinacy(s["home"]) >= _determinacy(s["away"]):
            team_code, opp_code = s["home"], s["away"]
            team_index = "home"
        else:
            team_code, opp_code = s["away"], s["home"]
            team_index = "away"

        # Most-likely concrete identity of the team side, and the opponent
        # distribution conditional on nothing (marginal over all sims).
        team_counter = defaultdict(int)
        opp_counter = defaultdict(int)
        for (home, away), cnt in slot_opponents[m].items():
            if home is None or away is None:
                continue
            t = home if team_index == "home" else away
            o = away if team_index == "home" else home
            team_counter[t] += cnt
            opp_counter[o] += cnt

        if not team_counter:
            continue

        team_name = max(team_counter, key=team_counter.get)
        # Opponent distribution restricted to runs where the team side is
        # the projected team_name (so the percentages read naturally).
        cond = defaultdict(int)
        total = 0
        for (home, away), cnt in slot_opponents[m].items():
            t = home if team_index == "home" else away
            o = away if team_index == "home" else home
            if t == team_name and o is not None:
                cond[o] += cnt
                total += cnt
        if total == 0:
            cond, total = opp_counter, sum(opp_counter.values())

        ranked = sorted(cond.items(), key=lambda kv: kv[1], reverse=True)
        opp_name, opp_cnt = ranked[0]
        opp_prob = int(round(100.0 * opp_cnt / total))

        alternates = []
        for name, cnt in ranked[1:3]:
            alternates.append({"name": name, "prob": int(round(100.0 * cnt / total))})

        team_obj = _team_obj(team_name, _slot_note(team_code))
        opp_obj = _team_obj(opp_name)
        opp_obj["prob"] = opp_prob

        matchups.append({
            "team": team_obj,
            "opponent": opp_obj,
            "alternates": alternates,
        })

    return matchups


def main():
    print("Fetching group membership from ESPN standings ...")
    membership = espn.fetch_group_membership()
    print("  groups:", ", ".join(sorted(membership.keys())))

    print("Fetching fixtures and results from ESPN scoreboard ...")
    played, scheduled, last = espn.fetch_matches()
    print("  played group matches:   ", len(played))
    print("  scheduled group matches:", len(scheduled))

    ratings = build_ratings(played)

    print("Running Monte Carlo (%d sims) ..." % N_SIMS)
    results = simulate.run(membership, played, scheduled, ratings, n_sims=N_SIMS)
    print("  feasible bracket sims:  ", results["feasible_sims"])

    matchups = build_matchups(results)
    print("  R32 ties produced:      ", len(matchups))

    if last:
        updated_iso = last["iso"]
        hm = meta(last["home"]); am = meta(last["away"])
        last_result = "%s %d-%d %s" % (
            last["home"], last["home_goals"], last["away_goals"], last["away"]
        )
    else:
        from datetime import datetime, timezone
        updated_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
        last_result = None

    out = {
        "tournament": "FIFA World Cup 2026",
        "stage": "Projected Round of 32",
        "updated_iso": updated_iso,
        "model": "Sportacle forecast",
        "matchups": matchups,
    }
    if last_result:
        out["last_result"] = last_result

    with open(OUT, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print("Wrote", OUT)
    print("  updated_iso:", updated_iso)
    if last_result:
        print("  last_result:", last_result)


if __name__ == "__main__":
    main()
