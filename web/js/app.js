// Sportacle: render the Projected Round of 32 board from predictions.json.
// Data is intentionally decoupled from the view: the prediction engine only has
// to rewrite data/predictions.json and the board reflects it on next load.

var SITE_URL = 'https://gosportacle.com';

function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

// Validate the small set of formats that come from the prediction engine so a
// future hostile/garbled value cannot inject CSS into the inline style attr.
function safeColor(c){ return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#5A6473'; }
function safeCode(c){ return /^[a-z]{2,3}$/.test(c) ? c : ''; }

// Coerce a probability to a finite 0..100 number; bad/missing -> null.
function pct(v){ var n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null; }

// Build a URL-safe slug for the per-card anchor (deep links).
function slug(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

function matchCard(m, i){
  var a = m && m.team, b = m && m.opponent;
  if (!a || !b) return ''; // skip a malformed row rather than wiping the board

  var aName = a.name == null ? '' : String(a.name);
  var bName = b.name == null ? '' : String(b.name);
  var ca = safeColor(a.color), cb = safeColor(b.color);
  var aCode = safeCode(a.code), bCode = safeCode(b.code);
  var aNote = a.note == null ? '' : String(a.note);

  var p = pct(b.prob);
  var pctText = p == null ? '' : p + '%';
  var barW = p == null ? 0 : p;

  var alts = (m.alternates || []).map(function(x){
    var xp = pct(x && x.prob);
    return esc(x && x.name != null ? String(x.name) : '') + (xp == null ? '' : ' ' + xp + '%');
  }).filter(function(t){ return t.trim(); }).join(' &middot; ');

  var anchor = 'm-' + (slug(aName) || ('row-' + i));

  // Share copy. Brand rule: NO em/en dashes. Use a colon and parentheses.
  var pctPhrase = p == null ? '' : ' (' + p + '%)';
  var shareText = aName + "'s most likely Round of 32 opponent: " + bName + pctPhrase + '. Projected by @TheSportacle';
  var shareUrl = SITE_URL + '/#' + anchor;
  var xHref = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(shareText) + '&url=' + encodeURIComponent(shareUrl);

  var aImg = aCode ? '<img class="flag" src="flags/' + aCode + '.png" alt="" loading="lazy" width="84" height="56">' : '<span class="flag flag-blank" aria-hidden="true"></span>';
  var bImg = bCode ? '<img class="flag" src="flags/' + bCode + '.png" alt="" loading="lazy" width="84" height="56">' : '<span class="flag flag-blank" aria-hidden="true"></span>';

  var aria = bName ? (aName + ' meets ' + bName + (p == null ? '' : ' at ' + p + ' percent')) : ('forecast for ' + aName);

  return '<article class="match" id="' + esc(anchor) + '" style="--ca:' + ca + ';--cb:' + cb + '">'
    + '<div class="sides">'
      + '<div class="side">'
        + aImg
        + '<span class="seed">' + (aNote ? esc(aNote) : 'Projected') + '</span>'
        + '<span class="team">' + esc(aName) + '</span>'
      + '</div>'
      + '<span class="vs" aria-hidden="true">VS</span>'
      + '<div class="side">'
        + bImg
        + '<span class="seed">Projected R32</span>'
        + '<span class="team">' + esc(bName) + '</span>'
      + '</div>'
    + '</div>'
    + '<div class="prob">'
      + '<div class="prob-row"><span class="lbl">Most likely matchup</span><span class="pct">' + esc(pctText) + '</span></div>'
      + '<div class="bar"><i style="width:' + barW + '%"></i></div>'
      + (alts ? '<div class="alts">then ' + alts + '</div>' : '')
      + '<div class="share" role="group" aria-label="Share ' + esc(aria) + '">'
        + '<a class="share-btn share-x" href="' + esc(xHref) + '" target="_blank" rel="noopener" '
          + 'data-text="' + esc(shareText) + '" data-url="' + esc(shareUrl) + '" '
          + 'aria-label="Share ' + esc(aria) + ' on X">'
          + '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z"/></svg>'
          + '<span>Share</span>'
        + '</a>'
        + '<button type="button" class="share-btn share-copy" '
          + 'data-text="' + esc(shareText) + '" data-url="' + esc(shareUrl) + '" '
          + 'aria-label="Copy link to ' + esc(aria) + '">'
          + '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M9 9h10v10H9z M5 15H4V4h11v1"/></svg>'
          + '<span class="copy-label">Copy</span>'
        + '</button>'
      + '</div>'
    + '</div>'
  + '</article>';
}

function wireShare(board){
  board.addEventListener('click', function(e){
    var x = e.target.closest('.share-x');
    if (x && navigator.share){
      // Prefer the native sheet on devices that support it; fall back to the
      // X intent (the link's own href) when share() is unavailable or rejected.
      e.preventDefault();
      navigator.share({ text: x.getAttribute('data-text'), url: x.getAttribute('data-url') })
        .catch(function(){ window.open(x.href, '_blank', 'noopener'); });
      return;
    }

    var copy = e.target.closest('.share-copy');
    if (copy){
      var url = copy.getAttribute('data-url');
      var label = copy.querySelector('.copy-label');
      var done = function(ok){
        if (!label) return;
        var prev = label.textContent;
        label.textContent = ok ? 'Copied' : 'Copy failed';
        copy.classList.toggle('is-copied', ok);
        setTimeout(function(){ label.textContent = 'Copy'; copy.classList.remove('is-copied'); }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(url).then(function(){ done(true); }, function(){ done(false); });
      } else {
        try {
          var ta = document.createElement('textarea');
          ta.value = url; ta.setAttribute('readonly', '');
          ta.style.position = 'absolute'; ta.style.left = '-9999px';
          document.body.appendChild(ta); ta.select();
          done(document.execCommand('copy'));
          document.body.removeChild(ta);
        } catch (err) { done(false); }
      }
    }
  });
}

// Relative "updated X ago", driven by the engine's updated_iso (the end time of
// the most recent finished match). Falls back to a plain label if no iso is set.
function relTime(iso){
  if (!iso) return '';
  var t = Date.parse(iso);
  if (isNaN(t)) return '';
  var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  var m = Math.floor(s / 60);
  if (m < 60) return m + (m === 1 ? ' minute' : ' minutes') + ' ago';
  var h = Math.floor(m / 60);
  if (h < 24) return h + (h === 1 ? ' hour' : ' hours') + ' ago';
  var d = Math.floor(h / 24);
  return d + (d === 1 ? ' day' : ' days') + ' ago';
}

var lastIso = '', lastLabel = '', shareWired = false;

function whenText(){ return relTime(lastIso) || lastLabel || ''; }

function stamp(){
  var w = whenText();
  var u = document.getElementById('updated');
  var fu = document.getElementById('footupdated');
  if (u) u.textContent = w ? 'Updated ' + w : '';
  if (fu) fu.textContent = w ? 'updated ' + w : '';
}

function load(){
  fetch('data/predictions.json', { cache: 'no-cache' })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data){
      lastIso = data.updated_iso || '';
      lastLabel = data.updated_label || '';
      stamp();
      var note = document.getElementById('datanote');
      if (note) note.textContent = data.model || '';
      var board = document.getElementById('board');
      board.innerHTML = (data.matchups || []).map(matchCard).join('') || '<p class="loading">No forecasts yet.</p>';
      if (!shareWired) { wireShare(board); shareWired = true; }
    })
    .catch(function(err){
      var b = document.getElementById('board');
      if (b && !b.querySelector('.match')) b.innerHTML = '<p class="loading">Could not load forecasts (' + esc(err.message) + ').</p>';
    });
}

load();
setInterval(load, 60000);   // re-pull projections every minute so the board reflects matches as they end
setInterval(stamp, 30000);  // keep the "updated X ago" label ticking between pulls
