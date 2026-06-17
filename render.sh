#!/bin/bash
# Render a card HTML to a PNG at 1080x1080 (2x for crispness) via headless Chrome.
# Usage: ./render.sh cards/ticket-A-slip.html renders/ticket-A-slip.png
set -e
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
IN_ABS="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUT="$2"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --virtual-time-budget=6000 \
  --window-size=1080,1080 --screenshot="$OUT" "file://$IN_ABS" >/dev/null 2>&1
echo "rendered $OUT"
