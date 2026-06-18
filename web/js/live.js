// Sportacle live layer: a sticky countdown / live-game banner, today's scores,
// and live standings, pulled CLIENT-SIDE straight from ESPN's public API (CORS is
// open: access-control-allow-origin *). Predictions remain the primary surface and
// live in app.js; this module is supplementary and fails quietly so a flaky ESPN
// response can never break the board.
//
// Day rule: a match belongs to the day its KICKOFF falls on, in the VISITOR'S
// local timezone (so "today" is correct wherever the site is opened), not its end
// time. ESPN's scoreboard groups by UTC date, which throws a late kickoff onto the
// wrong day, so we fetch a wide window and bucket precisely by local kickoff here.
(function () {
  'use strict';

  var SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
  var STANDINGS = 'https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings?season=2026';
  var REFRESH_MS = 30000; // re-pull scores/standings/live state every 30s

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Broadcast nation-name normalization (same set app.js uses). Display only.
  var DISPLAY = {
    'Congo DR': 'DR Congo',
    'Bosnia-Herzegovina': 'Bosnia and Herzegovina',
    'Bosnia Herzegovina': 'Bosnia and Herzegovina',
    'Turkiye': 'Türkiye'
  };
  function nm(s) { s = s == null ? '' : String(s); return DISPLAY[s] || s; }

  // Day bucketing and clock times use the VISITOR'S LOCAL timezone, so the site
  // is correct wherever it is opened (in Central this is unchanged). The countdown
  // itself is an absolute duration off the kickoff instant, correct everywhere.
  var dayFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  function localDay(d) { return dayFmt.format(d); }
  var timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  function localTime(d) { return timeFmt.format(d); }

  // UTC YYYYMMDD for the ESPN dates= window (we filter precisely client-side after).
  function utcYmd(d) {
    var m = ('0' + (d.getUTCMonth() + 1)).slice(-2);
    var day = ('0' + d.getUTCDate()).slice(-2);
    return '' + d.getUTCFullYear() + m + day;
  }

  function getJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ---- parse scoreboard ---------------------------------------------------
  function parseEvents(json) {
    return ((json && json.events) || []).map(function (e) {
      var comp = (e.competitions || [])[0] || {};
      var t = ((comp.status || {}).type) || {};
      var cs = comp.competitors || [];
      function side(ha) { for (var i = 0; i < cs.length; i++) { if (cs[i].homeAway === ha) return cs[i]; } return {}; }
      function team(c) {
        var tm = c.team || {};
        var sc = c.score;
        var n = (sc != null && sc !== '') ? parseInt(sc, 10) : null;
        return { name: tm.displayName || '', logo: tm.logo || '', score: Number.isFinite(n) ? n : null };
      }
      var iso = e.date || comp.date;
      return {
        iso: iso,
        date: new Date(iso),
        state: t.state || 'pre',                 // pre | in | post
        completed: !!t.completed,
        detail: t.detail || '',                  // "FT", "67'", "HT" ...
        shortDetail: t.shortDetail || '',
        home: team(side('home')),
        away: team(side('away'))
      };
    }).filter(function (ev) { return ev.iso && !isNaN(ev.date.getTime()); });
  }

  function byDate(a, b) { return a.date - b.date; }

  // ---- countdown ----------------------------------------------------------
  var countTarget = null; // ms timestamp of the next kickoff, or null when live/none

  function fmtCountdown(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    function p(n) { return ('0' + n).slice(-2); }
    if (d > 0) return d + 'd ' + h + 'h ' + p(m) + 'm';
    return p(h) + ':' + p(m) + ':' + p(s);
  }

  function tickCountdown() {
    var el = document.getElementById('livebanner');
    if (!el || el.hidden) return;
    var span = el.querySelector('.lb-count');
    if (!span || countTarget == null) return;
    var remain = countTarget - Date.now();
    span.textContent = fmtCountdown(remain);
    if (remain <= 0) { countTarget = null; refresh(); } // flip to live / next on kickoff
  }

  // ---- banner -------------------------------------------------------------
  function renderBanner(events) {
    var el = document.getElementById('livebanner');
    if (!el) return;

    var live = events.filter(function (ev) { return ev.state === 'in'; }).sort(byDate);
    var upcoming = events.filter(function (ev) {
      return ev.state === 'pre' && ev.date.getTime() > Date.now() - 60000;
    }).sort(byDate);

    if (live.length) {
      countTarget = null;
      var g = live[0];
      var min = g.shortDetail || g.detail || 'Live';
      var more = live.length > 1 ? '<span class="lb-more">+' + (live.length - 1) + ' more live</span>' : '';
      el.className = 'livebanner is-live';
      el.hidden = false;
      el.innerHTML =
        '<span class="lb-dot" aria-hidden="true"></span>' +
        '<span class="lb-label">Live</span>' +
        '<span class="lb-main">' + esc(nm(g.home.name)) + ' ' + (g.home.score == null ? 0 : g.home.score) +
        '-' + (g.away.score == null ? 0 : g.away.score) + ' ' + esc(nm(g.away.name)) +
        ' &middot; ' + esc(min) + '</span>' + more;
      return;
    }

    if (upcoming.length) {
      var n = upcoming[0];
      countTarget = n.date.getTime();
      el.className = 'livebanner';
      el.hidden = false;
      el.innerHTML =
        '<span class="lb-label">Next match</span>' +
        '<span class="lb-main">' + esc(nm(n.home.name)) + ' v ' + esc(nm(n.away.name)) + '</span>' +
        '<span class="lb-count">' + fmtCountdown(countTarget - Date.now()) + '</span>';
      return;
    }

    countTarget = null;
    el.hidden = true;
    el.innerHTML = '';
  }

  // ---- today's scores -----------------------------------------------------
  function teamRow(team, cls, showScore) {
    var img = team.logo
      ? '<img src="' + esc(team.logo) + '" alt="" loading="lazy" width="27" height="18">'
      : '<span style="width:27px;height:18px;flex:none"></span>';
    // Hide the score before kickoff (ESPN reports "0" for pre-match), so an
    // upcoming game reads as a fixture, not a played 0-0.
    var sc = (showScore && team.score != null) ? team.score : '';
    return '<div class="score-team ' + cls + '">' + img +
      '<span class="nm">' + esc(nm(team.name)) + '</span>' +
      '<span class="sc">' + sc + '</span></div>';
  }

  function renderScores(events) {
    var el = document.getElementById('scoreslist');
    var note = document.getElementById('scoresnote');
    if (!el) return;

    var today = localDay(new Date());
    var todays = events.filter(function (ev) { return localDay(ev.date) === today; }).sort(byDate);

    if (!todays.length) {
      el.innerHTML = '<p class="loading">No matches kick off today.</p>';
      if (note) note.textContent = '';
      return;
    }

    var done = 0, liveN = 0;
    var html = todays.map(function (ev) {
      var live = ev.state === 'in';
      var pre = ev.state === 'pre';
      if (ev.completed) done++;
      if (live) liveN++;

      // winner styling only once a result exists
      var hc = '', ac = '';
      if (!pre && ev.home.score != null && ev.away.score != null) {
        if (ev.home.score > ev.away.score) ac = 'lose';
        else if (ev.away.score > ev.home.score) hc = 'lose';
      }

      var status;
      if (pre) status = '<span class="score-status">' + esc(localTime(ev.date)) + '</span>';
      else if (live) status = '<span class="score-status live"><span class="lb-dot" aria-hidden="true"></span>' + esc(ev.shortDetail || ev.detail || 'Live') + '</span>';
      else status = '<span class="score-status">' + esc(ev.detail || 'FT') + '</span>';

      return '<div class="score' + (live ? ' is-live' : '') + '">' +
        '<div class="score-teams">' + teamRow(ev.home, hc, !pre) + teamRow(ev.away, ac, !pre) + '</div>' +
        status + '</div>';
    }).join('');

    el.innerHTML = html;
    if (note) {
      var bits = [];
      if (liveN) bits.push(liveN + ' live');
      bits.push(done + ' of ' + todays.length + ' final');
      note.textContent = bits.join(' · ');
    }
  }

  // ---- standings ----------------------------------------------------------
  function statOf(entry, name) {
    var arr = entry.stats || [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].name === name) {
        var s = arr[i];
        return s.displayValue != null ? s.displayValue : (s.value != null ? s.value : '');
      }
    }
    return '';
  }
  function numStat(entry, name) { var v = parseFloat(statOf(entry, name)); return Number.isFinite(v) ? v : 0; }

  // Live games (state 'in') as provisional results to fold into the standings.
  function liveGamesFrom(events) {
    return (events || []).filter(function (ev) { return ev.state === 'in'; }).map(function (ev) {
      return { h: ev.home.name, a: ev.away.name, hs: ev.home.score, as: ev.away.score };
    });
  }
  function cn(s) { return String(s || '').toLowerCase().trim(); }
  function provisional(base, isHome, hs, as) {
    var my = isHome ? hs : as, opp = isHome ? as : hs;
    var p = { P: base.P + 1, W: base.W, D: base.D, L: base.L, GD: base.GD + (my - opp), Pts: base.Pts, GF: base.GF + my };
    if (my > opp) { p.W += 1; p.Pts += 3; } else if (my < opp) { p.L += 1; } else { p.D += 1; p.Pts += 1; }
    return p;
  }

  // Standings with in-progress games folded in PROVISIONALLY: a team currently
  // winning shows the +3 (or +1 for a draw), the group re-sorts live, and the live
  // group + its two teams are highlighted until the in-game result changes.
  function renderStandings(json, events) {
    var el = document.getElementById('standingsgrid');
    var note = document.getElementById('standingsnote');
    if (!el) return;
    var groups = ((json && json.children) || []).slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    if (!groups.length) { el.innerHTML = '<p class="loading">Standings unavailable right now.</p>'; return; }
    var live = liveGamesFrom(events || []);
    var liveGroups = 0;

    var html = groups.map(function (g) {
      var entries = (((g.standings || {}).entries) || []).slice();
      var groupLive = false;
      var rows = entries.map(function (en) {
        var t = en.team || {}, name = t.displayName || '';
        var base = { P: numStat(en, 'gamesPlayed'), W: numStat(en, 'wins'), D: numStat(en, 'ties'), L: numStat(en, 'losses'), GD: numStat(en, 'pointDifferential'), Pts: numStat(en, 'points'), GF: numStat(en, 'pointsFor') };
        var s = base, isLive = false;
        for (var k = 0; k < live.length; k++) {
          if (cn(live[k].h) === cn(name)) { s = provisional(base, true, live[k].hs, live[k].as); isLive = true; groupLive = true; break; }
          if (cn(live[k].a) === cn(name)) { s = provisional(base, false, live[k].hs, live[k].as); isLive = true; groupLive = true; break; }
        }
        return { t: t, name: name, s: s, live: isLive };
      });
      rows.sort(function (a, b) { return (b.s.Pts - a.s.Pts) || (b.s.GD - a.s.GD) || (b.s.GF - a.s.GF); });
      if (groupLive) liveGroups++;

      var trs = rows.map(function (r, i) {
        var t = r.t, logo = (t.logos && t.logos[0] && t.logos[0].href) || t.logo || '';
        var img = logo ? '<img src="' + esc(logo) + '" alt="" loading="lazy" width="22" height="15">' : '<span style="width:22px;height:15px;flex:none"></span>';
        var cls = ((i < 2 ? 'adv' : '') + (r.live ? ' live' : '')).trim();
        var gd = (r.s.GD > 0 ? '+' : '') + r.s.GD;
        return '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' +
          '<td class="tm"><div class="teamcell"><span class="pos">' + (i + 1) + '</span>' + img + '<span class="nm">' + esc(nm(r.name)) + '</span></div></td>' +
          '<td>' + r.s.P + '</td><td>' + r.s.W + '</td><td>' + r.s.D + '</td><td>' + r.s.L + '</td><td>' + gd + '</td><td class="pts">' + r.s.Pts + '</td></tr>';
      }).join('');
      var badge = groupLive ? '<span class="glive"><span class="lb-dot" aria-hidden="true"></span>Live</span>' : '';
      return '<div class="group' + (groupLive ? ' islive' : '') + '"><h3>' + esc(g.name || 'Group') + badge + '</h3>' +
        '<table><thead><tr><th class="tm">Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead><tbody>' + trs + '</tbody></table></div>';
    }).join('');

    el.innerHTML = html;
    if (note) note.textContent = (liveGroups ? liveGroups + ' live · ' : '') + groups.length + ' groups';
  }

  // ---- refresh loop -------------------------------------------------------
  function refresh() {
    var now = Date.now();
    var start = utcYmd(new Date(now - 36 * 3600 * 1000));
    var end = utcYmd(new Date(now + 60 * 3600 * 1000));

    var pScores = getJSON(SCOREBOARD + '?dates=' + start + '-' + end).then(function (json) { return parseEvents(json); });
    pScores.then(function (events) { renderBanner(events); renderScores(events); }).catch(function () {
      var el = document.getElementById('scoreslist');
      if (el && !el.querySelector('.score')) el.innerHTML = '<p class="loading">Scores are temporarily unavailable.</p>';
    });

    // Standings re-render with the live games folded in (provisional points).
    Promise.all([getJSON(STANDINGS), pScores.catch(function () { return []; })]).then(function (res) {
      renderStandings(res[0], res[1]);
    }).catch(function () {
      var el = document.getElementById('standingsgrid');
      if (el && !el.querySelector('.group')) el.innerHTML = '<p class="loading">Standings are temporarily unavailable.</p>';
    });
  }

  refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(tickCountdown, 1000);
})();
