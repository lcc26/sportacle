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
from datetime import datetime, timedelta

N_SIMS = 30000


def _match_end_iso(kickoff_iso, minutes=115):
    """ESPN's event 'date' is the KICKOFF time. A match runs about 115 minutes
    wall-clock (90 + stoppage + halftime), so add that to get the final whistle.
    Without it the site's 'updated X ago' label lags by roughly two hours."""
    s = str(kickoff_iso).strip().replace("Z", "")
    dt = None
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            dt = datetime.strptime(s, fmt)
            break
        except ValueError:
            continue
    if dt is None:
        return kickoff_iso
    return (dt + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%MZ")

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


def _opp_payload(cond):
    """From a conditional opponent count distribution, return
    (opp_name, opp_prob, alternates, field) or None if empty.
    opponent + alternates + field always sum to 100 (honest remainder)."""
    total = sum(cond.values())
    if total == 0:
        return None
    ranked = sorted(cond.items(), key=lambda kv: kv[1], reverse=True)
    opp_name, opp_cnt = ranked[0]
    opp_prob = int(round(100.0 * opp_cnt / total))
    alternates = [
        {"name": n, "prob": int(round(100.0 * c / total))}
        for n, c in ranked[1:3]
    ]
    field = max(0, 100 - opp_prob - sum(a["prob"] for a in alternates))
    return opp_name, opp_prob, alternates, field


def build_matchups(results):
    slot_opponents = results["slot_opponents"]

    # Pass 1: for each R32 slot, gather the host-side distribution and, for every
    # possible host team, the opponent distribution CONDITIONAL on that host.
    # The host is the more-determined side (a group winner over a runner-up, a
    # runner-up over a third place).
    slots = []
    for s in bracket.R32_SLOTS:
        m = s["match"]
        if _determinacy(s["home"]) >= _determinacy(s["away"]):
            team_code, team_index = s["home"], "home"
        else:
            team_code, team_index = s["away"], "away"
        host_dist = defaultdict(int)
        opp_by_host = defaultdict(lambda: defaultdict(int))
        for (home, away), cnt in slot_opponents[m].items():
            if home is None or away is None:
                continue
            t = home if team_index == "home" else away
            o = away if team_index == "home" else home
            host_dist[t] += cnt
            opp_by_host[t][o] += cnt
        if not host_dist:
            continue
        slots.append({
            "match": m,
            "team_code": team_code,
            "host_dist": host_dist,
            "opp_by_host": opp_by_host,
            "top_share": max(host_dist.values()),
        })

    # Pass 2: a team can occupy only ONE bracket slot, so every card must have a
    # DISTINCT subject. Resolve the most-determined slots first; each takes its
    # most likely host that is still free, so a group's two strong sides land on
    # the winner and runner-up cards instead of both showing the same team.
    slots.sort(key=lambda si: si["top_share"], reverse=True)
    used = set()
    built = []
    for si in slots:
        host = None
        for name, _c in sorted(si["host_dist"].items(), key=lambda kv: kv[1], reverse=True):
            if name not in used:
                host = name
                break
        if host is None:
            continue
        payload = _opp_payload(si["opp_by_host"][host])
        if payload is None:
            continue
        used.add(host)
        opp_name, opp_prob, alternates, field = payload
        team_obj = _team_obj(host, _slot_note(si["team_code"]))
        opp_obj = _team_obj(opp_name)
        opp_obj["prob"] = opp_prob
        built.append((si["match"], {
            "team": team_obj,
            "opponent": opp_obj,
            "alternates": alternates,
            "field": field,
        }))

    # Restore natural bracket order (match 1..16) for display.
    built.sort(key=lambda x: x[0])
    return [card for _m, card in built]


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
        updated_iso = _match_end_iso(last["iso"])
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
