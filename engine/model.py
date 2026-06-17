"""
The statistical model: Elo ratings + a per-match outcome model.

ELO
---
Each team starts from a static seed (teams.py). We then replay every
already-finished group match to update the ratings before simulating, so
the seeds drift toward observed form.

Update rule (standard Elo with a goal-difference multiplier):
    expected_home = 1 / (1 + 10 ** (-(Rh - Ra) / 400))
    Rh' = Rh + K * G * (S_home - expected_home)
    Ra' = Ra + K * G * (S_away - expected_away)
where
    S_home in {1, 0.5, 0} for win/draw/loss,
    K = 40 (World Cup importance),
    G = goal-difference multiplier:
        1                       if margin <= 1
        1.5                     if margin == 2
        (11 + margin) / 8       if margin >= 3
World Cup group games are at neutral venues, so we apply NO home-field
bonus when updating from results.

MATCH OUTCOME (group games: win / draw / loss)
----------------------------------------------
From the Elo difference d = Rh - Ra (neutral, so no host bonus), the
"win-or-draw" expectation for the stronger side is the logistic
    p_strong_or_draw = 1 / (1 + 10 ** (-d / 400)).
We split that into a draw probability and decisive probabilities. The
draw rate falls as the teams are further apart:
    p_draw = DRAW_BASE * exp(-|d| / DRAW_DECAY)
Then the remaining (1 - p_draw) is divided between the two teams in
proportion to their logistic win expectations. We also draw a plausible
score so the group tables get goal-difference and goals-for, which feed
the FIFA tiebreakers. Goals are sampled from small Poisson-like draws
whose means scale gently with the Elo edge.

These formulas are MODELED (see engine/NOTES.md). They are deliberately
simple and transparent rather than calibrated to betting markets.
"""

import math
import random

K_FACTOR = 40.0
DRAW_BASE = 0.28        # draw probability when two equal teams meet
DRAW_DECAY = 220.0      # larger -> draws stay likely further apart


def expected_score(rating_a, rating_b):
    """Logistic expectation that A beats-or-halves B (neutral venue)."""
    return 1.0 / (1.0 + 10 ** (-(rating_a - rating_b) / 400.0))


def _gd_multiplier(margin):
    margin = abs(margin)
    if margin <= 1:
        return 1.0
    if margin == 2:
        return 1.5
    return (11.0 + margin) / 8.0


def apply_result(ratings, home, away, hg, ag):
    """Mutate `ratings` in place from one finished neutral-venue match."""
    rh, ra = ratings[home], ratings[away]
    exp_h = expected_score(rh, ra)
    exp_a = 1.0 - exp_h
    if hg > ag:
        s_h, s_a = 1.0, 0.0
    elif hg < ag:
        s_h, s_a = 0.0, 1.0
    else:
        s_h = s_a = 0.5
    g = _gd_multiplier(hg - ag)
    ratings[home] = rh + K_FACTOR * g * (s_h - exp_h)
    ratings[away] = ra + K_FACTOR * g * (s_a - exp_a)


def outcome_probs(rating_h, rating_a):
    """
    Return (p_home_win, p_draw, p_away_win) for a neutral group game.
    """
    d = rating_h - rating_a
    p_draw = DRAW_BASE * math.exp(-abs(d) / DRAW_DECAY)
    p_draw = max(0.06, min(0.40, p_draw))
    decisive = 1.0 - p_draw
    # split decisive mass by logistic win expectation
    e_h = expected_score(rating_h, rating_a)
    p_h = decisive * e_h
    p_a = decisive * (1.0 - e_h)
    return p_h, p_draw, p_a


def _sample_goals(rng, edge):
    """
    Sample a goal total for one side. `edge` shifts the mean up for the
    favored side. Mean lands roughly in [0.7, 2.1]. Small Poisson-like
    draw using the stdlib only.
    """
    mean = max(0.35, 1.25 + edge)
    # inverse-CDF-ish Poisson sample
    l = math.exp(-mean)
    k, p = 0, 1.0
    while True:
        p *= rng.random()
        if p <= l:
            return k
        k += 1


def simulate_match(rng, rating_h, rating_a):
    """
    Simulate one group match. Returns (home_goals, away_goals) consistent
    with the win/draw/loss model above. Scores feed the tiebreakers.
    """
    p_h, p_draw, p_a = outcome_probs(rating_h, rating_a)
    r = rng.random()
    edge = (rating_h - rating_a) / 1600.0   # gentle scaling of goal means
    if r < p_h:
        # home win
        while True:
            hg = _sample_goals(rng, edge + 0.25)
            ag = _sample_goals(rng, -edge - 0.10)
            if hg > ag:
                return hg, ag
    elif r < p_h + p_a:
        # away win
        while True:
            hg = _sample_goals(rng, edge - 0.10)
            ag = _sample_goals(rng, -edge + 0.25)
            if ag > hg:
                return hg, ag
    else:
        # draw
        g = _sample_goals(rng, abs(edge) * 0.3)
        return g, g
