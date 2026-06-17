"""
ESPN data access for the 2026 FIFA World Cup.

No API key required (confirmed working 2026-06-17). Python standard
library only: urllib for HTTP, json for parsing.

Two endpoints:
  - scoreboard: every fixture + live results (group stage and knockouts)
  - standings:  group membership and current points/GD/GF

We are defensive about field names because ESPN's shapes drift.
"""

import json
import ssl
import urllib.request

from teams import canonical

SCOREBOARD_URL = (
    "https://site.api.espn.com/apis/site/v2/sports/soccer/"
    "fifa.world/scoreboard?dates=20260611-20260720"
)
STANDINGS_URL = (
    "https://site.api.espn.com/apis/v2/sports/soccer/"
    "fifa.world/standings?season=2026"
)

# Some macOS Python builds ship an old LibreSSL; relax verification so the
# engine runs anywhere. We are only reading public sports data.
_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, context=_CTX, timeout=30) as resp:
        return json.load(resp)


def fetch_group_membership():
    """
    Return dict group_letter -> list of canonical team names (4 each),
    derived from the standings endpoint's 12 group children.
    """
    data = _get(STANDINGS_URL)
    groups = {}
    for child in data.get("children", []):
        name = child.get("name", "")
        if not name.startswith("Group "):
            continue
        letter = name.replace("Group ", "").strip()
        entries = (child.get("standings") or {}).get("entries", [])
        groups[letter] = [
            canonical(e["team"]["displayName"]) for e in entries
        ]
    return groups


def fetch_matches():
    """
    Return (played, scheduled, last_finished) parsed from the scoreboard.

    played: list of dicts for FINISHED group-stage matches:
        {"group": None, "home": team, "away": team,
         "home_goals": int, "away_goals": int, "iso": str}
        (group is filled in by the caller using membership; we leave the
         raw team names canonicalized here.)
    scheduled: list of dicts for SCHEDULED group-stage matches:
        {"home": team, "away": team, "iso": str}
    last_finished: dict for the most recently completed match overall
        (any stage) used for updated_iso + last_result label, or None.

    Only real teams are returned (placeholder knockout fixtures whose
    competitors are "Group C Winner" etc. are skipped, because their
    canonicalized names are not in our 48-team table).
    """
    from teams import TEAMS

    data = _get(SCOREBOARD_URL)
    events = data.get("events", [])

    played, scheduled = [], []
    finished_all = []

    for e in events:
        comps = e.get("competitions", [])
        if not comps:
            continue
        comp = comps[0]
        status = (e.get("status") or {}).get("type", {})
        iso = e.get("date") or comp.get("date")

        home = away = None
        hg = ag = None
        for c in comp.get("competitors", []):
            raw = c.get("team", {}).get("displayName", "")
            name = canonical(raw)
            try:
                goals = int(c.get("score")) if c.get("score") not in (None, "") else None
            except (TypeError, ValueError):
                goals = None
            if c.get("homeAway") == "home":
                home, hg = name, goals
            elif c.get("homeAway") == "away":
                away, ag = name, goals

        # Skip placeholder knockout fixtures (names not in our 48-team set).
        real = home in TEAMS and away in TEAMS
        completed = bool(status.get("completed"))

        if completed and real and hg is not None and ag is not None:
            played.append({
                "home": home, "away": away,
                "home_goals": hg, "away_goals": ag, "iso": iso,
            })
        elif (not completed) and real:
            scheduled.append({"home": home, "away": away, "iso": iso})

        if completed and real and hg is not None and ag is not None:
            finished_all.append({
                "home": home, "away": away,
                "home_goals": hg, "away_goals": ag, "iso": iso,
            })

    last_finished = None
    if finished_all:
        last_finished = max(finished_all, key=lambda m: m["iso"])

    return played, scheduled, last_finished
