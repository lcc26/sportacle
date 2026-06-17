#!/bin/bash
# Sportacle: regenerate live projections (and post cards) then deploy.
# Local use on macOS (has Chrome for the card generator). The GitHub Action
# runs the engine + deploy only, which needs no Chrome.
set -e
cd "$(dirname "$0")"

echo "[1/3] Engine: fetch results from ESPN and recompute projections"
python3 engine/run.py

echo "[2/3] Cards: regenerate one image per Round-of-32 tie"
python3 card-gen/generate.py || echo "  (card step skipped; needs Chrome. Site deploy continues.)"

echo "[3/3] Deploy to Netlify"
if [ -n "$NETLIFY_AUTH_TOKEN" ] && [ -n "$NETLIFY_SITE_ID" ]; then
  npx --yes netlify-cli@latest deploy --dir=web --prod --site "$NETLIFY_SITE_ID" --message "refresh projections and cards"
else
  echo "  Set NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID to deploy. Built locally in web/."
fi
echo "Done."
