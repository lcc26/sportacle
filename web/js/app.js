// Sportacle: render the Projected Round of 32 board from predictions.json.
// Data is intentionally decoupled from the view: the prediction engine only has
// to rewrite data/predictions.json and the board reflects it on next load.

var SITE_URL = 'https://gosportacle.com';

function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

// Broadcast nation-name normalization. The engine writes whatever it likes into
// data/predictions.json; we map a handful of names to the form an English-language
// broadcaster would say on air. Display only: the data and flag codes are untouched.
var DISPLAY_NAMES = {
  'Congo DR': 'DR Congo',
  'Bosnia-Herzegovina': 'Bosnia and Herzegovina',
  'Bosnia Herzegovina': 'Bosnia and Herzegovina',
  'Turkiye': 'Türkiye'
};
function displayName(name){
  var n = name == null ? '' : String(name);
  return Object.prototype.hasOwnProperty.call(DISPLAY_NAMES, n) ? DISPLAY_NAMES[n] : n;
}

// Confidence wording keyed to the top-pick probability, so a near-lock and an
// 11 percent toss-up never wear the same label. This pairs with the green-to-red
// glow: words carry the honesty, color carries the feel. Tuned to the calibrated
// model range; this early in the tournament almost nothing is truly locked in.
//   >= 55  near-certain, this opponent is close to locked in
//   >= 40  a clear favorite to be the opponent
//   >= 25  the most likely opponent, but far from settled
//   <  25  a wide-open slot, anyone's to take
function confidence(prob){
  if (prob == null) return null;
  if (prob >= 55) return { tag: 'LOCKED IN', lbl: 'Close to locked in' };
  if (prob >= 40) return { tag: 'LIKELY', lbl: 'Clear favorite' };
  if (prob >= 25) return { tag: 'LEANING', lbl: 'Most likely, not settled' };
  return { tag: 'WIDE OPEN', lbl: 'Wide open slot' };
}

// Validate the small set of formats that come from the prediction engine so a
// future hostile/garbled value cannot inject CSS into the inline style attr.
function safeColor(c){ return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#5A6473'; }
function safeCode(c){ return /^[a-z]{2,3}(-[a-z]{2,4})?$/.test(c) ? c : ''; } // allow federation codes (gb-eng, gb-sct, gb-wls)

// Coerce a probability to a finite 0..100 number; bad/missing -> null.
function pct(v){ var n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null; }

// Build a URL-safe slug for the per-card anchor (deep links).
function slug(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

// Probability-coded glow. The 16 live probs span 11..63, so the scale is
// anchored to the meaningful confidence band (12 floor, 60 ceiling) rather than
// a theoretical 0..100, which would crush every real card into red/amber.
// t = 0 deep red, t = 0.5 warm amber, t = 1 grounded pitch green. We walk the
// hue wheel the short way (2 to 40 to 142) to keep a natural stoplight feel and
// dip saturation toward green so it reads premium, not neon.
function glow(prob){
  if (prob == null) return null;
  var t = (prob - 12) / (60 - 12);
  t = Math.max(0, Math.min(1, t));
  var H, S, L, u;
  if (t < 0.5){ u = t / 0.5; H = 2 + (40 - 2) * u; S = 72 + (88 - 72) * u; L = 47 + (52 - 47) * u; }
  else { u = (t - 0.5) / 0.5; H = 40 + (142 - 40) * u; S = 88 + (60 - 88) * u; L = 52 + (42 - 52) * u; }
  H = Math.round(H); S = Math.round(S); L = Math.round(L);
  return {
    t: t,
    full: 'hsl(' + H + ' ' + S + '% ' + L + '%)',
    a: 'hsla(' + H + ', ' + S + '%, ' + L + '%, .55)',
    b: 'hsla(' + H + ', ' + S + '%, ' + L + '%, .28)'
  };
}

function matchCard(m, i){
  var a = m && m.team, b = m && m.opponent;
  if (!a || !b) return ''; // skip a malformed row rather than wiping the board

  var aName = displayName(a.name);
  var bName = displayName(b.name);
  var ca = safeColor(a.color), cb = safeColor(b.color);
  var aCode = safeCode(a.code), bCode = safeCode(b.code);
  var aNote = a.note == null ? '' : String(a.note);

  var p = pct(b.prob);
  var pctText = p == null ? '' : p + '%';
  var barW = p == null ? 0 : p;

  var altList = (m.alternates || []).map(function(x){
    var xp = pct(x && x.prob);
    return esc(x ? displayName(x.name) : '') + (xp == null ? '' : ' ' + xp + '%');
  }).filter(function(t){ return t.trim(); });
  // Honest remainder: opponent + alternates + field sum to 100.
  var fieldPct = pct(m.field);
  if (fieldPct != null && fieldPct > 0) altList.push('field ' + fieldPct + '%');
  var alts = altList.join(' &middot; ');

  var anchor = 'm-' + (slug(aName) || ('row-' + i));

  // Share copy. Brand rule: NO em/en dashes. Use a colon and parentheses.
  var pctPhrase = p == null ? '' : ' (' + p + '%)';
  var shareText = aName + "'s most likely Round of 32 opponent: " + bName + pctPhrase + '. Per-team projection by @TheSportacle';
  // Per-pairing share URL is a REAL page (web/r32/<slug>/) that serves this
  // pairing's own og:image + meta, so the social preview is pairing-specific.
  // Scrapers ignore #fragments, so the old /#m-<slug> always unfurled the default.
  var shareUrl = SITE_URL + '/r32/' + (slug(aName) || ('row-' + i)) + '/';
  var xHref = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(shareText) + '&url=' + encodeURIComponent(shareUrl);

  var aImg = aCode ? '<img class="flag" src="flags/' + aCode + '.png" alt="" loading="lazy" width="84" height="56">' : '<span class="flag flag-blank" aria-hidden="true"></span>';
  var bImg = bCode ? '<img class="flag" src="flags/' + bCode + '.png" alt="" loading="lazy" width="84" height="56">' : '<span class="flag flag-blank" aria-hidden="true"></span>';

  var aria = bName ? (aName + "'s most likely last-32 opponent: " + bName + (p == null ? '' : ', ' + p + ' percent')) : ('forecast for ' + aName);

  // Confidence wording keyed to the probability (honest framing).
  var conf = confidence(p);

  // Probability-coded glow: color the card border/halo by confidence. When prob
  // is null we emit no glow props so the card falls back to the neutral --line.
  var g = glow(p);
  var glowStyle = g ? (';--glow:' + g.full + ';--glowA:' + g.a + ';--glowB:' + g.b + ';--glowT:' + g.t.toFixed(3)) : '';
  // The most confident picks (t >= 0.7, roughly prob >= 46) get a gentle breathe.
  var confident = g && g.t >= 0.7 ? ' is-confident' : '';

  return '<article class="match' + confident + '" id="' + esc(anchor) + '" style="--ca:' + ca + ';--cb:' + cb + glowStyle + ';--i:' + i + '">'
    + '<div class="sides">'
      + '<div class="side">'
        + aImg
        + '<span class="seed">' + (aNote ? esc(aNote) : 'Projected') + '</span>'
        + '<span class="team">' + esc(aName) + '</span>'
      + '</div>'
      + '<span class="vs" aria-hidden="true">VS</span>'
      + '<div class="side">'
        + bImg
        + '<span class="seed">Projected last-32 opponent</span>'
        + '<span class="team">' + esc(bName) + '</span>'
      + '</div>'
    + '</div>'
    + '<div class="prob">'
      + '<div class="prob-row"><span class="lbl">Most likely opponent</span><span class="pct">' + esc(pctText) + '</span></div>'
      + '<div class="bar"><i style="width:' + barW + '%"></i></div>'
      + (conf ? '<div class="conf conf-' + conf.tag.toLowerCase().replace(/[^a-z]+/g, '-') + '"><span class="conf-tag">' + esc(conf.tag) + '</span><span class="conf-lbl">' + esc(conf.lbl) + '</span></div>' : '')
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
    // The X "Share" button is a plain anchor to the X web composer (target=_blank,
    // rel=noopener), so a click always opens the X intent on desktop and mobile.
    // Deliberate for an X-first brand: the desktop OS share sheet often has no X
    // target. We never intercept it; only the Copy button needs wiring.
    if (e.target.closest('.share-x')) return;

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

var lastIso = '', lastLabel = '', shareWired = false, firstPaint = true;

// One-shot enter polish (stagger + count-up), only on the very first paint.
// load() reruns every 60s, so this is gated exactly like shareWired.
function reducedMotion(){
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function countUp(board){
  if (reducedMotion()) return; // final values are already correct in the DOM
  var nodes = board.querySelectorAll('.pct');
  nodes.forEach(function(el){
    var m = /(\d+)/.exec(el.textContent || '');
    if (!m) return;
    var target = parseInt(m[1], 10);
    if (!(target > 0)) return;
    var dur = 700, start = null;
    var step = function(ts){
      if (start == null) start = ts;
      var k = Math.min(1, (ts - start) / dur);
      var eased = 1 - Math.pow(1 - k, 3); // easeOutCubic
      el.textContent = Math.round(eased * target) + '%';
      if (k < 1) requestAnimationFrame(step);
      else el.textContent = target + '%';
    };
    el.textContent = '0%';
    requestAnimationFrame(step);
  });
}

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
      var html = (data.matchups || []).map(matchCard).join('');
      if (firstPaint && html) board.classList.add('enter');
      board.innerHTML = html || '<p class="loading">No forecasts yet.</p>';
      if (!shareWired) { wireShare(board); shareWired = true; }
      if (firstPaint && html){
        countUp(board);
        firstPaint = false;
      }
    })
    .catch(function(err){
      var b = document.getElementById('board');
      if (b && !b.querySelector('.match')) b.innerHTML = '<p class="loading">Could not load forecasts (' + esc(err.message) + ').</p>';
    });
}

load();
setInterval(load, 60000);   // re-pull projections every minute so the board reflects matches as they end
setInterval(stamp, 30000);  // keep the "updated X ago" label ticking between pulls
