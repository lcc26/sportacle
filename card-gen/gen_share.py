#!/usr/bin/env python3
"""Per-pairing share pages + landscape OG cards.

Social scrapers (X, Facebook/Meta, etc.) ignore URL #fragments, so a deep link
like gosportacle.com/#m-germany unfurls with the SITE-DEFAULT image. To get a
per-pairing preview we need a REAL URL per team that serves its own og:image and
meta. This script reads web/data/predictions.json and writes:

  web/og/<slug>.png         a 1200x630 landscape OG card per SUBJECT card (the 16
                            group winners/runners-up that host a slot).
  web/r32/<slug>/index.html a real page for EVERY team that appears:
                            * a subject team -> its own card.
                            * an opponent/alternate (e.g. Croatia) -> the card
                              where it is featured, framed from its side, so the
                              link is never dead and the preview is relevant.

Each page also forwards a human visitor to the live board card. It regenerates
every run so the pages track the live projection. Stdlib only; Chrome comes from
$CHROME_BIN (GitHub runners ship google-chrome) or the local macOS path.
"""

import json
import os
import re
import subprocess
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PREDICTIONS = os.path.join(ROOT, "web", "data", "predictions.json")
OG_HTML = os.path.join(HERE, "og-card.html")
OG_DIR = os.path.join(ROOT, "web", "og")
PAGE_DIR = os.path.join(ROOT, "web", "r32")

SITE = "https://gosportacle.com"
GTM_ID = "GTM-WZW53CMT"

CHROME = os.environ.get(
    "CHROME_BIN",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)

# Mirrors web/js/app.js display map, so the slug matches the board card id (m-<slug>).
DISPLAY_NAMES = {
    "Congo DR": "DR Congo",
    "Bosnia-Herzegovina": "Bosnia and Herzegovina",
    "Bosnia Herzegovina": "Bosnia and Herzegovina",
    "Turkiye": "Turkiye",
}


def display_name(name):
    return DISPLAY_NAMES.get(name, name)


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def esc(s):
    return (
        str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


def build_query(team, opponent):
    params = {
        "an": display_name(team.get("name", "")),
        "ac": team.get("code", ""),
        "acolor": team.get("color", ""),
        "anote": team.get("note", ""),
        "bn": display_name(opponent.get("name", "")),
        "bc": opponent.get("code", ""),
        "bcolor": opponent.get("color", ""),
        "bnote": "Projected opponent",
        "prob": str(opponent.get("prob", "")),
    }
    return urllib.parse.urlencode(params)


def render_card(query, out_png):
    url = "file://" + urllib.parse.quote(OG_HTML) + "?" + query
    cmd = [
        CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--allow-file-access-from-files", "--force-device-scale-factor=2",
        "--window-size=1200,630", "--virtual-time-budget=4000",
        "--screenshot=" + out_png, url,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def write_page(page_slug, img_slug, board_slug, title, desc, headline):
    """Write web/r32/<page_slug>/index.html: per-pairing OG/Twitter meta + a brand
    fallback that forwards a human to the live board card."""
    page_url = "%s/r32/%s/" % (SITE, page_slug)
    img_url = "%s/og/%s.png" % (SITE, img_slug)
    board_url = "%s/#m-%s" % (SITE, board_slug)
    t, d = esc(title), esc(desc)
    html = """<!DOCTYPE html>
<html lang="en-US">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','%(gtm)s');</script>
<!-- End Google Tag Manager -->
<title>%(title)s</title>
<meta name="description" content="%(desc)s">
<link rel="canonical" href="%(page_url)s">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Sportacle">
<meta property="og:url" content="%(page_url)s">
<meta property="og:title" content="%(title)s">
<meta property="og:description" content="%(desc)s">
<meta property="og:image" content="%(img_url)s">
<meta property="og:image:width" content="2400">
<meta property="og:image:height" content="1260">
<meta property="og:image:alt" content="%(title)s">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@TheSportacle">
<meta name="twitter:title" content="%(title)s">
<meta name="twitter:description" content="%(desc)s">
<meta name="twitter:image" content="%(img_url)s">
<meta name="twitter:image:alt" content="%(title)s">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#F4F2EB;color:#14171C;font-family:"Inter",system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px}
.wrap{max-width:760px;width:100%%;text-align:center}
.brand{display:inline-flex;align-items:center;gap:11px;font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:24px;letter-spacing:-.5px;margin-bottom:26px}
.orb{width:21px;height:21px;border-radius:50%%;background:conic-gradient(from 210deg,#1E9B4B,#FFC400,#0A3478,#ED2939,#1E9B4B)}
.card-img{width:100%%;border-radius:16px;box-shadow:0 18px 44px rgba(20,23,28,.16);display:block}
h1{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:clamp(22px,4vw,32px);letter-spacing:-.6px;margin:26px 0 8px;line-height:1.1}
p{color:#5A6473;font-size:16px;margin:0 auto 22px;max-width:54ch}
.cta{display:inline-block;font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:16px;background:#14171C;color:#fff;padding:14px 26px;border-radius:999px}
</style>
<script>
/* Humans get the full interactive board, scrolled to this pairing. Scrapers do
   not run JS, so they read the per-pairing meta above. */
try { location.replace("%(board_url)s"); } catch (e) {}
</script>
</head>
<body>
<main class="wrap">
  <a class="brand" href="/"><span class="orb"></span>Sportacle</a>
  <img class="card-img" src="/og/%(img_slug)s.png" alt="%(title)s" width="1200" height="630">
  <h1>%(headline)s</h1>
  <p>%(desc)s</p>
  <a class="cta" href="%(board_url)s">See the full Round of 32 board</a>
</main>
</body>
</html>
""" % {
        "gtm": GTM_ID, "title": t, "desc": d, "page_url": page_url, "img_url": img_url,
        "img_slug": img_slug, "board_url": board_url, "headline": esc(headline),
    }
    out_dir = os.path.join(PAGE_DIR, page_slug)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "index.html"), "w") as f:
        f.write(html)


def main():
    with open(PREDICTIONS) as f:
        data = json.load(f)
    os.makedirs(OG_DIR, exist_ok=True)
    os.makedirs(PAGE_DIR, exist_ok=True)

    matchups = data.get("matchups", [])

    # Pass 1: subject cards (the 16 hosts). Render the OG image + its own page.
    subjects = []
    for m in matchups:
        team, opp = m["team"], m["opponent"]
        tname, oname = display_name(team["name"]), display_name(opp["name"])
        slug = slugify(tname)
        prob = opp.get("prob", "")
        subjects.append({"slug": slug, "tname": tname, "oname": oname, "prob": prob})

        out_png = os.path.join(OG_DIR, slug + ".png")
        try:
            render_card(build_query(team, opp), out_png)
        except Exception as e:
            print("  WARN: card render failed for %s (%s); keeping existing image" % (slug, e))

        title = "%s's most likely Round of 32 opponent: %s" % (tname, oname)
        desc = ("Sportacle projects %s (%s%%) as the team most likely waiting for %s in the "
                "World Cup Round of 32. See all 16 projections, updated as results land." % (oname, prob, tname))
        write_page(slug, slug, slug, title, desc, "%s most likely meet %s" % (tname, oname))
        print("  subject: %s vs %s -> /r32/%s/" % (tname, oname, slug))

    subject_slugs = {s["slug"] for s in subjects}

    # Pass 2: every OTHER team that appears (opponent or alternate) gets a page that
    # points at the card featuring it, framed from its side. Keep the appearance with
    # the highest probability (prefer a true opponent over an alternate on a tie).
    featured = {}  # team_slug -> {prob, is_opp, subj_slug, subj_name, team_name}
    for m in matchups:
        subj_name = display_name(m["team"]["name"])
        subj_slug = slugify(subj_name)
        candidates = [(display_name(m["opponent"]["name"]), m["opponent"].get("prob", 0), True)]
        for alt in m.get("alternates", []):
            candidates.append((display_name(alt.get("name", "")), alt.get("prob", 0), False))
        for tname, prob, is_opp in candidates:
            if not tname:
                continue
            tslug = slugify(tname)
            if tslug in subject_slugs:
                continue  # this team has its own subject page
            try:
                pr = int(prob)
            except (TypeError, ValueError):
                pr = 0
            cur = featured.get(tslug)
            better = (cur is None) or (pr > cur["prob"]) or (pr == cur["prob"] and is_opp and not cur["is_opp"])
            if better:
                featured[tslug] = {"prob": pr, "is_opp": is_opp, "subj_slug": subj_slug,
                                   "subj_name": subj_name, "team_name": tname}

    for tslug, info in featured.items():
        sub, team_name, pr = info["subj_name"], info["team_name"], info["prob"]
        if info["is_opp"]:
            title = "%s is %s's most likely Round of 32 opponent (%s%%)" % (team_name, sub, pr)
        else:
            title = "%s is in the mix to be %s's Round of 32 opponent (%s%%)" % (team_name, sub, pr)
        desc = ("Sportacle projects %s among the teams that could meet %s in the World Cup "
                "Round of 32, at %s%%. See all 16 projections, updated as results land." % (team_name, sub, pr))
        write_page(tslug, info["subj_slug"], info["subj_slug"], title, desc,
                   "%s could meet %s" % (team_name, sub))
        print("  alias:   %s -> features on /r32/%s/ card" % (team_name, info["subj_slug"]))

    print("Wrote %d subject pages + %d team aliases" % (len(subjects), len(featured)))


if __name__ == "__main__":
    main()
