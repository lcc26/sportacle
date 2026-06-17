# Sportacle Design System v0

The oracle for sports futures. A prediction-market terminal with the swagger of a sports-media graphic. Data is the hero. Cool, numerate, a little provocative.

This is v0, seeded from two hero-card concepts. It inherits the non-negotiables from the `visual-production` skill: chrome-strip, no em-dashes, 1:1 1080 default, billboard rule with the 4-to-5-item receipt exception, render-and-Read QC, and a distinct owned identity (unique headline font, "which brand is this?" test).

## Color tokens

```css
--bg:#0A0E16;        /* terminal night, the canvas */
--surface:#141B27;   /* raised stat blocks */
--surface-2:#1E2736; /* bar tracks, chips */
--line:#2B3445;      /* hairline borders */
--brand:#FFB627;     /* Sportacle gold, the oracle accent: wordmark, key emphasis */
--up:#23D18B;        /* green: advances, higher probability, the win path */
--down:#FF4D5E;      /* red: eliminated, lower probability, the bad timeline */
--text:#F2F5FA;      /* primary white */
--dim:#8C9AAE;       /* muted labels */
--faint:#586577;     /* context, disclaimers */
```

Semantics are strict: gold = brand, green = likely/advancing, red = unlikely/eliminated. Green and red are reserved for probability direction so the card reads like a market at a glance. No green backgrounds (green as accent only), per the skill.

## Type

- Display (`Saira Condensed`, 700 to 900): team names, hero lines. The signature. Condensed handles long country names and gives the odds-board punch.
- UI (`Inter`, 400 to 700): labels, scenario lines, captions, disclaimer.
- Numerics (`JetBrains Mono`, 500 to 800): every probability, percentage, and odds value. Mono numbers read as market data, not decoration.

No two Lariat brands share a headline font. Saira Condensed is Sportacle's and is distinct from the political brands (Newsreader, EB Garamond, Metropolis, Montserrat).

## Layout archetypes (named)

1. The Ticket: hero matchup. "Win and you face ___" / "Lose and it's ___". Billboard. (This file seeds two directions for it.)
2. The Ladder: projected path to the final. Receipt list, 4 to 5 short rungs (R32, R16, QF, SF, Final), the sanctioned billboard exception.
3. The Board: master bracket-projection state, and the "not getting out of the group" survival gauge.

## Voice

Confident, numerate, provocative but not snarky. The card carries the data; the post caption carries the take. No hedging, no "verified/tracked/monitored" vocabulary, no source-citation lines on the card, no em-dashes.

## Card spec

- 1080x1080, 1:1 default. Safe padding 64 to 88px.
- One brand mark (orb + Sportacle wordmark) top-left. One context label max (e.g. "World Cup 2026"). Handle in the footer. Nothing else editorial.
- Probability shown two ways: a mono number and a bar or pill.
- Mock/sample cards carry a small "sample · engine pending" note so they are never mistaken for live output.

## Ship gates (diagnostic, pass all before delivery)

1. In 2 seconds, can you read (a) which team, (b) the projected opponent, (c) the probability?
2. Is the card roughly 70% data/visual, 30% headline plus mark? If chrome crept in, strip it.
3. Any element under 18px that is not the disclaimer or handle is decoration. Cut it.
4. No em-dash or en-dash anywhere in the source or render.
5. Fits 1080 with safe margins, no overlap, no off-canvas, legible at thumbnail size. Verified by rendering the PNG and Reading it.

## Changelog

- v0 (2026-06-17): tokens, type, archetypes, voice, ship gates. Seeded by The Ticket concepts A (The Slip, market-minimal) and B (The Marquee, sportsbook-bold). Awaiting Chase's pick to scale.
