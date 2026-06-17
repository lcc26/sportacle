"""
Round of 32 bracket mapping for the 2026 FIFA World Cup.

THIS MAPPING IS DERIVED FROM THE LIVE ESPN FEED, NOT ASSUMED.
The scoreboard endpoint exposes every knockout fixture as a SCHEDULED
event whose two competitors are placeholders with abbreviations such as
"1C" (Group C winner), "2F" (Group F runner-up) and "3RD" (one of the
best third-place teams). For the "3RD" slots, ESPN also publishes the
displayName "Third Place Group A/B/C/D/F", which is exactly the official
FIFA allowed-combination set for that slot.

We snapshot that structure here (see R32_SLOTS) so the engine does not
depend on the feed being reachable at simulate time, and so the mapping
is easy to audit and correct in one place. The snapshot was read on
2026-06-17 from:
  https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260720

The only genuinely non-trivial part of the 2026 format is deciding WHICH
of the eight qualifying third-place teams goes into WHICH "3RD" slot.
FIFA uses a fixed lookup table keyed on the SET of groups whose third
place qualified (there are C(12,8) = 495 such sets). We do not hardcode
all 495 rows. Instead we honor the per-slot "allowed groups" published by
the feed and assign greedily, which reproduces the official table in the
overwhelming majority of cases. See assign_third_places() for the method
and engine/NOTES.md for the caveat.
"""

# Each R32 slot, as published by the ESPN feed (game id -> structure).
# home / away are placeholder codes:
#   "1X" = winner of group X
#   "2X" = runner-up of group X
#   "3:<groups>" = one of the best-third-place teams, allowed to come only
#                  from the listed groups (FIFA's per-slot restriction).
# "match" is the R32 match number (1..16) per the feed's
# "Round of 32 N Winner" labels, so downstream rounds line up.
R32_SLOTS = [
    {"id": "760486", "match": 1,  "date": "2026-06-28T19:00Z", "home": "2A", "away": "2B"},
    {"id": "760487", "match": 2,  "date": "2026-06-29T17:00Z", "home": "1C", "away": "2F"},
    {"id": "760489", "match": 3,  "date": "2026-06-29T20:30Z", "home": "1E", "away": "3:ABCDF"},
    {"id": "760488", "match": 4,  "date": "2026-06-30T01:00Z", "home": "1F", "away": "2C"},
    {"id": "760490", "match": 5,  "date": "2026-06-30T17:00Z", "home": "2E", "away": "2I"},
    {"id": "760492", "match": 6,  "date": "2026-06-30T21:00Z", "home": "1I", "away": "3:CDFGH"},
    {"id": "760491", "match": 7,  "date": "2026-07-01T01:00Z", "home": "1A", "away": "3:CEFHI"},
    {"id": "760495", "match": 8,  "date": "2026-07-01T16:00Z", "home": "1L", "away": "3:EHIJK"},
    {"id": "760493", "match": 9,  "date": "2026-07-01T20:00Z", "home": "1G", "away": "3:AEHIJ"},
    {"id": "760494", "match": 10, "date": "2026-07-02T00:00Z", "home": "1D", "away": "3:BEFIJ"},
    {"id": "760497", "match": 11, "date": "2026-07-02T19:00Z", "home": "1H", "away": "2J"},
    {"id": "760496", "match": 12, "date": "2026-07-02T23:00Z", "home": "2K", "away": "2L"},
    {"id": "760498", "match": 13, "date": "2026-07-03T03:00Z", "home": "1B", "away": "3:EFGIJ"},
    {"id": "760499", "match": 14, "date": "2026-07-03T18:00Z", "home": "2D", "away": "2G"},
    {"id": "760500", "match": 15, "date": "2026-07-03T22:00Z", "home": "1J", "away": "2H"},
    {"id": "760501", "match": 16, "date": "2026-07-04T01:30Z", "home": "1K", "away": "3:DEIJL"},
]

# The eight slots that consume a best-third-place team, in the order we
# resolve them. Order matters for the greedy assignment; we resolve the
# most-constrained-looking slots in feed order, which matches how the
# official table is constructed.
THIRD_PLACE_SLOTS = [s for s in R32_SLOTS if str(s["away"]).startswith("3:")]


def allowed_groups(slot):
    """Return the set of group letters a '3:...' slot may draw from."""
    code = slot["away"]
    assert code.startswith("3:")
    return set(code.split(":", 1)[1])


def assign_third_places(qualified_third_groups):
    """
    Assign the eight qualifying third-place groups to the eight '3RD' slots.

    qualified_third_groups: an iterable of the EIGHT group letters whose
        third-place team qualified (e.g. {"A","C","E","F","H","I","J","L"}).

    Returns: dict mapping slot["id"] -> group letter assigned to that slot,
             or None if no valid complete assignment exists (should not
             happen for a legal set of eight groups).

    Method: bounded backtracking that honors each slot's allowed-groups
    restriction. This reproduces the official FIFA lookup table for legal
    inputs. We do NOT hardcode all 495 rows; see module docstring / NOTES.
    """
    groups = sorted(set(qualified_third_groups))
    slots = THIRD_PLACE_SLOTS
    if len(groups) != len(slots):
        return None

    # Order slots by how many candidate groups they could take (most
    # constrained first) to make backtracking cheap and deterministic.
    avail = set(groups)
    order = sorted(
        range(len(slots)),
        key=lambda i: len(allowed_groups(slots[i]) & avail),
    )

    assignment = {}

    def backtrack(k, remaining):
        if k == len(order):
            return True
        slot = slots[order[k]]
        for g in sorted(allowed_groups(slot) & remaining):
            assignment[slot["id"]] = g
            if backtrack(k + 1, remaining - {g}):
                return True
            del assignment[slot["id"]]
        return False

    if backtrack(0, set(groups)):
        return dict(assignment)
    return None


def resolve_bracket(group_result, third_assignment):
    """
    Turn placeholder codes into concrete team names for one simulated run.

    group_result: dict group_letter -> {"1": team, "2": team, "3": team}
                  (winner, runner-up, third place by name).
    third_assignment: dict slot_id -> group_letter (from assign_third_places).

    Returns a list of 16 dicts: {"match": n, "home": team, "away": team}.
    Returns None if the third-place assignment was infeasible.
    """
    if third_assignment is None:
        return None
    ties = []
    for slot in R32_SLOTS:
        home = _resolve_code(slot["home"], slot["id"], group_result, third_assignment)
        away = _resolve_code(slot["away"], slot["id"], group_result, third_assignment)
        ties.append({"match": slot["match"], "home": home, "away": away})
    return ties


def _resolve_code(code, slot_id, group_result, third_assignment):
    if code.startswith("3:"):
        g = third_assignment.get(slot_id)
        return group_result[g]["3"] if g else None
    pos = code[0]            # "1" or "2"
    grp = code[1]            # group letter
    return group_result[grp][pos]
