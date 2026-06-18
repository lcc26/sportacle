# Sportacle live watcher

Always-on worker that turns ESPN's live World Cup data into ready-to-post cards
on your phone. ESPN's public API is poll-only (no push), so this polls the
scoreboard, diffs each event, and logs the matching card spec to a feed. Your
phone opens `gosportacle.com/live`, pulls the feed, and renders each card with
the same `render.js` engine. The phone never does the watching, so nothing is
missed while it sleeps.

Detected events -> cards:

| Event | Card |
|---|---|
| Upcoming fixture within 6h | Who Wins |
| Score increments while live | Goal (scorer/minute from match summary) |
| Halftime | Half |
| Full time | Final |

The first poll after a fresh start **seeds** current state silently (no flood of
old Finals); cards generate from the next change on.

## Run locally
```
PORT=8090 python3 watcher.py
# GET http://localhost:8090/feed.json   -> the card feed (CORS-open)
# GET http://localhost:8090/healthz     -> {"ok":true,...}
```
Then open `gosportacle.com/live/?feed=http://localhost:8090/feed.json` (the
`?feed=` is saved to the device, so you only paste it once).

## Deploy to Railway
1. New Railway service from this repo, **root directory** `live-watcher/`
   (Nixpacks auto-detects Python; no dependencies to install, stdlib only).
2. Start command is `python watcher.py` (also in `Procfile` / `railway.json`).
   Railway injects `PORT`; the server binds it automatically.
3. (Optional) Add a Railway **volume** and set `STATE_PATH=/data/state.json` so
   the feed + dedup survive redeploys. Without it, a redeploy reseeds (harmless,
   just re-suppresses old finals).
4. Copy the public URL, then on your phone open `gosportacle.com/live` and paste
   `https://<your-app>.up.railway.app/feed.json` into the setup box (or visit
   `gosportacle.com/live/?feed=<that-url>` once).

## Notes
- Cost is ESPN bandwidth only (their free public JSON). Adaptive cadence: ~30s
  while a match is live or near kickoff, ~5min otherwise.
- `teams.json` here is a fallback; the watcher prefers the live copy at
  `gosportacle.com/make/teams.json` so colors/codes stay in sync.
- Generates for review only. It never posts anything.
