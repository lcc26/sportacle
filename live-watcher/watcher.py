#!/usr/bin/env python3
"""
Sportacle live watcher.

ESPN's public API is poll-only (no push). This always-on worker polls the
World Cup scoreboard, diffs each event against the prior snapshot, and on a
transition logs the matching card spec (Goal / Half / Final / Who Wins) to an
in-memory feed served at GET /feed.json (CORS-open). The phone page on
gosportacle.com/live pulls that feed and renders each spec with render.js, so
the phone never has to do the watching and nothing is missed while it sleeps.

stdlib only (urllib, http.server, threading, json) -> no pip install, no
third-party supply-chain surface. Run: PORT=8080 python watcher.py
"""
import json, os, re, time, threading, unicodedata, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/"
SCOREBOARD = ESPN + "scoreboard"
TEAMS_URL = "https://gosportacle.com/make/teams.json"
STATE_PATH = os.environ.get("STATE_PATH", "state.json")
UA = {"User-Agent": "SportacleLiveWatcher/1.0 (+https://gosportacle.com)"}
MAX_CARDS = 60
KEEP_HOURS = 18

# ---- team aliasing: ported verbatim from the studio (normName + CANON) -------
CANON = {
    "drcongo": "congo", "congodr": "congo", "turkiye": "turkiye", "turkey": "turkiye",
    "unitedstates": "usa", "usa": "usa", "southkorea": "korea", "korearepublic": "korea",
    "republicofkorea": "korea", "ivorycoast": "ivory", "cotedivoire": "ivory",
    "bosniaandherzegovina": "bosnia", "bosniaherzegovina": "bosnia",
}
def norm_name(s):
    s = unicodedata.normalize("NFD", str(s or "").lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z]", "", s)
def canon(s):
    n = norm_name(s)
    return CANON.get(n, n)

TEAMS = []
def load_teams():
    global TEAMS
    try:
        TEAMS = get_json(TEAMS_URL)
    except Exception:
        try:
            with open(os.path.join(os.path.dirname(__file__), "teams.json")) as f:
                TEAMS = json.load(f)
        except Exception:
            TEAMS = []
def team_lookup(espn):
    c = canon(espn)
    for t in TEAMS:
        if canon(t.get("name", "")) == c:
            return t
    return None
def team_name(espn):
    t = team_lookup(espn); return t["name"] if t else espn
def team_code(espn):
    t = team_lookup(espn); return t["code"] if t else ""
def team_color(espn):
    t = team_lookup(espn); return t["color"] if t else "#1E9B4B"

# ---- ESPN fetch --------------------------------------------------------------
def get_json(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))

def ymd_u(epoch_ms):
    t = time.gmtime(epoch_ms / 1000.0)
    return "%04d%02d%02d" % (t.tm_year, t.tm_mon, t.tm_mday)

def iso_to_epoch_ms(iso):
    # ESPN gives UTC ISO (trailing Z), sometimes without seconds. Treat as UTC.
    from calendar import timegm
    s = str(iso).strip()
    m = re.match(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:?\d{2})?$", s)
    base = m.group(1) if m else s[:16]
    off = m.group(2) if m else None
    fmt = "%Y-%m-%dT%H:%M:%S" if len(base) == 19 else "%Y-%m-%dT%H:%M"
    epoch = timegm(time.strptime(base, fmt))
    if off and off != "Z":
        sign = 1 if off[0] == "+" else -1
        epoch -= sign * (int(off[1:3]) * 3600 + int(off[-2:]) * 60)
    return epoch * 1000.0

def parse_events(j):
    out = []
    for e in (j.get("events") or []):
        comp = (e.get("competitions") or [{}])[0]
        t = (comp.get("status") or {}).get("type") or {}
        cs = comp.get("competitors") or []
        def side(ha):
            for c in cs:
                if c.get("homeAway") == ha:
                    return c
            return {}
        def tm(c):
            x = c.get("team") or {}
            s = c.get("score")
            try:
                n = int(s) if (s is not None and s != "") else None
            except (TypeError, ValueError):
                n = None
            return {"name": x.get("displayName") or "", "score": n}
        iso = e.get("date") or comp.get("date")
        if not iso:
            continue
        try:
            epoch_ms = iso_to_epoch_ms(iso)
        except Exception:
            continue
        out.append({
            "id": str(e.get("id") or comp.get("id") or ""),
            "epoch": epoch_ms,
            "state": t.get("state") or "pre",
            "completed": bool(t.get("completed")),
            "detail": t.get("detail") or "",
            "shortDetail": t.get("shortDetail") or "",
            "home": tm(side("home")),
            "away": tm(side("away")),
        })
    return [ev for ev in out if ev["id"]]

def is_half(ev):
    return ev["shortDetail"] == "HT" or re.search(r"halftime|half time", ev["detail"] + " " + ev["shortDetail"], re.I)

def last_scorer(sm, scored_name):
    plays = (sm.get("scoringPlays") or sm.get("keyEvents") or []) if isinstance(sm, dict) else []
    c = canon(scored_name); best = None
    for pl in plays:
        team = (pl.get("team") or {}).get("displayName") or (pl.get("team") or {}).get("name") or ""
        if canon(team) != c:
            continue
        who = ""
        ai = pl.get("athletesInvolved") or []
        if ai and ai[0].get("displayName"):
            who = ai[0]["displayName"]
        else:
            parts = pl.get("participants") or []
            if parts and (parts[0].get("athlete") or {}).get("displayName"):
                who = parts[0]["athlete"]["displayName"]
        mn = (pl.get("clock") or {}).get("displayValue") or pl.get("time") or ""
        best = {"scorer": who, "min": mn}
    return best

def surname(full):
    a = str(full or "").strip().split()
    return " ".join(a[1:]) if len(a) > 1 else (a[0] if a else "")

# ---- feed state --------------------------------------------------------------
LOCK = threading.Lock()
snap = {}     # eventId -> {state, home, away}
seen = set()  # dedup keys
cards = []    # newest first
seeding = True

def save_state():
    try:
        with open(STATE_PATH, "w") as f:
            json.dump({"snap": snap, "seen": list(seen), "cards": cards}, f)
    except Exception:
        pass
def load_state():
    global snap, seen, cards, seeding
    try:
        with open(STATE_PATH) as f:
            d = json.load(f)
        snap = d.get("snap", {}); seen = set(d.get("seen", [])); cards = d.get("cards", [])
        seeding = False  # we already have prior state; don't retro-emit
    except Exception:
        pass

def add_card(key, kind, ctype, params, label, matchup):
    with LOCK:
        if key in seen:
            return
        seen.add(key)
        cards.insert(0, {"id": key, "kind": kind, "type": ctype, "params": params,
                         "label": label, "matchup": matchup, "ts": int(time.time() * 1000)})
        cutoff = (time.time() - KEEP_HOURS * 3600) * 1000
        kept = [c for c in cards if c["ts"] >= cutoff][:MAX_CARDS]
        cards[:] = kept
    save_state()
    print("[card] %s  %s" % (kind, matchup), flush=True)

def vs_params(ev):
    return {
        "an": team_name(ev["home"]["name"]), "ac": team_code(ev["home"]["name"]), "acolor": team_color(ev["home"]["name"]),
        "bn": team_name(ev["away"]["name"]), "bc": team_code(ev["away"]["name"]), "bcolor": team_color(ev["away"]["name"]),
        "hg": str(ev["home"]["score"] or 0), "ag": str(ev["away"]["score"] or 0),
    }

def emit_vs(ev, ctype, extra, kind):
    p = vs_params(ev); p.update(extra or {})
    add_card("%s:%s" % (ev["id"], kind.lower().replace(" ", "")), kind, ctype, p,
             kind, ev["home"]["name"] + " v " + ev["away"]["name"])

def emit_goal(ev, side):
    scored = ev["home"]["name"] if side == "home" else ev["away"]["name"]
    opp = ev["away"]["name"] if side == "home" else ev["home"]["name"]
    hs, as_ = ev["home"]["score"] or 0, ev["away"]["score"] or 0
    p = {"team": team_name(scored), "code": team_code(scored), "tc": team_color(scored) or "#1E9B4B",
         "score": "%d-%d" % (hs, as_), "vs": team_code(opp), "home": "1" if side == "home" else "0", "tag": "Live"}
    try:
        sc = last_scorer(get_json(ESPN + "summary?event=" + ev["id"]), scored)
        if sc:
            if sc["scorer"]:
                p["scorer"] = surname(sc["scorer"])
            if sc["min"]:
                p["min"] = sc["min"]
    except Exception:
        pass
    key = "%s:goal:%d-%d" % (ev["id"], hs, as_)
    add_card(key, "Goal", "goal", p, team_name(scored) + (" · " + p.get("scorer", "") if p.get("scorer") else ""),
             ev["home"]["name"] + " v " + ev["away"]["name"])

def detect(evs, seed):
    for ev in evs:
        prev = snap.get(ev["id"])
        hs, as_ = ev["home"]["score"] or 0, ev["away"]["score"] or 0
        if ev["state"] == "pre":
            mins = (ev["epoch"] - time.time() * 1000) / 60000.0
            if 0 < mins < 360 and (ev["id"] + ":ww") not in seen:
                emit_vs(ev, "whowins", {}, "Who Wins")
        elif ev["state"] == "in":
            if prev and prev["state"] == "in":
                if hs > prev["home"]:
                    emit_goal(ev, "home")
                if as_ > prev["away"]:
                    emit_goal(ev, "away")
            if is_half(ev) and (ev["id"] + ":ht") not in seen:
                seen.add(ev["id"] + ":ht")
                if not seed:
                    emit_vs(ev, "half", {"label": "Half Time", "lc": "#FFC400"}, "Half")
        elif ev["state"] == "post" or ev["completed"]:
            if (ev["id"] + ":ft") not in seen:
                seen.add(ev["id"] + ":ft")
                if not seed:
                    emit_vs(ev, "final", {"label": "Full Time"}, "Final")
        snap[ev["id"]] = {"state": ev["state"], "home": hs, "away": as_}

def poll_loop():
    global seeding
    while True:
        delay = 300
        try:
            now = time.time() * 1000
            url = "%s?dates=%s-%s" % (SCOREBOARD, ymd_u(now - 36 * 3600 * 1000), ymd_u(now + 60 * 3600 * 1000))
            evs = parse_events(get_json(url))
            detect(evs, seeding); seeding = False
            live_n = sum(1 for e in evs if e["state"] == "in")
            soon = any(e["state"] == "pre" and (e["epoch"] - now) < 15 * 60000 for e in evs)
            delay = 30 if (live_n or soon) else 300
            print("[poll] %d fixtures, %d live, next in %ds" % (len(evs), live_n, delay), flush=True)
        except Exception as e:
            print("[poll] error: %s" % e, flush=True)
            delay = 60
        time.sleep(delay)

# ---- HTTP --------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        b = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/feed.json", "/feed"):
            with LOCK:
                payload = json.dumps({"updated": int(time.time() * 1000), "cards": cards})
            self._send(200, payload)
        elif path in ("/healthz", "/"):
            self._send(200, json.dumps({"ok": True, "cards": len(cards), "teams": len(TEAMS)}))
        else:
            self._send(404, json.dumps({"error": "not found"}))
    def log_message(self, *a):
        pass

def main():
    load_teams()
    load_state()
    threading.Thread(target=poll_loop, daemon=True).start()
    port = int(os.environ.get("PORT", "8080"))
    print("[boot] teams=%d, serving on :%d" % (len(TEAMS), port), flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()

if __name__ == "__main__":
    main()
