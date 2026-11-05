/* =============================================================================
   cells.js — hand-drawn neuroimmune cells for the hero background
   =============================================================================
   No images, no dependencies. Every cell is drawn with canvas paths in a loose
   ink style: each outline is stroked twice with per-point jitter, and the
   cytoplasm wash is offset slightly from the outline, the way a watercolour
   sits off its pen line.

   Drifting layer : immune cells + microglia (all motile in vivo)
   Static layer   : neuron, astrocyte, oligodendrocyte (resident, they stay put)
   Signalling     : faint pulses travel between cells that come near each other

   HOW TO USE ON THE SITE
   ----------------------
   index.html already has  <canvas id="cell-net">  and  <script src="cells.js">
   so this file self-mounts on load. Nothing else to do.

   To tune it, edit DEFAULTS below, or mount by hand:

     HeroCells.mount(document.querySelector('#cell-net'), {
       presence: 0.28,        // 0.08 barely there … 0.6 clearly visible
       density: 1,            // multiplier on the number of drifting cells
       colorMode: 'per-type'  // 'per-type' | 'two-ink' | 'single-ink'
     });

   To add a cell type: add an entry to TYPES and a draw function to DRAW with
   the same id. Everything else (palette, sprites, motion) picks it up.
   ========================================================================== */

(function (global) {
'use strict';

/* ── DEFAULTS ─────────────────────────────────────────────────────────────── */

var DEFAULTS = {
  presence:   0.32,       // master opacity of the drifting layer
  density:    3,          // 1 ≈ one cell per 42 000 px² of hero
  colorMode:  'per-type',
  speed:      1.2,        // drift speed multiplier
  linkRange:  230,        // px within which two cells can signal
  pulseEvery: 1500        // ms between signalling attempts
};

/* ── COLOUR ───────────────────────────────────────────────────────────────────
   oklch → sRGB, done in JS so the exact same colours land in every browser
   and so hues can be interpolated without going muddy. Muted by construction:
   every ink shares one lightness and chroma, only the hue changes.          */

function oklch(L, C, H, a) {
  var h = H * Math.PI / 180, A = Math.cos(h) * C, B = Math.sin(h) * C;
  var l_ = L + 0.3963377774 * A + 0.2158037573 * B,
      m_ = L - 0.1055613458 * A - 0.0638541728 * B,
      s_ = L - 0.0894841775 * A - 1.2914855480 * B;
  var l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  var r =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  function f(v) {
    v = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  }
  return 'rgba(' + f(r) + ',' + f(g) + ',' + f(b) + ',' + a + ')';
}

var INK_L = 0.50, INK_C = 0.125;   // pen
var WASH_L = 0.85, WASH_C = 0.080; // cytoplasm
var SITE_HUE = 296;                // the site's existing purple

function hueFor(type, mode) {
  if (mode === 'single-ink') return SITE_HUE;
  if (mode === 'two-ink')    return type.family === 'neural' ? 62 : 300;
  return type.hue;
}

/* ── TYPES ────────────────────────────────────────────────────────────────────
   reach = how far the drawing extends past r, in units of r. Used to size
   sprites and reference tiles so processes never get clipped.               */

var TYPES = [
  { id:'tcell',      label:'T cell',           hue:250, family:'immune', motile:true,  reach:1.10,
    note:'round, thin rim, one large concentric nucleus' },
  { id:'bcell',      label:'B cell',           hue:230, family:'immune', motile:true,  reach:1.12,
    note:'a T cell with a slightly ruffled surface' },
  { id:'nk',         label:'NK cell',          hue:268, family:'immune', motile:true,  reach:1.12,
    note:'eccentric oval nucleus, scattered granules' },
  { id:'monocyte',   label:'Monocyte',         hue:308, family:'immune', motile:true,  reach:1.14,
    note:'gently waved rim, kidney-shaped nucleus' },
  { id:'macrophage', label:'Macrophage',       hue:328, family:'immune', motile:true,  reach:1.22,
    note:'scalloped membrane, pale vesicles in the cytoplasm' },
  { id:'neutrophil', label:'Neutrophil',       hue:290, family:'immune', motile:true,  reach:1.16,
    note:'three-lobed nucleus, fine dense granules' },
  { id:'basophil',   label:'Basophil',         hue:348, family:'immune', motile:true,  reach:1.14,
    note:'bilobed nucleus buried in coarse granules' },
  { id:'dendritic',  label:'Dendritic cell',   hue:284, family:'immune', motile:true,  reach:1.70,
    note:'small soma, long thin curving dendrites' },
  { id:'microglia',  label:'Microglia',        hue:22,  family:'neural', motile:true,  reach:1.75,
    note:'small soma, finely ramified processes' },
  { id:'neuron',     label:'Neuron',           hue:62,  family:'neural', motile:false, reach:2.15,
    note:'pyramidal soma, spiny apical arbor, one long axon' },
  { id:'astrocyte',  label:'Astrocyte',        hue:104, family:'neural', motile:false, reach:1.65,
    note:'bushy fine processes, endfeet at the tips' },
  { id:'oligodendrocyte', label:'Oligodendrocyte', hue:38, family:'neural', motile:false, reach:1.85,
    note:'processes ending in myelin sheaths on passing axons' }
];

var BY_ID = {};
TYPES.forEach(function (t) { BY_ID[t.id] = t; });

/* ── RNG ──────────────────────────────────────────────────────────────────── */

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ── INK PRIMITIVES ───────────────────────────────────────────────────────── */

function traceSmooth(ctx, pts, close) {
  var n = pts.length, i, c, x;
  ctx.beginPath();
  if (close) {
    ctx.moveTo((pts[0].x + pts[n - 1].x) / 2, (pts[0].y + pts[n - 1].y) / 2);
    for (i = 0; i < n; i++) {
      c = pts[i]; x = pts[(i + 1) % n];
      ctx.quadraticCurveTo(c.x, c.y, (c.x + x.x) / 2, (c.y + x.y) / 2);
    }
    ctx.closePath();
  } else {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (i = 1; i < n - 1; i++) {
      c = pts[i]; x = pts[i + 1];
      ctx.quadraticCurveTo(c.x, c.y, (c.x + x.x) / 2, (c.y + x.y) / 2);
    }
    ctx.lineTo(pts[n - 1].x, pts[n - 1].y);
  }
}

function nudge(pts, amt, rnd) {
  return pts.map(function (p) {
    return { x: p.x + (rnd() * 2 - 1) * amt, y: p.y + (rnd() * 2 - 1) * amt };
  });
}

/* two passes at different jitter = the look of a pen going round twice */
function inkStroke(ctx, pts, close, lw, ink, rnd, alpha) {
  var a = alpha == null ? 1 : alpha;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  traceSmooth(ctx, nudge(pts, lw * 0.5, rnd), close);
  ctx.lineWidth = lw; ctx.strokeStyle = ink(0.7 * a); ctx.stroke();
  traceSmooth(ctx, nudge(pts, lw * 1.1, rnd), close);
  ctx.lineWidth = lw * 0.6; ctx.strokeStyle = ink(0.22 * a); ctx.stroke();
}

/* wash deliberately off-register from the pen line */
function inkWash(ctx, pts, fill, rnd, off) {
  var dx = (rnd() * 2 - 1) * off, dy = (rnd() * 2 - 1) * off;
  traceSmooth(ctx, pts.map(function (p) { return { x: p.x + dx, y: p.y + dy }; }), true);
  ctx.fillStyle = fill; ctx.fill();
}

function disc(ctx, x, y, r, fill) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill; ctx.fill();
}

/* ── SHAPE BUILDERS ───────────────────────────────────────────────────────── */

function blob(rx, ry, rot, wob, n, rnd) {
  var pts = [], c = Math.cos(rot), s = Math.sin(rot), i, a, k, x, y;
  for (i = 0; i < n; i++) {
    a = (i / n) * Math.PI * 2;
    k = 1 + (rnd() * 2 - 1) * wob;
    x = Math.cos(a) * rx * k; y = Math.sin(a) * ry * k;
    pts.push({ x: x * c - y * s, y: x * s + y * c });
  }
  return pts;
}

function scallop(r, lobes, amp, n, rnd) {
  var pts = [], i, a, rr;
  for (i = 0; i < n; i++) {
    a = (i / n) * Math.PI * 2;
    rr = r * (1 + amp * Math.sin(a * lobes + 0.4) + (rnd() * 2 - 1) * 0.035);
    pts.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
  }
  return pts;
}

/* kidney / bean: one side pushed in */
function bean(r, rot, indent, rnd) {
  var pts = [], n = 24, c = Math.cos(rot), s = Math.sin(rot), i, a, d, rr, x, y;
  for (i = 0; i < n; i++) {
    a = (i / n) * Math.PI * 2;
    d = Math.max(0, Math.cos(a));
    rr = r * (1 - indent * Math.pow(d, 1.5)) * (1 + (rnd() * 2 - 1) * 0.035);
    x = Math.cos(a) * rr; y = Math.sin(a) * rr * 0.94;
    pts.push({ x: x * c - y * s, y: x * s + y * c });
  }
  return pts;
}

/* tapering, slightly wandering process, drawn as one filled outline so the
   width falls off smoothly instead of beading at segment joints */
function limb(ctx, x0, y0, ang, len, w0, ink, rnd, depth, curve, branchAt, spines) {
  var segs = 9, pts = [{ x: x0, y: y0 }], x = x0, y = y0, a = ang, i, t, w, pa, nx, ny;
  for (i = 0; i < segs; i++) {
    a += curve + (rnd() * 2 - 1) * 0.13;
    x += Math.cos(a) * len / segs; y += Math.sin(a) * len / segs;
    pts.push({ x: x, y: y });
  }
  var half = w0 * 0.5, left = [], right = [];
  for (i = 0; i < pts.length; i++) {
    t = i / (pts.length - 1);
    w = Math.max(0.28, half * ((1 - t) * (1 - t) * 0.92 + 0.1));
    pa = i === 0
      ? Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x)
      : Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
    nx = -Math.sin(pa) * w; ny = Math.cos(pa) * w;
    left.push({ x: pts[i].x + nx, y: pts[i].y + ny });
    right.push({ x: pts[i].x - nx, y: pts[i].y - ny });
  }
  traceSmooth(ctx, left.concat(right.slice().reverse()), true);
  ctx.fillStyle = ink(0.44); ctx.fill();
  var k = Math.max(2, Math.round(pts.length * 0.45));   // denser where it leaves the soma
  traceSmooth(ctx, left.slice(0, k).concat(right.slice(0, k).reverse()), true);
  ctx.fillStyle = ink(0.16); ctx.fill();
  if (spines) {
    for (i = 2; i < pts.length - 1; i++) {
      var side = (i % 2 ? 1 : -1), sa = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
      var sl = half * (1.05 + rnd() * 0.7), sx = pts[i].x - Math.sin(sa) * sl * side,
          sy = pts[i].y + Math.cos(sa) * sl * side;
      ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(sx, sy);
      ctx.lineWidth = Math.max(0.3, half * 0.2); ctx.strokeStyle = ink(0.34);
      ctx.lineCap = 'round'; ctx.stroke();
      disc(ctx, sx, sy, Math.max(0.35, half * 0.26), ink(0.36));
    }
  }
  if (depth > 0) {
    var bp = pts[Math.max(1, Math.floor(pts.length * (branchAt || 0.55)))];
    limb(ctx, bp.x, bp.y, a - 0.65 - rnd() * 0.3, len * 0.52, w0 * 0.62, ink, rnd, depth - 1, curve * 0.8, branchAt, spines);
    limb(ctx, bp.x, bp.y, a + 0.65 + rnd() * 0.3, len * 0.52, w0 * 0.62, ink, rnd, depth - 1, curve * 0.8, branchAt, spines);
  }
  return { x: x, y: y, a: a };
}

/* ── SPECS ────────────────────────────────────────────────────────────────── */

function makeSpec(typeId, r, seed, colorMode) {
  var t = BY_ID[typeId];
  var hue = hueFor(t, colorMode || 'per-type');
  return {
    type: typeId,
    r: r,
    reach: t.reach,
    ink:  function (a) { return oklch(INK_L,  INK_C,  hue, a); },
    wash: function (a) { return oklch(WASH_L, WASH_C, hue, a); },
    seed: seed == null ? 1 : seed
  };
}

/* ── DRAW ─────────────────────────────────────────────────────────────────── */

var DRAW = {

  tcell: function (ctx, s, rnd) {
    var m = blob(s.r, s.r * 0.97, rnd() * 6, 0.045, 16, rnd);
    inkWash(ctx, m, s.wash(0.85), rnd, s.r * 0.024);
    inkStroke(ctx, m, true, s.r * 0.046, s.ink, rnd);
    var nu = blob(s.r * 0.62, s.r * 0.60, rnd() * 6, 0.05, 14, rnd)
              .map(function (p) { return { x: p.x + s.r * 0.05, y: p.y - s.r * 0.03 }; });
    inkWash(ctx, nu, s.ink(0.26), rnd, s.r * 0.02);
    inkStroke(ctx, nu, true, s.r * 0.036, s.ink, rnd, 0.8);
  },

  bcell: function (ctx, s, rnd) {
    var m = scallop(s.r * 0.95, 9, 0.05, 30, rnd);
    inkWash(ctx, m, s.wash(0.85), rnd, s.r * 0.024);
    inkStroke(ctx, m, true, s.r * 0.046, s.ink, rnd);
    var nu = blob(s.r * 0.58, s.r * 0.57, rnd() * 6, 0.06, 14, rnd)
              .map(function (p) { return { x: p.x - s.r * 0.06, y: p.y + s.r * 0.04 }; });
    inkWash(ctx, nu, s.ink(0.26), rnd, s.r * 0.02);
    inkStroke(ctx, nu, true, s.r * 0.036, s.ink, rnd, 0.8);
  },

  nk: function (ctx, s, rnd) {
    var m = blob(s.r, s.r * 0.96, rnd() * 6, 0.05, 16, rnd);
    inkWash(ctx, m, s.wash(0.85), rnd, s.r * 0.024);
    inkStroke(ctx, m, true, s.r * 0.046, s.ink, rnd);
    var nu = blob(s.r * 0.60, s.r * 0.46, -0.55, 0.05, 14, rnd)
              .map(function (p) { return { x: p.x + s.r * 0.08, y: p.y + s.r * 0.10 }; });
    inkWash(ctx, nu, s.ink(0.26), rnd, s.r * 0.02);
    inkStroke(ctx, nu, true, s.r * 0.034, s.ink, rnd, 0.75);
    for (var g = 0; g < 9; g++) {
      var ga = rnd() * Math.PI * 2, gd = 0.42 + rnd() * 0.42;
      disc(ctx, Math.cos(ga) * s.r * gd, Math.sin(ga) * s.r * gd,
           s.r * (0.05 + rnd() * 0.04), s.ink(0.3));
    }
  },

  monocyte: function (ctx, s, rnd) {
    var m = scallop(s.r * 0.96, 7, 0.06, 30, rnd);
    inkWash(ctx, m, s.wash(0.85), rnd, s.r * 0.024);
    inkStroke(ctx, m, true, s.r * 0.046, s.ink, rnd);
    var nu = bean(s.r * 0.62, 2.35, 0.78, rnd)
              .map(function (p) { return { x: p.x - s.r * 0.05, y: p.y - s.r * 0.04 }; });
    inkWash(ctx, nu, s.ink(0.26), rnd, s.r * 0.02);
    inkStroke(ctx, nu, true, s.r * 0.036, s.ink, rnd, 0.8);
  },

  macrophage: function (ctx, s, rnd) {
    var m = scallop(s.r * 0.9, 11, 0.10, 40, rnd);
    inkWash(ctx, m, s.wash(0.85), rnd, s.r * 0.028);
    inkStroke(ctx, m, true, s.r * 0.044, s.ink, rnd);
    var nu = blob(s.r * 0.42, s.r * 0.41, rnd() * 6, 0.05, 14, rnd);
    inkWash(ctx, nu, s.ink(0.28), rnd, s.r * 0.02);
    inkStroke(ctx, nu, true, s.r * 0.034, s.ink, rnd, 0.8);
    for (var v = 0; v < 7; v++) {          // lysosomes / phagosomes
      var va = rnd() * Math.PI * 2, vd = 0.52 + rnd() * 0.25, vr = s.r * (0.07 + rnd() * 0.06);
      var vx = Math.cos(va) * s.r * vd, vy = Math.sin(va) * s.r * vd;
      disc(ctx, vx, vy, vr, s.wash(0.9));
      ctx.beginPath(); ctx.arc(vx, vy, vr, 0, Math.PI * 2);
      ctx.lineWidth = s.r * 0.022; ctx.strokeStyle = s.ink(0.34); ctx.stroke();
    }
  },

  neutrophil: function (ctx, s, rnd) {
    var m = scallop(s.r * 0.95, 8, 0.055, 32, rnd);
    inkWash(ctx, m, s.wash(0.85), rnd, s.r * 0.024);
    inkStroke(ctx, m, true, s.r * 0.046, s.ink, rnd);
    for (var g = 0; g < 26; g++) {         // fine granules, under the nucleus
      var ga = rnd() * Math.PI * 2, gd = rnd() * 0.82;
      disc(ctx, Math.cos(ga) * s.r * gd, Math.sin(ga) * s.r * gd,
           s.r * (0.035 + rnd() * 0.03), s.ink(0.2));
    }
    var lobes = [[-0.34, -0.16, 0.30], [0.10, -0.30, 0.27], [0.26, 0.20, 0.29]];
    ctx.lineCap = 'round';                 // chromatin bridges first
    for (var i = 0; i < lobes.length - 1; i++) {
      ctx.beginPath();
      ctx.moveTo(lobes[i][0] * s.r, lobes[i][1] * s.r);
      ctx.lineTo(lobes[i + 1][0] * s.r, lobes[i + 1][1] * s.r);
      ctx.lineWidth = s.r * 0.16; ctx.strokeStyle = s.ink(0.2); ctx.stroke();
    }
    lobes.forEach(function (l) {
      var nu = blob(s.r * l[2], s.r * l[2] * 0.9, rnd() * 6, 0.09, 12, rnd)
                .map(function (p) { return { x: p.x + l[0] * s.r, y: p.y + l[1] * s.r }; });
      inkWash(ctx, nu, s.ink(0.26), rnd, s.r * 0.016);
      inkStroke(ctx, nu, true, s.r * 0.03, s.ink, rnd, 0.65);
    });
  },

  basophil: function (ctx, s, rnd) {
    var m = blob(s.r, s.r * 0.97, rnd() * 6, 0.055, 18, rnd);
    inkWash(ctx, m, s.wash(0.85), rnd, s.r * 0.024);
    inkStroke(ctx, m, true, s.r * 0.046, s.ink, rnd);
    [[-0.3, -0.2, 0.29], [0.26, 0.2, 0.27]].forEach(function (l) {
      var nu = blob(s.r * l[2], s.r * l[2] * 0.88, rnd() * 6, 0.08, 12, rnd)
                .map(function (p) { return { x: p.x + l[0] * s.r, y: p.y + l[1] * s.r }; });
      inkWash(ctx, nu, s.ink(0.26), rnd, s.r * 0.016);
      inkStroke(ctx, nu, true, s.r * 0.032, s.ink, rnd, 0.7);
    });
    for (var g = 0; g < 16; g++) {         // coarse granules on top
      var ga = rnd() * Math.PI * 2, gd = rnd() * 0.84;
      disc(ctx, Math.cos(ga) * s.r * gd, Math.sin(ga) * s.r * gd,
           s.r * (0.07 + rnd() * 0.05), s.ink(0.3));
    }
  },

  dendritic: function (ctx, s, rnd) {
    var n = 8 + (rnd() < 0.5 ? 0 : 1), i;
    for (i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2 + (rnd() * 2 - 1) * 0.3;
      limb(ctx, Math.cos(a) * s.r * 0.44, Math.sin(a) * s.r * 0.44, a,
           s.r * (0.9 + rnd() * 0.5), s.r * 0.05, s.ink, rnd,
           rnd() < 0.35 ? 1 : 0, (rnd() < 0.5 ? 1 : -1) * 0.19, 0.65);
    }
    var m = blob(s.r * 0.52, s.r * 0.46, rnd() * 6, 0.12, 15, rnd);
    inkWash(ctx, m, s.wash(0.88), rnd, s.r * 0.02);
    inkStroke(ctx, m, true, s.r * 0.03, s.ink, rnd);
    var nu = blob(s.r * 0.28, s.r * 0.22, -0.5, 0.06, 12, rnd);
    inkWash(ctx, nu, s.ink(0.26), rnd, s.r * 0.016);
    inkStroke(ctx, nu, true, s.r * 0.03, s.ink, rnd, 0.7);
  },

  microglia: function (ctx, s, rnd) {
    var n = 6, i;
    for (i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2 + (rnd() * 2 - 1) * 0.35;
      limb(ctx, Math.cos(a) * s.r * 0.3, Math.sin(a) * s.r * 0.3, a,
           s.r * (0.55 + rnd() * 0.25), s.r * 0.1, s.ink, rnd, 2, 0.06, 0.5);
    }
    var m = blob(s.r * 0.38, s.r * 0.34, rnd() * 6, 0.14, 14, rnd);
    inkWash(ctx, m, s.wash(0.88), rnd, s.r * 0.018);
    inkStroke(ctx, m, true, s.r * 0.03, s.ink, rnd);
    var nu = blob(s.r * 0.19, s.r * 0.16, 0.4, 0.06, 10, rnd);
    inkWash(ctx, nu, s.ink(0.28), rnd, s.r * 0.02);
  },

  neuron: function (ctx, s, rnd) {
    /* Everything that separates a neuron from the glia around it is polarity:
       one dominant apical dendrite up, spiny dendrites, and a single long thin
       unbranched axon leaving the opposite pole. */
    var i;

    /* apical trunk — much thicker than any glial process, with obliques */
    var apex = limb(ctx, 0, -s.r * 0.55, -Math.PI / 2 + (rnd() * 2 - 1) * 0.09,
                    s.r * 1.24, s.r * 0.2, s.ink, rnd, 1, 0.015, 0.58, true);
    for (i = 0; i < 3; i++) {           // terminal tuft
      limb(ctx, apex.x, apex.y, apex.a - 0.55 + i * 0.55 + (rnd() * 2 - 1) * 0.12,
           s.r * (0.3 + rnd() * 0.14), s.r * 0.075, s.ink, rnd, 0, 0.06, 0.5, true);
    }

    /* basal dendrites — short, spiny, splayed off the base corners */
    [2.62, 2.14, 0.52, 1.0].forEach(function (a) {
      limb(ctx, Math.cos(a) * s.r * 0.4, s.r * 0.44, a + (rnd() * 2 - 1) * 0.12,
           s.r * (0.42 + rnd() * 0.18), s.r * 0.115, s.ink, rnd, 1, 0.06, 0.55, true);
    });

    /* axon — thin, smooth, unbranched, out of the opposite pole */
    var hill = { x: -s.r * 0.06, y: s.r * 0.6 };
    var tip = limb(ctx, hill.x, hill.y, Math.PI * 0.52, s.r * 1.15, s.r * 0.075,
                   s.ink, rnd, 0, 0.012, 0.5, false);
    for (i = 0; i < 3; i++) {           // terminal boutons
      var ta = tip.a - 0.5 + i * 0.5;
      var bx = tip.x + Math.cos(ta) * s.r * 0.17, by = tip.y + Math.sin(ta) * s.r * 0.17;
      ctx.beginPath(); ctx.moveTo(tip.x, tip.y); ctx.lineTo(bx, by);
      ctx.lineWidth = s.r * 0.03; ctx.strokeStyle = s.ink(0.42); ctx.lineCap = 'round'; ctx.stroke();
      disc(ctx, bx, by, s.r * 0.05, s.ink(0.4));
    }

    /* pyramidal soma: narrow apex, wide base */
    var soma = [
      { x: 0, y: -s.r * 0.68 },
      { x: s.r * 0.14, y: -s.r * 0.4 }, { x: s.r * 0.38, y: s.r * 0.16 },
      { x: s.r * 0.46, y: s.r * 0.5 }, { x: s.r * 0.16, y: s.r * 0.62 },
      { x: -s.r * 0.16, y: s.r * 0.62 }, { x: -s.r * 0.46, y: s.r * 0.5 },
      { x: -s.r * 0.38, y: s.r * 0.14 }, { x: -s.r * 0.14, y: -s.r * 0.42 }
    ].map(function (p) { return { x: p.x + (rnd() * 2 - 1) * s.r * 0.035, y: p.y + (rnd() * 2 - 1) * s.r * 0.035 }; });
    inkWash(ctx, soma, s.wash(0.9), rnd, s.r * 0.024);
    inkStroke(ctx, soma, true, s.r * 0.046, s.ink, rnd);
    var nu = blob(s.r * 0.24, s.r * 0.23, rnd() * 6, 0.06, 12, rnd)
              .map(function (p) { return { x: p.x, y: p.y + s.r * 0.12 }; });
    inkWash(ctx, nu, s.ink(0.26), rnd, s.r * 0.016);
    inkStroke(ctx, nu, true, s.r * 0.03, s.ink, rnd, 0.7);
    disc(ctx, s.r * 0.05, s.r * 0.16, s.r * 0.075, s.ink(0.4));   // nucleolus
  },

  astrocyte: function (ctx, s, rnd) {
    var n = 8, i, j;
    for (i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2 + (rnd() * 2 - 1) * 0.28;
      var tip = limb(ctx, Math.cos(a) * s.r * 0.3, Math.sin(a) * s.r * 0.3, a,
                     s.r * (0.5 + rnd() * 0.2), s.r * 0.11, s.ink, rnd, 2, 0.05, 0.42);
      for (j = 0; j < 2; j++) {             // fine tufts
        limb(ctx, tip.x, tip.y, tip.a - 0.5 + j * 1.0, s.r * 0.18, s.r * 0.04,
             s.ink, rnd, 0, 0.12, 0.6);
      }
      if (rnd() < 0.55) disc(ctx, tip.x, tip.y, s.r * 0.036, s.ink(0.3));  // endfoot
    }
    var m = blob(s.r * 0.36, s.r * 0.33, rnd() * 6, 0.13, 14, rnd);
    inkWash(ctx, m, s.wash(0.88), rnd, s.r * 0.018);
    inkStroke(ctx, m, true, s.r * 0.03, s.ink, rnd);
    var nu = blob(s.r * 0.17, s.r * 0.15, 0.6, 0.06, 10, rnd);
    inkWash(ctx, nu, s.ink(0.28), rnd, s.r * 0.02);
  },

  oligodendrocyte: function (ctx, s, rnd) {
    /* One oligodendrocyte myelinates segments of several different axons, so
       each process ends on a passing axon and the sheath is a tube wrapped
       around it — the axon runs on past both ends of the internode. */
    var n = 4, i, j;
    for (i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2 + (rnd() * 2 - 1) * 0.26;
      var tip = limb(ctx, Math.cos(a) * s.r * 0.3, Math.sin(a) * s.r * 0.3, a,
                     s.r * (0.6 + rnd() * 0.18), s.r * 0.085, s.ink, rnd, 0, 0.04, 0.6, false);

      /* the axon this process is myelinating, running across the process end */
      var aa = tip.a + (Math.PI / 2) * (rnd() < 0.5 ? 1 : -1) * (0.55 + rnd() * 0.35);
      var cx = tip.x + Math.cos(tip.a) * s.r * 0.14, cy = tip.y + Math.sin(tip.a) * s.r * 0.14;
      var dx = Math.cos(aa), dy = Math.sin(aa), L = s.r * 0.62;
      ctx.beginPath();
      ctx.moveTo(cx - dx * L, cy - dy * L); ctx.lineTo(cx + dx * L, cy + dy * L);
      ctx.lineWidth = s.r * 0.036; ctx.strokeStyle = s.ink(0.36); ctx.lineCap = 'round'; ctx.stroke();

      /* internode: a capsule around it, with wrap lines */
      var sh = blob(s.r * 0.3, s.r * 0.085, aa, 0.05, 18, rnd)
                .map(function (p) { return { x: p.x + cx, y: p.y + cy }; });
      inkWash(ctx, sh, s.wash(0.94), rnd, s.r * 0.014);
      inkStroke(ctx, sh, true, s.r * 0.036, s.ink, rnd, 0.9);
      for (j = -1; j <= 1; j++) {
        var ox = cx + dx * s.r * 0.11 * j, oy = cy + dy * s.r * 0.11 * j;
        var w = s.r * 0.072 * (1 - Math.abs(j) * 0.2);
        ctx.beginPath();
        ctx.moveTo(ox + dy * w, oy - dx * w); ctx.lineTo(ox - dy * w, oy + dx * w);
        ctx.lineWidth = s.r * 0.022; ctx.strokeStyle = s.ink(0.32); ctx.stroke();
      }
    }
    var m = blob(s.r * 0.32, s.r * 0.3, rnd() * 6, 0.09, 14, rnd);
    inkWash(ctx, m, s.wash(0.88), rnd, s.r * 0.018);
    inkStroke(ctx, m, true, s.r * 0.04, s.ink, rnd);
    var nu = blob(s.r * 0.16, s.r * 0.15, 0.3, 0.06, 10, rnd);
    inkWash(ctx, nu, s.ink(0.28), rnd, s.r * 0.016);
  }
};

function drawCell(ctx, spec) {
  var rnd = mulberry32(spec.seed * 2654435761 % 2147483647 | 0);
  ctx.save();
  DRAW[spec.type](ctx, spec, rnd);
  ctx.restore();
}

/* ── HERO MOUNT ───────────────────────────────────────────────────────────── */

function mount(canvas, opts) {
  var o = {}, k;
  for (k in DEFAULTS) o[k] = DEFAULTS[k];
  for (k in (opts || {})) o[k] = opts[k];

  var ctx = canvas.getContext('2d');
  var DPR = Math.min(2, global.devicePixelRatio || 1);
  var W = 0, H = 0, drifting = [], resident = [], pulses = [];
  var raf = null, last = 0, spawnClock = 0, ro = null;
  var reduced = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var MOTILE   = TYPES.filter(function (t) { return t.motile; });
  var RESIDENT = TYPES.filter(function (t) { return !t.motile; });

  function sprite(typeId, r, seed) {
    var half = Math.ceil(r * BY_ID[typeId].reach) + 3;
    var c = document.createElement('canvas');
    c.width = c.height = Math.ceil(half * 2 * DPR);
    var cx = c.getContext('2d');
    cx.setTransform(DPR, 0, 0, DPR, 0, 0);
    cx.translate(half, half);
    drawCell(cx, makeSpec(typeId, r, seed, o.colorMode));
    return { img: c, half: half };
  }

  function build() {
    var rnd = mulberry32(20260813);
    var n = Math.round(Math.min(26, Math.max(7, (W * H) / 42000)) * o.density);
    drifting = [];
    for (var i = 0; i < n; i++) {
      var t = MOTILE[Math.floor(rnd() * MOTILE.length)];
      var r = 27 + rnd() * 19;
      var sp = sprite(t.id, r, 1 + i * 37);
      drifting.push({
        sp: sp, x: rnd() * W, y: rnd() * H,
        vx: (rnd() * 2 - 1) * 5.5 * o.speed, vy: (rnd() * 2 - 1) * 5.5 * o.speed,
        rot: rnd() * Math.PI * 2, vr: (rnd() * 2 - 1) * 0.045 * o.speed
      });
    }
    var nRes = Math.round(Math.min(7, Math.max(3, (W * H) / 150000)));
    resident = [];

    /* Scatter the static neural cells on a jittered grid rather than at free
       random. Uniform random clumps badly at these small counts — you get two
       neurons touching and a bare half of the hero. One per grid slot, shuffled
       so the type order isn't readable, jittered inside the slot so it doesn't
       look like a grid. */
    var cols = Math.max(1, Math.round(Math.sqrt(nRes * (W / Math.max(1, H)))));
    var rows = Math.max(1, Math.ceil(nRes / cols));
    var slots = [], ci, ri, si, tmp;
    for (ri = 0; ri < rows; ri++)
      for (ci = 0; ci < cols; ci++) slots.push({ c: ci, r: ri });
    for (si = slots.length - 1; si > 0; si--) {
      var kk = Math.floor(rnd() * (si + 1));
      tmp = slots[si]; slots[si] = slots[kk]; slots[kk] = tmp;
    }

    for (var j = 0; j < nRes; j++) {
      var rt = RESIDENT[j % RESIDENT.length];   // neuron → astrocyte → oligodendrocyte
      var rr = 46 + rnd() * 26;
      var slot = slots[j % slots.length];
      resident.push({
        sp: sprite(rt.id, rr, 500 + j * 91),
        x: ((slot.c + 0.15 + rnd() * 0.70) / cols) * W,
        y: ((slot.r + 0.15 + rnd() * 0.70) / rows) * H,
        rot: rnd() * Math.PI * 2
      });
    }
    pulses = [];
  }

  function resize() {
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
    if (w === W && h === H) return;
    W = w; H = h;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    build();
    frame(0, true);   // paint at once — never wait on the first animation frame,
                      // which may not come if the tab or hero is not visible yet
  }

  function trySpawn() {
    var cand = [], i, j, a, b, d;
    for (i = 0; i < drifting.length; i++) {
      for (j = i + 1; j < drifting.length; j++) {
        a = drifting[i]; b = drifting[j];
        d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < o.linkRange && d > 40) cand.push([a, b, d]);
      }
    }
    if (!cand.length) return;
    var pick = cand[Math.floor(Math.random() * cand.length)];
    pulses.push({ a: pick[0], b: pick[1], t: 0, dur: 1.5 + Math.random() * 1.2 });
  }

  function frame(dt, still) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);

    /* resident neural layer — fainter, never moves */
    ctx.globalAlpha = o.presence * 0.88;
    resident.forEach(function (c) {
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.rot);
      ctx.drawImage(c.sp.img, -c.sp.half, -c.sp.half, c.sp.half * 2, c.sp.half * 2);
      ctx.restore();
    });

    /* signalling */
    ctx.globalAlpha = 1;
    for (var i = pulses.length - 1; i >= 0; i--) {
      var p = pulses[i];
      if (!still) p.t += dt / p.dur;
      if (p.t >= 1) { pulses.splice(i, 1); continue; }
      var fade = Math.sin(Math.min(1, p.t) * Math.PI);
      var x1 = p.a.x, y1 = p.a.y, x2 = p.b.x, y2 = p.b.y;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.lineWidth = 1; ctx.strokeStyle = oklch(INK_L, INK_C * 0.6, SITE_HUE, o.presence * 0.45 * fade);
      ctx.stroke();
      var e = p.t * p.t * (3 - 2 * p.t);   // ease the messenger along
      disc(ctx, x1 + (x2 - x1) * e, y1 + (y2 - y1) * e, 2.6,
           oklch(INK_L, INK_C, SITE_HUE, o.presence * 1.5 * fade));
    }

    /* drifting layer */
    ctx.globalAlpha = o.presence;
    drifting.forEach(function (c) {
      if (!still) {
        c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.vr * dt;
        var m = c.sp.half;
        if (c.x < -m) c.x = W + m; if (c.x > W + m) c.x = -m;
        if (c.y < -m) c.y = H + m; if (c.y > H + m) c.y = -m;
      }
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.rot);
      ctx.drawImage(c.sp.img, -c.sp.half, -c.sp.half, c.sp.half * 2, c.sp.half * 2);
      ctx.restore();
    });
    ctx.globalAlpha = 1;
  }

  function loop(ts) {
    if (!last) last = ts;
    var dt = Math.min(0.05, (ts - last) / 1000);
    last = ts;
    spawnClock += dt * 1000;
    if (spawnClock > o.pulseEvery) { spawnClock = 0; trySpawn(); }
    frame(dt);
    raf = requestAnimationFrame(loop);
  }

  resize();
  if (global.ResizeObserver) { ro = new ResizeObserver(resize); ro.observe(canvas); }
  else global.addEventListener('resize', resize);
  /* Pause when the tab is hidden or the hero is scrolled out of view, so the
     loop isn't burning frames (and battery) behind a background tab. */
  var paused = false, offscreen = false;

  function shouldRun() { return !reduced && !document.hidden && !offscreen; }

  function resume() {
    if (raf || !shouldRun()) return;
    last = 0;                       // avoid one huge dt after a long pause
    raf = requestAnimationFrame(loop);
  }
  function halt() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = null;
  }
  function sync() { if (shouldRun()) resume(); else halt(); }

  document.addEventListener('visibilitychange', sync);

  var io = null;
  if (global.IntersectionObserver) {
    io = new IntersectionObserver(function (entries) {
      offscreen = !entries[0].isIntersecting;
      sync();
    }, { threshold: 0 });
    io.observe(canvas);
  }

  if (!reduced) raf = requestAnimationFrame(loop);

  return {
    update: function (next) {
      for (var kk in (next || {})) o[kk] = next[kk];
      build();
      frame(0, true);
    },
    destroy: function () {
      if (raf) cancelAnimationFrame(raf);
      if (io) io.disconnect();
      document.removeEventListener('visibilitychange', sync);
      if (ro) ro.disconnect(); else global.removeEventListener('resize', resize);
    }
  };
}

/* ── EXPORT + SELF-MOUNT ──────────────────────────────────────────────────── */

global.HeroCells = {
  TYPES: TYPES, byId: BY_ID, DEFAULTS: DEFAULTS,
  oklch: oklch, hueFor: hueFor, makeSpec: makeSpec, drawCell: drawCell, mount: mount
};

function auto() {
  var el = document.getElementById('cell-net');
  if (el && !el.__heroCells) el.__heroCells = mount(el);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto);
else auto();

}(typeof window !== 'undefined' ? window : this));
