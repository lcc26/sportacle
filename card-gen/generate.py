#!/usr/bin/env python3
"""Sportacle Round-of-32 card generator.

Reads web/data/predictions.json and renders one 1080x1080 social card PNG per
matchup using the locked split design in card.html, driven entirely by the URL
query string. Stdlib only. Re-running regenerates every card (idempotent).
"""

import json
import os
import re
import subprocess
import urllib.parse

# Resolve all paths relative to this script so it runs from anywhere.
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PREDICTIONS = os.path.join(ROOT, "web", "data", "predictions.json")
CARD_HTML = os.path.join(HERE, "card.html")
OUT_DIR = os.path.join(ROOT, "web", "cards")
INDEX_JSON = os.path.join(OUT_DIR, "index.json")

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def slugify(name):
    """South Korea -> south-korea (lowercase, non-alphanumerics to hyphens)."""
    s = name.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def build_query(team, opponent):
    """URL-encode the matchup fields into the card's query string."""
    params = {
        "an": team.get("name", ""),
        "ac": team.get("code", ""),
        "acolor": team.get("color", ""),
        "anote": team.get("note", ""),
        "bn": opponent.get("name", ""),
        "bc": opponent.get("code", ""),
        "bcolor": opponent.get("color", ""),
        "bnote": "Projected Foe",
        "prob": str(opponent.get("prob", "")),
    }
    return urllib.parse.urlencode(params)


def render(query, out_png):
    url = "file://" + urllib.parse.quote(CARD_HTML) + "?" + query
    cmd = [
        CHROME,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--allow-file-access-from-files",
        "--force-device-scale-factor=2",
        "--window-size=1080,1080",
        "--virtual-time-budget=9000",
        "--screenshot=" + out_png,
        url,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    with open(PREDICTIONS, "r") as f:
        data = json.load(f)

    os.makedirs(OUT_DIR, exist_ok=True)

    index = []
    for m in data.get("matchups", []):
        team = m["team"]
        opponent = m["opponent"]
        slug = slugify(team["name"])
        out_png = os.path.join(OUT_DIR, slug + ".png")
        query = build_query(team, opponent)

        print("Rendering " + team["name"] + " vs " + opponent["name"] + " -> " + slug + ".png")
        render(query, out_png)

        index.append({
            "slug": slug,
            "team": team["name"],
            "opponent": opponent["name"],
            "prob": opponent.get("prob"),
            "png": "cards/" + slug + ".png",
        })

    with open(INDEX_JSON, "w") as f:
        json.dump(index, f, indent=2)
        f.write("\n")

    print("Done. " + str(len(index)) + " cards written to " + OUT_DIR)
    print("Index: " + INDEX_JSON)


if __name__ == "__main__":
    main()
