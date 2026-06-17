# Sportacle R32 engine: what is real vs modeled vs assumed

This file is the honest ledger. Read it before trusting any number.

## REAL (pulled live from ESPN, no API key)

- Fixtures and results: every group game and its score comes from the
  ESPN scoreboard endpoint. As of the last run there were 21 finished
  group matches and 51 still scheduled (72 total, the full group stage).
- Group membership: which of the 48 teams sit in Group A through L comes
  from the ESPN standings endpoint (12 group children, 4 teams each).
- The timestamp: `updated_iso` in predictions.json is the kickoff/date of
  the most recently finished match in the feed (not a made-up time, not
  "now"). `last_result` is that match's real scoreline.
- The Round of 32 bracket structure: the 16 R32 pairings (which group
  position plays which) are DERIVED FROM THE FEED, not assumed. ESPN
  publishes each knockout fixture as a scheduled event whose competitors
  are placeholders ("Group C Winner" = 1C, "Group F 2nd Place" = 2F, and
  "Third Place Group A/B/C/D/F" = a best-third from one of those groups).
  We snapshot that exact structure in `bracket.py` (R32_SLOTS), including
  the official per-slot list of which groups each third-place slot may
  draw from. So the bracket skeleton is confirmed, not guessed.

## MODELED (our assumptions, transparent and tunable)

- Elo seeds: each team starts from a static, approximate pre-tournament
  Elo rating in `teams.py`. These are reasonable real-world values (top
  sides around 2000+, mid around 1750, weak around 1500) but they are our
  estimates, not an official rating. They are then updated by replaying
  the finished results before simulating.
- Match outcome model: win/draw/loss probabilities come from the Elo gap
  via a logistic function plus a draw model whose rate shrinks as teams
  diverge. Group games are treated as neutral-venue (no host bonus).
  Scorelines are sampled from small Poisson-like draws so the group tables
  get goal difference and goals for. Formulas are documented in `model.py`.
- Monte Carlo: 30,000 simulations of the remaining group games. The
  opponent probabilities in predictions.json are empirical frequencies
  across those sims. More sims would tighten them slightly; the structure
  would not change.

## ASSUMED / SIMPLIFIED (needs-verification caveats)

- FIFA group tiebreakers: the official order is points, then (if a group
  is tied) HEAD-TO-HEAD results among the tied teams, then overall goal
  difference, then overall goals for, and so on. We apply points, then
  overall goal difference, then overall goals for. We SKIP head-to-head.
  This is a simplification: in the rare simulated runs where two teams
  finish level on points, we may order them differently than FIFA would.
  It mainly affects 2nd-vs-3rd and the third-place cutoff at the margins.
- Best-third-place slotting: deciding WHICH of the eight qualifying
  third-place teams fills WHICH "3RD" slot is FIFA's fixed lookup table,
  keyed on the SET of eight groups that qualified (495 possible sets). We
  do NOT hardcode all 495 rows. Instead we honor each slot's published
  allowed-groups restriction (from the feed) and solve the assignment by
  backtracking. This reproduces the official table for legal inputs and
  every assignment we produce is group-legal (verified), but it is not a
  literal copy of FIFA's 495-row table, so a specific edge-case set could
  in principle differ from the official chart. If you want zero risk here,
  drop the full lookup table into `bracket.assign_third_places`; the rest
  of the engine does not need to change.
- "Projected winner / runner-up" labels: we label the more-determined
  side of each tie (the group winner or runner-up host) with its most
  likely identity. Early in the group stage these are genuinely uncertain;
  the label reflects the single most likely team, not a settled result.

## How to correct things

- Bracket wrong? Edit only `bracket.py` (R32_SLOTS and/or
  assign_third_places). Everything is isolated there.
- Elo seeds off? Edit `teams.py`.
- Want head-to-head tiebreakers? Implement it in `simulate.py` where the
  group table is ranked (the `_standings_key` / sort step).
