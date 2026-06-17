"""
Team metadata table for the 2026 FIFA World Cup (48 teams).

Keyed by the exact ESPN displayName observed in the live feed
(scoreboard + standings endpoints). Each record carries:
  - code:  lowercase ISO-3166 alpha-2 used for the flag file web/flags/<code>.png
  - color: a hex brand color used by the site board
  - elo:   an approximate pre-tournament Elo rating (MODELED, not measured).
           Top sides sit around 2000+, mid sides around 1750, weak sides
           around 1500. These are reasonable real-world approximations and
           are intentionally static; the engine then updates them with the
           results that have already been played before simulating.

If ESPN ever renames a team, add an alias in ALIASES below rather than
editing the canonical key, so the rest of the engine keeps working.
"""

# code, color, elo seed
TEAMS = {
    # Group A
    "Mexico":             {"code": "mx", "color": "#0B6B3A", "elo": 1820},
    "Czechia":            {"code": "cz", "color": "#11457E", "elo": 1760},
    "South Korea":        {"code": "kr", "color": "#0A3478", "elo": 1740},
    "South Africa":       {"code": "za", "color": "#007749", "elo": 1620},
    # Group B
    "Canada":             {"code": "ca", "color": "#D52B1E", "elo": 1760},
    "Bosnia-Herzegovina": {"code": "ba", "color": "#002395", "elo": 1700},
    "Switzerland":        {"code": "ch", "color": "#D52B1E", "elo": 1850},
    "Qatar":              {"code": "qa", "color": "#8A1538", "elo": 1560},
    # Group C
    "Brazil":             {"code": "br", "color": "#1E9B4B", "elo": 2050},
    "Scotland":           {"code": "gb-sct", "color": "#0065BF", "elo": 1720},
    "Haiti":              {"code": "ht", "color": "#00209F", "elo": 1500},
    "Morocco":            {"code": "ma", "color": "#C1272D", "elo": 1860},
    # Group D
    "Paraguay":           {"code": "py", "color": "#D52B1E", "elo": 1700},
    "Turkiye":            {"code": "tr", "color": "#E30A17", "elo": 1820},
    "Australia":          {"code": "au", "color": "#00843D", "elo": 1710},
    "United States":      {"code": "us", "color": "#3C3B6E", "elo": 1800},
    # Group E
    "Ecuador":            {"code": "ec", "color": "#FFD100", "elo": 1820},
    "Germany":            {"code": "de", "color": "#2B2B2B", "elo": 1960},
    "Ivory Coast":        {"code": "ci", "color": "#F77F00", "elo": 1720},
    "Curacao":            {"code": "cw", "color": "#002B7F", "elo": 1500},
    # Group F
    "Netherlands":        {"code": "nl", "color": "#EC8B00", "elo": 1940},
    "Sweden":             {"code": "se", "color": "#006AA7", "elo": 1740},
    "Japan":              {"code": "jp", "color": "#BC002D", "elo": 1840},
    "Tunisia":            {"code": "tn", "color": "#E70013", "elo": 1640},
    # Group G
    "Belgium":            {"code": "be", "color": "#ED2939", "elo": 1930},
    "Iran":               {"code": "ir", "color": "#239F40", "elo": 1700},
    "Egypt":              {"code": "eg", "color": "#C8102E", "elo": 1680},
    "New Zealand":        {"code": "nz", "color": "#1B1B1B", "elo": 1540},
    # Group H
    "Spain":              {"code": "es", "color": "#C60B1E", "elo": 2080},
    "Uruguay":            {"code": "uy", "color": "#0038A8", "elo": 1890},
    "Saudi Arabia":       {"code": "sa", "color": "#006C35", "elo": 1620},
    "Cape Verde":         {"code": "cv", "color": "#003893", "elo": 1560},
    # Group I
    "Norway":             {"code": "no", "color": "#BA0C2F", "elo": 1850},
    "France":             {"code": "fr", "color": "#0055A4", "elo": 2040},
    "Senegal":            {"code": "sn", "color": "#00853F", "elo": 1820},
    "Iraq":               {"code": "iq", "color": "#007A3D", "elo": 1580},
    # Group J
    "Argentina":          {"code": "ar", "color": "#75AADB", "elo": 2070},
    "Austria":            {"code": "at", "color": "#ED2939", "elo": 1780},
    "Algeria":            {"code": "dz", "color": "#006233", "elo": 1700},
    "Jordan":             {"code": "jo", "color": "#007A3D", "elo": 1560},
    # Group K
    "Colombia":           {"code": "co", "color": "#FCD116", "elo": 1880},
    "Portugal":           {"code": "pt", "color": "#1B5E20", "elo": 2010},
    "Uzbekistan":         {"code": "uz", "color": "#1EB53A", "elo": 1620},
    "Congo DR":           {"code": "cd", "color": "#007FFF", "elo": 1620},
    # Group L
    "England":            {"code": "gb-eng", "color": "#CF142B", "elo": 2000},
    "Croatia":            {"code": "hr", "color": "#C8102E", "elo": 1880},
    "Panama":             {"code": "pa", "color": "#005293", "elo": 1620},
    "Ghana":              {"code": "gh", "color": "#CE1126", "elo": 1680},
}

# ESPN sometimes uses diacritics or alternate spellings; normalize them
# to the canonical keys above.
ALIASES = {
    "Turkiye": "Turkiye",
    "Turkey": "Turkiye",
    "Curacao": "Curacao",
    "Curaçao": "Curacao",
    "Türkiye": "Turkiye",
    "IR Iran": "Iran",
    "Korea Republic": "South Korea",
    "Republic of Korea": "South Korea",
    "Cote d'Ivoire": "Ivory Coast",
    "Côte d'Ivoire": "Ivory Coast",
    "Bosnia and Herzegovina": "Bosnia-Herzegovina",
    "USA": "United States",
    "DR Congo": "Congo DR",
}


def canonical(name):
    """Map a raw ESPN displayName to our canonical team key."""
    if name in TEAMS:
        return name
    if name in ALIASES:
        return ALIASES[name]
    # strip diacritics as a last resort
    import unicodedata
    stripped = "".join(
        c for c in unicodedata.normalize("NFKD", name)
        if not unicodedata.combining(c)
    )
    if stripped in TEAMS:
        return stripped
    if stripped in ALIASES:
        return ALIASES[stripped]
    return name


def meta(name):
    """Return the metadata record for a team (by raw or canonical name)."""
    return TEAMS.get(canonical(name))
