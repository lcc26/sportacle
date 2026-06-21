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
  // Anton = a free Impact-alike for classic meme captions (weight 400 only).
  // Drawn with a RAW ctx.font string (the font() helper quotes the family + can't add a fallback chain).
  var antonReady = null;
  function ensureAnton() {
    if (antonReady) return antonReady;
    var ff = new FontFace('Anton', "url(https://fonts.gstatic.com/s/anton/v25/1Ptgg87LROyAm3Kz-C8.woff2) format('woff2')");
    antonReady = ff.load().then(function (f) { document.fonts.add(f); }).catch(function () { });
    return antonReady;
  }

  // ---- assets ----
  var flagCache = {};
  function loadFlag(code) {
    if (!code) return Promise.resolve(null);
    if (flagCache[code]) return flagCache[code];
    var p = new Promise(function (res) {
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { try { console.warn('[render] flag failed to load: ' + code); } catch (e) {} res(null); };
      img.src = '/flags/' + code + '.png';
    });
    flagCache[code] = p;
    return p;
  }
  var imgCache = {};
  function loadImg(src) {
    if (!src) return Promise.resolve(null);
    if (imgCache[src]) return imgCache[src];
    var p = new Promise(function (res) {
      var img = new Image();
      img.crossOrigin = 'anonymous';   // espncdn sends ACAO *, so the canvas stays untainted
      img.onload = function () { res(img); };
      img.onerror = function () { res(null); };
      img.src = src;
    });
    imgCache[src] = p;
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
    pill(ctx, 540, 80, String(p.headline || 'WHO WILL WIN?').toUpperCase(), {
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
  // ---- MATCHDAY (pre-match gameday hype hero) ----
  function drawKickoffMedallion(ctx, cx, cy, p) {
    var r = 104;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 42; ctx.shadowOffsetY = 16;
    ctx.fillStyle = '#F4F2EB'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    ctx.lineWidth = 5; ctx.strokeStyle = INK; ctx.beginPath(); ctx.arc(cx, cy, r - 3, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = font('800', 19, BR); ls(ctx, 5); ctx.fillText('KICKOFF', cx, cy - 48); ls(ctx, 0);
    ctx.font = font('700', 74, KH); ctx.fillText(String(p.time || ''), cx, cy + 4);
    ctx.font = font('800', 21, BR); ls(ctx, 2); ctx.fillStyle = hexA(INK, .68); ctx.fillText(String(p.meridiem || '').toUpperCase(), cx, cy + 54); ls(ctx, 0);
  }
  function drawFormDots(ctx, results, cx, cy) {
    results = (results || []).slice(0, 3); var n = results.length; if (!n) return;
    var d = 44, gap = 12, totalW = n * d + (n - 1) * gap, x0 = cx - totalW / 2 + d / 2;
    var FC = { W: '#1E9B4B', D: '#FFC400', L: '#ED2939' };
    ctx.font = font('800', 20, BR); ls(ctx, 4); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = 'rgba(255,255,255,.8)';
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 8; ctx.fillText('FORM', cx, cy - 42); ctx.restore(); ls(ctx, 0);
    ctx.textBaseline = 'middle';
    for (var i = 0; i < n; i++) {
      var rch = String(results[i]).toUpperCase(), x = x0 + i * (d + gap), col = FC[rch] || '#8A93A0';
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, cy, d / 2, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      ctx.fillStyle = contrastInk(col); ctx.font = font('800', 24, BR); ctx.fillText(rch, x, cy + 1);
    }
  }
  function renderMatchday(ctx, p, F) {
    drawVsBg(ctx, p, F);
    var scg = ctx.createLinearGradient(0, W - 470, 0, W); scg.addColorStop(0, 'rgba(8,10,14,0)'); scg.addColorStop(1, 'rgba(8,10,14,.9)');
    ctx.fillStyle = scg; ctx.fillRect(0, W - 470, W, 470);
    var tc = p.tagColor || '#FFC400';
    pill(ctx, 540, 78, String(p.stakesTag || 'MATCHDAY').toUpperCase(), { font: font('800', 28, BR), lsp: 6, padX: 28, h: 54, bg: tc, color: contrastInk(tc), shadow: { c: 'rgba(0,0,0,.3)', b: 24, oy: 10 } });
    drawKickoffMedallion(ctx, 540, 452, p);
    if (p.day) { var dc = p.dayColor || '#C8102E'; pill(ctx, 540, 590, String(p.day).toUpperCase(), { font: font('800', 23, BR), lsp: 3, padX: 22, h: 48, bg: dc, color: contrastInk(dc), shadow: { c: 'rgba(0,0,0,.3)', b: 18, oy: 6 } }); }
    if (p.formA) drawFormDots(ctx, p.formA, 250, 656);
    if (p.formB) drawFormDots(ctx, p.formB, 830, 656);
    if (p.edge) pill(ctx, 540, 724, String(p.edge).toUpperCase(), { font: font('800', 26, BR), lsp: 2, padX: 24, h: 50, bg: '#F4F2EB', color: (p.edgeSide === 'b' ? (p.bcolor || '#C8102E') : (p.acolor || '#C8102E')), shadow: { c: 'rgba(0,0,0,.3)', b: 18, oy: 6 } });
    if (p.stakes) {
      var fwm = fitWrap(ctx, String(p.stakes).toUpperCase(), '700', 78, KH, W - 150, 2, 46);
      var lh = fwm.size * 0.86, n = fwm.lines.length, lastBase = (p.detail ? 842 : 866), topBase = lastBase - (n - 1) * lh;
      drawQuoteGlyph(ctx, 64, topBase - fwm.size * 0.95, 128, '#F4F2EB', .13);
      ctx.font = font('700', fwm.size, KH); ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 4;
      for (var i = 0; i < n; i++) ctx.fillText(fwm.lines[i], 78, topBase + i * lh);
      ctx.restore();
      if (p.detail) { var ds = fitFont(ctx, String(p.detail), '600', 28, BR, W - 160, 0); ctx.font = font('600', ds, BR); ctx.fillStyle = 'rgba(255,255,255,.78)'; ctx.textAlign = 'left'; ctx.fillText(String(p.detail), 80, lastBase + 42); }
    }
    drawBrand(ctx, p.acolor);
  }

  // ---- VERDICT (roast/meme cards: one flag-forward layout, many stamps) ----
  function fitFont(ctx, text, weight, size, fam, maxW, lsp) {
    ctx.font = font(weight, size, fam); ls(ctx, lsp || 0);
    while (ctx.measureText(text).width > maxW && size > 15) { size -= 2; ctx.font = font(weight, size, fam); }
    ls(ctx, 0); return size;
  }
  function wrapLines(ctx, text, maxW) {
    var words = String(text).split(' '), lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var t = cur ? cur + ' ' + words[i] : words[i];
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = words[i]; } else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  }
  function fitWrap(ctx, text, weight, size, fam, maxW, maxLines, floor) {
    while (size > (floor || 40)) {
      ctx.font = font(weight, size, fam);
      var lines = wrapLines(ctx, text, maxW);
      if (lines.length <= maxLines) return { size: size, lines: lines };
      size -= 4;
    }
    ctx.font = font(weight, size, fam);
    return { size: size, lines: wrapLines(ctx, text, maxW) };
  }
  // owned cream "quote" silhouette (a pair of filled commas), drawn as a path so it is machine-identical
  function drawQuoteGlyph(ctx, x, y, size, color, alpha) {
    ctx.save(); ctx.globalAlpha = (alpha == null ? 1 : alpha); ctx.fillStyle = color;
    var r = size * 0.26, gap = size * 0.30;
    for (var k = 0; k < 2; k++) {
      var ox = x + k * (r * 2 + gap);
      ctx.beginPath();
      ctx.arc(ox + r, y + r, r, 0, Math.PI * 2);
      ctx.moveTo(ox + r * 0.15, y + r * 1.7);
      ctx.quadraticCurveTo(ox + r * 0.9, y + r * 2.0, ox + r * 1.5, y + r * 0.6);
      ctx.lineTo(ox + r * 1.9, y + r * 1.2);
      ctx.quadraticCurveTo(ox + r * 0.9, y + r * 3.1, ox + r * 0.15, y + r * 1.7);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  // classic image-macro caption: uppercase Anton, chunky black outline + white fill, autofit + wrap.
  function drawImpactCaption(ctx, text, x, y, maxW, opts) {
    var o = opts || {};
    var place = o.place || 'bottom', maxH = o.maxH || 360;
    var startSize = o.startSize || 86, minSize = o.minSize || 30, maxLines = o.maxLines || 3;
    var fill = o.fill || '#fff', stroke = o.stroke || '#000';
    var strokeRatio = o.strokeRatio != null ? o.strokeRatio : 0.16;
    var shadow = o.shadow !== false, lineHeight = o.lineHeight || 0.96, tracking = o.tracking != null ? o.tracking : 1;
    var up = String(text || '').toUpperCase().trim();
    if (!up) return { height: 0, size: 0, lines: [] };
    function setFont(s) { ctx.font = '400 ' + s + 'px Anton, Impact, "Arial Narrow", sans-serif'; ls(ctx, tracking); }
    var size = startSize, lines;
    for (; size >= minSize; size -= 2) {
      setFont(size); lines = wrapLines(ctx, up, maxW);
      var tooTall = lines.length * size * lineHeight > maxH, tooMany = lines.length > maxLines, fits = true;
      for (var k = 0; k < lines.length; k++) if (ctx.measureText(lines[k]).width > maxW) { fits = false; break; }
      if (fits && !tooTall && !tooMany) break;
    }
    setFont(size);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round'; ctx.miterLimit = 2;
    var lh = size * lineHeight, blockH = lines.length * lh;
    var firstBaseline = (place === 'top') ? (y + size) : (y - blockH + size);
    for (var i = 0; i < lines.length; i++) {
      var by = firstBaseline + i * lh;
      ctx.lineWidth = size * strokeRatio; ctx.strokeStyle = stroke;
      if (shadow) { ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = size * 0.12; ctx.shadowOffsetY = size * 0.06; }
      ctx.strokeText(lines[i], x, by); ctx.strokeText(lines[i], x, by);
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.fillStyle = fill; ctx.fillText(lines[i], x, by);
    }
    ls(ctx, 0);
    return { height: blockH, size: size, lines: lines };
  }
  function drawStamp(ctx, cx, cy, text, color, scale) {
    scale = scale || 1; text = String(text || '').toUpperCase();
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(-7 * Math.PI / 180);
    var fs = 66 * scale; ctx.font = font('800', fs, BR); ls(ctx, 5);
    while (ctx.measureText(text).width + 80 * scale > 940 && fs > 30) { fs -= 3; ctx.font = font('800', fs, BR); }
    var tw = ctx.measureText(text).width, padX = 40 * scale, w = tw + padX * 2, h = 108 * scale;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 34 * scale; ctx.shadowOffsetY = 12 * scale;
    ctx.fillStyle = 'rgba(244,242,235,.93)'; rrect(ctx, -w / 2, -h / 2, w, h, 16 * scale); ctx.fill(); ctx.restore();
    ctx.lineWidth = 6 * scale; ctx.strokeStyle = color; rrect(ctx, -w / 2, -h / 2, w, h, 16 * scale); ctx.stroke();
    ctx.lineWidth = 2.5 * scale; rrect(ctx, -w / 2 + 11 * scale, -h / 2 + 11 * scale, w - 22 * scale, h - 22 * scale, 9 * scale); ctx.stroke();
    ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 2.5, 2 * scale); ls(ctx, 0);
    ctx.restore();
  }
  function drawSideMark(ctx, cx, cy, txt, color) {
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 26; ctx.shadowOffsetY = 8;
    ctx.fillStyle = color || '#C8102E'; ctx.beginPath(); ctx.arc(cx, cy, 80, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(255,255,255,.92)'; ctx.beginPath(); ctx.arc(cx, cy, 71, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = font('800', 94, BR); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(txt || 'L').toUpperCase(), cx, cy + 4);
  }
  function renderVerdict(ctx, p, F) {
    drawVsBg(ctx, p, F);
    // deepen the lower half so the punchline reads as the hero (verdict only)
    var sc = ctx.createLinearGradient(0, W - 560, 0, W);
    sc.addColorStop(0, 'rgba(12,15,20,0)'); sc.addColorStop(.5, 'rgba(12,15,20,.5)'); sc.addColorStop(1, 'rgba(12,15,20,.9)');
    ctx.fillStyle = sc; ctx.fillRect(0, W - 560, W, 560);
    // evidence: the scoreline (or L-marks for the draw verdicts)
    var hasScore = (p.hg != null && p.hg !== '' && p.ag != null && p.ag !== '');
    if (p.markA || p.markB) {
      if (p.markA) drawSideMark(ctx, 262, 432, p.markA, p.acolor || '#C8102E');
      if (p.markB) drawSideMark(ctx, 818, 432, p.markB, p.bcolor || '#C8102E');
    } else if (hasScore) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 6; ctx.fillStyle = '#fff';
      ctx.font = font('700', 148, KH); ctx.fillText(String(p.hg) + '  -  ' + String(p.ag), 540, 404);
      ctx.restore();
    }
    // the verdict label: a clean top banner (not the hero). Rotated stamp only if stampTilt.
    var stamp = String(p.stamp || 'VERDICT').toUpperCase(), scol = p.stampColor || '#C8102E';
    if (p.stampTilt) {
      drawStamp(ctx, 540, 432, stamp, scol, 1.0);
    } else {
      pill(ctx, 540, 76, stamp, { font: font('800', 33, BR), lsp: 6, padX: 30, h: 60, bg: '#F4F2EB', color: scol, shadow: { c: 'rgba(0,0,0,.35)', b: 24, oy: 8 } });
    }
    // HERO punchline: big Khand, wrapped, bottom-anchored, with the cream quote glyph behind
    if (p.headline) {
      var fwp = fitWrap(ctx, String(p.headline).toUpperCase(), '700', 104, KH, W - 152, 3, 52);
      var lh = fwp.size * 0.86, n = fwp.lines.length, lastBase = 884, topBase = lastBase - (n - 1) * lh;
      drawQuoteGlyph(ctx, 72, topBase - fwp.size * 0.96, 150, '#F4F2EB', 0.17);
      ctx.font = font('700', fwp.size, KH); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#F4F2EB';
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4;
      for (var i = 0; i < n; i++) ctx.fillText(fwp.lines[i], 78, topBase + i * lh);
      ctx.restore();
      if (p.receipt) {
        ctx.font = font('700', 24, BR); ls(ctx, 2); ctx.fillStyle = hexA('#F4F2EB', .72); ctx.textAlign = 'left';
        ctx.fillText(String(p.receipt).toUpperCase(), 80, lastBase + 46); ls(ctx, 0);
      }
    }
    drawBrand(ctx, p.acolor);
  }
  // ---- PANEL: a dictionary/knowledge-panel spoof (the "Battle of Mid" genre) ----
  function renderPanel(ctx, p, F) {
    var CREAM = '#F4F2EB', INKB = '#14171C', BLUE = '#0A3478', RED = '#C8102E';
    ctx.fillStyle = CREAM; ctx.fillRect(0, 0, W, W);
    fifaRibbon(ctx, 0, 10);
    // scorebug
    ctx.save(); ctx.shadowColor = 'rgba(20,23,28,.22)'; ctx.shadowBlur = 11; ctx.shadowOffsetY = 3;
    drawMiniFlag(ctx, F.a, 150, 66, 112, 75); drawMiniFlag(ctx, F.b, 818, 66, 112, 75); ctx.restore();
    ctx.fillStyle = INKB; ctx.font = font('800', 92, KH); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(p.score || '0 - 0'), 540, 112);
    pill(ctx, 540, 176, String(p.status || 'FULL TIME').toUpperCase(), { font: font('800', 23, BR), lsp: 5, padX: 24, h: 44, bg: hexA(BLUE, .12), color: BLUE });
    ctx.font = font('700', 27, BR); ls(ctx, 1); ctx.fillStyle = hexA(INKB, .7); ctx.textBaseline = 'middle';
    ctx.fillText(String(p.an || '').toUpperCase(), 206, 176); ctx.fillText(String(p.bn || '').toUpperCase(), 874, 176); ls(ctx, 0);
    // hairline
    ctx.strokeStyle = hexA(INKB, .15); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(64, 252); ctx.lineTo(1016, 252); ctx.stroke();
    // headword + pronunciation
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = INKB;
    var word = String(p.word || 'mid'), wf = fitFont(ctx, word, '800', 150, KH, 640, 0);
    ctx.font = font('800', wf, KH); ctx.fillText(word, 72, 408);
    var ww = ctx.measureText(word).width;
    if (p.pron) { ctx.font = font('400', 40, BR); ctx.fillStyle = hexA(INKB, .55); ctx.fillText(String(p.pron), 72 + ww + 24, 408); }
    ctx.font = font('600', 34, BR); ls(ctx, 1); ctx.fillStyle = RED; ctx.fillText(String(p.pos || 'noun'), 80, 474); ls(ctx, 0);
    // definitions (numbered, wrapped)
    var y = 558;
    function def(num, text) {
      if (!text) return;
      ctx.font = font('500', 44, BR); var lines = wrapLines(ctx, String(text), 870);
      ctx.fillStyle = RED; ctx.font = font('700', 44, BR); ctx.fillText(num + '.', 80, y);
      ctx.fillStyle = hexA(INKB, .85); ctx.font = font('500', 44, BR);
      for (var i = 0; i < lines.length; i++) ctx.fillText(lines[i], 134, y + i * 56);
      y += lines.length * 56 + 26;
    }
    def('1', p.def1 || ''); def('2', p.def2 || '');
    if (p.seeAlso) {
      var st = 'SEE ALSO: ' + String(p.seeAlso).toUpperCase();
      ctx.font = font('600', 26, BR); var stw = ctx.measureText(st).width;
      pill(ctx, 80 + stw / 2 + 22, Math.min(y + 8, 906), st, { font: font('600', 26, BR), lsp: 1, padX: 22, h: 46, bg: INKB, color: CREAM });
    }
    // cream footer wordmark (drawBrand is for dark cards)
    fifaRibbon(ctx, W - 10, 10);
    ctx.font = font('700', 36, KH); ls(ctx, 2); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    var t1 = 'SPORT', t2 = 'ACLE', b1 = ctx.measureText(t1).width, b2 = ctx.measureText(t2).width, fx = 540 - (b1 + b2) / 2, fy = W - 48;
    ctx.fillStyle = INKB; ctx.fillText(t1, fx, fy); ctx.fillStyle = RED; ctx.fillText(t2, fx + b1, fy); ls(ctx, 0);
  }
  // ---- QUOTE CARD (ESPN/B-R style: hero + oversized quote + attribution + context) ----
  // tiny ownable corner wordmark for the casual macro register (drawBrand is too heavy here)
  function macroMark(ctx) {
    ctx.font = font('700', 30, KH); ls(ctx, 2); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    var t1 = 'SPORT', t2 = 'ACLE', b1 = ctx.measureText(t1).width, x = 40, y = W - 34;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 2;
    ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fillText(t1, x, y);
    ctx.fillStyle = '#FFC400'; ctx.fillText(t2, x + b1, y);
    ctx.restore(); ls(ctx, 0);
  }
  // ---- IMAGE MACRO (classic impact-caption meme: photo/flag/VS bg + top/bottom captions) ----
  function renderMacro(ctx, p, F) {
    ctx.clearRect(0, 0, W, W);
    var bg = p.bg || (F.photo && F.photo.naturalWidth ? 'photo' : (p.bc ? 'vs' : 'flag'));
    if (bg === 'photo' && F.photo && F.photo.naturalWidth) {
      ctx.fillStyle = '#0d1016'; ctx.fillRect(0, 0, W, W);
      cover(ctx, F.photo, 0, 0, W, W, 0.5, (p.focusY != null ? p.focusY : 0.35));
    } else if (bg === 'vs' && F.b) {
      drawVsBg(ctx, p, { a: F.a, b: F.b }); ctx.fillStyle = 'rgba(0,0,0,.30)'; ctx.fillRect(0, 0, W, W);
    } else if (bg === 'flag' && F.a) {
      ctx.fillStyle = p.acolor || '#0d1016'; ctx.fillRect(0, 0, W, W);
      cover(ctx, F.a, 0, 0, W, W, 0.5, 0.5);
      ctx.save(); ctx.globalAlpha = 0.5; ctx.fillStyle = p.acolor || '#000'; ctx.fillRect(0, 0, W, W); ctx.restore();
    } else {
      var gg = ctx.createLinearGradient(0, 0, 0, W); gg.addColorStop(0, p.acolor || '#1b2330'); gg.addColorStop(1, '#0d1016');
      ctx.fillStyle = gg; ctx.fillRect(0, 0, W, W);
    }
    if (!p.flat && p.top) { var gt = ctx.createLinearGradient(0, 0, 0, 360); gt.addColorStop(0, p.bars ? '#000' : 'rgba(0,0,0,.62)'); gt.addColorStop(1, p.bars ? '#000' : 'rgba(0,0,0,0)'); ctx.fillStyle = gt; ctx.fillRect(0, 0, W, p.bars ? 300 : 360); }
    if (!p.flat && p.bottom) { var gb = ctx.createLinearGradient(0, W, 0, W - 380); gb.addColorStop(0, p.bars ? '#000' : 'rgba(0,0,0,.66)'); gb.addColorStop(1, p.bars ? '#000' : 'rgba(0,0,0,0)'); ctx.fillStyle = gb; ctx.fillRect(0, W - (p.bars ? 300 : 380), W, p.bars ? 300 : 380); }
    if (p.credit) { ctx.font = font('700', 22, BR); ls(ctx, 3); ctx.fillStyle = 'rgba(255,255,255,.72)'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(String(p.credit).toUpperCase(), 56, 56); ls(ctx, 0); }
    var sh = p.shadow !== false && !p.bars;
    if (p.top) drawImpactCaption(ctx, p.top, 540, 72, W - 112, { place: 'top', maxH: 300, startSize: 84, shadow: sh });
    if (p.bottom) drawImpactCaption(ctx, p.bottom, 540, W - 72, W - 112, { place: 'bottom', maxH: 340, startSize: 92, shadow: sh });
    macroMark(ctx);
  }
  function renderQuoteCard(ctx, p, F) {
    var CREAM = '#F4F2EB', INKB = '#14171C', RED = '#C8102E', col = p.color || '#1E9B4B';
    var heroH = 632;
    // hero: a player photo if one was supplied + loaded, else the flag (flag-forward default)
    ctx.fillStyle = col; ctx.fillRect(0, 0, W, heroH);
    var hero = (F.photo && F.photo.naturalWidth) ? F.photo : F.flag;
    if (hero) cover(ctx, hero, 0, 0, W, heroH, 0.5, 0.38);
    ctx.save(); ctx.globalAlpha = (F.photo && F.photo.naturalWidth) ? 0.18 : 0.42; ctx.fillStyle = col; ctx.fillRect(0, 0, W, heroH); ctx.restore();
    fifaRibbon(ctx, 0, 8);
    // scrim into the carve + team name
    var g = ctx.createLinearGradient(0, heroH - 240, 0, heroH); g.addColorStop(0, 'rgba(20,23,28,0)'); g.addColorStop(1, 'rgba(20,23,28,.45)');
    ctx.fillStyle = g; ctx.fillRect(0, heroH - 240, W, 240);
    ctx.font = font('800', 44, BR); ls(ctx, 8); ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 3;
    ctx.fillText(String(p.team || '').toUpperCase(), 64, 100); ctx.restore(); ls(ctx, 0);
    // carved cream panel
    ctx.beginPath(); ctx.moveTo(0, heroH); ctx.quadraticCurveTo(540, heroH - 44, W, heroH); ctx.lineTo(W, W); ctx.lineTo(0, W); ctx.closePath();
    ctx.fillStyle = CREAM; ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, heroH); ctx.quadraticCurveTo(540, heroH - 44, W, heroH); ctx.lineWidth = 6; ctx.strokeStyle = RED; ctx.stroke();
    // optional kicker (e.g. "ON THIS DATE IN 2019:") in the team color, just below the carve
    if (p.kicker) { ctx.font = font('700', 27, BR); ls(ctx, 3); ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(String(p.kicker).toUpperCase(), 80, heroH + 66); ls(ctx, 0); }
    // quote glyph + bold quote (bottom-anchored block)
    var fw = fitWrap(ctx, String(p.quote || '').toUpperCase(), '700', 90, KH, 922, 4, 48);
    var lh = fw.size * 0.85, n = fw.lines.length, lastBase = 902 - (p.context ? 36 : 0), topBase = lastBase - (n - 1) * lh;
    drawQuoteGlyph(ctx, 70, topBase - fw.size * 0.95, 168, RED, 0.16);
    ctx.font = font('700', fw.size, KH); ctx.fillStyle = INKB; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    for (var i = 0; i < n; i++) ctx.fillText(fw.lines[i], 80, topBase + i * lh);
    // attribution
    ctx.font = font('700', 38, BR); ls(ctx, 3); ctx.fillStyle = col;
    ctx.fillText(String(p.attribution || p.team || '').toUpperCase(), 82, lastBase + 50); ls(ctx, 0);
    // context
    if (p.context) {
      var cs = fitFont(ctx, String(p.context), '500', 29, BR, 940, 0);
      ctx.font = font('500', cs, BR); ctx.fillStyle = hexA(INKB, .6);
      ctx.fillText(String(p.context), 82, lastBase + 92);
    }
    // cream footer wordmark
    fifaRibbon(ctx, W - 10, 10);
    ctx.font = font('700', 32, KH); ls(ctx, 2); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    var t1 = 'SPORT', t2 = 'ACLE', b1 = ctx.measureText(t1).width, b2 = ctx.measureText(t2).width, fx = W - 64 - b1 - b2, fy = W - 46;
    ctx.fillStyle = INKB; ctx.fillText(t1, fx, fy); ctx.fillStyle = RED; ctx.fillText(t2, fx + b1, fy); ls(ctx, 0);
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
    ctx.font = font('700', 200, KH); ctx.fillStyle = safeAccent(p.acolor); ctx.fillText(d1, cur + w1 / 2, midY);
    cur += w1 + gap;
    ctx.font = font('600', 120, KH); ctx.fillStyle = 'rgba(17,22,31,.32)'; ctx.fillText('-', cur + dashW / 2, midY - 6);
    cur += dashW + gap;
    ctx.font = font('700', 200, KH); ctx.fillStyle = safeAccent(p.bcolor); ctx.fillText(d2, cur + w2 / 2, midY);
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
    ctx.fillStyle = safeAccent(accent); ctx.fillText(t2, x + padX + w1, cy + 1);
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
    // optional scorer jersey (upper-right): chosen kit, else team color
    if (p.jersey) drawJersey(ctx, 826, 392, 1.04, p.kit1 || p.tc, p.kit2 || shade(p.tc, 0.58), p.jersey, p.scorer);
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
    // headline (default GOAL), Khand 700, auto-fit width; amber bang appended unless already punctuated
    var head = String(p.headline || 'GOAL').toUpperCase();
    var bang = /[!?.]$/.test(head) ? '' : '!';
    var hs = 340; ctx.font = font('700', hs, KH);
    while (ctx.measureText(head + bang).width > W - 120 && hs > 110) { hs -= 10; ctx.font = font('700', hs, KH); }
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 10;
    var gy = heroBottom - 40;
    ctx.fillStyle = '#fff'; ctx.fillText(head, 60, gy);
    if (bang) { var gw = ctx.measureText(head).width; ctx.fillStyle = '#FFC400'; ctx.fillText(bang, 60 + gw + 6, gy); }
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

  // ---- color helpers ----
  function hexRgb(h) { h = String(h || '').replace('#', ''); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0]; }
  function lum(h) { var c = hexRgb(h); return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255; }
  function shade(h, f) { var c = hexRgb(h); function cl(v) { return Math.max(0, Math.min(255, Math.round(v))); } return 'rgb(' + cl(c[0] * f) + ',' + cl(c[1] * f) + ',' + cl(c[2] * f) + ')'; }
  // achromatic near-black team colors (Germany #2B2B2B, NZ #1B1B1B) vanish as a foreground
  // fill on near-white plates; lighten them to a readable slate, leaving saturated darks alone.
  function safeAccent(h) {
    var c = hexRgb(h), mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
    if (lum(h) < 0.20 && (mx - mn) < 40) return shade(h, 120 / Math.max(mx, 1));
    return h;
  }
  function contrastInk(h) { return lum(h) > 0.62 ? '#11161F' : '#ffffff'; }
  function hexA(h, a) { var c = hexRgb(h); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  // brand cues shared with the cover/share card: the conic orb + the FIFA-color ribbon
  function orb(ctx, cx, cy, r) {
    var g = ctx.createConicGradient(210 * Math.PI / 180, cx, cy);
    g.addColorStop(0, '#1E9B4B'); g.addColorStop(.25, '#FFC400'); g.addColorStop(.5, '#0A3478'); g.addColorStop(.75, '#ED2939'); g.addColorStop(1, '#1E9B4B');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  }
  function fifaRibbon(ctx, y, h) {
    var g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#1E9B4B'); g.addColorStop(.25, '#FFC400'); g.addColorStop(.5, '#0A3478'); g.addColorStop(.75, '#ED2939'); g.addColorStop(1, '#1E9B4B');
    ctx.fillStyle = g; ctx.fillRect(0, y, W, h);
  }

  // ---- generated jersey (stylized kit in team colors) ----
  function drawJersey(ctx, cx, cy, scale, c1, c2, num, name) {
    ctx.save();
    ctx.translate(cx, cy); ctx.scale(scale, scale); ctx.translate(-150, -170);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 18;
    var pts = [10, 60, 70, 30, 110, 30, 150, 58, 190, 30, 230, 30, 290, 60, 270, 132, 222, 112, 236, 330, 64, 330, 78, 112, 30, 132];
    poly(ctx, pts); ctx.fillStyle = c1; ctx.fill();
    ctx.restore();
    // top highlight for a little dimension
    var hg = ctx.createLinearGradient(0, 30, 0, 330);
    hg.addColorStop(0, 'rgba(255,255,255,.16)'); hg.addColorStop(.4, 'rgba(255,255,255,0)');
    poly(ctx, pts); ctx.save(); ctx.clip(); ctx.fillStyle = hg; ctx.fillRect(0, 0, 300, 340); ctx.restore();
    // collar + cuff trim (secondary)
    ctx.strokeStyle = c2; ctx.lineJoin = 'round';
    ctx.lineWidth = 11; ctx.beginPath(); ctx.moveTo(108, 33); ctx.lineTo(150, 64); ctx.lineTo(192, 33); ctx.stroke();
    ctx.lineWidth = 9;
    ctx.beginPath(); ctx.moveTo(34, 126); ctx.lineTo(14, 64); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(266, 126); ctx.lineTo(286, 64); ctx.stroke();
    // kit back: surname above number (reads like the back of the shirt)
    ctx.fillStyle = contrastInk(c1); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (name) {
      var kit = (String(name).split(' ').slice(1).join(' ') || String(name)).toUpperCase();
      var nf = 42; ctx.font = font('700', nf, KH); ls(ctx, 1);
      while (ctx.measureText(kit).width > 214 && nf > 22) { nf -= 2; ctx.font = font('700', nf, KH); }
      ctx.fillText(kit, 150, 118); ls(ctx, 0);
      if (num) { ctx.font = font('700', 110, KH); ctx.fillText(String(num), 150, 234); }
    } else if (num) {
      ctx.font = font('700', 120, KH); ctx.fillText(String(num), 150, 200);
    }
    ctx.restore();
  }

  // ---- STATS (post-match player card) ----
  function renderStats(ctx, p, photo) {
    var c1 = p.color || '#1E9B4B', c2 = p.color2 || shade(c1, 0.55);
    var hasPhoto = !!(photo && photo.naturalWidth);
    // background: dark with a team-color glow
    ctx.fillStyle = '#0d1016'; ctx.fillRect(0, 0, W, W);
    var rg = ctx.createRadialGradient(W / 2, 300, 0, W / 2, 300, 760);
    rg.addColorStop(0, shade(c1, 0.62)); rg.addColorStop(1, 'rgba(13,16,22,0)');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, W);
    var vg = ctx.createLinearGradient(0, W - 360, 0, W); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.55)');
    ctx.fillStyle = vg; ctx.fillRect(0, W - 360, W, 360);
    // tag + context
    ctx.font = font('800', 24, BR); ls(ctx, 6); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.fillText((p.team || '').toUpperCase(), 64, 80); ls(ctx, 0);
    if (p.context) { ctx.font = font('700', 22, BR); ls(ctx, 3); ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillText(p.context.toUpperCase(), W - 64, 80); ls(ctx, 0); }
    // Man of the Match ribbon
    var top = 150;
    if (p.motm) {
      pill(ctx, 540, 158, (p.motmLabel || 'Man of the Match').toUpperCase(), {
        font: font('800', 26, BR), lsp: 5, padX: 30, h: 52, bg: '#FFC400', color: INK, shadow: { c: 'rgba(0,0,0,.4)', b: 28, oy: 10 }
      });
      top = 210;
    }
    // hero: a sourced player portrait (B/R-style, CC-licensed) when one exists,
    // else the stylized team-color jersey. Photo is framed on a team-color block.
    if (hasPhoto) {
      var pw2 = 452, ph2 = 452, px2 = 540 - pw2 / 2, py2 = top + 12;
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 16;
      rrect(ctx, px2, py2, pw2, ph2, 28); ctx.fillStyle = shade(c1, 0.5); ctx.fill(); ctx.restore();
      ctx.save(); rrect(ctx, px2, py2, pw2, ph2, 28); ctx.clip();
      cover(ctx, photo, px2, py2, pw2, ph2, 0.5, 0.18);
      var fg = ctx.createLinearGradient(0, py2 + ph2 - 150, 0, py2 + ph2);
      fg.addColorStop(0, 'rgba(13,16,22,0)'); fg.addColorStop(1, hexA(shade(c1, 0.42), .78));
      ctx.fillStyle = fg; ctx.fillRect(px2, py2 + ph2 - 150, pw2, 150);
      ctx.restore();
      ctx.lineWidth = 6; ctx.strokeStyle = hexA(c1, .9); rrect(ctx, px2 + 3, py2 + 3, pw2 - 6, ph2 - 6, 26); ctx.stroke();
    } else {
      drawJersey(ctx, 540, top + 230, 1.15, p.kit1 || c1, p.kit2 || c2, p.jersey, p.player);
    }
    // player name
    var name = String(p.player || 'Player').toUpperCase();
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#fff';
    var ny = top + 470, nsize = name.length > 16 ? 76 : 96;
    ctx.font = font('700', nsize, KH);
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 16; ctx.fillText(name, 540, ny); ctx.restore();
    // position line
    if (p.position) { ctx.font = font('700', 22, BR); ls(ctx, 4); ctx.fillStyle = 'rgba(255,255,255,.66)'; ctx.fillText(p.position.toUpperCase(), 540, ny + 40); ls(ctx, 0); }
    // stat blocks
    drawStats(ctx, p.stats || [], ny + 110, c1);
    // photo credit, burned into the image (re-shares strip caption text, so attribution must live here)
    if (hasPhoto && p.credit) {
      ctx.font = font('700', 15, BR); ls(ctx, 1); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.fillText(String(p.credit).toUpperCase().slice(0, 54), 64, W - 92); ls(ctx, 0);
    }
    // brand footer
    ctx.font = font('700', 38, KH); ls(ctx, 3); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var t1 = 'SPORT', t2 = 'ACLE', bw1 = ctx.measureText(t1).width, bw2 = ctx.measureText(t2).width, bx = 540 - (bw1 + bw2) / 2, by = W - 56;
    ctx.textAlign = 'left'; ctx.fillStyle = '#fff'; ctx.fillText(t1, bx, by); ctx.fillStyle = '#FFC400'; ctx.fillText(t2, bx + bw1, by);
    ls(ctx, 0); ctx.font = font('700', 18, BR); ls(ctx, 3); ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillText('GOSPORTACLE.COM', bx + bw1 + bw2 + 16, by + 1); ls(ctx, 0);
  }
  function drawStats(ctx, stats, y, accent) {
    stats = stats.slice(0, 4); var n = stats.length; if (!n) return;
    var slot = Math.min(260, (W - 120) / n), startX = 540 - (slot * n) / 2 + slot / 2;
    for (var i = 0; i < n; i++) {
      var cx = startX + i * slot, s = stats[i];
      ctx.textAlign = 'center';
      ctx.font = font('700', 120, KH); ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#fff';
      ctx.fillText(String(s.value), cx, y);
      ctx.font = font('800', 21, BR); ls(ctx, 2.5); ctx.fillStyle = 'rgba(255,255,255,.62)';
      ctx.fillText(String(s.label).toUpperCase(), cx, y + 34); ls(ctx, 0);
    }
  }

  // ---- INFOGRAPHIC (ranked leaderboard of an oddball stat) ----
  function renderLeaderboard(ctx, p, flags) {
    // Brand system (matches the site + R32 + goal cards): cream field, ink type,
    // Khand headline, FIFA-color ribbon + conic orb, and TEAM-COLOR bars.
    var CREAM = '#F4F2EB', INKB = '#14171C', LINE = '#E6E2D8', MUTE = '#8A93A0', RED = '#C8102E';
    ctx.fillStyle = CREAM; ctx.fillRect(0, 0, W, W);
    fifaRibbon(ctx, 0, 10);
    // brand row
    orb(ctx, 86, 96, 24);
    ctx.fillStyle = INKB; ctx.font = font('700', 30, KH); ls(ctx, 1); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('SPORTACLE', 124, 97); ls(ctx, 0);
    // headline + subtitle
    ctx.textBaseline = 'alphabetic'; ctx.fillStyle = INKB; ctx.font = font('700', 66, KH);
    ctx.fillText(String(p.title || '').toUpperCase(), 64, 206);
    if (p.subtitle) { ctx.font = font('700', 24, BR); ls(ctx, 1); ctx.fillStyle = RED; ctx.fillText(String(p.subtitle).toUpperCase(), 66, 244); ls(ctx, 0); }
    // rows
    var rows = (p.rows || []).slice(0, 9), n = rows.length, maxRaw = 0;
    rows.forEach(function (r) { if (+r.raw > maxRaw) maxRaw = +r.raw; });
    var top = 298, rowH = n ? Math.min(76, (W - top - 130) / n) : 76;
    for (var i = 0; i < n; i++) {
      var r = rows[i], cy = top + i * rowH + rowH / 2, col = r.color || RED;
      if (i) { ctx.strokeStyle = LINE; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(64, cy - rowH / 2); ctx.lineTo(1016, cy - rowH / 2); ctx.stroke(); }
      ctx.font = font('700', 36, KH); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = MUTE; ctx.fillText(String(i + 1), 92, cy);
      var fw = 48, fh = 32; ctx.save(); ctx.shadowColor = 'rgba(20,23,28,.22)'; ctx.shadowBlur = 9; ctx.shadowOffsetY = 3; drawMiniFlag(ctx, flags[r.code], 116, cy - fh / 2, fw, fh); ctx.restore();
      ctx.font = font('700', 31, BR); ctx.textAlign = 'left'; ctx.fillStyle = INKB;
      var name = String(r.name || ''), maxW = 284;
      if (ctx.measureText(name).width > maxW) { while (name.length > 3 && ctx.measureText(name + '…').width > maxW) name = name.slice(0, -1); name += '…'; }
      ctx.fillText(name, 182, cy + 1);
      var bx = 486, bw = 432, bh = 26, fillw = maxRaw ? Math.max(12, (+r.raw / maxRaw) * bw) : 0;
      ctx.fillStyle = LINE; rrect(ctx, bx, cy - bh / 2, bw, bh, bh / 2); ctx.fill();
      var bg = ctx.createLinearGradient(bx, 0, bx + bw, 0); bg.addColorStop(0, shade(col, 0.78)); bg.addColorStop(1, col);
      ctx.fillStyle = bg; rrect(ctx, bx, cy - bh / 2, fillw, bh, bh / 2); ctx.fill();
      ctx.font = font('700', 42, KH); ctx.textAlign = 'right'; ctx.fillStyle = INKB; ctx.fillText(String(r.value), 1016, cy + 2);
    }
    // footer: wordmark + footnote above the bottom FIFA ribbon
    fifaRibbon(ctx, W - 10, 10);
    ctx.font = font('700', 36, KH); ls(ctx, 2); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    var t1 = 'SPORT', t2 = 'ACLE', bw1 = ctx.measureText(t1).width, bw2 = ctx.measureText(t2).width, fx = 540 - (bw1 + bw2) / 2, fy = W - 54;
    ctx.fillStyle = INKB; ctx.fillText(t1, fx, fy); ctx.fillStyle = RED; ctx.fillText(t2, fx + bw1, fy); ls(ctx, 0);
    if (p.footnote) { ctx.font = font('700', 17, BR); ls(ctx, 2); ctx.fillStyle = MUTE; ctx.fillText(String(p.footnote).toUpperCase(), fx + bw1 + bw2 + 16, fy + 1); ls(ctx, 0); }
  }

  // shared cream-card footer (wordmark + optional footnote)
  function creamFooter(ctx, footnote) {
    var INKB = '#14171C', RED = '#C8102E', MUTE = '#8A93A0';
    fifaRibbon(ctx, W - 10, 10);
    ctx.font = font('700', 36, KH); ls(ctx, 2); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    var t1 = 'SPORT', t2 = 'ACLE', b1 = ctx.measureText(t1).width, b2 = ctx.measureText(t2).width, fx = 540 - (b1 + b2) / 2, fy = W - 54;
    ctx.fillStyle = INKB; ctx.fillText(t1, fx, fy); ctx.fillStyle = RED; ctx.fillText(t2, fx + b1, fy); ls(ctx, 0);
    if (footnote) { ctx.font = font('700', 17, BR); ls(ctx, 2); ctx.fillStyle = MUTE; ctx.fillText(String(footnote).toUpperCase(), fx + b1 + b2 + 16, fy + 1); ls(ctx, 0); }
  }
  function creamHead(ctx, cx, cy, r) {
    orb(ctx, cx, cy, r);
    ctx.fillStyle = '#14171C'; ctx.font = font('700', 28, KH); ls(ctx, 1); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('SPORTACLE', cx + 38, cy + 1); ls(ctx, 0);
  }

  // ---- BRACKET TIER LIST (whole field bucketed S/A/B/C/F) ----
  function renderTierboard(ctx, p, flags) {
    var CREAM = '#F4F2EB', INKB = '#14171C', RED = '#C8102E', MUTE = '#8A93A0';
    ctx.fillStyle = CREAM; ctx.fillRect(0, 0, W, W); fifaRibbon(ctx, 0, 10);
    creamHead(ctx, 86, 96, 24);
    if (p.context) { ctx.font = font('700', 22, BR); ls(ctx, 1); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = MUTE; ctx.fillText(String(p.context).toUpperCase(), 1016, 97); ls(ctx, 0); }
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.fillStyle = INKB;
    var ts = fitFont(ctx, String(p.title || '').toUpperCase(), '700', 66, KH, W - 128, 0); ctx.font = font('700', ts, KH); ctx.fillText(String(p.title || '').toUpperCase(), 64, 206);
    if (p.subtitle) { ctx.font = font('700', 24, BR); ls(ctx, 1); ctx.fillStyle = RED; ctx.fillText(String(p.subtitle).toUpperCase(), 66, 244); ls(ctx, 0); }
    var tiers = (p.tiers || []).filter(function (t) { return (t.teams || []).length; });
    var top = 288, bandH = tiers.length ? Math.min(122, (W - 150 - top) / tiers.length) : 122;
    var maxRow = 1; tiers.forEach(function (t) { if (t.teams.length > maxRow) maxRow = t.teams.length; });
    var gap = 12, chipW = Math.min(72, Math.floor((840 - (maxRow - 1) * gap) / maxRow)), chipH = Math.round(chipW * 0.67);
    tiers.forEach(function (t, i) {
      var by = top + i * bandH;
      rrect(ctx, 28, by + 8, 62, bandH - 16, 12); ctx.fillStyle = t.color; ctx.fill();
      ctx.fillStyle = contrastInk(t.color); ctx.font = font('700', 46, KH); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(t.label), 59, by + bandH / 2);
      rrect(ctx, 102, by + 8, W - 130, bandH - 16, 12); ctx.fillStyle = hexA(t.color, .14); ctx.fill();
      var x = 118, cy = by + bandH / 2;
      t.teams.forEach(function (tm) {
        ctx.save(); ctx.shadowColor = 'rgba(20,23,28,.2)'; ctx.shadowBlur = 7; ctx.shadowOffsetY = 2;
        drawMiniFlag(ctx, flags[tm.code], x, cy - chipH / 2, chipW, chipH); ctx.restore();
        x += chipW + gap;
      });
    });
    creamFooter(ctx, p.footnote);
  }

  // ---- ODDS BOARD (one team's projected R32 opponent odds) ----
  function renderOddsboard(ctx, p, flags) {
    var CREAM = '#F4F2EB', INKB = '#14171C', LINE = '#E6E2D8', MUTE = '#8A93A0', RED = '#C8102E';
    ctx.fillStyle = CREAM; ctx.fillRect(0, 0, W, W); fifaRibbon(ctx, 0, 10);
    creamHead(ctx, 84, 70, 22);
    ctx.save(); ctx.shadowColor = 'rgba(20,23,28,.22)'; ctx.shadowBlur = 11; ctx.shadowOffsetY = 3; drawMiniFlag(ctx, flags[p.code], 64, 150, 132, 88); ctx.restore();
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.fillStyle = INKB;
    var hs = fitFont(ctx, String(p.team || '').toUpperCase(), '700', 70, KH, 600, 0); ctx.font = font('700', hs, KH); ctx.fillText(String(p.team || '').toUpperCase(), 214, 222);
    ctx.font = font('700', 26, BR); ls(ctx, 1); ctx.fillStyle = RED; ctx.fillText(String(p.question || 'Most likely R32 opponent').toUpperCase(), 216, 262); ls(ctx, 0);
    ctx.strokeStyle = hexA(INKB, .15); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(64, 322); ctx.lineTo(1016, 322); ctx.stroke();
    var rows = (p.rows || []).slice(0, 6), n = rows.length, maxP = 0; rows.forEach(function (r) { if (+r.prob > maxP) maxP = +r.prob; });
    var top = 360, rowH = n ? Math.min(96, (W - top - 140) / n) : 96;
    for (var i = 0; i < n; i++) {
      var r = rows[i], cy = top + i * rowH + rowH / 2, col = r.field ? MUTE : (r.color || RED);
      if (i) { ctx.strokeStyle = LINE; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(64, cy - rowH / 2); ctx.lineTo(1016, cy - rowH / 2); ctx.stroke(); }
      if (r.field) { orb(ctx, 110, cy, 28); } else { ctx.save(); ctx.shadowColor = 'rgba(20,23,28,.2)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2; drawMiniFlag(ctx, flags[r.code], 70, cy - 30, 90, 60); ctx.restore(); }
      ctx.font = font('700', 38, BR); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = INKB;
      var nm = String(r.name || ''), maxW = 300; if (ctx.measureText(nm).width > maxW) { while (nm.length > 3 && ctx.measureText(nm + '…').width > maxW) nm = nm.slice(0, -1); nm += '…'; }
      ctx.fillText(nm, 186, cy + 1);
      var bx = 540, bw = 358, bh = 32, fillw = maxP ? Math.max(14, (+r.prob / maxP) * bw) : 0;
      ctx.fillStyle = LINE; rrect(ctx, bx, cy - bh / 2, bw, bh, bh / 2); ctx.fill();
      var bg = ctx.createLinearGradient(bx, 0, bx + bw, 0); bg.addColorStop(0, shade(col, 0.78)); bg.addColorStop(1, col); ctx.fillStyle = bg; rrect(ctx, bx, cy - bh / 2, fillw, bh, bh / 2); ctx.fill();
      ctx.font = font('700', 48, KH); ctx.textAlign = 'right'; ctx.fillStyle = INKB; ctx.fillText(String(r.prob) + '%', 1016, cy + 2);
    }
    creamFooter(ctx, p.footnote);
  }

  // ---- MARKET MOVERS (risers + fallers from a projection shift) ----
  function renderMovers(ctx, p, flags) {
    var CREAM = '#F4F2EB', INKB = '#14171C', RED = '#C8102E', GRN = '#1E9B4B', REDD = '#ED2939';
    ctx.fillStyle = CREAM; ctx.fillRect(0, 0, W, W); fifaRibbon(ctx, 0, 10);
    creamHead(ctx, 84, 70, 22);
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.fillStyle = INKB; ctx.font = font('700', 62, KH); ctx.fillText('THE BRACKET MOVED', 64, 172);
    if (p.result) { ctx.font = font('700', 24, BR); ls(ctx, 1); ctx.fillStyle = RED; ctx.fillText(String(p.result).toUpperCase(), 66, 208); ls(ctx, 0); }
    var y = { v: 258 };
    function section(label, col, items, up) {
      if (!items.length) return;
      ctx.font = font('700', 26, BR); ls(ctx, 5); ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(label, 64, y.v); ls(ctx, 0); y.v += 22;
      items.forEach(function (c) {
        var ty = y.v, th = 84;
        rrect(ctx, 40, ty, 1000, th - 12, 16); ctx.fillStyle = hexA(col, .09); ctx.fill();
        ctx.save(); ctx.shadowColor = 'rgba(20,23,28,.2)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2; drawMiniFlag(ctx, flags[c.code], 62, ty + (th - 12 - 56) / 2, 84, 56); ctx.restore();
        ctx.fillStyle = INKB; ctx.font = font('700', 40, KH); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(String(c.team || '').toUpperCase(), 168, ty + 34);
        ctx.font = font('600', 23, BR); ctx.fillStyle = hexA(INKB, .6); ctx.fillText(String(c.oldOpp || '') + '  ->  ' + String(c.newOpp || ''), 168, ty + 60);
        var chip = (up ? '+' : '-') + Math.abs(c.delta) + '%';
        ctx.font = font('700', 30, BR); var cw = ctx.measureText(chip).width + 40;
        pill(ctx, 1012 - cw / 2, ty + (th - 12) / 2, chip, { font: font('700', 30, BR), lsp: 0, padX: 20, h: 48, bg: col, color: '#fff' });
        y.v += th;
      });
      y.v += 12;
    }
    section('RISERS', GRN, (p.risers || []).slice(0, 3), true);
    section('FALLERS', REDD, (p.fallers || []).slice(0, 3), false);
    creamFooter(ctx, p.footnote);
  }

  // ---- PROJECTION TICKER (breaking-news lower-third, flag-forward not navy) ----
  function renderTicker(ctx, p, F) {
    var INKB = '#11161F', CREAM = '#F4F2EB', RED = '#C8102E', col = p.acolor || '#1E9B4B';
    // flag hero + heavy team tint + scrim (the goal-card treatment, keeps it flag-forward)
    ctx.fillStyle = col; ctx.fillRect(0, 0, W, W);
    if (F.a) cover(ctx, F.a, 0, 0, W, W, 0.5, 0.4);
    ctx.save(); ctx.globalAlpha = .6; ctx.fillStyle = col; ctx.fillRect(0, 0, W, W); ctx.restore();
    var sc = ctx.createLinearGradient(0, 0, 0, W);
    sc.addColorStop(0, 'rgba(8,10,14,.62)'); sc.addColorStop(.45, 'rgba(8,10,14,.14)'); sc.addColorStop(1, 'rgba(8,10,14,.86)');
    ctx.fillStyle = sc; ctx.fillRect(0, 0, W, W);
    fifaRibbon(ctx, 0, 8);
    // BREAKING banner (left-flush red) with a live dot
    var lbl = String(p.label || 'PROJECTION ALERT').toUpperCase();
    ctx.font = font('800', 38, BR); ls(ctx, 8); var lw = ctx.measureText(lbl).width; ls(ctx, 0);
    var bw = lw + 96, by = 104, bh = 74;
    ctx.fillStyle = RED; ctx.fillRect(0, by, bw, bh);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(42, by + bh / 2, 9, 0, Math.PI * 2); ctx.fill();
    ctx.font = font('800', 38, BR); ls(ctx, 8); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(lbl, 66, by + bh / 2 + 1); ls(ctx, 0);
    // delta chip top-right
    if (p.delta) {
      var up = p.deltaDir !== 'down', dc = up ? '#1E9B4B' : '#ED2939';
      var dt = (up ? '+' : '-') + String(p.delta).replace(/^[+-]/, '');
      ctx.font = font('800', 36, BR); var cw = ctx.measureText(dt).width + 44;
      pill(ctx, 1016 - cw / 2, by + bh / 2, dt, { font: font('800', 36, BR), lsp: 0, padX: 22, h: bh - 8, bg: dc, color: '#fff', shadow: { c: 'rgba(0,0,0,.35)', b: 18, oy: 6 } });
    }
    // HEADLINE hero (Khand white, wrapped, bottom-anchored above the ticker)
    if (p.headline) {
      var fwt = fitWrap(ctx, String(p.headline), '700', 92, KH, W - 128, 3, 50);
      var lh = fwt.size * 0.86, n = fwt.lines.length, lastBase = W - 188, topBase = lastBase - (n - 1) * lh;
      drawQuoteGlyph(ctx, 56, topBase - fwt.size * 0.96, 150, '#F4F2EB', .12);
      ctx.font = font('700', fwt.size, KH); ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4;
      for (var i = 0; i < n; i++) ctx.fillText(fwt.lines[i], 64, topBase + i * lh);
      ctx.restore();
    }
    // TICKER footer: ink bar + LIVE tab + ticker text + wordmark, ribbon at the very bottom
    var ty = W - 88, th = 76;
    ctx.fillStyle = INKB; ctx.fillRect(0, ty, W, th);
    ctx.fillStyle = RED; ctx.fillRect(0, ty, 110, th);
    ctx.fillStyle = '#fff'; ctx.font = font('800', 26, BR); ls(ctx, 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('LIVE', 55, ty + th / 2); ls(ctx, 0);
    ctx.font = font('700', 30, KH); ls(ctx, 2); ctx.textAlign = 'left';
    var t1 = 'SPORT', t2 = 'ACLE', b1 = ctx.measureText(t1).width, b2 = ctx.measureText(t2).width, wx = W - 28 - b1 - b2;
    ctx.fillStyle = CREAM; ctx.fillText(t1, wx, ty + th / 2 + 1); ctx.fillStyle = '#FFC400'; ctx.fillText(t2, wx + b1, ty + th / 2 + 1); ls(ctx, 0);
    if (p.ticker) {
      var maxTW = wx - 130 - 28;
      var tss = fitFont(ctx, String(p.ticker).toUpperCase(), '700', 27, BR, maxTW, 1);
      ctx.font = font('700', tss, BR); ls(ctx, 1); ctx.fillStyle = hexA(CREAM, .82); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(String(p.ticker).toUpperCase(), 130, ty + th / 2 + 1); ls(ctx, 0);
    }
    fifaRibbon(ctx, W - 8, 8);
  }

  var LIGHTC = { g: '#1E9B4B', a: '#FFC400', r: '#ED2939' };
  // ---- QUALIFY (what each side needs: two-column + traffic-light scenarios) ----
  function drawScenarioRow(ctx, y, h, result, outA, outB, colA, colB) {
    var INKB = '#14171C', rh = h - 14, cy = y + rh / 2;
    rrect(ctx, 64, y, W - 128, rh, 14); ctx.fillStyle = '#fff'; ctx.fill();
    rrect(ctx, 64, y, W - 128, rh, 14); ctx.strokeStyle = hexA(INKB, .1); ctx.lineWidth = 1.5; ctx.stroke();
    ctx.font = font('800', 25, BR); ls(ctx, 2); ctx.fillStyle = hexA(INKB, .8); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(result).toUpperCase(), 540, cy); ls(ctx, 0);
    function out(cx, txt, col) { pill(ctx, cx, cy, String(txt).toUpperCase(), { font: font('800', 23, BR), lsp: 1, padX: 18, h: 46, bg: col, color: contrastInk(col) }); }
    out(238, outA, colA); out(842, outB, colB);
  }
  function renderQualify(ctx, p, flags) {
    var CREAM = '#F4F2EB', INKB = '#14171C', RED = '#C8102E', MUTE = '#8A93A0';
    ctx.fillStyle = CREAM; ctx.fillRect(0, 0, W, W); fifaRibbon(ctx, 0, 10);
    creamHead(ctx, 84, 70, 22);
    if (p.context) { ctx.font = font('700', 22, BR); ls(ctx, 1); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = MUTE; ctx.fillText(String(p.context).toUpperCase(), 1016, 70); ls(ctx, 0); }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = INKB;
    var t = String(p.title || 'WHAT THEY NEED').toUpperCase(), ts = fitFont(ctx, t, '700', 64, KH, W - 128, 0); ctx.font = font('700', ts, KH); ctx.fillText(t, 64, 170);
    if (p.subtitle) { ctx.font = font('700', 24, BR); ls(ctx, 1); ctx.fillStyle = RED; ctx.fillText(String(p.subtitle).toUpperCase(), 66, 208); ls(ctx, 0); }
    ctx.strokeStyle = hexA(INKB, .15); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(64, 250); ctx.lineTo(1016, 250); ctx.stroke();
    ctx.save(); ctx.shadowColor = 'rgba(20,23,28,.2)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3; drawMiniFlag(ctx, flags[p.ac], 150, 296, 132, 88); drawMiniFlag(ctx, flags[p.bc], 798, 296, 132, 88); ctx.restore();
    ctx.fillStyle = INKB; ctx.font = font('700', 58, KH); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('VS', 540, 340);
    ctx.textBaseline = 'alphabetic';
    var na = fitFont(ctx, String(p.an || '').toUpperCase(), '700', 46, KH, 380, 0); ctx.font = font('700', na, KH); ctx.fillStyle = INKB; ctx.fillText(String(p.an || '').toUpperCase(), 216, 440);
    var nb = fitFont(ctx, String(p.bn || '').toUpperCase(), '700', 46, KH, 380, 0); ctx.font = font('700', nb, KH); ctx.fillText(String(p.bn || '').toUpperCase(), 864, 440);
    var la = LIGHTC[p.lightA] || MUTE, lb = LIGHTC[p.lightB] || MUTE;
    if (p.verdictA) pill(ctx, 216, 488, String(p.verdictA).toUpperCase(), { font: font('800', 23, BR), lsp: 1, padX: 20, h: 52, bg: la, color: contrastInk(la) });
    if (p.verdictB) pill(ctx, 864, 488, String(p.verdictB).toUpperCase(), { font: font('800', 23, BR), lsp: 1, padX: 20, h: 52, bg: lb, color: contrastInk(lb) });
    var scen = (p.scenarios || []).slice(0, 3), top = 566, rowH = scen.length ? Math.min(110, (W - top - 156) / scen.length) : 110;
    scen.forEach(function (s, i) { drawScenarioRow(ctx, top + i * rowH, rowH, s.result, s.outA, s.outB, LIGHTC[s.lightA] || MUTE, LIGHTC[s.lightB] || MUTE); });
    if (p.kicker) { ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = hexA(INKB, .6); var ks = fitFont(ctx, String(p.kicker), '600', 26, BR, W - 140, 0); ctx.font = font('600', ks, BR); ctx.fillText(String(p.kicker), 540, W - 116); }
    creamFooter(ctx, p.footnote);
  }
  // ---- PERMUTATIONS (whole-group qualification matrix) ----
  function renderPermutations(ctx, p, flags) {
    var CREAM = '#F4F2EB', INKB = '#14171C', MUTE = '#8A93A0';
    var STATUS = { in: ['#1E9B4B', 'THROUGH'], win: ['#1E9B4B', 'WIN AND IN'], third: ['#C9A227', 'BEST THIRD'], draw: ['#FFC400', 'DRAW MIGHT DO'], mustwin: ['#ED2939', 'WIN OR HOME'], out: ['#14171C', 'ELIMINATED'] };
    ctx.fillStyle = CREAM; ctx.fillRect(0, 0, W, W); fifaRibbon(ctx, 0, 10);
    creamHead(ctx, 86, 96, 24);
    ctx.fillStyle = INKB; ctx.font = font('700', 54, KH); ls(ctx, 1); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(String(p.group || 'GROUP').toUpperCase(), 1016, 96); ls(ctx, 0);
    if (p.kicker) { ctx.font = font('700', 22, BR); ls(ctx, 1); ctx.fillStyle = '#C8102E'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(String(p.kicker).toUpperCase(), 64, 166); ls(ctx, 0); }
    var rows = (p.rows || []).slice(0, 4), top = 196, rowH = 130;
    rows.forEach(function (r, i) {
      var y = top + i * rowH, cy = y + rowH / 2, st = STATUS[r.status] || [MUTE, r.tag || ''], col = st[0];
      if (i) { ctx.strokeStyle = hexA(INKB, .1); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(64, y); ctx.lineTo(1016, y); ctx.stroke(); }
      ctx.fillStyle = col; rrect(ctx, 64, y + 16, 8, rowH - 32, 4); ctx.fill();
      ctx.save(); ctx.shadowColor = 'rgba(20,23,28,.2)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2; drawMiniFlag(ctx, flags[r.code], 96, cy - 32, 96, 64); ctx.restore();
      ctx.fillStyle = INKB; ctx.font = font('700', 40, KH); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(String(r.name || '').toUpperCase(), 220, cy - 6);
      ctx.font = font('800', 20, BR); ls(ctx, 1); ctx.fillStyle = MUTE; ctx.fillText(String(r.pts || '').toUpperCase(), 220, cy + 26); ls(ctx, 0);
      var tag = String(r.tag || st[1]).toUpperCase(); ctx.font = font('800', 21, BR); ls(ctx, 1); var tw = ctx.measureText(tag).width + 36; ls(ctx, 0);
      pill(ctx, 1016 - tw / 2, cy - 32, tag, { font: font('800', 21, BR), lsp: 1, padX: 18, h: 42, bg: col, color: contrastInk(col) });
      if (r.line) { ctx.font = font('600', 22, BR); ctx.fillStyle = hexA(INKB, .68); ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'; var lns = wrapLines(ctx, String(r.line), 470); lns.slice(0, 2).forEach(function (ln, k) { ctx.fillText(ln, 1016, cy + 14 + k * 27); }); }
    });
    creamFooter(ctx, p.footnote || 'gosportacle.com');
  }
  // ---- HOUSE LINE (engine-as-antagonist taunt + reply bait) ----
  function renderHouseLine(ctx, p, flag) {
    var CREAM = '#F4F2EB', INKD = '#11161F', RED = '#C8102E', col = p.color || '#0A3478', heroH = 668;
    ctx.fillStyle = col; ctx.fillRect(0, 0, W, heroH);
    if (flag && flag.naturalWidth) cover(ctx, flag, 0, 0, W, heroH, 0.5, 0.4);
    ctx.save(); ctx.globalAlpha = 0.32; ctx.fillStyle = col; ctx.fillRect(0, 0, W, heroH); ctx.restore();
    var tsc = ctx.createLinearGradient(0, 0, 0, 230); tsc.addColorStop(0, 'rgba(8,10,14,.5)'); tsc.addColorStop(1, 'rgba(8,10,14,0)');
    ctx.fillStyle = tsc; ctx.fillRect(0, 0, W, 230);
    var sc = ctx.createLinearGradient(0, 360, 0, heroH); sc.addColorStop(0, 'rgba(8,10,14,0)'); sc.addColorStop(1, 'rgba(8,10,14,.62)');
    ctx.fillStyle = sc; ctx.fillRect(0, 360, W, heroH - 360);
    fifaRibbon(ctx, 0, 8);
    ctx.textAlign = 'center';
    ctx.font = font('800', 30, BR); ls(ctx, 8); ctx.fillStyle = 'rgba(244,242,235,.92)'; ctx.textBaseline = 'alphabetic';
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 12; ctx.fillText(String(p.kicker || 'THE HOUSE SAYS').toUpperCase(), 540, 150); ctx.restore(); ls(ctx, 0);
    ctx.font = font('700', 290, KH); ctx.fillStyle = CREAM; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.lineWidth = 9; ctx.strokeStyle = INKD;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 26; ctx.shadowOffsetY = 8; ctx.strokeText(String(p.pct || ''), 540, 372); ctx.fillText(String(p.pct || ''), 540, 372); ctx.restore();
    ctx.textBaseline = 'alphabetic'; ctx.fillStyle = CREAM;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 12; var sj = fitFont(ctx, String(p.subject || '').toUpperCase(), '600', 40, KH, W - 120, 0); ctx.font = font('600', sj, KH); ctx.fillText(String(p.subject || '').toUpperCase(), 540, 560); ctx.restore();
    // cream band
    ctx.fillStyle = CREAM; ctx.fillRect(0, heroH, W, W - heroH);
    fifaRibbon(ctx, heroH - 5, 10);
    drawQuoteGlyph(ctx, 66, heroH + 30, 60, RED, .9);
    ctx.fillStyle = INKD; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    var tw = fitWrap(ctx, String(p.taunt || '').toUpperCase(), '700', 70, KH, W - 130, 2, 40), lh = tw.size * 0.86;
    ctx.font = font('700', tw.size, KH); for (var i = 0; i < tw.lines.length; i++) ctx.fillText(tw.lines[i], 66, heroH + 132 + i * lh);
    var afterY = heroH + 132 + tw.lines.length * lh;
    if (p.sub) { var ss = fitFont(ctx, String(p.sub), '600', 27, BR, W - 160, 0); ctx.font = font('600', ss, BR); ctx.fillStyle = hexA(INKD, .6); ctx.fillText(String(p.sub), 80, afterY + 8); }
    ctx.font = font('700', 26, BR); ls(ctx, 2); ctx.fillStyle = RED; ctx.textBaseline = 'middle'; ctx.fillText(String(p.prompt || 'REPLY YOUR NUMBER').toUpperCase(), 64, W - 46); ls(ctx, 0);
    ctx.font = font('700', 30, KH); ls(ctx, 2); ctx.textAlign = 'left';
    var t1 = 'SPORT', t2 = 'ACLE', b1 = ctx.measureText(t1).width, b2 = ctx.measureText(t2).width, wx = W - 28 - b1 - b2;
    ctx.fillStyle = INKD; ctx.fillText(t1, wx, W - 45); ctx.fillStyle = RED; ctx.fillText(t2, wx + b1, W - 45); ls(ctx, 0);
  }
  // ---- STANDINGS (group table, provisional during live games) ----
  function renderStandingsCard(ctx, p, flags) {
    var live = !!p.live, accent = live ? '#C8102E' : '#1E9B4B';
    ctx.fillStyle = '#0d1016'; ctx.fillRect(0, 0, W, W);
    var rg = ctx.createRadialGradient(540, 90, 0, 540, 90, 840); rg.addColorStop(0, hexA(accent, 0.16)); rg.addColorStop(1, 'rgba(13,16,22,0)');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, W);
    ctx.fillStyle = '#fff'; ctx.font = font('700', 76, KH); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    var title = String(p.title || p.group || 'Group').toUpperCase(); ctx.fillText(title, 64, 128);
    if (live) pill(ctx, 64 + ctx.measureText(title).width + 86, 102, 'LIVE', { font: font('800', 26, BR), lsp: 3, padX: 22, h: 46, bg: '#C8102E', color: '#fff' });
    var cols = [['P', 566], ['W', 652], ['D', 738], ['L', 824], ['GD', 930], ['PTS', 1032]];
    ctx.font = font('800', 22, BR); ls(ctx, 1.5); ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    cols.forEach(function (c) { ctx.fillText(c[0], c[1], 214); });
    ctx.textAlign = 'left'; ctx.fillText('TEAM', 66, 214); ls(ctx, 0);
    var rows = (p.rows || []).slice(0, 4), rowTop = 256, rowH = rows.length ? Math.min(152, (W - rowTop - 116) / rows.length) : 150;
    rows.forEach(function (r, i) {
      var cy = rowTop + i * rowH + rowH / 2;
      if (r.live) { ctx.fillStyle = 'rgba(200,16,46,.13)'; rrect(ctx, 40, cy - rowH / 2 + 6, W - 80, rowH - 12, 14); ctx.fill(); }
      // top 2 advance (green); a 3rd-placed team holding a best-third spot advances too (gold)
      var spine = i < 2 ? '#1E9B4B' : (r.adv ? '#C9A227' : null);
      if (spine) { ctx.fillStyle = spine; rrect(ctx, 42, cy - rowH / 2 + 12, 6, rowH - 24, 3); ctx.fill(); }
      ctx.font = font('700', 46, KH); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = i < 2 ? '#37C46A' : (r.adv ? '#E3B83C' : 'rgba(255,255,255,.5)');
      ctx.fillText(String(i + 1), 88, cy);
      var fw = 64, fh = 43; drawMiniFlag(ctx, flags[r.code], 130, cy - fh / 2, fw, fh);
      ctx.font = font('700', 41, KH); ctx.textAlign = 'left'; ctx.fillStyle = '#fff';
      var name = String(r.name || ''), maxW = 300; if (ctx.measureText(name).width > maxW) { while (name.length > 3 && ctx.measureText(name + '…').width > maxW) name = name.slice(0, -1); name += '…'; }
      ctx.fillText(name, 216, cy + 1);
      ctx.textAlign = 'right'; ctx.font = font('600', 40, KH); ctx.fillStyle = 'rgba(255,255,255,.82)';
      var vals = [r.P, r.W, r.D, r.L, (r.GD > 0 ? '+' : '') + r.GD];
      for (var j = 0; j < 5; j++) ctx.fillText(String(vals[j]), cols[j][1], cy + 1);
      ctx.font = font('700', 46, KH); ctx.fillStyle = r.live ? '#FF5A6A' : '#fff'; ctx.fillText(String(r.Pts), 1032, cy + 1);
    });
    ctx.font = font('700', 36, KH); ls(ctx, 3); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var t1 = 'SPORT', t2 = 'ACLE', bw1 = ctx.measureText(t1).width, bw2 = ctx.measureText(t2).width, fx = 540 - (bw1 + bw2) / 2, fy = W - 52;
    ctx.textAlign = 'left'; ctx.fillStyle = '#fff'; ctx.fillText(t1, fx, fy); ctx.fillStyle = accent; ctx.fillText(t2, fx + bw1, fy);
    ls(ctx, 0); ctx.font = font('700', 17, BR); ls(ctx, 2); ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.fillText(String(p.footnote || 'WORLD CUP 2026 · TOP 2 + BEST THIRDS ADVANCE').toUpperCase(), fx + bw1 + bw2 + 16, fy + 1); ls(ctx, 0);
  }

  // ---- public entry ----
  function renderTo(canvas, type, p, scale) {
    scale = scale || 2;
    canvas.width = W * scale; canvas.height = W * scale;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    return ensureFonts().then(function () {
      if (type === 'stats') {
        return (p.photo ? loadImg(p.photo) : Promise.resolve(null)).then(function (ph) { renderStats(ctx, p, ph); });
      }
      if (type === 'infographic' || type === 'standings' || type === 'cooked') {
        var codes = (p.rows || []).map(function (r) { return r.code; });
        return Promise.all(codes.map(loadFlag)).then(function (imgs) {
          var fmap = {}; codes.forEach(function (c, i) { fmap[c] = imgs[i]; });
          if (type === 'standings') renderStandingsCard(ctx, p, fmap); else renderLeaderboard(ctx, p, fmap);
        });
      }
      if (type === 'oddsboard' || type === 'movers' || type === 'tierboard' || type === 'qualify' || type === 'permutations') {
        var cds = [];
        if (type === 'oddsboard') { if (p.code) cds.push(p.code); (p.rows || []).forEach(function (r) { if (r.code) cds.push(r.code); }); }
        else if (type === 'movers') { (p.risers || []).concat(p.fallers || []).forEach(function (c) { if (c.code) cds.push(c.code); }); }
        else if (type === 'qualify') { if (p.ac) cds.push(p.ac); if (p.bc) cds.push(p.bc); }
        else if (type === 'permutations') { (p.rows || []).forEach(function (r) { if (r.code) cds.push(r.code); }); }
        else { (p.tiers || []).forEach(function (t) { (t.teams || []).forEach(function (x) { if (x.code) cds.push(x.code); }); }); }
        return Promise.all(cds.map(loadFlag)).then(function (imgs) {
          var fmap = {}; cds.forEach(function (c, i) { fmap[c] = imgs[i]; });
          if (type === 'oddsboard') renderOddsboard(ctx, p, fmap);
          else if (type === 'movers') renderMovers(ctx, p, fmap);
          else if (type === 'qualify') renderQualify(ctx, p, fmap);
          else if (type === 'permutations') renderPermutations(ctx, p, fmap);
          else renderTierboard(ctx, p, fmap);
        });
      }
      if (type === 'houseline') {
        return loadFlag(p.code).then(function (f) { renderHouseLine(ctx, p, f); });
      }
      if (type === 'goal') {
        return Promise.all([loadFlag(p.code), loadFlag(p.code), loadFlag(p.vs)]).then(function (f) {
          renderGoal(ctx, p, f[0], f[1], f[2]);
        });
      }
      if (type === 'quotecard') {
        return Promise.all([loadFlag(p.code), p.photo ? loadImg(p.photo) : Promise.resolve(null)]).then(function (f) {
          renderQuoteCard(ctx, p, { flag: f[0], photo: f[1] });
        });
      }
      if (type === 'macro') {
        return ensureAnton().then(function () {
          return Promise.all([loadFlag(p.ac), loadFlag(p.bc), p.photo ? loadImg(p.photo) : Promise.resolve(null)]).then(function (f) {
            renderMacro(ctx, p, { a: f[0], b: f[1], photo: f[2] });
          });
        });
      }
      return Promise.all([loadFlag(p.ac), loadFlag(p.bc)]).then(function (f) {
        var F = { a: f[0], b: f[1] };
        if (type === 'whowins') renderWhoWins(ctx, p, F); else if (type === 'verdict') renderVerdict(ctx, p, F); else if (type === 'panel') renderPanel(ctx, p, F); else if (type === 'ticker') renderTicker(ctx, p, F); else if (type === 'matchday') renderMatchday(ctx, p, F); else renderFinal(ctx, p, F);
      });
    });
  }

  window.SportacleRender = { renderTo: renderTo };
})();
