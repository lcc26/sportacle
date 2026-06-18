// Native canvas renderer for the Sportacle studio.
//
// No html-to-image, no SVG foreignObject. Each card is drawn directly onto a
// <canvas> (drawImage for flags, fillText for text, paths for shapes). This is
// bulletproof: same-origin flags never taint the canvas, there is no foreignObject
// rasterization (so no clip-path/box-shadow/blend ghosting), and nothing is fetched
// at capture time. The SAME canvas is the preview AND the download, so what you see
// is exactly what you get. The /make/ HTML templates stay for make.py + the URL trick.
(function () {
  'use strict';
  var W = 1080;
  var KH = 'Khand', BR = 'Barlow Semi Condensed', INK = '#11161F';

  // ---- assets ----
  var flagCache = {};
  function loadFlag(code) {
    if (!code) return Promise.resolve(null);
    if (flagCache[code]) return flagCache[code];
    var p = new Promise(function (res) {
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { res(null); };
      img.src = '/flags/' + code + '.png';
    });
    flagCache[code] = p;
    return p;
  }
  var fontsReady = null;
  function ensureFonts() {
    if (fontsReady) return fontsReady;
    var need = [
      '500 100px "Khand"', '600 100px "Khand"', '700 100px "Khand"',
      '600 30px "Barlow Semi Condensed"', '700 30px "Barlow Semi Condensed"', '800 30px "Barlow Semi Condensed"'
    ];
    fontsReady = Promise.all(need.map(function (f) {
      try { return document.fonts.load(f); } catch (e) { return Promise.resolve(); }
    })).then(function () { return document.fonts.ready; }).catch(function () {});
    return fontsReady;
  }

  // ---- helpers ----
  function font(w, s, fam) { return w + ' ' + s + 'px "' + fam + '"'; }
  function rrect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function poly(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (var i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.closePath();
  }
  function cover(ctx, img, x, y, w, h, px, py) {
    if (!img || !img.naturalWidth) return;
    var ir = img.naturalWidth / img.naturalHeight, br = w / h, sw, sh;
    if (ir > br) { sh = h; sw = h * ir; } else { sw = w; sh = w / ir; }
    ctx.drawImage(img, x + (w - sw) * px, y + (h - sh) * py, sw, sh);
  }
  function ls(ctx, v) { try { ctx.letterSpacing = (v || 0) + 'px'; } catch (e) {} }
  // a rounded "pill" with horizontally-centered, letter-spaced text
  function pill(ctx, cx, cy, text, o) {
    ctx.font = o.font; ls(ctx, o.lsp);
    var tw = ctx.measureText(text).width;
    var w = tw + o.padX * 2, h = o.h, x = cx - w / 2, y = cy - h / 2;
    ctx.save();
    if (o.shadow) { ctx.shadowColor = o.shadow.c; ctx.shadowBlur = o.shadow.b; ctx.shadowOffsetY = o.shadow.oy || 0; }
    ctx.fillStyle = o.bg; rrect(ctx, x, y, w, h, h / 2); ctx.fill();
    ctx.restore();
    ctx.fillStyle = o.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, cx + (o.lsp || 0) / 2, cy + (o.dy || 1));
    ls(ctx, 0);
    return w;
  }
  // size + (optional) wrap a team name exactly like the templates' applyName()
  function nameLayout(name) {
    var words = name.split(' '), ch = name.length, longest = 0;
    for (var i = 0; i < words.length; i++) if (words[i].length > longest) longest = words[i].length;
    var size = 104;
    if (ch > 9 && words.length > 1) size = 88;
    if (longest > 9 || ch > 16) size = 66;
    var lines = (words.length > 1 && ch > 9) ? words : [name];
    return { size: size, lines: lines };
  }
  function drawName(ctx, name, x, align) {
    var L = nameLayout(name);
    ctx.font = font('700', L.size, KH);
    ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 3;
    var topY = 150, base = topY + L.size * 0.78, adv = L.size * 0.82;
    for (var i = 0; i < L.lines.length; i++) ctx.fillText(L.lines[i].toUpperCase(), x, base + i * adv);
    ctx.restore();
  }

  // ---- shared VS background (halves + flags + scrims + seam + names) ----
  function drawVsBg(ctx, p, F) {
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, W);
    // LEFT half (clip to diagonal), team-color fill + flag cover (object-position 100% 50%)
    ctx.save(); poly(ctx, [0, 0, 614, 0, 466, W, 0, W]); ctx.clip();
    ctx.fillStyle = p.acolor; ctx.fillRect(0, 0, W, W);
    cover(ctx, F.a, 0, 0, W, W, 1, 0.5);
    ctx.restore();
    // RIGHT half (object-position 0% 50%)
    ctx.save(); poly(ctx, [614, 0, W, 0, W, W, 466, W]); ctx.clip();
    ctx.fillStyle = p.bcolor; ctx.fillRect(0, 0, W, W);
    cover(ctx, F.b, 0, 0, W, W, 0, 0.5);
    ctx.restore();
    // scrims (full width, above both flags)
    var gt = ctx.createLinearGradient(0, 0, 0, 330);
    gt.addColorStop(0, 'rgba(0,0,0,.66)'); gt.addColorStop(.58, 'rgba(0,0,0,.26)'); gt.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gt; ctx.fillRect(0, 0, W, 330);
    var gb = ctx.createLinearGradient(0, W, 0, W - 300);
    gb.addColorStop(0, 'rgba(0,0,0,.64)'); gb.addColorStop(.52, 'rgba(0,0,0,.26)'); gb.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gb; ctx.fillRect(0, W - 300, W, 300);
    // seam-edge (team gradient) then white seam blade
    var seg = ctx.createLinearGradient(0, 0, 0, W); seg.addColorStop(0, p.acolor); seg.addColorStop(1, p.bcolor);
    ctx.save(); ctx.globalAlpha = .9; ctx.fillStyle = seg; poly(ctx, [601, 0, 627, 0, 479, W, 453, W]); ctx.fill(); ctx.restore();
    ctx.fillStyle = '#fff'; poly(ctx, [607, 0, 621, 0, 473, W, 459, W]); ctx.fill();
    // names
    drawName(ctx, p.an, 72, 'left');
    drawName(ctx, p.bn, W - 72, 'right');
  }
  // ---- FINAL / HALF ----
  function renderFinal(ctx, p, F) {
    drawVsBg(ctx, p, F);
    // FULL/HALF TIME pill
    pill(ctx, 540, 80, (p.label || 'Full Time').toUpperCase(), {
      font: font('800', 30, BR), lsp: 9, padX: 30, h: 52, bg: p.lc || '#fff', color: INK,
      shadow: { c: 'rgba(0,0,0,.3)', b: 30, oy: 12 }
    });
    drawScore(ctx, p);
    if (p.note) pill(ctx, 540, W - 188, p.note.toUpperCase(), {
      font: font('800', 26, BR), lsp: 6, padX: 28, h: 46, bg: 'rgba(255,255,255,.94)', color: INK,
      shadow: { c: 'rgba(0,0,0,.22)', b: 30, oy: 12 }
    });
    drawBrand(ctx, p.acolor);
  }
  // ---- WHO WILL WIN (upcoming match, engagement) ----
  function renderWhoWins(ctx, p, F) {
    drawVsBg(ctx, p, F);
    pill(ctx, 540, 80, 'WHO WILL WIN?', {
      font: font('800', 30, BR), lsp: 7, padX: 30, h: 52, bg: '#FFC400', color: INK,
      shadow: { c: 'rgba(0,0,0,.3)', b: 30, oy: 12 }
    });
    drawMedallion(ctx, 540, 560);
    pill(ctx, 540, W - 188, (p.prompt || 'Reply with your prediction').toUpperCase(), {
      font: font('800', 24, BR), lsp: 4, padX: 28, h: 46, bg: 'rgba(255,255,255,.94)', color: INK,
      shadow: { c: 'rgba(0,0,0,.22)', b: 30, oy: 12 }
    });
    drawBrand(ctx, p.acolor);
  }
  function drawMedallion(ctx, cx, cy) {
    var r = 92;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 16;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    ctx.lineWidth = 5; ctx.strokeStyle = INK; ctx.beginPath(); ctx.arc(cx, cy, r - 2.5, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = INK; ctx.font = font('700', 86, KH); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('VS', cx, cy + 4);
  }
  function drawScore(ctx, p) {
    var cx = 540, cy = 560;
    var d1 = String(p.hg), d2 = String(p.ag);
    ctx.font = font('700', 200, KH);
    var w1 = Math.max(96, ctx.measureText(d1).width), w2 = Math.max(96, ctx.measureText(d2).width);
    ctx.font = font('600', 120, KH);
    var dashW = ctx.measureText('-').width;
    var gap = 30, padX = 52, padT = 18, padB = 24;
    var content = w1 + gap + dashW + gap + w2;
    var pw = content + padX * 2, ph = 148 + padT + padB;
    var x = cx - pw / 2, y = cy - ph / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.30)'; ctx.shadowBlur = 36; ctx.shadowOffsetY = 14;
    ctx.fillStyle = '#fff'; rrect(ctx, x, y, pw, ph, 40); ctx.fill();
    ctx.restore();
    ctx.lineWidth = 5; ctx.strokeStyle = INK; rrect(ctx, x + 2.5, y + 2.5, pw - 5, ph - 5, 38); ctx.stroke();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    var midY = cy + 6, cur = x + padX;
    ctx.font = font('700', 200, KH); ctx.fillStyle = p.acolor; ctx.fillText(d1, cur + w1 / 2, midY);
    cur += w1 + gap;
    ctx.font = font('600', 120, KH); ctx.fillStyle = 'rgba(17,22,31,.32)'; ctx.fillText('-', cur + dashW / 2, midY - 6);
    cur += dashW + gap;
    ctx.font = font('700', 200, KH); ctx.fillStyle = p.bcolor; ctx.fillText(d2, cur + w2 / 2, midY);
  }
  function drawBrand(ctx, accent) {
    // wordmark pill: "SPORT" ink + "ACLE" accent, Khand 700 46 ls3
    ctx.font = font('700', 46, KH); ls(ctx, 3);
    var t1 = 'SPORT', t2 = 'ACLE';
    var w1 = ctx.measureText(t1).width, w2 = ctx.measureText(t2).width;
    var tw = w1 + w2, padX = 26, pw = tw + padX * 2, h = 70, cx = 540, cy = W - 48 - 30;
    var x = cx - pw / 2, y = cy - h / 2;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.22)'; ctx.shadowBlur = 28; ctx.shadowOffsetY = 10;
    ctx.fillStyle = 'rgba(255,255,255,.94)'; rrect(ctx, x, y, pw, h, h / 2); ctx.fill(); ctx.restore();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = INK; ctx.fillText(t1, x + padX, cy + 1);
    ctx.fillStyle = accent; ctx.fillText(t2, x + padX + w1, cy + 1);
    ls(ctx, 0);
    // handle pill below
    pill(ctx, 540, W - 48 + 18, '@THESPORTACLE · GOSPORTACLE.COM', {
      font: font('700', 20, BR), lsp: 3, padX: 16, h: 36, bg: 'rgba(255,255,255,.88)', color: INK
    });
  }

  // ---- GOAL ----
  function renderGoal(ctx, p, flag, lA, lB) {
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = p.tc; ctx.fillRect(0, 0, W, W);
    cover(ctx, flag, 0, 0, W, W, 0.5, 0.5);
    // tint (team color, alpha .5)
    ctx.save(); ctx.globalAlpha = .5; ctx.fillStyle = p.tc; ctx.fillRect(0, 0, W, W); ctx.restore();
    // vignette
    var vg = ctx.createRadialGradient(W * 0.5, W * 0.28, 0, W * 0.5, W * 0.28, W * 0.72);
    vg.addColorStop(.38, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.55)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, W);
    // shade (top + heavy bottom)
    var sh = ctx.createLinearGradient(0, 0, 0, W);
    sh.addColorStop(0, 'rgba(0,0,0,.5)'); sh.addColorStop(.26, 'rgba(0,0,0,0)');
    sh.addColorStop(.52, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,.82)');
    ctx.fillStyle = sh; ctx.fillRect(0, 0, W, W);
    // blade (corner FIFA accent)
    ctx.save(); poly(ctx, [0, 0, 360, 0, 0, 360]); ctx.clip();
    ctx.strokeStyle = '#FFC400'; ctx.lineWidth = 14; ctx.beginPath(); ctx.moveTo(0, 20); ctx.lineTo(20, 0); // approx
    ctx.restore();
    // simpler blade: two diagonal bars near the corner
    ctx.save(); poly(ctx, [0, 0, 360, 0, 0, 360]); ctx.clip();
    ctx.strokeStyle = '#FFC400'; ctx.lineWidth = 14; ctx.beginPath(); ctx.moveTo(-40, 60); ctx.lineTo(60, -40); ctx.stroke();
    ctx.strokeStyle = '#ED2939'; ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(-40, 110); ctx.lineTo(110, -40); ctx.stroke();
    ctx.restore();
    // tag
    ctx.font = font('800', 26, BR); ls(ctx, 6); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 10; ctx.fillStyle = '#fff';
    ctx.fillText((p.tag || 'Sportacle').toUpperCase(), 64, 86); ctx.restore(); ls(ctx, 0);
    // hero block, anchored to bottom 212
    var heroBottom = W - 212;
    // team name (small, above GOAL)
    ctx.font = font('800', 46, BR); ls(ctx, 8); ctx.fillStyle = '#fff';
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 3;
    ctx.fillText(p.team.toUpperCase(), 64, heroBottom - 300); ctx.restore(); ls(ctx, 0);
    // GOAL!  (Khand 700 340, "!" amber)
    ctx.font = font('700', 340, KH); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 10;
    var gy = heroBottom - 40;
    ctx.fillStyle = '#fff'; ctx.fillText('GOAL', 60, gy);
    var gw = ctx.measureText('GOAL').width;
    ctx.fillStyle = '#FFC400'; ctx.fillText('!', 60 + gw + 6, gy);
    ctx.restore();
    // scorer + minute
    if (p.scorer) {
      ctx.font = font('600', 64, KH); ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillStyle = '#fff';
      var sy = heroBottom + 40;
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 14;
      ctx.fillText(p.scorer.toUpperCase(), 64, sy); ctx.restore();
      var sw = ctx.measureText(p.scorer.toUpperCase()).width;
      if (p.min) {
        var m = /'$/.test(p.min) ? p.min : (p.min + "'");
        ctx.font = font('800', 34, BR);
        var mw = ctx.measureText(m).width, mpadX = 16, pwm = mw + mpadX * 2, hm = 50;
        var mx = 64 + sw + 22, my = sy - hm / 2;
        ctx.fillStyle = '#FFC400'; rrect(ctx, mx, my, pwm, hm, 10); ctx.fill();
        ctx.fillStyle = INK; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(m, mx + mpadX, sy + 1);
      }
    }
    // scoreline pill (mini flags + score), only if score + opponent
    if (p.score && lB) {
      var parts = String(p.score).replace(/\s/g, '').split('-');
      var sc = parts.length === 2 ? (parts[0] + ' - ' + parts[1]) : String(p.score);
      ctx.font = font('700', 62, KH);
      var scw = ctx.measureText(sc).width;
      var fw = 58, fh = 39, gap = 18, padX = 26, h = 64;
      var pw = padX * 2 + fw + gap + scw + gap + fw;
      var leftF = (p.home === '0') ? lB : lA, rightF = (p.home === '0') ? lA : lB;
      var cx = 540, y = (W - 140) - h / 2, x = cx - pw / 2;
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 34; ctx.shadowOffsetY = 14;
      ctx.fillStyle = 'rgba(255,255,255,.95)'; rrect(ctx, x, y, pw, h, h / 2); ctx.fill(); ctx.restore();
      var fy = y + (h - fh) / 2, cur = x + padX;
      drawMiniFlag(ctx, leftF, cur, fy, fw, fh); cur += fw + gap;
      ctx.fillStyle = INK; ctx.font = font('700', 62, KH); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(sc, cur + scw / 2, y + h / 2 + 1); cur += scw + gap;
      drawMiniFlag(ctx, rightF, cur, fy, fw, fh);
    }
    // brand footer
    ctx.font = font('700', 42, KH); ls(ctx, 3); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var t1 = 'SPORT', t2 = 'ACLE';
    var bw1 = ctx.measureText(t1).width, bw2 = ctx.measureText(t2).width, btw = bw1 + bw2;
    var bx = 540 - btw / 2, by = W - 46 - 16;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff'; ctx.fillText(t1, bx, by);
    ctx.fillStyle = '#FFC400'; ctx.fillText(t2, bx + bw1, by);
    ls(ctx, 0);
    ctx.font = font('700', 19, BR); ls(ctx, 3); ctx.fillStyle = 'rgba(255,255,255,.82)'; ctx.textAlign = 'left';
    ctx.fillText('GOSPORTACLE.COM', bx + btw + 16, by + 1); ls(ctx, 0);
  }
  function drawMiniFlag(ctx, img, x, y, w, h) {
    ctx.save(); rrect(ctx, x, y, w, h, 5); ctx.clip();
    if (img && img.naturalWidth) cover(ctx, img, x, y, w, h, 0.5, 0.5);
    else { ctx.fillStyle = '#999'; ctx.fillRect(x, y, w, h); }
    ctx.restore();
  }

  // ---- public entry ----
  function renderTo(canvas, type, p, scale) {
    scale = scale || 2;
    canvas.width = W * scale; canvas.height = W * scale;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    return ensureFonts().then(function () {
      if (type === 'goal') {
        return Promise.all([loadFlag(p.code), loadFlag(p.code), loadFlag(p.vs)]).then(function (f) {
          renderGoal(ctx, p, f[0], f[1], f[2]);
        });
      }
      return Promise.all([loadFlag(p.ac), loadFlag(p.bc)]).then(function (f) {
        var F = { a: f[0], b: f[1] };
        if (type === 'whowins') renderWhoWins(ctx, p, F); else renderFinal(ctx, p, F);
      });
    });
  }

  window.SportacleRender = { renderTo: renderTo };
})();
