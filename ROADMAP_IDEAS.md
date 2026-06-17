# Sportacle Roadmap: Forward-Looking Feature Ideas

Sportacle (@TheSportacle, gosportacle.com) is a sports-futures site. Today it answers one sharp question: at the 2026 World Cup, who is each team's most likely Round of 32 opponent, and with what probability. The board is a static page that renders 16 ties from `data/predictions.json`, refreshes every 60 seconds, and lets a visitor share any card to X.

This document looks past that single board. It groups ideas by theme, and for each idea it states what it is, why it fits the brand and the data we already publish, its impact, its effort, and a rough horizon. Horizons are: now (ships on the current static site before the tournament), this tournament (during June and July 2026, may need a light backend or a scheduled job), and next season (a structural bet that pays off beyond this World Cup).

The brand rules hold throughout: flag-forward, clean light cards, a team-color top accent, a green probability bar, no generic dark neon dashboards, no em or en dashes, and respect for prefers-reduced-motion on every animation. Where an effect is suggested it should be tasteful, premium, and data-driven, never decorative for its own sake.

## Where the product is heading

The current board is a snapshot of one knockout round. The natural arc of a futures product is to grow along three axes at once:

1. Depth. From one round to the whole bracket, then from a static forecast to a live, in-match win probability.
2. Participation. From a board you read to a board you play: make your own call, compare to the model, climb a leaderboard.
3. Reach. From one page people visit to widgets and alerts that travel: embeds on other sites, notifications when a projected foe changes, and eventually the same engine pointed at other sports.

The ideas below are ordered to follow that arc. The earliest ones harden and extend the thing that already works. The later ones are the bets that turn a tournament site into a returning product and, ultimately, into a brand that outlives this one World Cup.

## Theme 1: Depth of the forecast

### 1.1 The full bracket as it narrows

What it is: a bracket view that sits alongside the Round of 32 board and shows the projected path through Round of 16, quarters, semis, and the final, with each projected tie carrying its probability the same way a card does today. As real results land, settled ties lock and the downstream projections re-narrow.

Why it fits: the model already reasons about who meets whom; the board only exposes the first knockout layer. A bracket is the most natural and most expected next surface for a knockout forecaster, and it reuses the exact card anatomy (flags, team-color accent, probability bar) at smaller scale.

Impact: high. It is the single feature most likely to make a first-time visitor stay and explore, and it gives the site a reason to be checked every matchday as the tree collapses.

Effort: medium to high. The view and the narrowing logic are real work, but the data shape is a known extension of what the engine already produces.

Horizon: this tournament. Ship the static projected bracket first, then wire the lock-as-results-land behavior.

### 1.2 Per-team "path to the final" pages

What it is: a dedicated page per team that lays out the projected route, round by round, to the final: the most likely opponent at each stage, the cumulative probability of reaching each round, and the single hardest tie on the path. Shareable as a clean per-team card.

Why it fits: fans follow a team, not a bracket. A path page is the personal, emotional cut of the same data, and it is the most shareable artifact a national-team supporter can post. It also gives every team its own landing surface for search and social.

Impact: high for engagement and for organic reach, because supporters share their own team far more readily than a neutral board.

Effort: medium. Mostly a new view over existing projections plus a cumulative-probability calculation.

Horizon: this tournament, right after the bracket lands.

### 1.3 Live win probability during matches

What it is: while a match is being played, the relevant cards switch to a live win-probability readout that updates as the score and game state change, then settles into the result and re-projects the downstream board.

Why it fits: it converts the site from a thing you check before matches into a thing you keep open during them. It is the most direct expression of the "futures" identity: a number that moves in real time.

Impact: very high on session length and live traffic, but it depends on a reliable in-match data feed and the engine producing live numbers.

Effort: high. Needs a live data source, an in-match model path, and careful, calm presentation that does not turn into a flickering ticker.

Horizon: this tournament if a feed and live model exist; otherwise next season as a headline feature.

## Theme 2: The Sportacle edge

### 2.1 Bracket landmines and collision watch

What it is: a feature that surfaces the dangerous and dramatic structure of the bracket: two heavyweights projected to collide early, a favorite with a brutal path, a sleeper with an open lane. Each "landmine" is a short, punchy card ("Brazil and Netherlands are on a collision course in the Round of 16") backed by the probability.

Why it fits: this is the editorial voice of the brand made into a feature. It is provocative, numerate, and inherently shareable, and it is computed entirely from projections the model already produces. It also gives @TheSportacle a steady stream of native social posts.

Impact: high for social reach and for giving the site a personality beyond a data table.

Effort: low to medium. The collision and difficulty math is straightforward over existing projections; the work is in selecting and phrasing the most striking few.

Horizon: now for a basic version over the current board, expanding to this tournament once the full bracket exists.

### 2.2 The travel and altitude edge model differentiator

What it is: a visible, explained model factor that accounts for the 2026 tournament's unusual geography: long travel between host cities and venues at very different altitudes (for example Mexico City versus sea-level coastal venues). Each affected tie gets a small "Sportacle edge" note explaining how travel load or altitude shifts the probability.

Why it fits: this is the credibility and differentiation play. Anyone can publish odds; a visible, defensible edge is what makes Sportacle a model worth trusting and citing. It is uniquely relevant to a continent-spanning, multi-altitude World Cup, and it directly supports the "futures site with a real model" positioning.

Impact: high for authority and press citations, medium for direct engagement. This is the feature that gets the site quoted.

Effort: medium to high, mostly on the engine side. The website work is the explanatory surface, which is small.

Horizon: this tournament for the explanatory surface; the underlying factor is an engine effort that can begin now.

## Theme 3: Participation and games

### 3.1 Make your own prediction (already specced)

What it is: let a visitor pick a team, pick its Round of 32 opponent, set a probability with a slider styled as the existing bar, compare it to the model, and share a clean branded card. The detailed v1 to v3 plan already lives in `USER_PREDICTIONS_RECOMMENDATIONS.md` and ships client-only on the current static site.

Why it fits: it turns a board you read into a board you play, and the core hook (disagree with the model, post your number) is the most on-brand engagement loop available. The data needed is already in `predictions.json`.

Impact: very high. This is the conversion from audience to participants and the seed for every social and leaderboard feature below.

Effort: medium for the client-only v1, growing with the serverless and saved phases.

Horizon: now for v1, this tournament for the serverless unfurl and saved predictions.

### 3.2 Prediction games and a public leaderboard

What it is: once predictions can be saved and real results settle, rank forecasters by accuracy using a Brier score (lower is better), with "top forecasters" and a crowd consensus number ("the crowd's average is 36 percent") shown next to the model. Includes streaks for consecutive correct calls.

Why it fits: accuracy scoring is the most numerate, on-brand competitive metric, and a leaderboard is the retention engine that pulls people back every matchday. It is the natural payoff of "make your own prediction."

Impact: very high for retention during the tournament, but only meaningful once real results exist to settle against.

Effort: high. Needs storage, an anonymous or account-based identity, and a scheduled job that settles predictions against results.

Horizon: this tournament, in the v3 phase, because accuracy hooks have nothing to score until matches are played.

## Theme 4: Reach and growth

### 4.1 Embeddable widgets for other sites

What it is: a tiny embeddable version of a card, a team's path, or the bracket that a blog, a news outlet, or a fan site can drop in with one line, themed to match Sportacle, linking back to gosportacle.com and auto-updating from the same data.

Why it fits: it turns every partner site into a distribution channel and a backlink, which compounds reach and search authority. The card is already a self-contained, data-driven unit, so an embed is a natural packaging of what exists.

Impact: high for top-of-funnel growth and credibility by association, lower for direct on-site engagement.

Effort: medium. The rendering exists; the work is a stable embed surface, theming, and a lightweight loader that does not bloat host pages.

Horizon: this tournament, after the make-your-own and bracket surfaces give embeds something worth placing.

### 4.2 Alerts when a team's projected foe changes

What it is: let a visitor follow a team and get notified (email, web push, or a posted update) when that team's projected Round of 32 opponent or path materially changes after results land.

Why it fits: the board already updates every 60 seconds; the change is the news. Turning a silent update into a notification is the lightest possible retention mechanism and it gives people a reason to come back at the exact moment the story moves.

Impact: high for retention and return visits, because it re-engages at the moment of maximum relevance.

Effort: medium. Needs a follow mechanism, a diff of projections between updates, and a delivery channel. Web push or email is lighter than a full account system.

Horizon: this tournament. A simple per-team "what changed today" digest is a strong, low-cost first version.

### 4.3 Generalize the brand to other sports

What it is: take the engine, the card language, and the "meet your foe" futures framing and point them at the next bracket or knockout event after the World Cup: continental cups, club knockouts, or entirely different sports with playoff structures.

Why it fits: this is the original stated goal. The product is deliberately built as data decoupled from view (the engine rewrites a JSON file and the board reflects it), which means the hard architectural work of generalizing is largely already paid for. The brand ("Sportacle", flag-forward, numerate, a little provocative) is sport-agnostic.

Impact: very high strategically. It is the difference between a tournament site that goes quiet in August and a returning product with a calendar of events.

Effort: high, but front-loaded. Most of the cost is a second engine and data source; the website is reusable.

Horizon: next season. The World Cup is the proof of concept that earns the right to generalize.

## Suggested sequencing

1. Now: ship make-your-own v1 (client only), a basic collision watch over the current board, and the editorial landmine cards. These extend what already works with no backend.
2. This tournament: the projected bracket, per-team path pages, change alerts, embeddable widgets, the travel and altitude edge surface, and the saved-prediction leaderboard. These need the full bracket data, a light backend, or a settlement job, and they turn the site into a returning product for the duration of the event.
3. Next season: live in-match win probability as a headline feature and the generalization of the brand to other sports. These are the structural bets that pay off beyond this one World Cup.

The through-line: deepen the forecast, make it playable, make it travel, and build it so the same machinery can be aimed at the next event when this one ends.
