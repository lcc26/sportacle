#!/usr/bin/env python3
"""Make a GOAL or FINAL graphic for X, on the fly. 1080x1080.

You give team names + a score; this resolves each team's flag + color from
engine/teams.py and renders the matching template (goal.html / final.html) to a
PNG, copies it to your Downloads, and opens it.

Examples
--------
  # Full-time result
  python3 card-gen/make.py final England Croatia 4-2 --note "Group L"

  # Half-time result (amber label)
  python3 card-gen/make.py half England Croatia 1-0 --note "Group L"

  # A goal, with scorer + minute and the running scoreline
  python3 card-gen/make.py goal England --scorer Kane --min 67 --score 2-1 --vs Croatia

  # A goal, minimal
  python3 card-gen/make.py goal Portugal

Stdlib only. Chrome comes from $CHROME_BIN or the local macOS path.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "engine"))
import teams as TEAMS_MOD  # noqa: E402

# Templates live under web/make/ so the SAME files are also hosted on the site
# (gosportacle.com/make/...). They auto-detect the flag path: ../flags for a
# local file:// render, /flags when served over http(s).
TPL_DIR = os.path.join(ROOT, "web", "make")
OUT_DIR = os.path.join(HERE, "out")
DOWNLOADS = os.path.expanduser("~/Downloads")
CHROME = os.environ.get(
    "CHROME_BIN", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
)

# Broadcast display names (the data key may differ); mirrors web/js/app.js.
DISPLAY = {
    "Congo DR": "DR Congo",
    "Bosnia-Herzegovina": "Bosnia and Herzegovina",
    "Turkiye": "Turkiye",
}


def resolve(name):
    """team name (any alias) -> (display_name, flag_code, color)."""
    key = TEAMS_MOD.canonical(name)
    m = TEAMS_MOD.meta(name)
    if not m:
        sys.exit("Unknown team: %r. Use the country's common English name." % name)
    return DISPLAY.get(key, key), m["code"], m["color"]


def parse_score(s):
    nums = re.findall(r"\d+", s or "")
    if len(nums) < 2:
        sys.exit("Score must look like 4-2 (got %r)." % s)
    return nums[0], nums[1]


def render(template, query, out_png):
    url = "file://" + urllib.parse.quote(os.path.join(TPL_DIR, template)) + "?" + query
    subprocess.run(
        [
            CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
            "--allow-file-access-from-files", "--force-device-scale-factor=2",
            "--window-size=1080,1080", "--virtual-time-budget=4000",
            "--screenshot=" + out_png, url,
        ],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def finish(out_png, stem):
    os.makedirs(DOWNLOADS, exist_ok=True)
    dl = os.path.join(DOWNLOADS, "sportacle-" + stem + ".png")
    shutil.copyfile(out_png, dl)
    print("Wrote %s" % out_png)
    print("Copied to %s" % dl)
    if sys.platform == "darwin":
        subprocess.run(["open", dl], check=False)


def _result(a, label, lc, stem_prefix):
    """Shared scoreline card (final.html): FINAL and HALF differ only by the top
    label and its accent color (amber for half-time, so HT reads differently at a
    glance from FT in a feed)."""
    an, ac, acolor = resolve(a.home)
    bn, bc, bcolor = resolve(a.away)
    hg, ag = parse_score(a.score)
    params = {
        "an": an, "ac": ac, "acolor": acolor,
        "bn": bn, "bc": bc, "bcolor": bcolor,
        "hg": hg, "ag": ag, "label": label, "note": a.note or "",
    }
    if lc:
        params["lc"] = lc
    os.makedirs(OUT_DIR, exist_ok=True)
    stem = "%s-%s-%s-%s-%s" % (stem_prefix, ac, bc, hg, ag)
    out = os.path.join(OUT_DIR, stem + ".png")
    render("final.html", urllib.parse.urlencode(params), out)
    finish(out, stem)


def cmd_final(a):
    _result(a, a.label, "", "final")


def cmd_half(a):
    _result(a, a.label, "#FFC400", "half")


def cmd_goal(a):
    team, code, color = resolve(a.team)
    params = {"team": team, "tc": color, "code": code, "tag": a.tag}
    if a.scorer:
        params["scorer"] = a.scorer
    if a.min:
        params["min"] = a.min
    if a.score and a.vs:
        _, vcode, _ = resolve(a.vs)
        params["score"] = a.score
        params["vs"] = vcode
        params["home"] = "0" if a.away else "1"  # left flag = opponent if --away
    q = urllib.parse.urlencode(params)
    os.makedirs(OUT_DIR, exist_ok=True)
    stem = "goal-" + code + (("-" + re.sub(r"[^a-z0-9]+", "", a.scorer.lower())) if a.scorer else "")
    out = os.path.join(OUT_DIR, stem + ".png")
    render("goal.html", q, out)
    finish(out, stem)


def main():
    p = argparse.ArgumentParser(description="Make GOAL / FINAL graphics for X (1080x1080).")
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("final", help="full-time result card")
    f.add_argument("home")
    f.add_argument("away")
    f.add_argument("score", help='e.g. 4-2  (home-away)')
    f.add_argument("--note", default="", help='lower band, e.g. "Group L"')
    f.add_argument("--label", default="Full Time", help='top label (default "Full Time")')
    f.set_defaults(func=cmd_final)

    h = sub.add_parser("half", help="half-time result card (amber label)")
    h.add_argument("home")
    h.add_argument("away")
    h.add_argument("score", help='e.g. 1-0  (home-away)')
    h.add_argument("--note", default="", help='lower band, e.g. "Group L"')
    h.add_argument("--label", default="Half Time", help='top label (default "Half Time")')
    h.set_defaults(func=cmd_half)

    g = sub.add_parser("goal", help="goal card (one team hero)")
    g.add_argument("team")
    g.add_argument("--scorer", default="", help="scorer name (optional)")
    g.add_argument("--min", default="", help="minute, e.g. 67 (optional)")
    g.add_argument("--score", default="", help='running score, e.g. 2-1 (optional; needs --vs)')
    g.add_argument("--vs", default="", help="opponent team (for the scoreline flag)")
    g.add_argument("--away", action="store_true", help="scoring team is the away side (flips the scoreline)")
    g.add_argument("--tag", default="Sportacle", help='top-left tag (default "Sportacle")')
    g.set_defaults(func=cmd_goal)

    a = p.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
