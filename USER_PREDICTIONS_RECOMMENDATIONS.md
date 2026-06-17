# Make Your Own Prediction: Product Recommendations

Sportacle (@TheSportacle, gosportacle.com)
Feature: let a visitor build their own Round of 32 prediction, set their own probability, and share it as a clean branded Sportacle graphic.

This doc covers UX flows, the share-image problem, the backend question, engagement hooks, and a concrete v1 that ships on the current Netlify static site. It does not build anything. All numbers and copy below follow the brand rules (no em-dashes or en-dashes, flag-forward, keep the wordmark and the @TheSportacle handle, locked team-color flag-VS split for social cards).

## Context: what we are building on

The site today is a static, served page (Netlify in production, `server.py` locally). `js/app.js` fetches `data/predictions.json` and renders one card per matchup. Each matchup already carries everything a user prediction needs:

```
team:     { name, code, color, note }   e.g. Brazil, "br", "#1E9B4B", "Winner, Group G"
opponent: { name, code, color, prob }   e.g. South Korea, "kr", "#0A3478", 38
alternates: [ { name, prob }, ... ]
```

So the model already publishes, per team: the favored opponent, that opponent's probability, and two alternates. That is the exact raw material a "make your own" feature compares against. The visual language is locked and worth matching: cream canvas (#F4F2EB), white card, a team-color split rule across the top (`--ca` to `--cb`), flag VS flag, a large Space Grotesk percentage, and a team-color gradient probability bar. The user-made prediction and its share card should look like a first-class member of that board, not a separate widget.

One layout constraint to respect in the builder: on a 390px phone the existing two-flag VS row already runs tight against the right edge. Any picker UI we add should stack vertically on mobile rather than reuse the side-by-side flag row at full size.

## Part 1: UX flows for building a prediction

Goal: pick a team, pick its Round of 32 opponent, set a probability with a slider, lock it in. Below are four flows from lightest to richest. They are not mutually exclusive; Flow A is the v1 spine and the others layer on later.

### Flow A: Inline "challenge the model" on an existing card (recommended core)

Every board card gets a small action: "Make your call". Tapping it expands the card in place into an editor without leaving the page.

1. The team side is fixed to that card's team (Brazil). No team picker needed for the common case, because the user is reacting to a forecast they are already looking at.
2. The opponent side becomes a chooser. The model's favored opponent and the two alternates are offered first as one-tap chips (South Korea 38, Uruguay 24, Ghana 19), plus a "someone else" control that opens the full team list. Pre-loading the model's three names removes most of the typing.
3. A slider appears under the flag-VS row, styled as the existing probability bar (same team-color gradient fill, same track color #ECE8DE). Dragging it updates a large Space Grotesk percentage live, exactly like the static card's `.pct`. Default the handle to the model's number for that opponent so the user starts from the forecast and moves away from it.
4. "Lock it in" freezes the card into a finished user prediction: the bar fills, the percentage sets, and a share row appears (Share, Copy link, Download image). A subtle "Your call" tag distinguishes it from the model card.

Why this is the spine: it reuses components that already exist on the page, it requires zero new screens, and it frames the whole feature as a head-to-head with Sportacle's model, which is the most on-brand hook (confident, numerate, a little provocative).

### Flow B: Dedicated builder ("Build a prediction" page or panel)

A standalone three-step builder for users arriving cold (for example from a shared link's call to action), reachable at `/build` or as a full-width panel above the board.

1. Step 1, pick your team: a flag grid of all teams (the `flags/*.png` assets). Tap to select; the chosen team's color theming (`--ca`) flows into the rest of the builder.
2. Step 2, pick the opponent: same flag grid, with the picked team removed and the model's likely opponents floated to the top and labeled "model favors". Tap to select; the second color (`--cb`) sets, and the top split rule and bar gradient now read as the real card will.
3. Step 3, set the odds: the slider, with three live reference markers on the track showing where the model sits for that pairing (favored, alt 1, alt 2) so the user can agree or deliberately diverge. A live preview card renders below exactly as it will be shared.
4. Lock it in, then the same share row as Flow A.

This is the richer surface and the natural home for the dynamic preview and the "vs model" comparison. It is v1-shippable but heavier than Flow A; recommend it as the second surface, not the first.

### Flow C: One-line conversational composer

A single sentence with three inline editable tokens, sitting at the top of the board:

"I think [Brazil] meets [South Korea] in the Round of 32, and I'd put it at [42%]."

Each bracket is a tap target: the first two open a flag picker popover, the percentage opens the slider (or accepts typed entry). This is the fastest possible build, reads like a take rather than a form, and is excellent for mobile because it is vertical by nature and never reuses the tight side-by-side flag row. Strong candidate to pair with Flow A: card-level "Make your call" for reactions, this composer for cold starts.

### Flow D: Swipe / agree-or-disagree micro flow (engagement variant)

A stack of model cards presented one at a time with two buttons: "I agree" (adopts the model's exact prediction and percentage as the user's own, one tap) and "I'd change it" (drops into the Flow A slider so they can move the number or swap the opponent). This turns prediction-building into a fast game loop and seeds a lot of shareable predictions with minimal effort. Best as a v2/v3 engagement mode layered on the Flow A machinery, not the first thing built.

### Interaction details that apply across flows

- Slider: snap to whole percentages, large hit area, keyboard accessible (arrow keys), and it drives the same `width:NN%` fill the static bar uses so the preview is pixel-accurate to the board.
- Live echo: the big percentage and the bar update on every input event, never only on release. The number is the product.
- Default to the model: always seed the slider at the model's value for the chosen pairing. Users anchoring on the forecast and then disagreeing is the entire emotional hook.
- Validation: clamp 1 to 99 (never 0 or 100, which read as fake certainty and undercut the "futures" voice). If the user picks an opponent the model considers impossible (different side of the bracket), allow it but show a gentle "bold call" note rather than blocking.
- Reset and re-pick are always one tap; locking is reversible until shared.

## Part 2: Sharing a user-made prediction (the share image problem)

Sharing has two layers: the link (easy) and the image with the user's own numbers (the hard part). Treat them separately.

### The link layer: encode the prediction in the URL

Carry the whole prediction in the URL so no database is required to reproduce it:

```
https://gosportacle.com/p/?t=br&o=kr&p=42
```

`t` = team code, `o` = opponent code, `p` = the user's percentage. The page reads these params, looks up names and colors from the same `predictions.json` (or a small static `teams.json`), and re-renders the exact card for anyone who opens the link. This is the backbone of a no-backend v1: the prediction is fully described by the link itself. Keep the param set tiny and stable, because it is effectively a public API and it is what the OG image function in v2 will also read.

### The image layer: four realistic options

The requirement: a clean branded graphic showing the user's own percentage in the locked team-color flag-VS split style, suitable for X and other social. Here are the realistic ways to generate it, with tradeoffs.

#### Option 1: Client-side canvas (recommended for v1)

Render the card to an HTML `<canvas>` in the browser, then `canvas.toBlob()` to produce a downloadable PNG.

- How: draw the cream background, the two flags (the PNGs already load on the page, so they are in cache and can be drawn with `drawImage`), the two team names, the big percentage, the team-color split bar, and the Sportacle wordmark plus @TheSportacle handle. Fonts: load Space Grotesk and Inter via the CSS already on the page and wait on `document.fonts.ready` before drawing so the canvas uses the real typefaces.
- Pros: zero backend, ships on the current Netlify static setup today, no per-image cost, works offline, full control of the locked layout, instant. The flags and fonts are already present, which removes the usual canvas asset-loading pain.
- Cons: the user has to actively download or the app has to invoke the Web Share API with the file; the image is not auto-embedded when the link is pasted (see the unfurl note below). Canvas text layout is manual work (wrapping long names like "United States", measuring text). Pixel parity with the CSS card requires care.
- Verdict: best effort-to-value ratio for v1. The user gets a real, on-brand PNG they can post, with no infrastructure.

#### Option 2: SVG-to-image in the browser

Build the card as an SVG string (which can mirror the CSS almost exactly, including the gradient bar), then rasterize by drawing the SVG into a canvas and exporting PNG.

- Pros: the card is basically the same vector design language as the site, so visual parity is easier than hand-drawn canvas; text and layout use SVG instead of manual measurement.
- Cons: the classic gotcha is that external images referenced from SVG (the flag PNGs) and external fonts taint or fail to load when rasterizing, so flags and fonts often must be inlined as data URIs inside the SVG before export. Note this is the only place data URIs are appropriate here, strictly inside the generated share image, never for the served site assets. More moving parts than plain canvas for the same v1 outcome.
- Verdict: a fine alternative to Option 1 if we prefer authoring the card as markup, but it carries the font/flag inlining tax. Either Option 1 or Option 2 satisfies v1; recommend canvas for fewer surprises.

#### Option 3: Serverless Open Graph image function (recommended for v2)

A Netlify Function (or Edge Function) that takes the same params (`?t=br&o=kr&p=42`) and returns a 1200x630 PNG generated server-side with satori (JSX/HTML plus CSS to SVG) or @vercel/og, rasterized to PNG.

- Pros: this is the only option that makes the prediction unfurl as a rich image card automatically when the link is pasted into X, iMessage, Slack, Discord, and so on, because crawlers fetch the page's `og:image` URL and get a freshly rendered image with the user's numbers baked in. No user download step required for the link to look good. Server controls fonts and flags, so parity and quality are reliable.
- Cons: requires Netlify Functions (still the same Netlify deploy, but now with a serverless piece, so not "pure static" anymore), a cold-start and per-invocation cost, and the OG image URL needs caching (CDN cache by query string) so popular predictions are not re-rendered every crawl. satori has layout constraints (a subset of CSS) to design within.
- Verdict: the right v2. It is the upgrade that turns a shared link from "text plus a manual screenshot" into "paste the link and a branded card with the user's percentage appears automatically." Build v1 on canvas, then add this without changing the URL contract.

#### Option 4: Pre-rendered template images

Ship a fixed set of background templates and composite text on top, either a static OG image per team or a small library of base cards.

- Pros: cheapest possible to serve, trivially cached.
- Cons: cannot show an arbitrary user percentage or an arbitrary opponent pairing without either client compositing (which is just Option 1 again) or a server step (Option 3). A purely static template cannot bake in "42% vs South Korea" for every combination. As a standalone approach it fails the core requirement (the user's own numbers), so its only real role is the generic fallback `og:image` for the build page before a specific prediction exists.
- Verdict: not a primary option. Useful only as the default share image for the landing/build page.

### Recommendation for v1 sharing

Use Option 1 (client-side canvas) for the actual graphic, plus the URL-encoded link from Part 2. Concretely the share row offers:

1. Download image: canvas to PNG, on-brand card with the user's percentage.
2. Share (mobile): Web Share API with the PNG file attached where supported (`navigator.canShare({ files })`), falling back to download.
3. Post to X: open an intent URL with prefilled text and the prediction link, for example text like "My Round of 32 call: Brazil vs South Korea, I'd put it at 42%. The Sportacle model says 38%. Build yours:" plus the `/p/?t=br&o=kr&p=42` link. The user attaches the downloaded PNG in the composer (until v2 makes the unfurl automatic).
4. Copy link: copies the encoded URL.

This ships entirely on the current Netlify static site.

### How the shared link unfurls

- v1 (static): the `/p/` page carries the standard site-wide `og:image` (a generic branded Sportacle card, Option 4 used only here as the default). So a pasted link unfurls with a clean Sportacle-branded preview, but not yet the user's specific number. The user's specific number travels as the attached PNG they downloaded, plus the visible tweet text ("I'd put it at 42%"). This is an honest, good-looking v1: branded unfurl plus a real custom image in the post.
- v2 (serverless): point `og:image` at the OG function, `https://gosportacle.com/og/?t=br&o=kr&p=42`. Now the same pasted link unfurls as a per-prediction card with the user's 42% and both flags rendered server-side, no attachment needed. The page's `<meta property="og:image">` is set per prediction (either server-rendered HTML or a tiny script that rewrites it before crawl is not reliable, so the page should be served by the function or have the meta baked at request time). Keep `og:title` and `og:description` dynamic too ("Brazil vs South Korea, my call: 42%").

## Part 3: when a backend is actually needed

Map each capability to the lightest infrastructure that supports it. The guiding principle: do not add a server until a feature genuinely cannot live in the URL plus the browser.

| Capability | Needs | Why |
| --- | --- | --- |
| Build a prediction, set %, see live card | Client only | All in-browser; reads existing JSON. |
| Share a custom PNG with the user's % | Client only (canvas) | `toBlob` plus Web Share / download. |
| Reproduce any prediction from a link | Client only (URL params) | The link fully describes the prediction. |
| Branded link unfurl (generic) | Static `og:image` | One static image, no compute. |
| Per-prediction unfurl (user's % in the preview) | Serverless function | Crawlers need a server-rendered `og:image` per params. |
| Save predictions, recall "my predictions" | Database | State must persist beyond a URL and a device. |
| Public leaderboard, counts, "73% of users agree" | Database plus a write path | Requires aggregating many users' submissions. |
| Streaks, weekly recap, settling against real results | Database plus identity plus a scheduled job | Needs stored history, a user key, and result ingestion. |

### Recommended phased path

- v1, client only: Flow A (and optionally Flow C), canvas share image, URL-encoded links, generic static unfurl. Ships on the current Netlify static deploy with no new services. This is the whole feature for a first release and it already delivers the core loop: build, see your number against the model, share a branded image.
- v2, serverless OG image: add one Netlify Function returning a per-prediction 1200x630 PNG via satori or @vercel/og, set `og:image` to it, add CDN caching by query string. No change to the URL contract or the client builder. The single, high-leverage upgrade: shared links now unfurl with the user's own percentage automatically.
- v3, saved and social: introduce storage (start with the lightest option, for example Netlify Blobs or a hosted Postgres/SQLite-class store, or a backend-as-a-service) to persist predictions behind a short share ID (`/p/abc123`), then build the leaderboard, agree-or-disagree tallies, streaks, and the weekly recap on top. This is where identity (even anonymous, cookie or device based) and a job to settle predictions against real World Cup results enter.

Each phase is independently shippable and does not block on the next. v1 is genuinely useful alone, which is the point of starting client-only.

## Part 4: engagement hooks

Ordered by how early they can ship and how on-brand they are.

- Compare to the model (v1, highest priority): every user prediction shows Sportacle's number next to it. "You: 42%. Sportacle model: 38%." This is the core of the brand voice and it is free in v1 because `predictions.json` already carries the model's probability and alternates. The delta is the story: surface it ("You are 4 points more bullish than the model").
- Agree or disagree (v1/v2): a one-tap "I agree with the model" that adopts its number, versus building your own. Frames participation as taking a side. Feeds Flow D. Pure client in v1; becomes a public tally in v3.
- Bold-call meter (v1, lightweight): label how far the user diverges from the model. Small percentages on a longshot opponent get a "bold call" tag; matching the favorite gets a "chalk" tag. Turns the slider into a personality test and gives the share image a hook line ("a bold call: 55% on a longshot").
- Public prediction leaderboard (v3): once predictions are saved and results settle, rank users by accuracy (Brier score is the numerate, on-brand metric, lower is better). "Top forecasters" plays directly to the futures-site identity. Needs a database and result ingestion.
- Crowd number (v3): "73% of Sportacle users also picked South Korea" and "the crowd's average probability is 36%." A second comparison axis next to the model. Needs aggregated writes.
- Streaks (v3): consecutive correct calls as results land, with a visible streak badge that can ride along on the share card. Needs stored history and a device or account key.
- Weekly recap (v3): an automated "here is how your Round of 32 calls are tracking" card each matchday, shareable, that also pulls lapsed users back. Needs the scheduled settlement job plus saved predictions. Strong retention lever once the tournament is live, which is also when the data exists to make it real.

A note on honesty in the voice: until real results exist, accuracy-based hooks (leaderboard, streaks, recap) have nothing to settle against, so they belong in v3 during the tournament. The model-comparison and bold-call hooks work on day one and carry v1 on their own.

## Part 5: recommended v1 (concrete, ships on the current Netlify static site)

Build this and nothing more for the first release.

1. Surface: add a "Make your call" action to each existing board card (Flow A), plus the one-line composer at the top of the board (Flow C) for cold starts. No new pages required, though a `/build` route is an easy optional add.
2. Build interaction: opponent chosen from the model's three names as chips plus a full flag-grid fallback; probability set with a slider styled as the existing team-color bar, defaulting to the model's number for the pairing, echoing a live Space Grotesk percentage. Clamp 1 to 99.
3. Comparison hook baked in: show the model's number and the delta inline ("You: 42%. Model: 38%.") and a bold-call/chalk tag. Free from existing JSON.
4. Share image: client-side canvas renders the locked team-color flag-VS split card with the user's percentage, the Sportacle wordmark, and @TheSportacle. Export via `toBlob`. Wait on `document.fonts.ready` and reuse the already-loaded flag PNGs.
5. Share actions: Download image, Web Share (file where supported), Post to X (intent URL with prefilled take plus the encoded link), Copy link.
6. Link contract: `/p/?t=<team>&o=<opponent>&p=<pct>`. The `/p/` page reads params, looks names and colors up from the existing JSON, and re-renders the exact card. Keep the param names stable; v2's OG function will reuse them verbatim.
7. Unfurl: the `/p/` page ships the standard generic Sportacle `og:image` so pasted links preview as on-brand. The user's specific number rides in the downloaded PNG and the tweet text for now. v2 swaps `og:image` to the serverless per-prediction renderer with no other changes.

Why this is the right v1: it delivers the entire emotional loop (pick, disagree with the model, get a clean branded image with your own percentage, post it) with no backend, no database, and no change to the Netlify static deployment. It reuses the flags, fonts, colors, and card anatomy already on the page, so the user's prediction looks native to the board and the share card matches the locked social style. Every later phase (serverless unfurl, saved predictions, leaderboard, streaks, recap) layers on without reworking the URL contract or the builder.

### One-screen summary

- v1: client-only. Flow A plus Flow C, canvas PNG, URL-encoded links, model-comparison and bold-call hooks, generic branded unfurl. Ships on current Netlify static.
- v2: add one serverless OG-image function (satori or @vercel/og) so links unfurl with the user's own percentage. Same URL contract.
- v3: add storage and identity for saved predictions, public leaderboard (Brier score), crowd numbers, streaks, and a weekly recap settled against real results.
