# Sportacle Round-of-32 prediction engine

A real prediction engine for [Sportacle](https://gosportacle.com)
(@TheSportacle) that projects the 2026 FIFA World Cup Round of 32 from
LIVE results and writes the projection to the site's data file.

Standard library only (urllib, json, random, datetime). No third-party
packages, no API keys.

## How to run

```
python3 engine/run.py
```

That fetches live data, runs the simulation, and overwrites
`web/data/predictions.json`. Takes a few seconds.

## Data source (ESPN, no key, confirmed working)

- Schedule + results:
  `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260720`
- Group standings / membership:
  `https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings?season=2026`

Both are public and require no authentication. See `espn.py` for the
defensive parser.

## The model

1. Elo. Every team is seeded with an approximate pre-tournament rating
   (`teams.py`). We then replay each finished group game to update those
   ratings before simulating.

   - Win-or-draw expectation: `E = 1 / (1 + 10 ** (-(Rh - Ra) / 400))`
   - Update: `R' = R + K * G * (S - E)` with `K = 40` and a goal-
     difference multiplier `G` (1 for a one-goal win, 1.5 for two, larger
     for blowouts). Group games are neutral venue, so no host bonus.

2. Match outcome. From the Elo gap we derive win/draw/loss probabilities
   (logistic split plus a draw model that shrinks as teams diverge) and
   sample a plausible scoreline so the group tables get goal difference
   and goals for. See `model.py` for the exact formulas.

3. Monte Carlo. We simulate every remaining scheduled group match 30,000
   times. Each run completes the 12 group tables, ranks them on FIFA
   tiebreakers (points, then goal difference, then goals for), takes 1st
   and 2nd from each group plus the eight best third-place teams, resolves
   the Round of 32 bracket, and records every tie. The probabilities in
   `predictions.json` are the empirical frequencies across all runs.

## The bracket (and its one caveat)

The 16 Round-of-32 pairings are DERIVED FROM THE ESPN FEED, not assumed.
ESPN publishes each knockout fixture with placeholder competitors
("Group C Winner", "Group F 2nd Place", "Third Place Group A/B/C/D/F"),
which is exactly the official FIFA structure including the per-slot
allowed-groups restriction for the eight best-third-place slots. We
snapshot that in `bracket.py`.

The one modeled piece is WHICH qualifying third-place team fills WHICH
"3RD" slot. FIFA uses a fixed 495-row lookup table; we instead honor each
slot's published allowed-groups set and solve the assignment by
backtracking, which reproduces the official table for legal inputs. Every
assignment we emit is group-legal. See `NOTES.md` for the full honest
breakdown of real vs modeled vs assumed, and `bracket.py` if you want to
drop in the literal 495-row table.

## Files

- `run.py`      entry point; fetch, simulate, write predictions.json
- `espn.py`     ESPN fetch + defensive parsing
- `teams.py`    48-team metadata (flag code, brand color, Elo seed)
- `model.py`    Elo update + per-match outcome/score model
- `simulate.py` Monte Carlo over the remaining group games
- `bracket.py`  Round-of-32 structure (from the feed) + 3rd-place slotting
- `NOTES.md`    what is real vs modeled vs assumed (read this)

## Output

`web/data/predictions.json` in the schema the site already reads, with a
real `updated_iso` (the end time of the most recently finished match).
No `sample` field: the data is real.

## Automation

`.github/workflows/update-predictions.yml` runs this on a cron (every 15
minutes) and on manual dispatch, then commits the refreshed
predictions.json so a push triggers the Netlify deploy.
