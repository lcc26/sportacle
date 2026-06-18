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
import base64, json, os, posixpath, re, time, threading, unicodedata, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
BASIC_USER = os.environ.get("BASIC_USER", "lariat")
BASIC_PASS = os.environ.get("BASIC_PASS", "")  # set on Railway; empty = auth disabled (warned at boot)
CTYPES = {".html": "text/html; charset=utf-8", ".js": "application/javascript", ".json": "application/json",
          ".png": "image/png", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon",
          ".webmanifest": "application/manifest+json"}

ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/"
SCOREBOARD = ESPN + "scoreboard"
TEAMS_URL = "https://gosportacle.com/make/teams.json"
STANDINGS_URL = "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings?season=2026"
PREDICTIONS_URL = "https://gosportacle.com/data/predictions.json"
STATE_PATH = os.environ.get("STATE_PATH", "state.json")
# Event-driven deploy: on full time, fire the GitHub workflow that re-runs the
# engine + redeploys, so projections refresh within ~2 min of the whistle
# (the */15 cron is unreliable). No-op until GITHUB_TOKEN is set on Railway.
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "lcc26/sportacle")
GITHUB_WORKFLOW = os.environ.get("GITHUB_WORKFLOW", "update-predictions.yml")
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
snap = {}        # eventId -> {state, home, away}
seen = set()     # dedup keys
cards = []       # newest first
ht_scores = {}   # eventId -> [hs, as] captured at halftime (for Bottled It)
scorelines = set()  # sorted "min-max" strings seen this tournament (for Scorigami)
proj_last = {"iso": "", "map": {}}  # last seen predictions snapshot (for the shift tracker)
shifts = []      # newest first: how projections moved after each result
seeding = True

def save_state():
    try:
        d = os.path.dirname(STATE_PATH)
        if d:
            os.makedirs(d, exist_ok=True)
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"snap": snap, "seen": list(seen), "cards": cards,
                       "ht": ht_scores, "scorelines": list(scorelines),
                       "proj_last": proj_last, "shifts": shifts}, f)
        os.replace(tmp, STATE_PATH)  # atomic
    except Exception as e:
        print("[state] save failed (%s): %s" % (STATE_PATH, e), flush=True)
def load_state():
    global snap, seen, cards, ht_scores, scorelines, proj_last, shifts, seeding
    try:
        with open(STATE_PATH) as f:
            d = json.load(f)
        snap = d.get("snap", {}); seen = set(d.get("seen", [])); cards = d.get("cards", [])
        ht_scores = d.get("ht", {}); scorelines = set(d.get("scorelines", []))
        proj_last = d.get("proj_last", {"iso": "", "map": {}}); shifts = d.get("shifts", [])
        seeding = False  # we already have prior state; don't retro-emit
        print("[state] loaded %d cards / %d seen from %s" % (len(cards), len(seen), STATE_PATH), flush=True)
    except FileNotFoundError:
        print("[state] no prior state at %s (fresh start, will seed)" % STATE_PATH, flush=True)
    except Exception as e:
        print("[state] load failed (%s): %s" % (STATE_PATH, e), flush=True)

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

# ---- roast verdicts -----------------------------------------------------------
def _stat_int(stats_list, name):
    for x in stats_list or []:
        if x.get("name") == name:
            try:
                return int(float(x.get("displayValue") or x.get("value") or 0))
            except (TypeError, ValueError):
                return 0
    return 0

def team_stats(ev):
    out = {}
    try:
        sm = get_json(ESPN + "summary?event=" + ev["id"])
    except Exception:
        return out
    for ros in (sm.get("rosters") or []):
        tname = (ros.get("team") or {}).get("displayName", "")
        agg = out.setdefault(canon(tname), {"shots": 0, "sot": 0, "yel": 0, "red": 0, "goals": 0})
        for q in (ros.get("roster") or []):
            st = q.get("stats") or []
            agg["shots"] += _stat_int(st, "totalShots"); agg["sot"] += _stat_int(st, "shotsOnTarget")
            agg["yel"] += _stat_int(st, "yellowCards"); agg["red"] += _stat_int(st, "redCards")
            agg["goals"] += _stat_int(st, "totalGoals")
    return out

_stand_cache = {"t": 0.0, "wins": {}}
def winless_map():
    now = time.time()
    if now - _stand_cache["t"] < 300 and _stand_cache["wins"]:
        return _stand_cache["wins"]
    try:
        d = get_json(STANDINGS_URL)
        m = {}
        for g in d.get("children", []):
            for en in ((g.get("standings") or {}).get("entries") or []):
                m[canon((en.get("team") or {}).get("displayName", ""))] = _stat_int(en.get("stats"), "wins")
        if m:
            _stand_cache["t"] = now; _stand_cache["wins"] = m
        return m
    except Exception:
        return _stand_cache["wins"]

def verdict_card(ev, vid, stamp, color, headline, receipt, marks=False):
    p = vs_params(ev)
    p["stamp"] = stamp; p["stampColor"] = color
    if headline:
        p["headline"] = headline
    if receipt:
        p["receipt"] = receipt
    if marks:
        p.pop("hg", None); p.pop("ag", None); p["markA"] = "L"; p["markB"] = "L"
    add_card("%s:v:%s" % (ev["id"], vid), "Roast", "verdict", p, stamp.title(),
             ev["home"]["name"] + " v " + ev["away"]["name"])

def record_scoreline(ev):
    hs, as_ = ev["home"]["score"] or 0, ev["away"]["score"] or 0
    scorelines.add("%d-%d" % (min(hs, as_), max(hs, as_)))

def emit_verdicts(ev):
    hs, as_ = ev["home"]["score"] or 0, ev["away"]["score"] or 0
    hn, an_ = team_name(ev["home"]["name"]), team_name(ev["away"]["name"])
    total, margin, draw = hs + as_, abs(hs - as_), hs == as_
    # Scorigami: a sorted scoreline not seen before (skip the dull low-scoring ones)
    key = "%d-%d" % (min(hs, as_), max(hs, as_))
    fresh = key not in scorelines
    scorelines.add(key)
    if fresh and total >= 3:
        verdict_card(ev, "scorigami", "SCORIGAMI", "#1E9B4B",
                     "First %d-%d of the tournament" % (max(hs, as_), min(hs, as_)),
                     "A scoreline we had not seen yet")
    if margin >= 4:
        win, lose = (hn, an_) if hs > as_ else (an_, hn)
        verdict_card(ev, "mercy", "MERCY RULE", "#C8102E",
                     "%s put %s to bed" % (win, lose), "Somebody call it off")
    if draw and total <= 2:
        verdict_card(ev, "bore", "BORE DRAW", "#C8102E",
                     "Mutually assured mediocrity", "90 minutes you will never get back")
    if draw:
        wm = winless_map(); ch, ca = canon(ev["home"]["name"]), canon(ev["away"]["name"])
        if wm and wm.get(ch, 1) == 0 and wm.get(ca, 1) == 0:
            verdict_card(ev, "doublel", "NOBODY WINS", "#C8102E",
                         "A point that helps neither", "Both still without a win", marks=True)
    ht = ht_scores.get(ev["id"])
    if ht and ht[0] != ht[1]:
        led_home = ht[0] > ht[1]
        bottler = hn if (led_home and not (hs > as_)) else (an_ if ((not led_home) and not (as_ > hs)) else None)
        if bottler:
            verdict_card(ev, "bottled", "BOTTLED IT", "#C8102E",
                         "%s led at the half. Then this." % bottler, "A lead is not a guarantee")
    ts = team_stats(ev)
    if ts:
        for side in (ev["home"]["name"], ev["away"]["name"]):
            s = ts.get(canon(side))
            if s and s["shots"] >= 15 and s["goals"] == 0:
                verdict_card(ev, "allergic", "ALLERGIC TO THE NET", "#ED2939",
                             "All shots, no end product", "%s: %d shots, 0 goals" % (team_name(side), s["shots"]))
                break
        cards_total = sum((v["yel"] + v["red"]) for v in ts.values())
        if cards_total >= 8:
            verdict_card(ev, "fight", "THAT WASN'T FOOTBALL", "#C8102E",
                         "More cards than chances", "%d cards shown" % cards_total)

def detect(evs, seed):
    ft = False
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
                ht_scores[ev["id"]] = [hs, as_]   # capture the halftime score (for Bottled It)
                if not seed:
                    emit_vs(ev, "half", {"label": "Half Time", "lc": "#FFC400"}, "Half")
        elif ev["state"] == "post" or ev["completed"]:
            if (ev["id"] + ":ft") not in seen:
                seen.add(ev["id"] + ":ft")
                if not seed:
                    emit_vs(ev, "final", {"label": "Full Time"}, "Final")
                    emit_verdicts(ev)
                    ft = True
                else:
                    record_scoreline(ev)   # seed: remember the scoreline so Scorigami stays accurate
        snap[ev["id"]] = {"state": ev["state"], "home": hs, "away": as_}
    return ft

_last_dispatch = [0.0]
def trigger_deploy():
    if not GITHUB_TOKEN:
        return
    now = time.time()
    if now - _last_dispatch[0] < 90:   # debounce several near-simultaneous finals into one deploy
        return
    _last_dispatch[0] = now
    try:
        url = "https://api.github.com/repos/%s/actions/workflows/%s/dispatches" % (GITHUB_REPO, GITHUB_WORKFLOW)
        req = urllib.request.Request(url, data=json.dumps({"ref": "main"}).encode("utf-8"), method="POST",
                                     headers={"Authorization": "Bearer " + GITHUB_TOKEN, "Accept": "application/vnd.github+json",
                                              "User-Agent": "SportacleLiveWatcher", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            print("[deploy] triggered %s after full time (HTTP %d)" % (GITHUB_WORKFLOW, r.status), flush=True)
    except Exception as e:
        print("[deploy] trigger failed: %s" % e, flush=True)

def poll_projections():
    # Fetch the public projections; when updated_iso changes (a new result was
    # folded in), diff each team's projected R32 opponent and log the shifts.
    try:
        d = get_json(PREDICTIONS_URL + "?t=" + str(int(time.time())))
    except Exception:
        return
    iso = d.get("updated_iso") or ""
    cur = {}
    for m in (d.get("matchups") or []):
        tn = (m.get("team") or {}).get("name", "")
        opp = m.get("opponent") or {}
        if tn:
            cur[tn] = {"opp": opp.get("name", ""), "prob": int(opp.get("prob") or 0),
                       "code": (m.get("team") or {}).get("code", ""), "oppcode": opp.get("code", "")}
    if not cur:
        return
    if not proj_last["map"]:
        proj_last["iso"] = iso; proj_last["map"] = cur; save_state(); return  # first snapshot, nothing to diff
    if iso and iso != proj_last["iso"]:
        changes = []
        for tn, nv in cur.items():
            ov = proj_last["map"].get(tn)
            if not ov:
                continue
            flip = ov["opp"] != nv["opp"]
            if flip or abs(nv["prob"] - ov["prob"]) >= 3:
                changes.append({"team": tn, "code": nv.get("code", ""),
                                "oldOpp": ov["opp"], "oldProb": ov["prob"],
                                "newOpp": nv["opp"], "newProb": nv["prob"],
                                "newOppCode": nv.get("oppcode", ""), "flip": flip})
        if changes:
            changes.sort(key=lambda c: (not c["flip"], -abs(c["newProb"] - c["oldProb"])))
            shifts.insert(0, {"ts": int(time.time() * 1000), "iso": iso,
                              "result": d.get("last_result", ""), "changes": changes})
            del shifts[40:]
            print("[shift] %d projection changes after %s" % (len(changes), d.get("last_result", "")), flush=True)
        proj_last["iso"] = iso; proj_last["map"] = cur; save_state()

def poll_loop():
    global seeding
    while True:
        delay = 300
        try:
            now = time.time() * 1000
            url = "%s?dates=%s-%s" % (SCOREBOARD, ymd_u(now - 36 * 3600 * 1000), ymd_u(now + 60 * 3600 * 1000))
            evs = parse_events(get_json(url))
            ft = detect(evs, seeding); seeding = False
            if ft:
                trigger_deploy()
            poll_projections()
            live_n = sum(1 for e in evs if e["state"] == "in")
            soon = any(e["state"] == "pre" and (e["epoch"] - now) < 15 * 60000 for e in evs)
            delay = 30 if (live_n or soon) else 300
            print("[poll] %d fixtures, %d live, next in %ds" % (len(evs), live_n, delay), flush=True)
        except Exception as e:
            print("[poll] error: %s" % e, flush=True)
            delay = 60
        time.sleep(delay)

# ---- HTTP --------------------------------------------------------------------
def auth_ok(header):
    if not BASIC_PASS:
        return True  # auth disabled (boot warns); set BASIC_PASS on Railway to enforce
    if not header or not header.startswith("Basic "):
        return False
    try:
        u, _, p = base64.b64decode(header[6:]).decode("utf-8").partition(":")
        return u == BASIC_USER and p == BASIC_PASS
    except Exception:
        return False

class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json", extra=None):
        b = body if isinstance(body, (bytes, bytearray)) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)
    def do_GET(self):
        path = self.path.split("?")[0]
        # health stays open (Railway / uptime checks); everything else needs auth
        if path == "/healthz":
            return self._send(200, json.dumps({"ok": True, "cards": len(cards), "teams": len(TEAMS)}))
        if not auth_ok(self.headers.get("Authorization")):
            return self._send(401, "Authentication required\n", "text/plain; charset=utf-8",
                              {"WWW-Authenticate": 'Basic realm="Sportacle internal"'})
        if path in ("/feed.json", "/feed"):
            with LOCK:
                payload = json.dumps({"updated": int(time.time() * 1000), "cards": cards})
            return self._send(200, payload, "application/json", {"Cache-Control": "no-store"})
        if path in ("/shifts.json", "/shifts.json/"):
            with LOCK:
                payload = json.dumps({"updated": int(time.time() * 1000), "current_iso": proj_last.get("iso", ""), "shifts": shifts})
            return self._send(200, payload, "application/json", {"Cache-Control": "no-store"})
        return self._serve_static(path)
    def _serve_static(self, path):
        if path == "/":
            path = "/live/index.html"        # default landing is the phone page
        elif path.endswith("/"):
            path += "index.html"
        rel = posixpath.normpath(path).lstrip("/")
        full = os.path.join(STATIC_DIR, rel)
        if not os.path.abspath(full).startswith(STATIC_DIR + os.sep) or not os.path.isfile(full):
            return self._send(404, "Not found\n", "text/plain; charset=utf-8")
        with open(full, "rb") as f:
            data = f.read()
        ext = os.path.splitext(full)[1].lower()
        self._send(200, data, CTYPES.get(ext, "application/octet-stream"))
    def log_message(self, *a):
        pass

def main():
    load_teams()
    load_state()
    threading.Thread(target=poll_loop, daemon=True).start()
    port = int(os.environ.get("PORT", "8080"))
    if not BASIC_PASS:
        print("[boot] WARNING: BASIC_PASS not set -> auth DISABLED (set it on Railway to lock the tools)", flush=True)
    print("[boot] deploy-on-full-time: %s" % ("ON" if GITHUB_TOKEN else "OFF (set GITHUB_TOKEN to enable)"), flush=True)
    print("[boot] teams=%d, static=%s, serving on :%d" % (len(TEAMS), STATIC_DIR, port), flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()

if __name__ == "__main__":
    main()
