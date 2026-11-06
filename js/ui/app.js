// Hauptsteuerung der Benutzeroberfläche
import { TYPES, isBody, isLine, hasRotation, ports, portWorld, propNum, propExpr } from '../mech/elements.js';
import { ensureParams, usedParams, paramEnv, buildModel } from '../mech/model.js';
import { setupDofs, analyze, suggestDofs } from '../mech/kinematics.js';
import { derive, METHODS } from '../mech/derive.js';
import { compile, simulate, INTEGRATORS, evalInput } from '../mech/numeric.js';
import { tryParse } from '../cas/parse.js';
import { nameToLatex } from '../cas/latex.js';
import { renderScene, makeView, paletteIcon, labelSpans, lineGeometry } from './render.js';
import { Plot, SERIES_COLORS } from './plot.js';
import { EXAMPLES } from '../examples.js';

const LS_KEY = 'mks-simulator-v1';
const $ = (s, r = document) => r.querySelector(s);
const svg = $('#canvas');
const app = $('#app');
const panel = $('#panel');

// ------------------------------------------------------------ Zustand
function emptySystem() {
  return {
    elements: [], params: {}, gravity: false, dofs: [], method: 'L2', mode: 'linear',
    sim: { init: {}, T: 5, h: 0.002, integrator: 'rk4' },
  };
}
const state = {
  sys: emptySystem(),
  step: 'model',
  tool: 'select',
  sel: null,
  pending: null,
  view: { cx: 0, cy: 0.15, s: 400 },
  hotPort: null,
  pointerW: null,
  result: null, resultKey: null, resultError: null,
  cm: null, simOut: null, simError: null,
  anim: { t: 0, playing: false, speed: 1, exag: 1, last: 0 },
  plotQty: 'q',
};

function loadInitial() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d.sys && Array.isArray(d.sys.elements)) { state.sys = normalize(d.sys); if (d.view) state.view = d.view; return; }
    }
  } catch { /* ignore */ }
  state.sys = normalize(structuredClone(EXAMPLES[0].sys));
  state.fitOnStart = true;
}
function normalize(sys) {
  const e = emptySystem();
  const s = { ...e, ...sys, sim: { ...e.sim, ...(sys.sim || {}) } };
  s.sim.init = s.sim.init || {};
  s.dofs = s.dofs || [];
  ensureParams(s);
  return s;
}
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ sys: state.sys, view: state.view })); } catch { /* voll */ }
  }, 250);
}
function modelKey() {
  const { sim, ...rest } = state.sys;
  return JSON.stringify(rest);
}
/** Nach Änderungen am Modell */
function changed({ keepResult = false } = {}) {
  ensureParams(state.sys);
  if (!keepResult) { state.cm = null; state.simOut = null; stopAnim(); }
  save();
  draw();
}

// ------------------------------------------------------------ Hilfen
let idCounter = Date.now() % 100000;
const newId = (p) => p + (idCounter++).toString(36);
const env = () => paramEnv(state.sys);
const byId = (id) => state.sys.elements.find((e) => e.id === id);
const bodies = () => state.sys.elements.filter(isBody);
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function katexStr(tex, display = false) {
  if (window.katex) {
    try { return window.katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore' }); } catch { /* */ }
  }
  return '<code>' + esc(tex) + '</code>';
}
/** Text mit $…$-Formeln */
function mathText(str) {
  return String(str).split(/(\$[^$]+\$)/g).map((p) => (p.startsWith('$') && p.endsWith('$') ? katexStr(p.slice(1, -1)) : esc(p))).join('');
}
const nameTex = (n) => { try { return nameToLatex(n); } catch { return n; } };
const snapV = (v, g = 0.05) => Math.round(v / g) * g;
const round3 = (v) => Math.round(v * 1000) / 1000;
function nextLabel() {
  const nums = bodies().map((b) => parseInt(b.label, 10)).filter(Number.isFinite);
  return String((nums.length ? Math.max(...nums) : 0) + 1);
}
function nextIndex(prefix) {
  let i = 1;
  const used = new Set(usedParams(state.sys).names);
  while (used.has(prefix + '_' + i)) i++;
  return i;
}

// ------------------------------------------------------------ Palette
const TOOLS = [
  ['Bearbeiten', [['select', 'Auswahl'], ['delete', 'Löschen']]],
  ['Körper', [['block', 'Klotz'], ['disk', 'Scheibe'], ['stepdisk', 'Stufen­rolle'], ['rod', 'Stab'], ['point', 'Punkt­masse']]],
  ['Umgebung', [['ground', 'Boden'], ['fix', 'Fest­punkt']]],
  ['Lager', [['pin', 'Fest­lager'], ['roller', 'Los­lager'], ['hinge', 'Gelenk'], ['roll', 'Rollen'], ['slide', 'Gleiten']]],
  ['Verbinder', [['rope', 'Seil'], ['spring', 'Feder'], ['damper', 'Dämpfer'], ['springdamper', 'Feder ∥ Dämpfer'], ['tspring', 'Dreh­feder'], ['tdamper', 'Dreh­dämpfer']]],
  ['Lasten', [['force', 'Kraft'], ['moment', 'Moment']]],
];
const PORT_TOOLS = new Set(['pin', 'roller', 'hinge', 'rope', 'spring', 'damper', 'springdamper', 'force']);
const LINE_TOOLS = new Set(['rope', 'spring', 'damper', 'springdamper']);
const HINTS = {
  select: 'Element antippen zum Bearbeiten, Körper ziehen zum Verschieben, Leerfläche ziehen zum Verschieben der Ansicht.',
  delete: 'Element antippen, um es zu löschen.',
  block: 'Auf die Zeichenfläche tippen, um einen Klotz zu platzieren.',
  disk: 'Auf die Zeichenfläche tippen, um eine Scheibe zu platzieren.',
  stepdisk: 'Auf die Zeichenfläche tippen, um eine Stufenrolle (zwei Radien) zu platzieren.',
  rod: 'Auf die Zeichenfläche tippen, um einen Stab zu platzieren.',
  point: 'Auf die Zeichenfläche tippen, um eine Punktmasse zu platzieren.',
  ground: 'Auf die Zeichenfläche tippen, um einen Boden (Bahn) zu platzieren.',
  fix: 'Auf die Zeichenfläche tippen, um einen Festpunkt (Wand) zu platzieren.',
  pin: 'Blauen Anschlusspunkt eines Körpers antippen → Festlager.',
  roller: 'Blauen Anschlusspunkt antippen → Loslager (Richtung danach im Panel einstellen).',
  hinge: 'Anschlusspunkt am ersten Körper, dann am zweiten Körper antippen.',
  roll: 'Scheibe antippen → rollt ohne Gleiten auf dem nächsten Boden.',
  slide: 'Körper antippen → gleitet reibungsfrei auf dem nächsten Boden (Führung).',
  rope: 'Ersten, dann zweiten Anschlusspunkt antippen (leere Fläche = Festpunkt).',
  spring: 'Ersten, dann zweiten Anschlusspunkt antippen (leere Fläche = Festpunkt).',
  damper: 'Ersten, dann zweiten Anschlusspunkt antippen (leere Fläche = Festpunkt).',
  springdamper: 'Ersten, dann zweiten Anschlusspunkt antippen (leere Fläche = Festpunkt).',
  tspring: 'Drehbaren Körper antippen, dann zweiten Körper oder leere Fläche (Umgebung).',
  tdamper: 'Drehbaren Körper antippen, dann zweiten Körper oder leere Fläche (Umgebung).',
  force: 'Anschlusspunkt antippen, an dem die Kraft angreift.',
  moment: 'Drehbaren Körper antippen.',
};
function buildPalette() {
  const p = $('#palette');
  p.innerHTML = TOOLS.map(([g, list]) => `<div class="pal-group">${g}</div>` + list.map(([id, name]) =>
    `<button class="tool" data-tool="${id}" title="${esc(name.replace(/­/g, ''))}">${paletteIcon(id)}<span>${name}</span></button>`).join('')).join('');
  p.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (!b) return;
    setTool(b.dataset.tool);
  });
}
function setTool(t) {
  state.tool = t;
  state.pending = null;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  updateHint();
  draw();
}
function updateHint() {
  let h = '';
  if (state.step === 'model') {
    h = HINTS[state.tool] || '';
    if (state.pending) {
      if (state.pending.kind === 'line') h = 'Zweiten Anschlusspunkt antippen (leere Fläche = Festpunkt). Esc bricht ab.';
      if (state.pending.kind === 'hinge') h = 'Anschlusspunkt am zweiten Körper antippen.';
      if (state.pending.kind === 'torsion') h = 'Zweiten Körper antippen oder leere Fläche (Umgebung).';
    }
  } else if (state.step === 'dof') h = 'Körper antippen, um seine Koordinaten als Freiheitsgrad zu wählen.';
  $('#hint').textContent = h;
}

// ------------------------------------------------------------ Zeichnen
let V = null;
function draw() {
  const W = svg.clientWidth, H = svg.clientHeight;
  if (!W || !H) return;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  V = makeView(state.view, W, H);
  const step = state.step;
  const opts = {
    env: env(),
    selected: step === 'model' || step === 'dof' ? state.sel : null,
    grid: step === 'model',
    showDofs: step !== 'model',
    showPorts: step === 'model' && (PORT_TOOLS.has(state.tool) || state.pending?.kind === 'line'),
    hotPort: state.hotPort,
    step,
  };
  if (state.pending?.kind === 'line' && state.pointerW) {
    const a = state.pending.a;
    const el = byId(a.el);
    if (el) opts.preview = [portWorld(el, a.port, opts.env), state.pointerW];
  }
  if (step === 'sim' && state.simOut) opts.disp = currentDisp();
  svg.innerHTML = renderScene(state.sys, V, opts);
}

// ------------------------------------------------------------ Elemente erzeugen
function addParamDefaults(names) {
  for (const [n, v] of Object.entries(names)) if (state.sys.params[n] === undefined) state.sys.params[n] = v;
}
function createBody(type, w) {
  const label = nextLabel();
  const i = label;
  const el = { id: newId('b'), type: type === 'stepdisk' ? 'disk' : type, label, x: snapV(w[0]), y: snapV(w[1]), angle: 0, props: {} };
  switch (type) {
    case 'block':
      el.props = { m: `m_${i}`, a: '0.2', b: '0.12', rot: false, J: `J_${i}` };
      break;
    case 'disk':
      el.props = { m: `m_${i}`, J: `J_${i}`, R: `r_${i}`, Ri: '' };
      addParamDefaults({ [`r_${i}`]: 0.1, [`m_${i}`]: 1, [`J_${i}`]: 0.005 });
      break;
    case 'stepdisk':
      el.props = { m: `m_${i}`, J: `J_${i}`, R: `2*r_${i}`, Ri: `r_${i}` };
      addParamDefaults({ [`r_${i}`]: 0.1, [`m_${i}`]: 2, [`J_${i}`]: 0.04 });
      break;
    case 'rod':
      el.angle = 90;
      el.props = { m: `m_${i}`, l: `l_${i}`, J: `m_${i}*l_${i}^2/12` };
      addParamDefaults({ [`l_${i}`]: 0.4 });
      break;
    case 'point':
      el.props = { m: `m_${i}` };
      break;
  }
  state.sys.elements.push(el);
  return el;
}
function portAt(sx, sy, maxDist = 18, filter = null) {
  const e = env();
  let best = null, bd = maxDist;
  for (const el of state.sys.elements) {
    if (!isBody(el) && el.type !== 'fix') continue;
    if (filter && !filter(el)) continue;
    for (const p of ports(el, e)) {
      if (el.type === 'rod' && (p.id === 'q1' || p.id === 'q2')) continue;
      const P = V.S(el.x + p.w[0], el.y + p.w[1]);
      const d = Math.hypot(P[0] - sx, P[1] - sy);
      if (d < bd) { bd = d; best = { el: el.id, port: p.id }; }
    }
  }
  return best;
}
function bodyAt(target, sx, sy) {
  const g = target?.closest?.('[data-id]');
  if (g) { const el = byId(g.dataset.id); if (el && isBody(el)) return el; }
  // nächster Körper in Reichweite
  const w = V.toWorld(sx, sy), e = env();
  let best = null, bd = Infinity;
  for (const el of bodies()) {
    const d = Math.hypot(el.x - w[0], el.y - w[1]);
    const r = el.type === 'disk' ? propNum(el, 'R', e, 0.1) : el.type === 'rod' ? propNum(el, 'l', e, 0.4) / 2 : 0.1;
    if (d < r + 12 / V.s && d < bd) { bd = d; best = el; }
  }
  return best;
}
function lineLength(el) {
  const g = lineGeometry(state.sys, el, env());
  return g ? g.len : 0;
}
function createFix(w, towards) {
  const el = { id: newId('w'), type: 'fix', x: snapV(w[0]), y: snapV(w[1]), angle: 0 };
  if (towards) el.angle = Math.round((Math.atan2(towards[1] - el.y, towards[0] - el.x) * 180) / Math.PI / 15) * 15;
  state.sys.elements.push(el);
  return el;
}
function finishLine(a, b, wB) {
  const e = env();
  let A = byId(a.el);
  let B = b ? byId(b.el) : null;
  if (!B) {
    const pa = portWorld(A, a.port, e);
    B = createFix(wB, pa);
    b = { el: B.id, port: 'c' };
  }
  if (A.type === 'fix' && A.autoAngle) {
    const pb = portWorld(B, b.port, e);
    A.angle = Math.round((Math.atan2(pb[1] - A.y, pb[0] - A.x) * 180) / Math.PI / 15) * 15;
    delete A.autoAngle;
  }
  if (a.el === b.el) { toast('Beide Enden liegen am selben Element.'); return null; }
  const t = state.tool;
  const el = { id: newId('l'), type: t, a, b, props: {}, L0auto: true };
  if (t === 'spring' || t === 'springdamper') el.props.k = 'k_' + nextIndex('k');
  if (t === 'damper' || t === 'springdamper') el.props.d = 'd_' + nextIndex('d');
  state.sys.elements.push(el);
  const L = lineLength(el);
  if (L < 1e-6) { state.sys.elements.pop(); toast('Die Enden liegen aufeinander.'); return null; }
  el.props.L0 = String(round3(L));
  return el;
}
function updateAutoL0() {
  for (const el of state.sys.elements) if (isLine(el) && el.L0auto) {
    const L = lineLength(el);
    if (L > 1e-6) el.props.L0 = String(round3(L));
  }
}
function nearestGround(body) {
  let best = null, bd = Infinity;
  for (const g of state.sys.elements.filter((x) => x.type === 'ground')) {
    const a = ((g.angle || 0) * Math.PI) / 180;
    const d = Math.abs(-Math.sin(a) * (body.x - g.x) + Math.cos(a) * (body.y - g.y));
    if (d < bd) { bd = d; best = g; }
  }
  return best;
}
function placeOnGround(body, g) {
  const e = env();
  const a = ((g.angle || 0) * Math.PI) / 180;
  const n = [-Math.sin(a), Math.cos(a)];
  let side = n[0] * (body.x - g.x) + n[1] * (body.y - g.y) >= 0 ? 1 : -1;
  const h = body.type === 'disk' ? propNum(body, 'R', e, 0.1) : body.type === 'block' ? propNum(body, 'b', e, 0.1) / 2 : 0;
  const t = [Math.cos(a), Math.sin(a)];
  const s = t[0] * (body.x - g.x) + t[1] * (body.y - g.y);
  body.x = round3(g.x + s * t[0] + side * h * n[0]);
  body.y = round3(g.y + s * t[1] + side * h * n[1]);
  if (body.type === 'block') body.angle = g.angle || 0;
}
function contactTool(body, mode) {
  if (mode === 'roll' && body.type !== 'disk') { toast('Rollen ohne Gleiten geht nur mit Scheiben.'); return; }
  if (body.type === 'rod' || body.type === 'point') { toast('Kontakt nur für Klotz oder Scheibe.'); return; }
  if (state.sys.elements.some((x) => x.type === 'contact' && x.body === body.id)) { toast('Dieser Körper hat schon einen Bodenkontakt.'); return; }
  let g = nearestGround(body);
  if (!g) {
    const e = env();
    const h = body.type === 'disk' ? propNum(body, 'R', e, 0.1) : propNum(body, 'b', e, 0.1) / 2;
    g = { id: newId('g'), type: 'ground', x: body.x, y: round3(body.y - h), angle: 0, len: 1.0 };
    state.sys.elements.push(g);
  }
  placeOnGround(body, g);
  const c = { id: newId('c'), type: 'contact', body: body.id, ground: g.id, mode };
  state.sys.elements.push(c);
  state.sel = c.id;
}
function deleteElement(id) {
  const del = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const el of state.sys.elements) {
      if (del.has(el.id)) continue;
      const refs = [el.at?.el, el.a?.el, el.b?.el, el.body, el.ground, typeof el.a === 'string' ? el.a : null, typeof el.b === 'string' ? el.b : null];
      if (refs.some((r) => r && del.has(r))) { del.add(el.id); grew = true; }
    }
  }
  state.sys.elements = state.sys.elements.filter((e) => !del.has(e.id));
  state.sys.dofs = state.sys.dofs.filter((d) => !del.has(d.body));
  if (del.has(state.sel)) state.sel = null;
  // nicht mehr benutzte Festpunkte ohne Verbindung bleiben bestehen (können Wände sein)
  changed();
  renderPanel();
}

// ------------------------------------------------------------ Tipp-Aktionen
function tap(sx, sy, target) {
  const w = V.toWorld(sx, sy);
  const ws = [snapV(w[0]), snapV(w[1])];
  const t = state.tool;
  if (state.step === 'dof') {
    const b = bodyAt(target, sx, sy);
    state.sel = b ? b.id : null;
    draw(); renderPanel();
    return;
  }
  if (state.step !== 'model') return;
  const elG = target?.closest?.('[data-id]');
  switch (t) {
    case 'select': state.sel = elG ? elG.dataset.id : null; break;
    case 'delete': if (elG) deleteElement(elG.dataset.id); return;
    case 'block': case 'disk': case 'stepdisk': case 'rod': case 'point': {
      const el = createBody(t, ws);
      state.sel = el.id; setTool('select');
      break;
    }
    case 'ground': {
      const el = { id: newId('g'), type: 'ground', x: ws[0], y: ws[1], angle: 0, len: 1.0 };
      state.sys.elements.push(el); state.sel = el.id; setTool('select');
      break;
    }
    case 'fix': {
      const el = createFix(ws); el.angle = 0;
      state.sel = el.id; setTool('select');
      break;
    }
    case 'pin': case 'roller': {
      const p = portAt(sx, sy, 20, isBody);
      if (!p) { toast('Bitte einen blauen Anschlusspunkt eines Körpers antippen.'); return; }
      // Lagerrichtung: vom Körpermittelpunkt zum Anschlusspunkt (sonst nach unten)
      const B = byId(p.el), pw = portWorld(B, p.port, env());
      const dx = pw[0] - B.x, dy = pw[1] - B.y;
      const ang = Math.hypot(dx, dy) > 1e-6 ? Math.round((Math.atan2(dy, dx) * 180) / Math.PI / 45) * 45 : -90;
      const el = { id: newId('s'), type: t, at: p, angle: ang };
      state.sys.elements.push(el); state.sel = el.id;
      break;
    }
    case 'hinge': {
      const p = portAt(sx, sy, 20, isBody);
      if (!p) { toast('Bitte einen Anschlusspunkt antippen.'); return; }
      if (!state.pending) { state.pending = { kind: 'hinge', a: p }; updateHint(); draw(); return; }
      if (p.el === state.pending.a.el) { toast('Bitte einen Punkt an einem anderen Körper wählen.'); return; }
      const e = env();
      const pa = portWorld(byId(state.pending.a.el), state.pending.a.port, e);
      const B = byId(p.el), pb = portWorld(B, p.port, e);
      B.x = round3(B.x + pa[0] - pb[0]); B.y = round3(B.y + pa[1] - pb[1]);
      const el = { id: newId('h'), type: 'hinge', a: state.pending.a, b: p };
      state.sys.elements.push(el); state.sel = el.id; state.pending = null;
      break;
    }
    case 'roll': case 'slide': {
      const b = bodyAt(target, sx, sy);
      if (!b) { toast('Bitte einen Körper antippen.'); return; }
      contactTool(b, t === 'roll' ? 'roll' : 'slide');
      break;
    }
    case 'rope': case 'spring': case 'damper': case 'springdamper': {
      const p = portAt(sx, sy, 18);
      if (!state.pending) {
        if (p) state.pending = { kind: 'line', a: p };
        else { const f = createFix(ws); f.autoAngle = true; state.pending = { kind: 'line', a: { el: f.id, port: 'c' } }; }
        state.pointerW = w;
        updateHint(); changed(); return;
      }
      const el = finishLine(state.pending.a, p, ws);
      state.pending = null;
      if (el) state.sel = el.id;
      break;
    }
    case 'tspring': case 'tdamper': {
      const b = bodyAt(target, sx, sy);
      if (!state.pending) {
        if (!b || !hasRotation(b)) { toast('Bitte einen drehbaren Körper (Scheibe, Stab, drehbarer Klotz) antippen.'); return; }
        state.pending = { kind: 'torsion', a: b.id }; updateHint(); draw(); return;
      }
      if (b && b.id === state.pending.a) { toast('Zweiten Körper oder leere Fläche wählen.'); return; }
      if (b && !hasRotation(b)) { toast('Der zweite Körper ist nicht drehbar.'); return; }
      const el = { id: newId('t'), type: t, a: state.pending.a, b: b ? b.id : null, props: {} };
      if (t === 'tspring') el.props.kt = 'kt_' + nextIndex('kt'); else el.props.dt = 'dt_' + nextIndex('dt');
      state.sys.elements.push(el); state.sel = el.id; state.pending = null;
      break;
    }
    case 'force': {
      const p = portAt(sx, sy, 20, isBody);
      if (!p) { toast('Bitte einen Anschlusspunkt eines Körpers antippen.'); return; }
      const el = { id: newId('f'), type: 'force', at: p, angle: 0, props: { F: 'F_' + nextIndex('F') } };
      state.sys.elements.push(el); state.sel = el.id;
      break;
    }
    case 'moment': {
      const b = bodyAt(target, sx, sy);
      if (!b || !hasRotation(b)) { toast('Bitte einen drehbaren Körper antippen.'); return; }
      const el = { id: newId('M'), type: 'moment', body: b.id, dir: 1, props: { M: 'M_' + nextIndex('M') } };
      state.sys.elements.push(el); state.sel = el.id;
      break;
    }
  }
  updateHint();
  changed();
  renderPanel();
}

// ------------------------------------------------------------ Zeiger (Maus/Touch)
const pointers = new Map();
let gesture = null;
svg.addEventListener('pointerdown', (e) => {
  svg.setPointerCapture(e.pointerId);
  const r = svg.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  pointers.set(e.pointerId, [sx, sy]);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { kind: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), view0: { ...state.view }, mid0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    return;
  }
  const elG = e.target.closest?.('[data-id]');
  const el = elG ? byId(elG.dataset.id) : null;
  const draggable = state.step === 'model' && state.tool === 'select' && el && (isBody(el) || el.type === 'ground' || el.type === 'fix');
  gesture = { kind: 'down', sx, sy, target: e.target, el: draggable ? el : null, ox: el?.x, oy: el?.y, view0: { ...state.view }, moved: false };
});
svg.addEventListener('pointermove', (e) => {
  const r = svg.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [sx, sy]);
  if (gesture?.kind === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const s = Math.min(4000, Math.max(40, gesture.view0.s * (d / gesture.d0)));
    const v0 = makeView(gesture.view0, V.W, V.H);
    const wm = v0.toWorld(...gesture.mid0);
    state.view = { s, cx: wm[0] - (mid[0] - V.W / 2) / s, cy: wm[1] + (mid[1] - V.H / 2) / s };
    draw();
    return;
  }
  if (gesture?.kind === 'down') {
    const dx = sx - gesture.sx, dy = sy - gesture.sy;
    if (!gesture.moved && Math.hypot(dx, dy) > 5) gesture.moved = true;
    if (gesture.moved) {
      if (gesture.el) {
        gesture.el.x = round3(snapV(gesture.ox + dx / state.view.s, 0.025));
        gesture.el.y = round3(snapV(gesture.oy - dy / state.view.s, 0.025));
        updateAutoL0();
      } else {
        state.view.cx = gesture.view0.cx - dx / state.view.s;
        state.view.cy = gesture.view0.cy + dy / state.view.s;
      }
      draw();
    }
    return;
  }
  // Schweben
  if (state.step === 'model' && V) {
    const wantPorts = PORT_TOOLS.has(state.tool) || state.pending?.kind === 'line';
    const hp = wantPorts ? portAt(sx, sy, 18) : null;
    const key = hp ? hp.el + '|' + hp.port : null;
    state.pointerW = V.toWorld(sx, sy);
    if (key !== state.hotPort || state.pending) { state.hotPort = key; draw(); }
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (gesture?.kind === 'pinch') { if (pointers.size === 0) { gesture = null; save(); } return; }
  if (gesture?.kind === 'down') {
    const g = gesture;
    gesture = null;
    if (!g.moved) tap(g.sx, g.sy, g.target);
    else if (g.el) { changed(); renderPanel(); }
    else save();
  }
}
svg.addEventListener('pointerup', endPointer);
svg.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); gesture = null; });
svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = svg.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });
function zoomAt(sx, sy, f) {
  const w = V.toWorld(sx, sy);
  const s = Math.min(4000, Math.max(40, state.view.s * f));
  state.view = { s, cx: w[0] - (sx - V.W / 2) / s, cy: w[1] + (sy - V.H / 2) / s };
  draw(); save();
}
function fitView() {
  const e = env();
  const pts = [];
  for (const el of state.sys.elements) {
    if (isBody(el)) {
      const r = el.type === 'disk' ? propNum(el, 'R', e, 0.1) : el.type === 'rod' ? propNum(el, 'l', e, 0.4) / 2 : 0.12;
      pts.push([el.x - r, el.y - r], [el.x + r, el.y + r]);
    } else if (el.type === 'ground') {
      const L = (el.len || 1) / 2, a = ((el.angle || 0) * Math.PI) / 180;
      pts.push([el.x - L * Math.cos(a), el.y - L * Math.sin(a) - 0.03], [el.x + L * Math.cos(a), el.y + L * Math.sin(a)]);
    } else if (el.type === 'fix') pts.push([el.x - 0.05, el.y - 0.05], [el.x + 0.05, el.y + 0.05]);
  }
  if (!pts.length) { state.view = { cx: 0, cy: 0.15, s: 400 }; draw(); return; }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const W = svg.clientWidth || 600, H = svg.clientHeight || 400;
  const s = Math.min(1200, (W - 120) / Math.max(0.2, x1 - x0), (H - 120) / Math.max(0.2, y1 - y0));
  state.view = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, s: Math.max(60, s) };
  draw(); save();
}
document.querySelector('.zoom-ctl').addEventListener('click', (e) => {
  const z = e.target.closest('[data-zoom]')?.dataset.zoom;
  if (!z) return;
  if (z === 'fit') fitView();
  else zoomAt(V.W / 2, V.H / 2, z === 'in' ? 1.25 : 0.8);
});
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel && state.step === 'model') { e.preventDefault(); deleteElement(state.sel); }
  if (e.key === 'Escape') {
    if (state.pending) {
      const p = state.pending;
      state.pending = null;
      // automatisch erzeugten Festpunkt ohne Verbindung entfernen
      if (p.kind === 'line') { const f = byId(p.a.el); if (f?.autoAngle) state.sys.elements = state.sys.elements.filter((x) => x !== f); }
      updateHint(); changed();
    } else setTool('select');
  }
});
new ResizeObserver(() => draw()).observe(svg);

// ------------------------------------------------------------ Schritte
function setStep(step) {
  if (step !== 'sim') stopAnim();
  state.step = step;
  state.pending = null;
  app.className = 'step-' + step;
  document.querySelectorAll('#steps button').forEach((b) => b.classList.toggle('active', b.dataset.step === step));
  $('#eqview').hidden = step !== 'eq';
  $('#player').hidden = !(step === 'sim' && state.simOut);
  updateHint();
  renderPanel();
  requestAnimationFrame(draw);
}
$('#steps').addEventListener('click', (e) => {
  const b = e.target.closest('[data-step]');
  if (b) setStep(b.dataset.step);
});

// ------------------------------------------------------------ Panels
function renderPanel() {
  if (state.step === 'model') panelModel();
  else if (state.step === 'dof') panelDof();
  else if (state.step === 'eq') eqView();
  else if (state.step === 'sim') panelSim();
}

function field(label, key, value, opts = {}) {
  const type = opts.type || 'text';
  return `<div class="field"><label>${label}</label><input type="${type}" data-k="${key}" value="${esc(value ?? '')}" ${opts.attrs || ''} spellcheck="false" autocomplete="off" autocapitalize="off"></div>`;
}
function exprField(label, key, el) {
  const v = el.props?.[key] ?? '';
  const bad = v !== '' && tryParse(v).error;
  return `<div class="field"><label>${label}</label><input type="text" class="${bad ? 'bad' : ''}" data-prop="${key}" value="${esc(v)}" spellcheck="false" autocomplete="off" autocapitalize="off"></div>`;
}
function angleField(label, el, key = 'angle') {
  return `<div class="field"><label>${label}</label><div class="row"><input type="number" step="15" data-k="${key}" value="${el[key] ?? 0}" style="width:90px" class="inp"><button class="btn small" data-rot="-15">↻ 15°</button><button class="btn small" data-rot="15">↺ 15°</button></div></div>`;
}

function panelModel() {
  const el = state.sel ? byId(state.sel) : null;
  let h = '';
  if (el) {
    const t = TYPES[el.type];
    h += `<h2>${esc(t.name)}${el.label ? ' ' + esc(el.label) : ''}</h2><div class="card" id="el-props">`;
    if (isBody(el)) h += field('Bezeichnung', 'label', el.label);
    switch (el.type) {
      case 'block':
        h += exprField('Masse m', 'm', el) + exprField('Breite a', 'a', el) + exprField('Höhe b', 'b', el) + angleField('Winkel (°)', el);
        h += `<div class="field"><label>drehbar</label><label class="row"><input type="checkbox" data-bool="rot" ${el.props.rot ? 'checked' : ''}> Verdrehung als Koordinate</label></div>`;
        if (el.props.rot) h += exprField('Trägheit J<sub>S</sub>', 'J', el);
        break;
      case 'disk':
        h += exprField('Masse m', 'm', el) + exprField('Trägheit J<sub>S</sub>', 'J', el) + exprField('Radius R', 'R', el) + exprField('Innenradius', 'Ri', el);
        h += '<p class="muted">Innenradius leer lassen für eine einfache Scheibe. Beispiele: <code>2*r</code>, <code>m*r^2/2</code>.</p>';
        break;
      case 'rod':
        h += exprField('Masse m', 'm', el) + exprField('Länge l', 'l', el) + exprField('Trägheit J<sub>S</sub>', 'J', el) + angleField('Winkel (°)', el);
        break;
      case 'point': h += exprField('Masse m', 'm', el); break;
      case 'ground': h += angleField('Neigung (°)', el) + field('Länge (Zeichnung)', 'len', el.len, { type: 'number', attrs: 'step="0.1" min="0.1"' }); break;
      case 'fix': h += angleField('Richtung (°)', el); break;
      case 'pin': h += angleField('Richtung (°)', el) + '<p class="muted">Festlager: Punkt unverschieblich, Drehung frei.</p>'; break;
      case 'roller': h += angleField('Richtung (°)', el) + '<p class="muted">Loslager/Gleitlager: Verschiebung in Richtung des Lagers gesperrt, quer dazu frei.</p>'; break;
      case 'hinge': h += '<p class="muted">Gelenk: Anschlusspunkte beider Körper bleiben zusammen, relative Drehung frei.</p>'; break;
      case 'contact': {
        const b = byId(el.body);
        h += `<div class="field"><label>Kontaktart</label><div class="seg"><button data-mode="roll" class="${el.mode === 'roll' ? 'on' : ''}" ${b?.type !== 'disk' ? 'disabled' : ''}>Rollen ohne Gleiten</button><button data-mode="slide" class="${el.mode !== 'roll' ? 'on' : ''}">Gleiten</button></div></div>`;
        break;
      }
      case 'rope': case 'spring': case 'damper': case 'springdamper':
        if (el.props.k !== undefined) h += exprField('Steifigkeit k', 'k', el);
        if (el.props.d !== undefined) h += exprField('Dämpfung d', 'd', el);
        h += exprField(el.type === 'rope' ? 'Seillänge l₀' : 'Länge l₀ (entspannt)', 'L0', el);
        h += `<div class="field"><label></label><label class="row"><input type="checkbox" data-l0auto ${el.L0auto ? 'checked' : ''}> l₀ aus Zeichnung übernehmen</label></div>`;
        h += '<p class="muted">l₀ geht nur in die nichtlineare Rechnung ein. Liegt ein Ende tangential an einer Scheibe, wird es als aufgewickelt behandelt.</p>';
        break;
      case 'tspring': h += exprField('Drehsteifigkeit', 'kt', el); break;
      case 'tdamper': h += exprField('Drehdämpfung', 'dt', el); break;
      case 'force': h += exprField('Kraft F(t)', 'F', el) + angleField('Richtung (°)', el) + '<p class="muted">Z. B. <code>F_0*cos(Omega*t)</code>. Richtung bleibt raumfest.</p>'; break;
      case 'moment':
        h += exprField('Moment M(t)', 'M', el);
        h += `<div class="field"><label>Drehsinn</label><div class="seg"><button data-mdir="1" class="${el.dir !== -1 ? 'on' : ''}">↺ gegen Uhrzeiger</button><button data-mdir="-1" class="${el.dir === -1 ? 'on' : ''}">↻ im Uhrzeiger</button></div></div>`;
        break;
    }
    h += `<div class="row" style="margin-top:10px"><button class="btn danger small" data-del>Löschen</button></div></div>`;
  } else {
    h += `<h2>Modell</h2><p class="muted">Werkzeug links (am Handy oben) wählen und auf die Zeichenfläche tippen. Elemente mit „Auswahl“ antippen, um Parameter zu ändern.</p>`;
  }
  h += `<h3>Parameter</h3><div class="card">${paramTable()}
    <div class="field"><label>Schwerkraft</label><label class="row"><input type="checkbox" data-grav ${state.sys.gravity ? 'checked' : ''}> Gewichtskraft (g nach unten)</label></div></div>`;
  h += `<button class="btn primary block" data-next="dof">Weiter: Freiheitsgrade →</button>`;
  panel.innerHTML = h;
  bindModelPanel(el);
}
function paramTable() {
  const names = ensureParams(state.sys);
  if (!names.length) return '<p class="muted">Noch keine Parameter.</p>';
  return '<table class="ptable">' + names.map((n) =>
    `<tr><td>${katexStr(nameTex(n))}</td><td><input type="number" step="any" data-param="${esc(n)}" value="${state.sys.params[n]}"></td></tr>`).join('') + '</table>';
}
function bindParamInputs(root) {
  root.querySelectorAll('[data-param]').forEach((inp) => inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    if (Number.isFinite(v)) { state.sys.params[inp.dataset.param] = v; inp.classList.remove('bad'); updateAutoL0(); changed(); }
    else inp.classList.add('bad');
  }));
}
function bindModelPanel(el) {
  bindParamInputs(panel);
  panel.querySelector('[data-grav]')?.addEventListener('change', (e) => { state.sys.gravity = e.target.checked; changed(); panelModel(); });
  panel.querySelector('[data-next]')?.addEventListener('click', () => setStep('dof'));
  if (!el) return;
  panel.querySelectorAll('[data-prop]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const k = inp.dataset.prop;
      el.props[k] = inp.value;
      if (k === 'L0') el.L0auto = false;
      const bad = inp.value !== '' && tryParse(inp.value).error;
      inp.classList.toggle('bad', !!bad);
      if (!bad) { changed(); updateAutoL0(); }
    });
    inp.addEventListener('change', () => { const box = panel.querySelector('.ptable')?.closest('.card'); if (box) { panelModel(); } });
  });
  panel.querySelectorAll('[data-k]').forEach((inp) => inp.addEventListener('input', () => {
    const k = inp.dataset.k;
    if (k === 'label') {
      const v = inp.value.trim();
      if (v && !bodies().some((b) => b !== el && b.label === v)) { el.label = v; changed(); }
      return;
    }
    const v = parseFloat(inp.value);
    if (Number.isFinite(v)) { el[k] = v; updateAutoL0(); changed(); }
  }));
  panel.querySelectorAll('[data-rot]').forEach((b) => b.addEventListener('click', () => {
    el.angle = (((el.angle || 0) + Number(b.dataset.rot)) % 360 + 360) % 360;
    if (el.angle > 180) el.angle -= 360;
    updateAutoL0(); changed(); panelModel();
  }));
  panel.querySelector('[data-bool]')?.addEventListener('change', (e) => { el.props[e.target.dataset.bool] = e.target.checked; changed(); panelModel(); });
  panel.querySelector('[data-l0auto]')?.addEventListener('change', (e) => { el.L0auto = e.target.checked; updateAutoL0(); changed(); panelModel(); });
  panel.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { el.mode = b.dataset.mode; changed(); panelModel(); }));
  panel.querySelectorAll('[data-mdir]').forEach((b) => b.addEventListener('click', () => { el.dir = Number(b.dataset.mdir); changed(); panelModel(); }));
  panel.querySelector('[data-del]')?.addEventListener('click', () => deleteElement(el.id));
}

// ---- Freiheitsgrade
function panelDof() {
  const sys = state.sys;
  let analysis = null, buildErr = null, model = null;
  try {
    model = buildModel(sys);
    let dofs = null;
    try { dofs = setupDofs(model, sys); } catch (e) { buildErr = e.message; }
    analysis = analyze(model, dofs);
  } catch (e) { buildErr = e.message; }
  let h = `<h2>Methode</h2><div class="card radio-list">`;
  const desc = {
    L1: 'Alle Lagekoordinaten + Zwangskräfte λ (differential-algebraisch)',
    L2: 'Energien T, U, D und generalisierte Kräfte',
    DAL: 'Virtuelle Arbeit der Trägheits- und eingeprägten Kräfte',
  };
  for (const [k, n] of Object.entries(METHODS)) {
    h += `<label><input type="radio" name="method" value="${k}" ${sys.method === k ? 'checked' : ''}><span>${esc(n)}<small>${desc[k]}</small></span></label>`;
  }
  h += `</div><div class="card"><div class="field"><label>Modus</label><div class="seg"><button data-modeopt="linear" class="${sys.mode === 'linear' ? 'on' : ''}">linearisiert</button><button data-modeopt="nonlinear" class="${sys.mode !== 'linear' ? 'on' : ''}">nichtlinear</button></div></div>
    <p class="muted">${sys.mode === 'linear' ? 'Kleine Auslenkungen um die gezeichnete Lage: M q̈ + D q̇ + K q = f(t).' : 'Große Bewegungen, exakte Geometrie (sin, cos, Wurzeln).'}</p></div>`;

  h += '<h2>Freiheitsgrade</h2><div class="card">';
  if (buildErr && !analysis) h += `<div class="msg error">${mathText(buildErr)}</div>`;
  if (analysis) {
    h += `<div class="muted">n = ${analysis.n} Lagekoordinaten, r = ${analysis.rank} unabhängige Bindungen ⇒ <b style="color:var(--ink)">f = ${analysis.f}</b></div>`;
    if (buildErr) h += `<div class="msg error">${mathText(buildErr)}</div>`;
    for (const m of analysis.messages) h += `<div class="msg ${m.type}">${mathText(m.text)}</div>`;
  }
  for (const d of sys.dofs) {
    const b = byId(d.body);
    const dirOpts = d.coord === 'phi' ? [[-1, '↻ im Uhrzeigersinn'], [1, '↺ gegen Uhrzeigersinn']] : d.coord === 'x' ? [[1, '→ nach rechts'], [-1, '← nach links']] : [[1, '↑ nach oben'], [-1, '↓ nach unten']];
    h += `<div class="dof-item" data-dof="${d.id}"><div>
      <div class="row"><span class="dof-title">${katexStr(nameTex(d.name))}</span><span class="muted">${d.coord === 'phi' ? 'Drehwinkel' : d.coord + '-Verschiebung'} von Körper ${esc(b?.label ?? '?')}</span></div>
      <div class="row" style="margin-top:6px"><input class="inp" style="width:110px" data-dname value="${esc(d.name)}" title="Name, z. B. phi_1, x, s">
      <div class="seg">${dirOpts.map(([v, t]) => `<button data-ddir="${v}" class="${d.dir === v ? 'on' : ''}">${t}</button>`).join('')}</div></div></div>
      <button class="btn small danger" data-drem title="Entfernen">×</button></div>`;
  }
  h += `<div class="row" style="margin-top:8px"><button class="btn small" data-suggest>Vorschlag übernehmen</button></div></div>`;

  h += '<h3>Körper</h3><div class="card">';
  for (const b of bodies()) {
    const rot = hasRotation(b);
    const has = (c) => sys.dofs.some((d) => d.body === b.id && d.coord === c);
    h += `<div class="body-row ${state.sel === b.id ? 'sel' : ''}" data-body="${b.id}"><span class="bname">${esc(TYPES[b.type].name)} ${esc(b.label)}</span>
      <button class="chip ${has('x') ? 'on' : ''}" data-add="x">x</button><button class="chip ${has('y') ? 'on' : ''}" data-add="y">y</button><button class="chip ${has('phi') ? 'on' : ''}" data-add="phi" ${rot ? '' : 'disabled'}>φ</button></div>`;
  }
  if (!bodies().length) h += '<p class="muted">Noch keine Körper im Modell.</p>';
  h += '</div>';
  h += `<button class="btn primary block" data-derive ${analysis?.ok ? '' : 'disabled'}>Bewegungsgleichungen herleiten →</button>`;
  panel.innerHTML = h;

  panel.querySelectorAll('input[name=method]').forEach((r) => r.addEventListener('change', () => { sys.method = r.value; changed(); panelDof(); }));
  panel.querySelectorAll('[data-modeopt]').forEach((b) => b.addEventListener('click', () => { sys.mode = b.dataset.modeopt; changed(); panelDof(); }));
  panel.querySelectorAll('[data-dof]').forEach((row) => {
    const d = sys.dofs.find((x) => x.id === row.dataset.dof);
    row.querySelector('[data-dname]').addEventListener('change', (e) => { d.name = e.target.value.trim() || d.name; changed(); panelDof(); });
    row.querySelectorAll('[data-ddir]').forEach((b) => b.addEventListener('click', () => { d.dir = Number(b.dataset.ddir); changed(); panelDof(); }));
    row.querySelector('[data-drem]').addEventListener('click', () => { sys.dofs = sys.dofs.filter((x) => x !== d); changed(); panelDof(); });
  });
  panel.querySelectorAll('[data-body]').forEach((row) => {
    row.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => toggleDof(row.dataset.body, b.dataset.add)));
  });
  panel.querySelector('[data-suggest]')?.addEventListener('click', () => {
    try {
      const m = buildModel(sys);
      const s = suggestDofs(m);
      sys.dofs = [];
      for (const c of s) {
        const b = m.bodies.find((x) => [x.X, x.Y, x.TH].includes(c));
        const coord = c === b.X ? 'x' : c === b.Y ? 'y' : 'phi';
        addDof(b.el.id, coord);
      }
      changed(); panelDof();
    } catch (e) { toast(e.message); }
  });
  panel.querySelector('[data-derive]')?.addEventListener('click', () => setStep('eq'));
}
function addDof(bodyId, coord) {
  const b = byId(bodyId);
  const used = new Set(state.sys.dofs.map((d) => d.name));
  let name = (coord === 'phi' ? 'phi' : coord) + '_' + b.label;
  if (used.has(name)) name += 'b';
  let i = 1; while (state.sys.dofs.some((d) => d.id === 'q' + i)) i++;
  state.sys.dofs.push({ id: 'q' + i, body: bodyId, coord, dir: coord === 'phi' ? -1 : coord === 'y' ? -1 : 1, name });
}
function toggleDof(bodyId, coord) {
  const ex = state.sys.dofs.find((d) => d.body === bodyId && d.coord === coord);
  if (ex) state.sys.dofs = state.sys.dofs.filter((d) => d !== ex);
  else addDof(bodyId, coord);
  state.sel = bodyId;
  changed(); panelDof();
}

// ---- Gleichungen
function ensureResult() {
  const key = modelKey();
  if (state.resultKey === key) return;
  state.resultKey = key;
  state.result = null; state.resultError = null; state.cm = null; state.simOut = null;
  try { state.result = derive(state.sys); } catch (e) { state.resultError = e.message; console.error(e); }
}
function eqView() {
  const box = $('#eqview');
  box.innerHTML = '<div class="eq-inner"><p><span class="spinner"></span> Herleitung läuft …</p></div>';
  setTimeout(() => {
    ensureResult();
    const r = state.result;
    let h = '<div class="eq-inner"><div class="eq-head">';
    h += `<h2>${esc(METHODS[state.sys.method] || '')} · ${state.sys.mode === 'linear' ? 'linearisiert' : 'nichtlinear'}</h2>`;
    h += '<button class="btn small" data-back>← Freiheitsgrade</button>';
    if (r) h += '<button class="btn small" data-copy>LaTeX kopieren</button><button class="btn primary small" data-sim>Simulation →</button>';
    h += '</div>';
    if (!r) {
      h += `<div class="msg error">${mathText(state.resultError || 'Unbekannter Fehler')}</div>`;
    } else {
      r.doc.sections.forEach((s, i) => {
        const last = s.title.startsWith('Bewegungsgleichungen');
        h += `<div class="eq-sec${last ? ' result' : ''}"><h3>${i + 1}. ${esc(s.title)}</h3>`;
        if (s.intro) h += `<p class="intro">${esc(s.intro)}</p>`;
        for (const row of s.rows) {
          if (row.text) h += `<p class="eq-text">${mathText(row.text)}</p>`;
          else h += `<div class="eq-row"><div class="formula">${katexStr(row.tex, true)}</div>${row.note ? `<div class="note">${mathText(row.note)}</div>` : ''}</div>`;
        }
        h += '</div>';
      });
    }
    h += '</div>';
    box.innerHTML = h;
    box.querySelector('[data-back]')?.addEventListener('click', () => setStep('dof'));
    box.querySelector('[data-sim]')?.addEventListener('click', () => setStep('sim'));
    box.querySelector('[data-copy]')?.addEventListener('click', () => {
      const t = r.doc.sections.map((s) => '% ' + s.title + '\n' + s.rows.filter((x) => x.tex).map((x) => x.tex).join('\n')).join('\n\n');
      navigator.clipboard?.writeText(t).then(() => toast('LaTeX in die Zwischenablage kopiert.'), () => toast('Kopieren nicht möglich.'));
    });
  }, 20);
}

// ---- Simulation
function panelSim() {
  ensureResult();
  const sys = state.sys;
  const r = state.result;
  let h = '<h2>Simulation</h2>';
  if (!r) {
    h += `<div class="msg error">${mathText(state.resultError || 'Zuerst Freiheitsgrade festlegen.')}</div><button class="btn" data-goto="dof">← Freiheitsgrade</button>`;
    panel.innerHTML = h;
    panel.querySelector('[data-goto]')?.addEventListener('click', () => setStep('dof'));
    return;
  }
  h += '<h3>Anfangswerte</h3><div class="card"><table class="ptable"><tr><td></td><td class="muted" style="font-family:system-ui;font-style:normal;font-size:12px">q(0)</td><td class="muted" style="font-size:12px">q̇(0)</td></tr>';
  for (const d of sys.dofs) {
    const iv = sys.sim.init[d.id] || (sys.sim.init[d.id] = { q: '0', qd: '0' });
    h += `<tr><td>${katexStr(nameTex(d.name))}</td><td><input data-iq="${d.id}" value="${esc(iv.q)}"></td><td><input data-iqd="${d.id}" value="${esc(iv.qd)}"></td></tr>`;
  }
  h += '</table><p class="muted">Winkel in rad (z. B. <code>10*pi/180</code>), Längen in m.</p></div>';
  h += '<h3>Zeitdiskretisierung</h3><div class="card">';
  h += `<div class="field"><label>Verfahren</label><select data-integ class="inp">${Object.entries(INTEGRATORS).map(([k, v]) => `<option value="${k}" ${sys.sim.integrator === k ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></div>`;
  h += `<div class="formula" style="font-size:13px">${katexStr(INTEGRATORS[sys.sim.integrator]?.tex || '', true)}</div>`;
  h += `<p class="muted">Zustand ${katexStr('\\mathbf{y} = [\\mathbf{q}, \\dot{\\mathbf{q}}]^T')}, ${katexStr('\\mathbf{F} = [\\dot{\\mathbf{q}}, \\ddot{\\mathbf{q}}]^T')}${r.numeric.type === 'dae' ? ' (q̈ und λ aus dem Gleichungssystem, mit Projektion auf die Bindungen)' : ' mit q̈ aus M(q) q̈ = F'}.</p>`;
  h += field('Schrittweite h (s)', 'h', sys.sim.h, { type: 'number', attrs: 'step="any" min="0"' });
  h += field('Endzeit T (s)', 'T', sys.sim.T, { type: 'number', attrs: 'step="any" min="0"' });
  h += `<button class="btn primary block" data-run>▶ Simulation starten</button>`;
  if (state.simError) h += `<div class="msg error">${mathText(state.simError)}</div>`;
  h += '</div>';
  if (state.simOut) {
    const out = state.simOut;
    h += `<h3>Verläufe</h3><div class="card"><div class="seg" id="qty">${plotQtyOptions().map(([k, n]) => `<button data-qty="${k}" class="${state.plotQty === k ? 'on' : ''}">${n}</button>`).join('')}</div>
      <div class="legend" id="legend"></div><div class="plot-wrap" id="plotwrap"></div>
      <div class="row" style="margin-top:8px"><span class="muted">${out.t.length} Ausgabepunkte, ${Math.ceil(sys.sim.T / sys.sim.h)} Schritte</span><button class="btn small" data-csv>CSV</button></div></div>`;
    h += `<h3>Darstellung</h3><div class="card">${field('Überhöhung', 'exag', state.anim.exag, { type: 'number', attrs: 'step="any" min="0"' })}<p class="muted">Vergrößert die Auslenkungen in der Animation (nur Darstellung).</p></div>`;
  }
  h += '<h3>Parameter</h3><div class="card">' + paramTable() + '</div>';
  panel.innerHTML = h;

  bindParamInputs(panel);
  panel.querySelectorAll('[data-iq]').forEach((i) => i.addEventListener('input', () => { sys.sim.init[i.dataset.iq].q = i.value; save(); }));
  panel.querySelectorAll('[data-iqd]').forEach((i) => i.addEventListener('input', () => { sys.sim.init[i.dataset.iqd].qd = i.value; save(); }));
  panel.querySelector('[data-integ]').addEventListener('change', (e) => { sys.sim.integrator = e.target.value; save(); panelSim(); });
  panel.querySelectorAll('[data-k]').forEach((i) => i.addEventListener('input', () => {
    const v = parseFloat(i.value);
    if (!Number.isFinite(v) || v < 0) return;
    if (i.dataset.k === 'exag') { state.anim.exag = v; draw(); return; }
    sys.sim[i.dataset.k] = v; save();
  }));
  panel.querySelector('[data-run]').addEventListener('click', runSim);
  panel.querySelector('[data-csv]')?.addEventListener('click', exportCSV);
  panel.querySelectorAll('[data-qty]').forEach((b) => b.addEventListener('click', () => { state.plotQty = b.dataset.qty; panelSim(); }));
  if (state.simOut) setupPlot();
}
function plotQtyOptions() {
  const o = [['q', 'Lage q'], ['v', 'Geschw. q̇']];
  if (state.result?.numeric.type === 'dae') o.push(['lam', 'Zwangskräfte λ']);
  if (state.result?.numeric.energyValid) o.push(['E', 'Energie']);
  return o;
}
let plot = null;
const hiddenSeries = new Set();
function setupPlot() {
  const wrap = $('#plotwrap');
  plot = new Plot(wrap);
  plot.onSeek = (t) => { state.anim.t = t; state.anim.playing = false; updatePlayer(); draw(); };
  const out = state.simOut, res = state.result;
  const dofIdx = state.cm.type === 'dae' ? res.numeric.coords.map((c, i) => (c.dof ? i : -1)).filter((i) => i >= 0) : res.numeric.coords.map((_, i) => i);
  const coords = state.cm.type === 'dae' ? res.numeric.coords : res.numeric.coords;
  let series = [];
  const q = state.plotQty;
  if (q === 'q' || q === 'v') {
    const idx = state.cm.type === 'dae' ? coords.map((_, i) => i) : dofIdx;
    series = idx.map((i, k) => ({
      key: q + i, name: (q === 'v' ? 'd/dt ' : '') + plainName(coords[i]), y: out[q].map((r) => r[i]),
      color: SERIES_COLORS[k % SERIES_COLORS.length], visible: !hiddenSeries.has(q + i) && (state.cm.type !== 'dae' || !!coords[i].dof || hiddenSeries.has('show' + q + i)),
    }));
  } else if (q === 'lam') {
    const m = out.lam[0]?.length || 0;
    series = Array.from({ length: m }, (_, j) => ({ key: 'l' + j, name: 'λ' + (j + 1), y: out.lam.map((r) => r[j]), color: SERIES_COLORS[j % SERIES_COLORS.length], visible: !hiddenSeries.has('l' + j) }));
  } else {
    series = ['T (kinetisch)', 'U (potentiell)', 'E = T + U'].map((n, j) => ({ key: 'E' + j, name: n, y: out.E.map((r) => r[j]), color: SERIES_COLORS[j], visible: !hiddenSeries.has('E' + j) }));
  }
  const leg = $('#legend');
  leg.innerHTML = series.map((s) => `<label><input type="checkbox" data-s="${s.key}" ${s.visible ? 'checked' : ''}><i style="background:${s.color}"></i>${esc(s.name)}</label>`).join('');
  leg.querySelectorAll('[data-s]').forEach((cb) => cb.addEventListener('change', () => {
    const s = series.find((x) => x.key === cb.dataset.s);
    s.visible = cb.checked;
    if (cb.checked) { hiddenSeries.delete(s.key); hiddenSeries.add('show' + s.key); } else { hiddenSeries.add(s.key); hiddenSeries.delete('show' + s.key); }
    plot.draw();
  }));
  plot.setData(out.t, series);
  plot.setCursor(state.anim.t);
}
function plainName(c) {
  const t = c.dof ? c.dof.name : c.tex;
  return t.replace(/\\vartheta/g, 'ϑ').replace(/\\varphi|phi/g, 'φ').replace(/[{}\\]/g, '').replace(/_/g, '');
}
function runSim() {
  const sys = state.sys;
  state.simError = null;
  try {
    ensureResult();
    const r = state.result;
    if (!r) throw new Error(state.resultError);
    const e = paramEnv(sys);
    if (!state.cm) state.cm = compile(r, e);
    const cm = state.cm;
    const q0d = sys.dofs.map((d) => evalInput(sys.sim.init[d.id]?.q, e));
    const v0d = sys.dofs.map((d) => evalInput(sys.sim.init[d.id]?.qd, e));
    let q0 = q0d, v0 = v0d;
    if (cm.type === 'dae') {
      q0 = r.numeric.coords.map((c) => (c.dof ? q0d[sys.dofs.indexOf(c.dof)] : 0));
      v0 = r.numeric.coords.map((c) => (c.dof ? v0d[sys.dofs.indexOf(c.dof)] : 0));
    }
    const t0 = performance.now();
    state.simOut = simulate(cm, { method: sys.sim.integrator, h: sys.sim.h, T: sys.sim.T, q0, v0 });
    state.simOut.ms = performance.now() - t0;
    state.anim.t = 0;
    state.anim.playing = true;
    state.anim.last = performance.now();
    $('#player').hidden = false;
    buildPlayer();
    requestAnimationFrame(animLoop);
  } catch (e) {
    console.error(e);
    state.simError = e.message;
    state.simOut = null;
  }
  panelSim();
  draw();
}
function exportCSV() {
  const out = state.simOut, r = state.result;
  const names = r.numeric.coords.map(plainName);
  let csv = 't;' + names.join(';') + ';' + names.map((n) => 'd/dt ' + n).join(';') + '\n';
  out.t.forEach((t, i) => { csv += [t, ...out.q[i], ...out.v[i]].map((x) => String(x).replace('.', ',')).join(';') + '\n'; });
  download('simulation.csv', csv, 'text/csv');
}

// ---- Animation
function currentDisp() {
  const out = state.simOut;
  const t = state.anim.t;
  const ts = out.t;
  let lo = 0, hi = ts.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; }
  const i1 = lo, i0 = Math.max(0, i1 - 1);
  const a = ts[i1] > ts[i0] ? (t - ts[i0]) / (ts[i1] - ts[i0]) : 0;
  const A0 = out.abs[i0], A1 = out.abs[i1];
  const x = state.anim.exag;
  const m = new Map();
  state.cm.bodies.forEach((b, k) => {
    const v = (j) => (A0[3 * k + j] * (1 - a) + A1[3 * k + j] * a) * x;
    m.set(b.el.id, { u: v(0), v: v(1), th: v(2) });
  });
  return m;
}
function buildPlayer() {
  const p = $('#player');
  const T = state.simOut.t[state.simOut.t.length - 1];
  p.innerHTML = `<button class="btn small" data-play>${state.anim.playing ? '⏸' : '▶'}</button>
    <input type="range" min="0" max="${T}" step="${T / 1000}" value="${state.anim.t}" data-scrub>
    <span class="time" data-time></span>
    <select class="inp" data-speed style="width:auto">${[0.1, 0.25, 0.5, 1, 2].map((s) => `<option value="${s}" ${state.anim.speed === s ? 'selected' : ''}>${String(s).replace('.', ',')}×</option>`).join('')}</select>`;
  p.querySelector('[data-play]').addEventListener('click', () => {
    if (!state.anim.playing && state.anim.t >= T) state.anim.t = 0;
    state.anim.playing = !state.anim.playing;
    state.anim.last = performance.now();
    updatePlayer();
    if (state.anim.playing) requestAnimationFrame(animLoop);
  });
  p.querySelector('[data-scrub]').addEventListener('input', (e) => { state.anim.t = Number(e.target.value); state.anim.playing = false; updatePlayer(); draw(); plot?.setCursor(state.anim.t); });
  p.querySelector('[data-speed]').addEventListener('change', (e) => { state.anim.speed = Number(e.target.value); });
  updatePlayer();
}
function updatePlayer() {
  const p = $('#player');
  if (!state.simOut || p.hidden) return;
  p.querySelector('[data-play]').textContent = state.anim.playing ? '⏸' : '▶';
  p.querySelector('[data-scrub]').value = state.anim.t;
  p.querySelector('[data-time]').textContent = 't = ' + state.anim.t.toFixed(2).replace('.', ',') + ' s';
}
function animLoop(now) {
  if (!state.anim.playing || state.step !== 'sim' || !state.simOut) return;
  const dt = (now - state.anim.last) / 1000;
  state.anim.last = now;
  const T = state.simOut.t[state.simOut.t.length - 1];
  state.anim.t = Math.min(T, state.anim.t + dt * state.anim.speed);
  if (state.anim.t >= T) state.anim.playing = false;
  draw();
  updatePlayer();
  plot?.setCursor(state.anim.t);
  if (state.anim.playing) requestAnimationFrame(animLoop);
}
function stopAnim() { state.anim.playing = false; }

// ------------------------------------------------------------ Menü, Datei
function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function loadSystem(sys) {
  state.sys = normalize(structuredClone(sys));
  state.sel = null; state.pending = null; state.resultKey = null; state.result = null; state.simOut = null; state.cm = null;
  save();
  fitView();
  setStep('model');
}
const menu = $('#menu');
$('#btn-menu').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.menu')) menu.hidden = true; });
$('#menu-examples').innerHTML = EXAMPLES.map((ex, i) => `<button data-ex="${i}">${esc(ex.name)}</button>`).join('');
menu.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  menu.hidden = true;
  if (b.dataset.ex !== undefined) { loadSystem(EXAMPLES[Number(b.dataset.ex)].sys); toast('Beispiel geladen: ' + EXAMPLES[Number(b.dataset.ex)].name); return; }
  switch (b.dataset.act) {
    case 'new': if (confirm('Aktuelles System verwerfen und neu beginnen?')) loadSystem(emptySystem()); break;
    case 'export': download('mks-system.json', JSON.stringify({ format: 'mks-simulator', version: 1, sys: state.sys }, null, 1), 'application/json'); break;
    case 'import': $('#file-input').click(); break;
    case 'svg': {
      const st = '<style>text{font-family:"Times New Roman",serif}.lbl{font-style:italic;font-size:17px}.bodyno{font-size:10px;fill:#999}.grid,.port,.port-hit{display:none}</style>';
      download('mks-zeichnung.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${svg.getAttribute('viewBox')}">${st}<rect width="100%" height="100%" fill="#fff"/>${svg.innerHTML}</svg>`, 'image/svg+xml');
      break;
    }
    case 'help': $('#help').hidden = false; break;
  }
});
$('#file-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    const sys = d.sys || d;
    if (!Array.isArray(sys.elements)) throw new Error('Keine gültige Systemdatei.');
    loadSystem(sys);
    toast('System geladen.');
  } catch (err) { toast('Fehler beim Laden: ' + err.message); }
  e.target.value = '';
});
$('#help').addEventListener('click', (e) => { if (e.target.matches('[data-close], .modal')) $('#help').hidden = true; });

// ------------------------------------------------------------ Start
buildPalette();
loadInitial();
setTool('select');
setStep('model');
if (state.fitOnStart) requestAnimationFrame(fitView);
window.__mks = state; // für Tests/Debugging
export { state, setStep, draw, propExpr };
