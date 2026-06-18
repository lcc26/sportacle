#!/usr/bin/env python3
"""Per-pairing share pages + landscape OG cards.

Social scrapers (X, Facebook/Meta, etc.) ignore URL #fragments, so a deep link
like gosportacle.com/#m-germany unfurls with the SITE-DEFAULT image. To get a
per-pairing preview we need a REAL URL per pairing that serves its own og:image
and meta. This script reads web/data/predictions.json and, for every subject card,
writes:

  web/og/<slug>.png         a 1200x630 landscape OG card (rendered from og-card.html)
  web/r32/<slug>/index.html  a real page with that pairing's OG/Twitter meta, that
                             also forwards a human visitor to the live board card.

It regenerates every run, so when the engine rewrites predictions.json on each
deploy these stay in sync with the live projection. Stdlib only; Chrome is taken
from $CHROME_BIN (GitHub runners ship google-chrome) or the local macOS path.
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
    s = re.sub(r"[^a-z0-9]+", "-", name.lower())
    return s.strip("-")


def esc(s):
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
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
        CHROME,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--allow-file-access-from-files",
        "--force-device-scale-factor=2",
        "--window-size=1200,630",
        "--virtual-time-budget=4000",
        "--screenshot=" + out_png,
        url,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def page_html(team_name, opp_name, prob, slug, note):
    """A real, scrapeable page: per-pairing OG/Twitter meta + a brand fallback that
    forwards a human to the live board card (scrapers do not run the script)."""
    title = "%s's most likely Round of 32 opponent: %s" % (team_name, opp_name)
    desc = "Sportacle projects %s (%s%%) as the team most likely waiting for %s in the World Cup Round of 32. See all 16 projections, updated as results land." % (
        opp_name,
        prob,
        team_name,
    )
    page_url = "%s/r32/%s/" % (SITE, slug)
    img_url = "%s/og/%s.png" % (SITE, slug)
    board_url = "%s/#m-%s" % (SITE, slug)
    t, o, d = esc(title), esc(opp_name), esc(desc)
    return """<!DOCTYPE html>
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
  <img class="card-img" src="/og/%(slug)s.png" alt="%(title)s" width="1200" height="630">
  <h1>%(team)s most likely meet %(opp)s</h1>
  <p>%(desc)s</p>
  <a class="cta" href="%(board_url)s">See the full Round of 32 board</a>
</main>
</body>
</html>
""" % {
        "gtm": GTM_ID,
        "title": t,
        "desc": d,
        "page_url": page_url,
        "img_url": img_url,
        "board_url": board_url,
        "slug": slug,
        "team": esc(team_name),
        "opp": o,
    }


def main():
    with open(PREDICTIONS) as f:
        data = json.load(f)

    os.makedirs(OG_DIR, exist_ok=True)
    os.makedirs(PAGE_DIR, exist_ok=True)

    count = 0
    for m in data.get("matchups", []):
        team = m["team"]
        opp = m["opponent"]
        team_name = display_name(team["name"])
        opp_name = display_name(opp["name"])
        prob = opp.get("prob", "")
        slug = slugify(team_name)

        out_png = os.path.join(OG_DIR, slug + ".png")
        # Never let a render hiccup (e.g. Chrome missing in CI) break the deploy:
        # degrade to the previously committed card and keep the page fresh.
        try:
            render_card(build_query(team, opp), out_png)
        except Exception as e:
            print("  WARN: card render failed for %s (%s); keeping existing image" % (slug, e))

        page_dir = os.path.join(PAGE_DIR, slug)
        os.makedirs(page_dir, exist_ok=True)
        with open(os.path.join(page_dir, "index.html"), "w") as f:
            f.write(page_html(team_name, opp_name, prob, slug, team.get("note", "")))

        print("  %s vs %s -> /r32/%s/" % (team_name, opp_name, slug))
        count += 1

    print("Wrote %d share pages + OG cards" % count)


if __name__ == "__main__":
    main()
