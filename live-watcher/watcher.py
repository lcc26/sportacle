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
import base64, html, json, os, posixpath, random, re, time, threading, unicodedata, urllib.parse, urllib.request, urllib.error
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
# Phone push: when a notable ("recommended") card is generated, POST it to an
# ntfy.sh topic so the phone gets a tappable deep-link to the card. No-op until
# NTFY_TOPIC is set on Railway. Posting stays human (view-only); this only notifies.
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")
NTFY_SERVER = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
LIVE_BASE = os.environ.get("LIVE_BASE", "https://sportacle-live-production.up.railway.app").rstrip("/")
# Auto-source CC-licensed player portraits (Wikimedia Commons) for player cards.
COMMONS_PHOTOS = os.environ.get("COMMONS_PHOTOS", "1") != "0"
UA = {"User-Agent": "SportacleLiveWatcher/1.0 (+https://gosportacle.com)"}
MAX_CARDS = 60
KEEP_HOURS = 18
STATS_VERSION = 2   # bump to force a one-time re-scan of recent games when the player-stat logic changes

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

VBANK = {}   # verdict copy bank from static/make/verdicts.json
PWORDS = {}  # definition word bank from static/make/panel_words.json
KITS = {}    # jersey kits from static/make/kits.json
def load_banks():
    global VBANK, PWORDS, KITS
    try:
        with open(os.path.join(STATIC_DIR, "make", "verdicts.json")) as f:
            VBANK = json.load(f).get("verdicts") or {}
    except Exception:
        VBANK = {}
    try:
        with open(os.path.join(STATIC_DIR, "make", "panel_words.json")) as f:
            PWORDS = json.load(f).get("words") or {}
    except Exception:
        PWORDS = {}
    try:
        with open(os.path.join(STATIC_DIR, "make", "kits.json")) as f:
            KITS = json.load(f) or {}
    except Exception:
        KITS = {}

def home_kit(espn):
    c = canon(espn)
    for k in KITS:
        if canon(k) == c and KITS[k]:
            return [KITS[k][0].get("s"), KITS[k][0].get("t")]
    return None

def pos_name(abbr):
    a = str(abbr or "").upper()
    return {"F": "Forward", "M": "Midfielder", "D": "Defender", "G": "Goalkeeper", "GK": "Goalkeeper"}.get(a, a or "")

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
        who = ""; aid = ""
        ai = pl.get("athletesInvolved") or []
        if ai and ai[0].get("displayName"):
            who = ai[0]["displayName"]; aid = str(ai[0].get("id") or "")
        else:
            parts = pl.get("participants") or []
            if parts and (parts[0].get("athlete") or {}).get("displayName"):
                who = parts[0]["athlete"]["displayName"]; aid = str((parts[0].get("athlete") or {}).get("id") or "")
        mn = (pl.get("clock") or {}).get("displayValue") or pl.get("time") or ""
        best = {"scorer": who, "min": mn, "id": aid}
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
predictions_raw = {}  # last fetched predictions.json (served same-origin for the studio)
stats_done = set()    # eventIds we've already emitted player-stat cards for
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
                       "proj_last": proj_last, "shifts": shifts, "stats_done": list(stats_done),
                       "stats_version": STATS_VERSION}, f)
        os.replace(tmp, STATE_PATH)  # atomic
    except Exception as e:
        print("[state] save failed (%s): %s" % (STATE_PATH, e), flush=True)
def load_state():
    global snap, seen, cards, ht_scores, scorelines, proj_last, shifts, stats_done, seeding
    try:
        with open(STATE_PATH) as f:
            d = json.load(f)
        snap = d.get("snap", {}); seen = set(d.get("seen", [])); cards = d.get("cards", [])
        ht_scores = d.get("ht", {}); scorelines = set(d.get("scorelines", []))
        proj_last = d.get("proj_last", {"iso": "", "map": {}}); shifts = d.get("shifts", [])
        stats_done = set(d.get("stats_done", []))
        if d.get("stats_version") != STATS_VERSION:
            stats_done = set()   # logic changed -> re-scan recent games once (add_card dedups per player)
        seeding = False  # we already have prior state; don't retro-emit
        print("[state] loaded %d cards / %d seen from %s" % (len(cards), len(seen), STATE_PATH), flush=True)
    except FileNotFoundError:
        print("[state] no prior state at %s (fresh start, will seed)" % STATE_PATH, flush=True)
    except Exception as e:
        print("[state] load failed (%s): %s" % (STATE_PATH, e), flush=True)

# Cards worth pinging the phone for + pre-drafting an editable caption.
RECO_KINDS = {"Goal", "Player", "Roast", "Market Movers", "Definition"}

def caption_for(kind, ctype, p, matchup):
    # A draft, editable tweet caption assembled from facts already in the spec.
    # NO link in the body (a URL ~13x's any future API post cost; it goes in bio).
    try:
        if ctype == "goal":
            who, mn, sc = p.get("scorer", ""), p.get("min", ""), p.get("score", "")
            head = (who + (" " + mn if mn else "")) if who else (p.get("team", "") + " score")
            return (head + (" to make it " + sc if sc else "") + ". " + matchup).strip()
        if ctype == "stats":
            st = p.get("stats") or []
            line = ", ".join("%s %s" % (x.get("value", ""), x.get("label", "")) for x in st[:3] if x.get("value") not in ("", "0"))
            tag = "Player of the match: " if p.get("motm") else ""
            return (tag + p.get("player", "") + (" (" + line + ")" if line else "") + ". " + (p.get("context") or matchup)).strip()
        if ctype == "verdict":
            return " ".join(x for x in [p.get("headline", ""), p.get("receipt", "")] if x) or matchup
        if ctype == "panel":
            return (p.get("word", "") + ": " + (p.get("def1", "") or "")).strip(": ").strip() or matchup
        if ctype == "movers":
            rs = (p.get("risers") or []) + (p.get("fallers") or [])
            if rs:
                c = rs[0]
                return "%s's projected R32 foe: %s -> %s. The bracket moved." % (c.get("team", ""), c.get("oldOpp", ""), c.get("newOpp", ""))
            return "The projected bracket moved."
        if ctype == "final":
            return "%s %s-%s %s. Full time." % (p.get("an", ""), p.get("hg", "0"), p.get("ag", "0"), p.get("bn", ""))
        if ctype == "half":
            return "%s %s-%s %s at the break." % (p.get("an", ""), p.get("hg", "0"), p.get("ag", "0"), p.get("bn", ""))
        if ctype == "whowins":
            return "%s vs %s. Who wins?" % (p.get("an", ""), p.get("bn", ""))
    except Exception:
        pass
    return matchup

_push_ready = [False]   # flips True after the first poll so boot-backfill doesn't flood the phone
_last_push = [0.0]
def notify_push(card):
    if not NTFY_TOPIC or not _push_ready[0]:
        return
    now = time.time()
    if now - _last_push[0] < 8:    # collapse a full-time burst into one ping; the feed holds the rest
        return
    _last_push[0] = now
    try:
        title = (card.get("label") or card.get("kind") or "Sportacle")
        title = "".join(ch for ch in title if ord(ch) < 128).strip() or "Sportacle"   # HTTP header must be latin-1
        body = (card.get("caption") or card.get("matchup") or "")[:240]
        click = "%s/live/#%s" % (LIVE_BASE, urllib.parse.quote(card.get("id", ""), safe=""))
        req = urllib.request.Request(NTFY_SERVER + "/" + urllib.parse.quote(NTFY_TOPIC, safe=""),
                                     data=body.encode("utf-8"),
                                     headers={"Title": title, "Click": click, "Tags": "soccer",
                                              "User-Agent": "SportacleLiveWatcher"})
        with urllib.request.urlopen(req, timeout=10):
            pass
    except Exception as e:
        print("[push] failed: %s" % e, flush=True)

def add_card(key, kind, ctype, params, label, matchup):
    with LOCK:
        if key in seen:
            return
        seen.add(key)
        card = {"id": key, "kind": kind, "type": ctype, "params": params,
                "label": label, "matchup": matchup,
                "caption": caption_for(kind, ctype, params, matchup),
                "recommended": kind in RECO_KINDS,
                "ts": int(time.time() * 1000)}
        cards.insert(0, card)
        cutoff = (time.time() - KEEP_HOURS * 3600) * 1000
        kept = [c for c in cards if c["ts"] >= cutoff][:MAX_CARDS]
        cards[:] = kept
    save_state()
    print("[card] %s  %s" % (kind, matchup), flush=True)
    if card["recommended"]:
        notify_push(card)

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

def apply_subs(text, names, nums):
    si = [0]; di = [0]
    def s(_m):
        v = names[si[0]] if si[0] < len(names) else (names[-1] if names else "")
        si[0] += 1; return str(v)
    def d(_m):
        v = nums[di[0]] if di[0] < len(nums) else (nums[-1] if nums else 0)
        di[0] += 1; return str(v)
    return re.sub(r"%d", d, re.sub(r"%s", s, str(text or "")))

_last_pick = {}
def pick_fresh(arr, key):
    # like random.choice but avoids repeating the last value drawn for this key,
    # so a shallow copy bank doesn't print the same headline twice in a row
    arr = arr or [""]
    if len(arr) == 1:
        return arr[0]
    choices = [x for x in arr if x != _last_pick.get(key)] or arr
    v = random.choice(choices)
    _last_pick[key] = v
    return v

def fire_verdict(ev, vid, names=None, nums=None):
    v = VBANK.get(vid)
    if not v:
        return
    names = names or []; nums = nums or []
    hl = apply_subs(pick_fresh(v.get("headlines") or [""], vid + ":h"), names, nums)
    rc = apply_subs(pick_fresh(v.get("receipts") or [""], vid + ":r"), names, nums)
    verdict_card(ev, vid, v.get("stamp", "VERDICT"), v.get("color", "#C8102E"), hl, rc, marks=bool(v.get("marks")))

def emit_panel(ev, key):
    P = PWORDS.get(key)
    if not P or ("%s:panel" % ev["id"]) in seen:
        return
    hs, as_ = ev["home"]["score"] or 0, ev["away"]["score"] or 0
    line = "%s %d-%d %s" % (team_name(ev["home"]["name"]), hs, as_, team_name(ev["away"]["name"]))
    p = vs_params(ev)
    p["score"] = "%d - %d" % (hs, as_); p["status"] = "FULL TIME"
    p["word"] = P.get("word", ""); p["pron"] = P.get("pron", ""); p["pos"] = P.get("pos", "noun")
    p["def1"] = (P.get("def1", "") or "").replace("%s", line)
    p["def2"] = (P.get("def2", "") or "").replace("%s", line)
    p["seeAlso"] = P.get("seeAlso", "")
    add_card("%s:panel" % ev["id"], "Definition", "panel", p, P.get("word", "def"),
             ev["home"]["name"] + " v " + ev["away"]["name"])

def emit_verdicts(ev):
    hs, as_ = ev["home"]["score"] or 0, ev["away"]["score"] or 0
    hn, an_ = team_name(ev["home"]["name"]), team_name(ev["away"]["name"])
    total, margin, draw = hs + as_, abs(hs - as_), hs == as_
    # Scorigami: a sorted scoreline not seen before (skip dull low-scoring ones)
    key = "%d-%d" % (min(hs, as_), max(hs, as_))
    fresh = key not in scorelines
    scorelines.add(key)
    if fresh and total >= 3:
        fire_verdict(ev, "scorigami", [], [max(hs, as_), min(hs, as_)])
    if margin >= 4:
        win, lose = (hn, an_) if hs > as_ else (an_, hn)
        fire_verdict(ev, "mercy", [win, lose])
    if total >= 6:
        fire_verdict(ev, "goalfest", [], [total])
    both_winless = False
    if draw:
        wm = winless_map(); ch, ca = canon(ev["home"]["name"]), canon(ev["away"]["name"])
        both_winless = bool(wm and wm.get(ch, 1) == 0 and wm.get(ca, 1) == 0)
        if total <= 2:
            fire_verdict(ev, "bore")
        if both_winless:
            fire_verdict(ev, "doublel")
        # definition spoof on a draw: 0-0 -> nil, both winless -> stalemate, else -> mid
        emit_panel(ev, "nil" if total == 0 else ("stalemate" if both_winless else "mid"))
    # Comeback / Bottled / Let It Slip (need the halftime score).
    # Bottled = led at the break then actually LOST. A lead surrendered to a DRAW
    # is the softer "Let It Slip" (two points dropped), never "bottled".
    ht = ht_scores.get(ev["id"])
    if ht and ht[0] != ht[1]:
        led_home = ht[0] > ht[1]
        leader, chaser = (hn, an_) if led_home else (an_, hn)
        leader_final = hs if led_home else as_
        chaser_final = as_ if led_home else hs
        if chaser_final > leader_final:        # the leader was overtaken and lost
            fire_verdict(ev, "comeback", [chaser])   # celebrate the side that came from behind
            fire_verdict(ev, "bottled", [leader])    # roast the side that bottled the lead
        elif leader_final == chaser_final:     # lead surrendered to a draw
            fire_verdict(ev, "letitslip", [leader])
    # Per-team stats: Allergic to the Net + Street Fight
    ts = team_stats(ev)
    if ts:
        for side in (ev["home"]["name"], ev["away"]["name"]):
            st = ts.get(canon(side))
            if st and st["shots"] >= 15 and st["goals"] == 0:
                fire_verdict(ev, "allergic", [team_name(side)], [st["shots"]])
                break
        cards_total = sum((v["yel"] + v["red"]) for v in ts.values())
        if cards_total >= 8:
            fire_verdict(ev, "fight", [], [cards_total])

# ---- Wikimedia Commons CC player portraits (the only free-commercial, zero-auth,
# CORS-clean source that actually covers players). CC-BY/CC0/PD only; ShareAlike
# and editorial-only sources (Getty/AP/FIFA) are deliberately never fetched.
_BAD_TITLE = re.compile(r"logo|badge|crest|emblem|signature|coat[ _]of[ _]arms|\bflag\b|\bkit\b|stadium|\bmap\b", re.I)
def _name_match(title_norm, name):
    # tolerant: handles "Vinicius Jr" vs "Vinicius Junior", mononyms (Pedri), and
    # first+last present, so Commons file titles match the ESPN display name
    toks = [norm_name(t) for t in str(name).split()]
    toks = [t for t in toks if len(t) >= 3]
    if not toks:
        return False
    t2 = title_norm.replace("junior", "jr")
    full = "".join(toks).replace("junior", "jr")
    if full and full in t2:
        return True
    last = toks[-1]
    if last in ("junior", "jr") and len(toks) >= 2:
        last = toks[-2]          # "Vinicius Junior" -> match on "vinicius", not "jr"
    last = last.replace("junior", "jr")
    if len(last) >= 4 and last in t2:
        return True
    return len(toks) >= 2 and toks[0] in title_norm and any(len(t) >= 3 and t in title_norm for t in toks[1:])
def commons_photo(name):
    if not COMMONS_PHOTOS or not name:
        return None
    try:
        q = urllib.parse.urlencode({
            "action": "query", "format": "json", "prop": "imageinfo",
            "iiprop": "url|extmetadata|mime", "iiurlwidth": "1080",
            "generator": "search", "gsrnamespace": "6", "gsrlimit": "12",
            "gsrsearch": name + " footballer",
        })
        d = get_json("https://commons.wikimedia.org/w/api.php?" + q)
    except Exception:
        return None
    for pg in sorted(((d.get("query") or {}).get("pages") or {}).values(), key=lambda x: x.get("index", 99)):
        title = pg.get("title") or ""
        if _BAD_TITLE.search(title) or not _name_match(norm_name(title), name):
            continue
        ii = (pg.get("imageinfo") or [{}])[0]
        mime = ii.get("mime") or ""
        if not mime.startswith("image/") or "svg" in mime:
            continue
        url = ii.get("thumburl") or ii.get("url") or ""
        if "upload.wikimedia.org" not in url:   # CORS-clean host only (render.js toBlob must not taint)
            continue
        ext = ii.get("extmetadata") or {}
        lic = ((ext.get("License") or {}).get("value") or "").lower()
        lic_name = (ext.get("LicenseShortName") or {}).get("value") or ""
        if "-nc" in lic or "-nd" in lic:   # non-commercial / no-derivatives genuinely bar our use
            continue
        if not (any(k in lic for k in ("cc-by", "cc0", "cc-zero", "publicdomain")) or "public domain" in lic_name.lower()):
            continue
        artist = html.unescape(re.sub(r"<[^>]+>", "", (ext.get("Artist") or {}).get("value") or ""))
        artist = re.sub(r"\[\d+\]", "", artist)            # drop wiki citation markers like [1]
        artist = re.sub(r"\s+", " ", artist).strip(" ,;|")
        if len(artist) > 48 or artist.lower().startswith("http") or not re.search(r"[A-Za-z]", artist) or re.search(r"unknown", artist, re.I):
            artist = ""                                    # junk/empty/unknown credit -> treat as none
        if "cc-by" in lic and not artist:   # CC-BY / CC-BY-SA need a visible credit; none resolvable -> skip
            continue
        return {"url": url, "credit": ("PHOTO: " + " / ".join(x for x in [artist, lic_name or "Wikimedia Commons"] if x))[:72]}
    return None

def emit_player_stats(ev):
    # Always pick a player of the match for EVERY game (best by a weighted score),
    # plus any extra 2+ goal scorers. The single best gets the MOTM ribbon.
    try:
        sm = get_json(ESPN + "summary?event=" + ev["id"])
    except Exception:
        return
    hs, as_ = ev["home"]["score"] or 0, ev["away"]["score"] or 0
    context = "%s %d-%d %s" % (team_name(ev["home"]["name"]), hs, as_, team_name(ev["away"]["name"]))
    plist = []
    for ros in (sm.get("rosters") or []):
        tname = (ros.get("team") or {}).get("displayName", "")
        color = team_color(tname); kit = home_kit(tname)
        for q in (ros.get("roster") or []):
            st = q.get("stats") or []
            goals = _stat_int(st, "totalGoals"); assists = _stat_int(st, "goalAssists")
            shots = _stat_int(st, "totalShots"); sot = _stat_int(st, "shotsOnTarget"); saves = _stat_int(st, "saves")
            pos = (q.get("position") or {}).get("abbreviation", ""); gk = pos in ("G", "GK")
            score = goals * 100 + assists * 45 + sot * 10 + (saves * 6 if gk else 0) + shots * 2
            if score <= 0:   # bench / no productive involvement
                continue
            a = q.get("athlete") or {}
            stats = ([{"label": "Saves", "value": str(saves)},
                      {"label": "Conceded", "value": str(_stat_int(st, "goalsConceded"))},
                      {"label": "Shots Faced", "value": str(_stat_int(st, "shotsFaced"))}] if gk else
                     [{"label": "Goals", "value": str(goals)}, {"label": "Assists", "value": str(assists)},
                      {"label": "Shots", "value": str(shots)}, {"label": "On Target", "value": str(sot)}])
            params = {"team": team_name(tname), "color": color, "context": context,
                      "player": a.get("displayName", ""), "jersey": str(q.get("jersey", "") or ""),
                      "position": pos_name(pos), "stats": stats}
            if kit and kit[0]:
                params["kit1"] = kit[0]; params["kit2"] = kit[1]
            tag = (str(goals) + "G") if goals > 0 else ((str(saves) + " saves") if gk else "MOTM")
            plist.append({"score": score, "goals": goals, "id": a.get("id", ""), "name": a.get("displayName", ""), "tag": tag, "params": params})
    if not plist:
        return
    plist.sort(key=lambda p: -p["score"])
    best = plist[0]
    picks, ids = [best], {best["id"]}
    for p in plist:                       # add any other 2+ goal scorers
        if p["goals"] >= 2 and p["id"] not in ids:
            picks.append(p); ids.add(p["id"])
    for p in picks[:4]:
        p["params"]["motm"] = (p["id"] == best["id"])
        if p["id"] == best["id"] or p["goals"] >= 2:   # only the headline player(s) get a sourced portrait
            ph = commons_photo(p["name"])
            if ph:
                p["params"]["photo"] = ph["url"]; p["params"]["credit"] = ph["credit"]
        add_card("%s:pstats:%s" % (ev["id"], p["id"]), "Player", "stats", p["params"],
                 p["name"] + " · " + p["tag"], ev["home"]["name"] + " v " + ev["away"]["name"])

def scan_player_stats(evs):
    # backfill + ongoing: standout-scorer Stats cards for recently finished games
    now = time.time() * 1000
    budget = 4
    for ev in evs:
        if ev["id"] in stats_done or not (ev["state"] == "post" or ev["completed"]):
            continue
        if (now - ev["epoch"]) > 14 * 3600 * 1000:   # too old; mark done so we never recheck
            stats_done.add(ev["id"]); continue
        if budget <= 0:
            break
        budget -= 1
        emit_player_stats(ev)
        stats_done.add(ev["id"])

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
    global predictions_raw
    try:
        d = get_json(PREDICTIONS_URL + "?t=" + str(int(time.time())))
    except Exception:
        return
    predictions_raw = d   # cache for /predictions.json (studio reads it same-origin)
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
            emit_movers(d, changes, iso)
        proj_last["iso"] = iso; proj_last["map"] = cur; save_state()

def emit_movers(d, changes, iso):
    # Market Movers card: risers + fallers from one projection shift
    risers = [c for c in changes if c["newProb"] > c["oldProb"]]
    fallers = [c for c in changes if c["newProb"] < c["oldProb"]]
    if len(risers) + len(fallers) < 2:
        return
    def mv(c):
        return {"code": c.get("code", ""), "team": team_name(c["team"]),
                "oldOpp": c["oldOpp"], "newOpp": c["newOpp"], "delta": abs(c["newProb"] - c["oldProb"])}
    params = {"result": "After " + (d.get("last_result", "") or "a result"),
              "footnote": "Projected R32 opponent odds",
              "risers": [mv(c) for c in risers[:3]], "fallers": [mv(c) for c in fallers[:3]]}
    add_card("%s:movers" % iso, "Market Movers", "movers", params,
             d.get("last_result", ""), "the bracket moved")

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
            scan_player_stats(evs)
            _push_ready[0] = True   # boot backfill is done; pushes are live from here on
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
        return False  # fail closed; do_GET already 503s before reaching here when unset
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
            return self._send(200, json.dumps({"ok": True, "cards": len(cards), "teams": len(TEAMS),
                                               "auth": bool(BASIC_PASS)}))
        if not BASIC_PASS:
            # fail CLOSED: an unset password locks the private tools, never exposes them
            return self._send(503, "Service not configured (auth disabled)\n", "text/plain; charset=utf-8")
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
        if path in ("/predictions.json", "/predictions.json/"):
            return self._send(200, json.dumps(predictions_raw or {}), "application/json", {"Cache-Control": "no-store"})
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
    load_banks()
    load_state()
    threading.Thread(target=poll_loop, daemon=True).start()
    port = int(os.environ.get("PORT", "8080"))
    if not BASIC_PASS:
        print("[boot] WARNING: BASIC_PASS not set -> failing CLOSED (503 on all non-health routes; set it on Railway)", flush=True)
    print("[boot] deploy-on-full-time: %s" % ("ON" if GITHUB_TOKEN else "OFF (set GITHUB_TOKEN to enable)"), flush=True)
    print("[boot] phone push: %s" % (("ON -> " + NTFY_SERVER + "/" + NTFY_TOPIC) if NTFY_TOPIC else "OFF (set NTFY_TOPIC to enable)"), flush=True)
    print("[boot] commons portraits: %s" % ("ON" if COMMONS_PHOTOS else "OFF"), flush=True)
    print("[boot] teams=%d, static=%s, serving on :%d" % (len(TEAMS), STATIC_DIR, port), flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()

if __name__ == "__main__":
    main()
