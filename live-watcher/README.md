# Sportacle live host (private, internal)

A single always-on Railway service that is the home for the internal tools,
kept OFF the public gosportacle.com domain. It does two things, both behind
one HTTP Basic Auth password:

1. **Watches ESPN** (poll-only; no push). Polls the World Cup scoreboard,
   diffs each event, and serves detected card specs at `/feed.json`.
2. **Serves the tools**: the canvas studio at `/studio/` and the on-the-go
   phone feed page at `/live/`, plus their assets (`render.js`, `/flags/*`,
   `/make/teams.json`, `/make/kits.json`) from the bundled `static/` dir, so
   everything is same-origin (no cross-origin canvas tainting).

Detected events -> cards:

| Event | Card |
|---|---|
| Upcoming fixture within 6h | Who Wins |
| Score increments while live | Goal (scorer/minute from match summary) |
| Halftime | Half |
| Full time | Final |

The first poll after a fresh start **seeds** current state silently (no flood
of old Finals); cards generate from the next change on.

## Auth
Everything except `/healthz` requires Basic Auth. Set on Railway:
- `BASIC_USER` (default `lariat`)
- `BASIC_PASS` (required to enforce; if unset, the boot log WARNS and serves open)

The password lives only in Railway's env, never in the repo. Rotate any time:
```
railway variables --set "BASIC_PASS=new-pass" --service sportacle-live
```

## Persistence
State (feed + dedup) is written to `STATE_PATH` (set to `/data/state.json`,
backed by a Railway volume mounted at `/data`), so the feed survives redeploys.

## Run locally
```
BASIC_PASS=test PORT=8092 python3 watcher.py
# open http://localhost:8092/studio/  and  /live/   (browser will prompt for auth)
# GET /feed.json   -> card feed ;  GET /healthz -> open status
```

## Deploy to Railway
Already deployed as service **sportacle-live** (project `sportacle-live`):
```
railway up --service sportacle-live --ci         # build + deploy this dir
railway variables --set "BASIC_USER=lariat" --service sportacle-live
railway variables --set "BASIC_PASS=<secret>"   --service sportacle-live
```
Public URL: `https://sportacle-live-production.up.railway.app`
- `/studio/` the builder, `/live/` the phone page, `/feed.json` the feed.

## Notes
- stdlib only (no pip install) -> zero third-party supply-chain surface.
- Adaptive poll: ~30s while a match is live or near kickoff, ~5min otherwise.
- Generates for review only. It never posts anything.
