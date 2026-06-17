"""
Monte Carlo simulation of the remaining group stage and the resulting
Round of 32 bracket.

Each simulation:
  1. Starts from the real, already-played results (fixed).
  2. Simulates every remaining SCHEDULED group match with model.py.
  3. Completes the 12 group tables and ranks each on FIFA tiebreakers:
        points, then goal difference, then goals for.
     (Head-to-head is the official first tiebreaker after points; we
      approximate with GD then GF and note the simplification in NOTES.md.)
  4. Takes 1st and 2nd from each group plus the eight best third-place
     teams (ranked across all 12 groups on points, GD, GF).
  5. Resolves the real ESPN-derived R32 bracket (bracket.py), including
     the official per-slot third-place restriction.
  6. Records, for each of the 16 R32 ties, the (home, away) pair so we can
     build an opponent distribution per slot.

Across all sims we also tally each team's probability of advancing
(finishing 1st, 2nd, or qualifying as a best third).
"""

import random
from collections import defaultdict

import model
import bracket


def _standings_key(rec):
    # higher is better: points, goal difference, goals for
    return (rec["pts"], rec["gf"] - rec["ga"], rec["gf"])


def _blank_table(teams):
    return {t: {"pts": 0, "gf": 0, "ga": 0, "played": 0} for t in teams}


def _record(table, home, away, hg, ag):
    th, ta = table[home], table[away]
    th["gf"] += hg; th["ga"] += ag; th["played"] += 1
    ta["gf"] += ag; ta["ga"] += hg; ta["played"] += 1
    if hg > ag:
        th["pts"] += 3
    elif hg < ag:
        ta["pts"] += 3
    else:
        th["pts"] += 1; ta["pts"] += 1


def run(membership, played, scheduled, seed_ratings, n_sims=20000, seed=20260617):
    """
    Run the Monte Carlo. Returns a dict:
      {
        "slot_opponents": {match_no: {(home,away): count}},
        "advance": {team: count},
        "finish_first": {team: count},
        "finish_second": {team: count},
        "third_qualify": {team: count},
        "n_sims": n,
        "feasible_sims": n_feasible,
      }
    membership: dict group_letter -> [team, team, team, team]
    played:     list of finished group matches (fixed every sim)
    scheduled:  list of remaining group matches to simulate
    seed_ratings: dict team -> Elo already updated with played results
    """
    rng = random.Random(seed)

    # Pre-group the fixtures so we do not re-scan every sim.
    team_group = {}
    for g, teams in membership.items():
        for t in teams:
            team_group[t] = g

    played_by_group = defaultdict(list)
    for m in played:
        g = team_group.get(m["home"])
        if g and team_group.get(m["away"]) == g:
            played_by_group[g].append(m)

    sched_by_group = defaultdict(list)
    for m in scheduled:
        g = team_group.get(m["home"])
        if g and team_group.get(m["away"]) == g:
            sched_by_group[g].append(m)

    slot_opponents = {s["match"]: defaultdict(int) for s in bracket.R32_SLOTS}
    advance = defaultdict(int)
    finish_first = defaultdict(int)
    finish_second = defaultdict(int)
    third_qualify = defaultdict(int)
    feasible = 0

    groups_sorted = sorted(membership.keys())

    for _ in range(n_sims):
        group_result = {}          # letter -> {"1":team,"2":team,"3":team}
        thirds = []                # list of (letter, rec) for 3rd places

        for g in groups_sorted:
            teams = membership[g]
            table = _blank_table(teams)
            for m in played_by_group[g]:
                _record(table, m["home"], m["away"], m["home_goals"], m["away_goals"])
            for m in sched_by_group[g]:
                hg, ag = model.simulate_match(
                    rng, seed_ratings[m["home"]], seed_ratings[m["away"]]
                )
                _record(table, m["home"], m["away"], hg, ag)

            ranked = sorted(
                teams,
                key=lambda t: _standings_key(table[t]),
                reverse=True,
            )
            group_result[g] = {"1": ranked[0], "2": ranked[1], "3": ranked[2]}
            finish_first[ranked[0]] += 1
            finish_second[ranked[1]] += 1
            advance[ranked[0]] += 1
            advance[ranked[1]] += 1
            thirds.append((g, ranked[2], table[ranked[2]]))

        # Rank all 12 third-place teams; best 8 qualify.
        thirds_ranked = sorted(
            thirds, key=lambda x: _standings_key(x[2]), reverse=True
        )
        best_eight = thirds_ranked[:8]
        qualified_groups = sorted(g for (g, _team, _rec) in best_eight)
        for (_g, team, _rec) in best_eight:
            third_qualify[team] += 1
            advance[team] += 1

        assignment = bracket.assign_third_places(qualified_groups)
        ties = bracket.resolve_bracket(group_result, assignment)
        if ties is None:
            continue
        feasible += 1
        for tie in ties:
            slot_opponents[tie["match"]][(tie["home"], tie["away"])] += 1

    return {
        "slot_opponents": {k: dict(v) for k, v in slot_opponents.items()},
        "advance": dict(advance),
        "finish_first": dict(finish_first),
        "finish_second": dict(finish_second),
        "third_qualify": dict(third_qualify),
        "n_sims": n_sims,
        "feasible_sims": feasible,
    }
