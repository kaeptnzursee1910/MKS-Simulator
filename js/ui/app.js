// Hauptsteuerung der Benutzeroberfläche
import { TYPES, isBody, isLine, hasRotation, ports, portWorld, propNum, propExpr, findPort } from '../mech/elements.js';
import { ensureParams, usedParams, paramEnv, buildModel, pointOnCurve } from '../mech/model.js';
import { setupDofs, analyze, suggestDofs } from '../mech/kinematics.js';
import { derive, METHODS } from '../mech/derive.js';
import { compile, simulate, INTEGRATORS, evalInput } from '../mech/numeric.js';
import { tryParse, paramNames as paramNamesOf } from '../cas/parse.js';
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
  guides: null,
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
function changed({ keepResult = false, typing = false } = {}) {
  ensureParams(state.sys);
  if (!keepResult) { state.cm = null; state.simOut = null; stopAnim(); }
  save();
  // Tippen wird zu einem Schritt zusammengefasst, jede andere Aktion ist ein eigener Schritt
  if (typing) scheduleCommit(); else commitHistory();
  draw();
}

// ------------------------------------------------------------ Rückgängig / Wiederholen
// Jede Modelländerung wird (zusammengefasst über kurze Eingabepausen) als Zustand gemerkt.
const hist = { undo: [], redo: [], last: null, timer: 0 };
const HIST_MAX = 100;
function histSnap() { return JSON.stringify(state.sys); }
function scheduleCommit() {
  clearTimeout(hist.timer);
  hist.timer = setTimeout(commitHistory, 350);
  updateEditCtl();
}
function commitHistory() {
  clearTimeout(hist.timer);
  const cur = histSnap();
  if (hist.last === null) { hist.last = cur; return; }
  if (cur === hist.last) return;
  hist.undo.push(hist.last);
  if (hist.undo.length > HIST_MAX) hist.undo.shift();
  hist.redo = [];
  hist.last = cur;
  updateEditCtl();
}
function restoreSnap(json) {
  state.sys = normalize(JSON.parse(json));
  hist.last = json;
  if (state.sel && !byId(state.sel)) state.sel = null;
  state.pending = null;
  state.cm = null; state.simOut = null; stopAnim();
  save(); draw(); renderPanel(); updateHint(); updateEditCtl();
}
function undo() {
  commitHistory();
  if (!hist.undo.length) { toast('Nichts rückgängig zu machen.'); return; }
  hist.redo.push(hist.last);
  restoreSnap(hist.undo.pop());
}
function redo() {
  commitHistory();
  if (!hist.redo.length) return;
  hist.undo.push(hist.last);
  restoreSnap(hist.redo.pop());
}
function updateEditCtl() {
  const u = document.querySelector('[data-edit="undo"]'), r = document.querySelector('[data-edit="redo"]');
  if (u) u.disabled = !hist.undo.length && histSnap() === hist.last;
  if (r) r.disabled = !hist.redo.length;
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
  ['Umgebung', [['ground', 'Boden'], ['curve', 'Kreis­bahn'], ['fix', 'Fest­punkt']]],
  ['Lager', [['pin', 'Fest­lager'], ['roller', 'Los­lager'], ['hinge', 'Gelenk'], ['roll', 'Rollen'], ['slide', 'Gleiten']]],
  ['Verbinder', [['rope', 'Seil'], ['spring', 'Feder'], ['damper', 'Dämpfer'], ['springdamper', 'Feder ∥ Dämpfer'], ['node', 'Knoten'], ['tspring', 'Dreh­feder'], ['tdamper', 'Dreh­dämpfer']]],
  ['Lasten', [['force', 'Kraft'], ['moment', 'Moment']]],
];
const PORT_TOOLS = new Set(['pin', 'roller', 'hinge', 'rope', 'spring', 'damper', 'springdamper', 'force', 'rod']);
const LINE_TOOLS = new Set(['rope', 'spring', 'damper', 'springdamper']);
/** Werkzeuge, die zwei Punkte verbinden: Antippen–Antippen oder in einem Zug ziehen */
const CONNECT_TOOLS = new Set([...LINE_TOOLS, 'hinge', 'tspring', 'tdamper', 'rod']);
const HINTS = {
  select: 'Element antippen zum Bearbeiten, Körper ziehen zum Verschieben (richtet sich an anderen Punkten aus), Leerfläche ziehen verschiebt die Ansicht.',
  delete: 'Element antippen, um es zu löschen.',
  block: 'Auf die Zeichenfläche tippen, um einen Klotz zu platzieren.',
  disk: 'Auf die Zeichenfläche tippen, um eine Scheibe zu platzieren.',
  stepdisk: 'Auf die Zeichenfläche tippen, um eine Stufenrolle (zwei Radien) zu platzieren.',
  rod: 'Stab vom Anfangs- zum Endpunkt ziehen (oder beide antippen), Winkel in 15°-Schritten. An Anschlusspunkten wird er gelenkig angeschlossen.',
  point: 'Auf die Zeichenfläche tippen, um eine Punktmasse zu platzieren.',
  ground: 'Auf die Zeichenfläche tippen, um einen Boden (Bahn) zu platzieren.',
  curve: 'Tippen setzt den tiefsten Punkt einer Kreismulde. Radius, Bogen und Mulde/Kuppe im Panel einstellen.',
  fix: 'Auf freie Fläche (Wand) oder auf ein freies Seil-/Federende tippen.',
  pin: 'Anschlusspunkt eines Körpers oder freies Seil-/Federende antippen → Festlager.',
  roller: 'Blauen Anschlusspunkt antippen → Loslager (Richtung danach im Panel einstellen).',
  hinge: 'Vom Anschlusspunkt des ersten Körpers zum zweiten Körper ziehen (oder beide antippen).',
  roll: 'Scheibe antippen → rollt ohne Gleiten auf dem nächsten Boden bzw. der nächsten Kreisbahn.',
  slide: 'Körper antippen → gleitet reibungsfrei auf dem nächsten Boden bzw. der nächsten Kreisbahn.',
  rope: 'Vom ersten zum zweiten Punkt ziehen (oder beide antippen). Anschlusspunkt = verbunden, leere Fläche = freies Ende. Wird automatisch gerade bzw. tangential ausgerichtet.',
  spring: 'Vom ersten zum zweiten Punkt ziehen (oder beide antippen). Anschlusspunkt = verbunden, leere Fläche = freies Ende. Wird automatisch gerade bzw. tangential ausgerichtet.',
  damper: 'Vom ersten zum zweiten Punkt ziehen (oder beide antippen). Anschlusspunkt = verbunden, leere Fläche = freies Ende. Wird automatisch gerade bzw. tangential ausgerichtet.',
  springdamper: 'Vom ersten zum zweiten Punkt ziehen (oder beide antippen). Anschlusspunkt = verbunden, leere Fläche = freies Ende. Wird automatisch gerade bzw. tangential ausgerichtet.',
  node: 'Freies Seil-/Federende antippen (oder leere Fläche): masseloser Verbindungspunkt für Reihenschaltungen.',
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
      if (state.pending.kind === 'line') h = 'Zweiten Punkt antippen oder dorthin ziehen (leere Fläche = freies Ende). Esc bricht ab.';
      if (state.pending.kind === 'rod') h = 'Endpunkt des Stabs antippen.';
      if (state.pending.kind === 'hinge') h = 'Anschlusspunkt am zweiten Körper antippen.';
      if (state.pending.kind === 'torsion') h = 'Zweiten Körper antippen oder leere Fläche (Umgebung).';
    }
  } else if (state.step === 'dof') h = 'Körper antippen, um seine Koordinaten als Freiheitsgrad zu wählen.';
  const hint = $('#hint');
  hint.classList.remove('action');
  hint.onclick = null;
  // Handy (Hochformat): Eigenschaften stehen unter der Zeichnung – Hinweis mit Sprung dorthin
  if (isPortraitPhone() && (state.step === 'model' || state.step === 'dof') && state.sel && !state.pending && state.tool === 'select') {
    const el = byId(state.sel);
    if (el) {
      h = (TYPES[el.type]?.name || 'Element') + (el.label ? ' ' + el.label : '') + ' ausgewählt – Eigenschaften unten ↓';
      hint.classList.add('action');
      hint.onclick = () => panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } else if (isPhone() && h.length > 60) h = h.split(/[.,(]/)[0] + '.';
  hint.textContent = h;
}
const isPhone = () => matchMedia('(max-width: 860px), (max-height: 500px)').matches;
const isPortraitPhone = () => matchMedia('(max-width: 860px) and (min-height: 501px)').matches;

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
    showPorts: step === 'model' && (PORT_TOOLS.has(state.tool) || state.pending?.kind === 'line' || gesture?.kind === 'handle'),
    hotPort: state.hotPort,
    step,
  };
  if (state.pending?.kind === 'line' && state.pointerW) {
    const a = state.pending.a;
    const el = a.el ? byId(a.el) : null;
    opts.preview = [el ? portWorld(el, a.port, opts.env) : [a.x, a.y], state.pointerW];
  }
  if (state.pending?.kind === 'rod' && state.pointerW) opts.preview = [state.pending.p, state.pointerW];
  if (state.pending?.kind === 'hinge' && state.pointerW) { const A = byId(state.pending.a.el); if (A) opts.preview = [portWorld(A, state.pending.a.port, opts.env), state.pointerW]; }
  if (state.pending?.kind === 'torsion' && state.pointerW) { const A = byId(state.pending.a); if (A) opts.preview = [[A.x, A.y], state.pointerW]; }
  opts.guides = state.guides;
  opts.handles = step === 'model' && state.tool === 'select';
  if (step === 'sim' && state.simOut) opts.disp = currentDisp();
  svg.innerHTML = renderScene(state.sys, V, opts);
  updateSelTools();
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
    if (!isBody(el) && el.type !== 'fix' && el.type !== 'node') continue;
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
    let d, r;
    if (el.type === 'rod') {
      // Abstand zur Stabachse
      const h = propNum(el, 'l', e, 0.4) / 2, a = ((el.angle || 0) * Math.PI) / 180;
      const t = [Math.cos(a), Math.sin(a)], v = [w[0] - el.x, w[1] - el.y];
      const s = Math.max(-h, Math.min(h, v[0] * t[0] + v[1] * t[1]));
      d = Math.hypot(v[0] - s * t[0], v[1] - s * t[1]); r = 0;
    } else {
      d = Math.hypot(el.x - w[0], el.y - w[1]);
      r = el.type === 'disk' ? propNum(el, 'R', e, 0.1) : el.type === 'block' ? Math.max(propNum(el, 'a', e, 0.2), propNum(el, 'b', e, 0.1)) / 2 : 0.02;
    }
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
/** Seil/Feder/Dämpfer zwischen zwei Enden; ein Ende ist ein Anschlusspunkt {el, port} oder frei {x, y} */
function finishLine(a, b) {
  if (a.el && b.el && a.el === b.el) { toast('Beide Enden liegen am selben Element.'); return null; }
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
function nodeAt(sx, sy, maxDist = 16) {
  let best = null, bd = maxDist;
  for (const el of state.sys.elements) {
    if (el.type !== 'node') continue;
    const P = V.S(el.x, el.y);
    const d = Math.hypot(P[0] - sx, P[1] - sy);
    if (d < bd) { bd = d; best = el; }
  }
  return best;
}
/** freies Seil-/Federende in der Nähe eines Bildschirmpunkts */
function freeEndAt(sx, sy, maxDist = 18) {
  let best = null, bd = maxDist;
  for (const el of state.sys.elements) {
    if (!isLine(el)) continue;
    for (const k of ['a', 'b']) {
      const r = el[k];
      if (!r || r.el || !Number.isFinite(r.x)) continue;
      const P = V.S(r.x, r.y);
      const d = Math.hypot(P[0] - sx, P[1] - sy);
      if (d < bd) { bd = d; best = { line: el, end: k }; }
    }
  }
  return best;
}
/** Über Gelenke verbundene Baugruppe eines Körpers */
function hingeGroup(bodyId) {
  const g = new Set([bodyId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const h of state.sys.elements) {
      if (h.type !== 'hinge') continue;
      const a = h.a?.el, b = h.b?.el;
      if (g.has(a) && !g.has(b) && b) { g.add(b); grew = true; }
      if (g.has(b) && !g.has(a) && a) { g.add(a); grew = true; }
    }
  }
  return g;
}
/** Ist die Baugruppe gelagert (Fest-/Loslager oder Bodenkontakt)? */
function groupAnchored(g) {
  return state.sys.elements.some((x) => ((x.type === 'pin' || x.type === 'roller') && g.has(x.at?.el)) || (x.type === 'contact' && g.has(x.body)));
}
function moveGroup(g, dx, dy) {
  for (const id of g) { const b = byId(id); if (b) { b.x = round6(b.x + dx); b.y = round6(b.y + dy); } }
}
/** Gelenk-/Lagerpunkt eines Körpers (Drehpunkt beim Ändern des Winkels) */
function pivotPort(body) {
  for (const x of state.sys.elements) {
    if ((x.type === 'pin' || x.type === 'roller') && x.at?.el === body.id) return x.at.port;
    if (x.type === 'hinge') { if (x.a?.el === body.id) return x.a.port; if (x.b?.el === body.id) return x.b.port; }
  }
  return null;
}
/** freies Ende in einen masselosen Knoten umwandeln (für Reihenschaltungen) */
function nodeAtFreeEnd(fe) {
  const r = fe.line[fe.end];
  const n = { id: newId('n'), type: 'node', x: r.x, y: r.y };
  state.sys.elements.push(n);
  fe.line[fe.end] = { el: n.id, port: 'c' };
  return n;
}
/** Lager (Festlager-Symbol oder Wand) an einem freien Ende anbringen */
function supportFreeEnd(fe, style) {
  const r = fe.line[fe.end];
  const other = fe.line[fe.end === 'a' ? 'b' : 'a'];
  const f = { id: newId('w'), type: 'fix', x: r.x, y: r.y, angle: -90 };
  if (style === 'pin') f.style = 'pin';
  else {
    const op = other?.el ? portWorld(byId(other.el), other.port, env()) : [other.x, other.y];
    f.angle = Math.round((Math.atan2(op[1] - r.y, op[0] - r.x) * 180) / Math.PI / 15) * 15;
  }
  state.sys.elements.push(f);
  fe.line[fe.end] = { el: f.id, port: 'c' };
  return f;
}

// ------------------------------------------------------------ Ausrichten, Geradeziehen, Führung
/** Weltpunkt eines Linienendes */
function refPoint(ref) {
  if (ref?.el) { const X = byId(ref.el); return X ? portWorld(X, ref.port, env()) : [0, 0]; }
  return [ref.x, ref.y];
}
/** Anzahl der Elemente (außer `except`), die sich auf Element id beziehen */
function refCount(id, except) {
  return state.sys.elements.filter((e) => e !== except && e.id !== id && [e.at?.el, e.a?.el, e.b?.el, e.body, typeof e.a === 'string' ? e.a : null, typeof e.b === 'string' ? e.b : null].includes(id)).length;
}
/** Kann dieses Linienende verschoben werden, ohne andere Verbindungen zu stören? */
function movableEnd(line, k) {
  const ref = line[k];
  if (!ref) return null;
  if (!ref.el) return { kind: 'free', ref };
  const X = byId(ref.el);
  if (!X) return null;
  if (X.type === 'fix' || X.type === 'node') return refCount(X.id, line) === 0 ? { kind: 'point', X } : null;
  if (!isBody(X)) return null;
  const g = hingeGroup(X.id);
  if (groupAnchored(g)) return null;
  const busy = state.sys.elements.some((e) => e !== line && (
    (isLine(e) && (g.has(e.a?.el) || g.has(e.b?.el))) || (e.type === 'force' && g.has(e.at?.el))));
  return busy ? null : { kind: 'body', g };
}
/** Radiale Richtung, falls das Ende auf dem Umfang einer Scheibe sitzt */
function rimDir(ref) {
  if (!ref?.el) return null;
  const X = byId(ref.el);
  if (X?.type !== 'disk') return null;
  const p = findPort(X, ref.port, env());
  if (!p?.rim) return null;
  const r = Math.hypot(p.w[0], p.w[1]) || 1;
  return [p.w[0] / r, p.w[1] / r];
}
/** Seil/Feder gerade ausrichten: tangential an Scheiben, sonst waagrecht/senkrecht/45°.
 *  Verschoben wird nur ein frei bewegliches Ende (freies Ende, unverbundener Festpunkt, ungelagerter Körper). */
function straighten(line) {
  for (const k of ['b', 'a']) {
    const mv = movableEnd(line, k);
    if (!mv) continue;
    const o = k === 'a' ? 'b' : 'a';
    const F = refPoint(line[o]), Q = refPoint(line[k]);
    const v = [Q[0] - F[0], Q[1] - F[1]];
    const L = Math.hypot(v[0], v[1]);
    if (L < 1e-6) return false;
    const rd = rimDir(line[o]) || rimDir(line[k]);
    const S = Math.SQRT1_2;
    const cands = rd ? [[-rd[1], rd[0], 25], [rd[0], rd[1], 20]] : [[1, 0, 15], [0, 1, 15], [S, S, 8], [S, -S, 8]];
    let best = null, bc = -1;
    for (const u of cands) { const c = Math.abs(v[0] * u[0] + v[1] * u[1]) / L; if (c > bc) { bc = c; best = u; } }
    if (bc < Math.cos((best[2] * Math.PI) / 180)) return false;
    const pr = v[0] * best[0] + v[1] * best[1];
    const d = [F[0] + pr * best[0] - Q[0], F[1] + pr * best[1] - Q[1]];
    if (Math.hypot(d[0], d[1]) < 1e-9) return true;
    if (mv.kind === 'free') { mv.ref.x = round6(mv.ref.x + d[0]); mv.ref.y = round6(mv.ref.y + d[1]); }
    else if (mv.kind === 'point') { mv.X.x = round6(mv.X.x + d[0]); mv.X.y = round6(mv.X.y + d[1]); }
    else moveGroup(mv.g, d[0], d[1]);
    return true;
  }
  return false;
}

/** Punkte eines Elements, die beim Verschieben ausgerichtet werden */
function snapPoints(el) {
  const e = env();
  if (isBody(el) || el.type === 'fix' || el.type === 'node') {
    return ports(el, e).filter((p) => !(el.type === 'rod' && (p.id === 'q1' || p.id === 'q2'))).map((p) => [el.x + p.w[0], el.y + p.w[1]]);
  }
  return [];
}
function targetPoints(skip) {
  const pts = [];
  for (const el of state.sys.elements) {
    if (skip.has(el.id)) continue;
    pts.push(...snapPoints(el));
    if (el.type === 'curve') {
      const rho = propNum(el, 'rho', env(), 0.5);
      pts.push([el.x, el.y]);
      for (const a of [el.a0 ?? 200, el.a1 ?? 340]) pts.push([round6(el.x + rho * Math.cos((a * Math.PI) / 180)), round6(el.y + rho * Math.sin((a * Math.PI) / 180))]);
    }
    if (isLine(el)) for (const k of ['a', 'b']) if (el[k] && !el[k].el && Number.isFinite(el[k].x)) pts.push([el[k].x, el[k].y]);
  }
  return pts;
}
/** Ausrichtung an Anschlusspunkten anderer Elemente (waagrecht/senkrecht), Toleranz in Pixeln */
function alignOffset(own, skip, tolPx = 9) {
  const tol = tolPx / V.s;
  const others = targetPoints(skip);
  let bx = null, by = null;
  for (const p of own) for (const q of others) {
    const dx = q[0] - p[0], dy = q[1] - p[1];
    if (Math.abs(dx) < tol && (!bx || Math.abs(dx) < Math.abs(bx.d))) bx = { d: dx, p, q };
    if (Math.abs(dy) < tol && (!by || Math.abs(dy) < Math.abs(by.d))) by = { d: dy, p, q };
  }
  const dx = bx ? bx.d : 0, dy = by ? by.d : 0;
  const guides = [];
  if (bx) guides.push([[bx.q[0], bx.p[1] + dy], bx.q]);
  if (by) guides.push([[by.p[0] + dx, by.q[1]], by.q]);
  return { dx, dy, guides };
}
function alignElement(el, skip = new Set([el.id]), tolPx = 9) {
  const a = alignOffset(snapPoints(el), skip, tolPx);
  el.x = round6(el.x + a.dx); el.y = round6(el.y + a.dy);
  return a;
}

/** Führung (senkrecht/waagrecht) eines Körpers – intern ein Loslager im Schwerpunkt */
const guideOf = (b) => state.sys.elements.find((x) => x.guide && x.at?.el === b.id);
function guideMode(b) {
  const g = guideOf(b);
  if (!g) return 'none';
  return Math.abs(Math.sin(((g.angle ?? -90) * Math.PI) / 180)) < 0.5 ? 'v' : 'h';
}
function setGuide(b, mode, auto = false) {
  state.sys.elements = state.sys.elements.filter((x) => !(x.guide && x.at?.el === b.id));
  if (mode === 'v' || mode === 'h') state.sys.elements.push({ id: newId('s'), type: 'roller', guide: true, auto, at: { el: b.id, port: 'c' }, angle: mode === 'v' ? 180 : -90 });
}
const bodyName = (b) => (TYPES[b.type].name.split(' ')[0]) + ' ' + (b.label || '');
/** Hängt ein Körper nur an einer senkrechten Verbindung, wird er (wie in Skizzen üblich) senkrecht geführt */
function autoGuide(line) {
  const P = refPoint(line.a), Q = refPoint(line.b);
  const vertical = Math.abs(P[0] - Q[0]) < 1e-6, horizontal = Math.abs(P[1] - Q[1]) < 1e-6;
  for (const k of ['a', 'b']) {
    const X = line[k]?.el ? byId(line[k].el) : null;
    if (!X || !['block', 'point', 'disk'].includes(X.type)) continue;
    const g = guideOf(X);
    if (g?.auto && !vertical && guideMode(X) === 'v' && horizontal) {
      setGuide(X, 'none'); toast(bodyName(X) + ': senkrechte Führung entfernt (waagrechte Verbindung).'); continue;
    }
    if (!vertical || g) continue;
    const constrained = state.sys.elements.some((e) => e.type === 'contact' && e.body === X.id
      || ((e.type === 'pin' || e.type === 'roller') && e.at?.el === X.id) || (e.type === 'hinge' && (e.a?.el === X.id || e.b?.el === X.id)));
    if (constrained) continue;
    // nur, wenn alle Verbindungen des Körpers senkrecht sind
    const allVertical = state.sys.elements.filter((e) => isLine(e) && (e.a?.el === X.id || e.b?.el === X.id))
      .every((e) => { const A = refPoint(e.a), B = refPoint(e.b); return Math.abs(A[0] - B[0]) < 1e-6; });
    if (!allVertical) continue;
    setGuide(X, 'v', true);
    toast(bodyName(X) + ' wird senkrecht geführt (wie in der Skizze) – änderbar unter „Führung“.', 3800);
  }
}
/** gezeichnete Länge als Ausdruck vorschlagen: Vielfaches von l₀ (√2·r, 2·r …) oder Zahlenwert */
function drawnLengthExpr(el, L) {
  let L0n;
  try { L0n = propNum(el, 'L0', env(), NaN); } catch { L0n = NaN; }
  if (!Number.isFinite(L0n) || L0n <= 0) return String(round3(L));
  const q = L / L0n;
  if (Math.abs(q - 1) < 0.005) return '';
  const src = String(el.props.L0).trim();
  const base = /^[A-Za-z0-9_.]+$/.test(src) ? src : '(' + src + ')';
  const C = [['sqrt(2)', Math.SQRT2], ['sqrt(3)', Math.sqrt(3)], ['sqrt(5)', Math.sqrt(5)], ['2', 2], ['3', 3], ['4', 4], ['1/2', 0.5], ['3/2', 1.5],
    ['sqrt(2)/2', Math.SQRT1_2], ['sqrt(3)/2', Math.sqrt(3) / 2], ['2*sqrt(2)', 2 * Math.SQRT2], ['1/3', 1 / 3], ['2/3', 2 / 3]];
  for (const [t, v] of C) if (Math.abs(q - v) < 0.002 * v) return t + '*' + base;
  return String(round3(L));
}
function updateAutoL0() {
  for (const el of state.sys.elements) {
    if (!isLine(el)) continue;
    const L = lineLength(el);
    if (L <= 1e-6) continue;
    if (el.L0auto) el.props.L0 = String(round3(L));
    else if (el.L0auto === false && el.type !== 'rope' && el.LzAuto !== false) { el.props.Lz = drawnLengthExpr(el, L); el.LzAuto = true; }
  }
}
function groundDistance(body, g) {
  if (g.type === 'curve') return Math.abs(Math.hypot(body.x - g.x, body.y - g.y) - propNum(g, 'rho', env(), 0.5));
  const a = ((g.angle || 0) * Math.PI) / 180;
  return Math.abs(-Math.sin(a) * (body.x - g.x) + Math.cos(a) * (body.y - g.y));
}
function nearestGround(body) {
  let best = null, bd = Infinity;
  for (const g of state.sys.elements.filter((x) => x.type === 'ground' || x.type === 'curve')) {
    const d = groundDistance(body, g);
    if (d < bd) { bd = d; best = g; }
  }
  return best;
}
function placeOnGround(body, g) {
  const e = env();
  if (g.type === 'curve') {
    const rho = propNum(g, 'rho', e, 0.5);
    const R = body.type === 'disk' ? propNum(body, 'R', e, 0.1) : 0;
    const dx = body.x - g.x, dy = body.y - g.y;
    const dist = Math.hypot(dx, dy) || 1;
    const inside = g.concave !== false;
    const rc = inside ? rho - R : rho + R;
    // Winkel auf 15° runden, damit die Geometrie exakt bleibt
    // Winkel auf 30°/45°-Raster runden, damit die Geometrie exakt und übersichtlich bleibt
    const raw = (Math.atan2(dy, dx) * 180) / Math.PI;
    const cands = []; for (let k = -12; k <= 12; k++) { cands.push(k * 30, k * 45); }
    const beta = (cands.reduce((b, c) => (Math.abs(c - raw) < Math.abs(b - raw) ? c : b), 0) * Math.PI) / 180;
    void dist;
    body.x = round6(g.x + rc * Math.cos(beta));
    body.y = round6(g.y + rc * Math.sin(beta));
    return;
  }
  const a = ((g.angle || 0) * Math.PI) / 180;
  const n = [-Math.sin(a), Math.cos(a)];
  let side = n[0] * (body.x - g.x) + n[1] * (body.y - g.y) >= 0 ? 1 : -1;
  const h = body.type === 'disk' ? propNum(body, 'R', e, 0.1) : body.type === 'block' ? propNum(body, 'b', e, 0.1) / 2 : 0;
  const t = [Math.cos(a), Math.sin(a)];
  const s = t[0] * (body.x - g.x) + t[1] * (body.y - g.y);
  body.x = round6(g.x + s * t[0] + side * h * n[0]);
  body.y = round6(g.y + s * t[1] + side * h * n[1]);
  if (body.type === 'block') body.angle = g.angle || 0;
}
const round6 = (v) => Math.round(v * 1e6) / 1e6;
function contactTool(body, mode) {
  if (mode === 'roll' && body.type !== 'disk') { toast('Rollen ohne Gleiten geht nur mit Scheiben.'); return; }
  if (body.type === 'rod') { toast('Kontakt nur für Klotz, Scheibe oder Punktmasse.'); return; }
  if (state.sys.elements.some((x) => x.type === 'contact' && x.body === body.id)) { toast('Dieser Körper hat schon einen Bodenkontakt.'); return; }
  const g = nearestGround(body);
  if (!g) { toast('Bitte zuerst einen Boden oder eine Kreisbahn zeichnen.'); return; }
  if (g.type === 'curve' && body.type === 'block') { toast('Auf einer Kreisbahn laufen nur Scheiben und Punktmassen.'); return; }
  if (g.type !== 'curve' && body.type === 'point') { toast('Punktmassen können nur auf einer Kreisbahn geführt werden (auf geradem Boden: Loslager verwenden).'); return; }
  placeOnGround(body, g);
  setGuide(body, 'none');
  const c = { id: newId('c'), type: 'contact', body: body.id, ground: g.id, mode };
  state.sys.elements.push(c);
  state.sel = c.id;
}
function deleteElement(id) {
  const del = new Set([id]);
  // Seile/Federn bleiben erhalten: angeschlossene Enden werden frei
  const e0 = env();
  for (const el of state.sys.elements) {
    if (!isLine(el) || el.id === id) continue;
    for (const k of ['a', 'b']) {
      if (el[k]?.el === id) {
        const X = byId(id);
        const p = portWorld(X, el[k].port, e0);
        el[k] = { x: round3(p[0]), y: round3(p[1]) };
      }
    }
  }
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
    draw(); renderPanel(); updateHint();
    return;
  }
  if (state.step !== 'model') return;
  const elG = target?.closest?.('[data-id]');
  switch (t) {
    case 'select': state.sel = elG ? elG.dataset.id : null; break;
    case 'delete': if (elG) deleteElement(elG.dataset.id); return;
    case 'rod': {
      // Stabenden rasten an Anschlusspunkten anderer Körper ein und werden dort gelenkig angeschlossen
      const pp = portAt(sx, sy, 18, isBody);
      const pw = pp ? portWorld(byId(pp.el), pp.port, env()) : ws;
      if (!state.pending) { state.pending = { kind: 'rod', p: pw, port: pp }; state.pointerW = w; updateHint(); draw(); return; }
      const p0 = state.pending.p, port0 = state.pending.port;
      state.pending = null;
      let L = Math.hypot(pw[0] - p0[0], pw[1] - p0[1]);
      let ang = 90;
      if (L < 0.04) L = 0.4;
      else ang = Math.round((Math.atan2(pw[1] - p0[1], pw[0] - p0[0]) * 180) / Math.PI / 15) * 15;
      L = pp ? Math.max(0.05, round3(L)) : Math.max(0.05, Math.round(L / 0.05) * 0.05);
      const el = createBody('rod', p0);
      const a = (ang * Math.PI) / 180;
      el.angle = ang;
      el.x = round6(p0[0] + (L / 2) * Math.cos(a));
      el.y = round6(p0[1] + (L / 2) * Math.sin(a));
      const ln = 'l_' + el.label;
      if (state.sys.params[ln] === undefined || state.sys.params[ln] === 0.4) state.sys.params[ln] = round3(L);
      const e1 = env();
      let joined = 0;
      for (const [ref, endId] of [[port0, 'e1'], [pp, 'e2']]) {
        if (!ref || ref.el === el.id) continue;
        const a = portWorld(el, endId, e1), b = portWorld(byId(ref.el), ref.port, e1);
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.004) { state.sys.elements.push({ id: newId('h'), type: 'hinge', a: { el: el.id, port: endId }, b: ref }); joined++; }
      }
      if (joined) toast('Stab ' + el.label + ' gelenkig angeschlossen' + (joined > 1 ? ' (beide Enden).' : '.'));
      state.sel = el.id; setTool('select');
      break;
    }
    case 'curve': {
      const i = nextIndex('rho');
      const el = { id: newId('k'), type: 'curve', x: ws[0], y: round3(ws[1] + 0.5), a0: 200, a1: 340, concave: true, props: { rho: 'rho_' + i } };
      addParamDefaults({ ['rho_' + i]: 0.5 });
      state.sys.elements.push(el); state.sel = el.id; setTool('select');
      break;
    }
    case 'block': case 'disk': case 'stepdisk': case 'point': {
      const el = createBody(t, ws);
      alignElement(el, new Set([el.id]), 12);
      state.sel = el.id; setTool('select');
      break;
    }
    case 'ground': {
      const el = { id: newId('g'), type: 'ground', x: ws[0], y: ws[1], angle: 0, len: 1.0 };
      state.sys.elements.push(el); state.sel = el.id; setTool('select');
      break;
    }
    case 'node': {
      const fe = freeEndAt(sx, sy);
      const n = fe ? nodeAtFreeEnd(fe) : { id: newId('n'), type: 'node', x: ws[0], y: ws[1] };
      if (!fe) state.sys.elements.push(n);
      state.sel = n.id;
      break;
    }
    case 'fix': {
      const nd = nodeAt(sx, sy);
      if (nd) { nd.type = 'fix'; nd.angle = 0; state.sel = nd.id; break; }
      const fe = freeEndAt(sx, sy);
      if (fe) { state.sel = supportFreeEnd(fe, 'wall').id; break; }
      const el = createFix(ws); el.angle = 0;
      state.sel = el.id; setTool('select');
      break;
    }
    case 'pin': case 'roller': {
      const p = portAt(sx, sy, 20, isBody);
      if (!p) {
        const nd = nodeAt(sx, sy);
        if (nd && t === 'pin') { nd.type = 'fix'; nd.style = 'pin'; nd.angle = -90; state.sel = nd.id; break; }
        const fe = freeEndAt(sx, sy);
        if (fe && t === 'pin') { state.sel = supportFreeEnd(fe, 'pin').id; break; }
        if (fe) { toast('Ein freies Seil-/Federende ist masselos und kann nicht verschieblich gelagert werden – Festlager verwenden.'); return; }
        toast('Bitte einen blauen Anschlusspunkt eines Körpers oder ein freies Seil-/Federende antippen.'); return;
      }
      // Lagerrichtung: vom Körpermittelpunkt zum Anschlusspunkt (sonst nach unten)
      const B = byId(p.el), pw = portWorld(B, p.port, env());
      const dx = pw[0] - B.x, dy = pw[1] - B.y;
      const ang = Math.hypot(dx, dy) > 1e-6 ? Math.round((Math.atan2(dy, dx) * 180) / Math.PI / 45) * 45 : -90;
      const gd = guideOf(B);
      if (gd?.auto) setGuide(B, 'none');
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
      const A = byId(state.pending.a.el), B = byId(p.el);
      const pa = portWorld(A, state.pending.a.port, e), pb = portWorld(B, p.port, e);
      const dx = pa[0] - pb[0], dy = pa[1] - pb[1];
      if (Math.hypot(dx, dy) > 1e-6) {
        // Bestehende Verbindungen erhalten: nur eine ungelagerte Baugruppe als Ganzes verschieben
        const gA = hingeGroup(A.id), gB = hingeGroup(B.id);
        if (gA.has(B.id) || (groupAnchored(gA) && groupAnchored(gB))) {
          if (Math.hypot(dx, dy) > 0.005) {
            state.pending = null; updateHint(); draw();
            toast('Die Punkte liegen nicht übereinander und beide Teile sind schon gelagert bzw. verbunden – bitte zuerst passend platzieren.', 4000);
            return;
          }
        } else if (!groupAnchored(gB)) moveGroup(gB, dx, dy);
        else moveGroup(gA, -dx, -dy);
      }
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
      let p = portAt(sx, sy, 18);
      if (!p) {
        const fe = freeEndAt(sx, sy);
        if (fe) { const n = nodeAtFreeEnd(fe); p = { el: n.id, port: 'c' }; }
      }
      let endRef = p;
      if (!endRef) { const al = alignOffset([ws], new Set()); endRef = { x: round6(ws[0] + al.dx), y: round6(ws[1] + al.dy) }; }
      if (!state.pending) {
        state.pending = { kind: 'line', a: endRef };
        state.pointerW = w;
        updateHint(); draw(); return;
      }
      const el = finishLine(state.pending.a, endRef);
      state.pending = null;
      if (el) {
        if (straighten(el)) { updateAutoL0(); if (el.L0auto) el.props.L0 = String(round3(lineLength(el))); }
        autoGuide(el);
        state.sel = el.id;
      }
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
  const hG = e.target.closest?.('[data-handle]');
  if (hG && state.step === 'model' && state.tool === 'select') {
    const [lid, k] = hG.dataset.handle.split('|');
    gesture = { kind: 'handle', line: byId(lid), end: k, sx, sy, moved: false };
    return;
  }
  const elG = e.target.closest?.('[data-id]');
  const el = elG ? byId(elG.dataset.id) : null;
  const draggable = state.step === 'model' && state.tool === 'select' && el && (isBody(el) || el.type === 'ground' || el.type === 'fix' || el.type === 'node' || el.type === 'curve');
  const grp = draggable && isBody(el) ? [...hingeGroup(el.id)].map((id) => byId(id)).map((b) => ({ b, x: b.x, y: b.y })) : null;
  // Ziehen ab einem Anschlusspunkt verbindet, Ziehen auf leerer Fläche verschiebt weiterhin die Ansicht
  let connect = false;
  if (state.step === 'model' && CONNECT_TOOLS.has(state.tool) && !state.pending) {
    if (state.tool === 'tspring' || state.tool === 'tdamper') { const bb = bodyAt(e.target, sx, sy); connect = !!(bb && hasRotation(bb)); }
    else if (state.tool === 'hinge') connect = !!portAt(sx, sy, 20, isBody);
    else if (state.tool === 'rod') connect = true;
    else connect = !!(portAt(sx, sy, 18) || freeEndAt(sx, sy));
  }
  gesture = { kind: 'down', sx, sy, target: e.target, el: draggable ? el : null, ox: el?.x, oy: el?.y, grp, view0: { ...state.view }, moved: false, connect };
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
  if (gesture?.kind === 'handle') {
    if (Math.hypot(sx - gesture.sx, sy - gesture.sy) > 3) gesture.moved = true;
    const hp = portAt(sx, sy, 18, (x) => !gesture.line[gesture.end === 'a' ? 'b' : 'a']?.el || x.id !== gesture.line[gesture.end === 'a' ? 'b' : 'a'].el);
    const w = V.toWorld(sx, sy);
    let fp = null;
    if (!hp) {
      fp = [round3(snapV(w[0], 0.025)), round3(snapV(w[1], 0.025))];
      const al = alignOffset([fp], new Set());
      fp = [round6(fp[0] + al.dx), round6(fp[1] + al.dy)];
      state.guides = al.guides.length ? al.guides : null;
    } else state.guides = null;
    gesture.line[gesture.end] = hp || { x: fp[0], y: fp[1] };
    state.hotPort = hp ? hp.el + '|' + hp.port : null;
    updateAutoL0();
    draw();
    return;
  }
  if (gesture?.kind === 'down') {
    const dx = sx - gesture.sx, dy = sy - gesture.sy;
    if (!gesture.moved && Math.hypot(dx, dy) > 6) gesture.moved = true;
    if (gesture.moved && gesture.connect) {
      // Verbinden in einem Zug: Startpunkt beim Drücken, Endpunkt beim Loslassen
      if (!gesture.started) {
        gesture.started = true;
        if (!state.pending) tap(gesture.sx, gesture.sy, gesture.target);
        if (!state.pending) { gesture.connect = false; gesture.dead = true; return; }
      }
      state.pointerW = V.toWorld(sx, sy);
      const hp = state.pending?.kind === 'torsion' ? null : portAt(sx, sy, 18);
      state.hotPort = hp ? hp.el + '|' + hp.port : null;
      draw();
      return;
    }
    if (gesture.dead) return;
    if (gesture.moved) {
      if (gesture.el) {
        let nx = round3(snapV(gesture.ox + dx / state.view.s, 0.025));
        let ny = round3(snapV(gesture.oy - dy / state.view.s, 0.025));
        // an Anschlusspunkten anderer Elemente ausrichten (Hilfslinien)
        const skip = new Set(gesture.grp ? gesture.grp.map((g) => g.b.id) : [gesture.el.id]);
        const px = gesture.el.x, py = gesture.el.y;
        gesture.el.x = nx; gesture.el.y = ny;
        const al = alignOffset(snapPoints(gesture.el), skip);
        gesture.el.x = px; gesture.el.y = py;
        nx = round6(nx + al.dx); ny = round6(ny + al.dy);
        state.guides = al.guides.length ? al.guides : null;
        if (gesture.grp) for (const g of gesture.grp) { g.b.x = round6(g.x + nx - gesture.ox); g.b.y = round6(g.y + ny - gesture.oy); }
        else { gesture.el.x = nx; gesture.el.y = ny; }
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
  state.guides = null;
  if (gesture?.kind === 'pinch') { if (pointers.size === 0) { gesture = null; save(); } return; }
  if (gesture?.kind === 'handle') { gesture = null; state.hotPort = null; changed(); renderPanel(); return; }
  if (gesture?.kind === 'down') {
    const g = gesture;
    gesture = null;
    if (g.dead) { draw(); return; }
    if (g.moved && g.connect) {
      const r = svg.getBoundingClientRect();
      const ex = e.clientX - r.left, ey = e.clientY - r.top;
      const tgt = document.elementFromPoint(e.clientX, e.clientY);
      state.hotPort = null;
      if (state.pending) tap(ex, ey, svg.contains(tgt) ? tgt : null);
      else draw();
      return;
    }
    if (!g.moved) tap(g.sx, g.sy, g.target);
    else if (g.el) { changed(); renderPanel(); }
    else save();
  }
}
svg.addEventListener('pointerup', endPointer);
svg.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); gesture = null; state.guides = null; draw(); });
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
    } else if (el.type === 'fix' || el.type === 'node') pts.push([el.x - 0.05, el.y - 0.05], [el.x + 0.05, el.y + 0.05]);
    else if (el.type === 'curve') {
      const r = propNum(el, 'rho', e, 0.5);
      let a0 = el.a0 ?? 200, a1 = el.a1 ?? 340; if (a1 < a0) a1 += 360;
      for (let a = a0; a <= a1; a += 10) pts.push([el.x + r * Math.cos((a * Math.PI) / 180), el.y + r * Math.sin((a * Math.PI) / 180)]);
    } else if (isLine(el)) for (const k of ['a', 'b']) if (el[k] && !el[k].el && Number.isFinite(el[k].x)) pts.push([el[k].x, el[k].y]);
  }
  if (!pts.length) { state.view = { cx: 0, cy: 0.15, s: 400 }; draw(); return; }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const W = svg.clientWidth || 600, H = svg.clientHeight || 400;
  const pad = Math.min(140, Math.max(60, W * 0.2)), padY = Math.min(120, Math.max(60, H * 0.22));
  const s = Math.min(1200, (W - pad) / Math.max(0.2, x1 - x0), (H - padY) / Math.max(0.2, y1 - y0));
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
  const mod = e.ctrlKey || e.metaKey;
  if (mod && state.step === 'model' && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && state.step === 'model' && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
  if (mod && state.step === 'model' && (e.key === 'd' || e.key === 'D') && state.sel) { e.preventDefault(); duplicateSelected(); return; }
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
// Drehen des Handys: Ansicht neu einpassen
let lastOrient = matchMedia('(orientation: landscape)').matches;
window.addEventListener('resize', () => {
  const o = matchMedia('(orientation: landscape)').matches;
  if (o !== lastOrient) { lastOrient = o; setTimeout(() => { fitView(); updateHint(); }, 150); }
});

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
// ---- Einheiten (SI)
const PROP_UNITS = {
  m: 'kg', J: 'kg·m²', R: 'm', Ri: 'm', a: 'm', b: 'm', l: 'm', L0: 'm',
  rho: 'm', k: 'N/m', d: 'N·s/m', kt: 'N·m/rad', dt: 'N·m·s/rad', F: 'N', M: 'N·m',
};
const FREQ_NAMES = /^(Omega|omega|w|Om)(_|$)/;
const unitTag = (u) => (u ? ` <span class="unit">[${u}]</span>` : '');
/** Einheit eines Parameters aus seiner Verwendung ableiten */
function paramUnits() {
  const units = { g: 'm/s²' };
  for (const el of state.sys.elements) {
    for (const [k, v] of Object.entries(el.props || {})) {
      const u = PROP_UNITS[k];
      if (!u || typeof v !== 'string' || !v.trim()) continue;
      const r = tryParse(v);
      if (r.error) continue;
      const names = paramNamesOf(r.expr);
      for (const n of names) if (FREQ_NAMES.test(n)) units[n] = 'rad/s';
      const rest = names.filter((n) => !FREQ_NAMES.test(n));
      if (rest.length === 1 && !units[rest[0]]) units[rest[0]] = u;
    }
  }
  return units;
}
function coordUnit(c) {
  if (c.dof) return c.dof.coord === 'phi' ? 'rad' : 'm';
  return c.name.startsWith('T_') ? 'rad' : 'm';
}
function exprField(label, key, el) {
  const v = el.props?.[key] ?? '';
  const bad = v !== '' && tryParse(v).error;
  return `<div class="field"><label>${label}${unitTag(PROP_UNITS[key])}</label><input type="text" class="${bad ? 'bad' : ''}" data-prop="${key}" value="${esc(v)}" spellcheck="false" autocomplete="off" autocapitalize="off"></div>`;
}
function angleField(label, el, key = 'angle') {
  return `<div class="field"><label>${label}</label><div class="row"><input type="number" step="1" data-k="${key}" value="${el[key] ?? 0}" style="width:90px" class="inp"><button class="btn small" data-rot="-15">↻ 15°</button><button class="btn small" data-rot="15">↺ 15°</button></div></div>`;
}

function panelModel() {
  const el = state.sel ? byId(state.sel) : null;
  let h = '';
  if (el) {
    const t = TYPES[el.type];
    h += `<h2>${el.guide ? 'Führung' : esc(t.name)}${el.label ? ' ' + esc(el.label) : ''}</h2><div class="card" id="el-props">`;
    if (isBody(el)) h += field('Bezeichnung', 'label', el.label);
    switch (el.type) {
      case 'block':
        h += exprField('Masse m', 'm', el) + exprField('Breite a', 'a', el) + exprField('Höhe b', 'b', el) + angleField('Winkel' + unitTag('°'), el);
        h += `<div class="field"><label>drehbar</label><label class="row"><input type="checkbox" data-bool="rot" ${el.props.rot ? 'checked' : ''}> Verdrehung als Koordinate</label></div>`;
        if (el.props.rot) h += exprField('Trägheit J<sub>S</sub>', 'J', el);
        break;
      case 'disk':
        h += exprField('Masse m', 'm', el) + exprField('Trägheit J<sub>S</sub>', 'J', el) + exprField('Radius R', 'R', el) + exprField('Innenradius', 'Ri', el);
        h += '<p class="muted">Innenradius leer lassen für eine einfache Scheibe. Beispiele: <code>2*r</code>, <code>m*r^2/2</code>.</p>';
        break;
      case 'rod':
        h += exprField('Masse m', 'm', el) + exprField('Länge l', 'l', el) + exprField('Trägheit J<sub>S</sub>', 'J', el) + angleField('Winkel' + unitTag('°'), el);
        break;
      case 'point': h += exprField('Masse m', 'm', el); break;
      case 'ground': h += angleField('Neigung' + unitTag('°'), el) + field('Länge (Zeichnung)' + unitTag('m'), 'len', el.len, { type: 'number', attrs: 'step="0.1" min="0.1"' }); break;
      case 'fix':
        h += `<div class="field"><label>Darstellung</label><div class="seg"><button data-fstyle="wall" class="${el.style !== 'pin' ? 'on' : ''}">Wand</button><button data-fstyle="pin" class="${el.style === 'pin' ? 'on' : ''}">Festlager</button></div></div>`;
        h += angleField('Richtung' + unitTag('°'), el) + '<p class="muted">Raumfester Punkt (Lager) für Seil-, Feder- und Dämpferenden.</p>';
        break;
      case 'curve':
        h += exprField('Radius ρ', 'rho', el);
        h += field('Bogen von' + unitTag('°'), 'a0', el.a0 ?? 200, { type: 'number', attrs: 'step="5"' }) + field('Bogen bis' + unitTag('°'), 'a1', el.a1 ?? 340, { type: 'number', attrs: 'step="5"' });
        h += `<div class="field"><label>Art</label><div class="seg"><button data-concave="1" class="${el.concave !== false ? 'on' : ''}">◡ Mulde</button><button data-concave="0" class="${el.concave === false ? 'on' : ''}">◠ Kuppe</button></div></div>`;
        h += `<div class="field"><label>Bogen</label><div class="row"><button class="btn small" data-arc="half">Halbkreis</button><button class="btn small" data-arc="flat">flach</button></div></div>`;
        h += '<p class="muted">Kreisförmige Bahn um den Mittelpunkt. Scheiben (Rollen/Gleiten) und Punktmassen (Gleiten) laufen innen (Mulde) oder außen (Kuppe). Werkzeug „Rollen“ bzw. „Gleiten“ auf den Körper anwenden.</p>';
        break;
      case 'pin': h += angleField('Richtung' + unitTag('°'), el) + '<p class="muted">Festlager: Punkt unverschieblich, Drehung frei.</p>'; break;
      case 'roller':
        if (el.guide) {
          const B = byId(el.at?.el);
          h += `<div class="field"><label>Richtung</label><div class="seg"><button data-gdir="v" class="${Math.abs(Math.sin(((el.angle ?? -90) * Math.PI) / 180)) < 0.5 ? 'on' : ''}">↕ senkrecht</button><button data-gdir="h" class="${Math.abs(Math.sin(((el.angle ?? -90) * Math.PI) / 180)) >= 0.5 ? 'on' : ''}">↔ waagrecht</button></div></div>`;
          h += `<p class="muted">Führung von ${esc(B ? bodyName(B) : '?')}: Der Körper kann sich nur in der gewählten Richtung verschieben.</p>`;
          break;
        }
        h += angleField('Richtung' + unitTag('°'), el) + '<p class="muted">Loslager/Gleitlager: Verschiebung in Richtung des Lagers gesperrt, quer dazu frei.</p>'; break;
      case 'node': {
        const n = state.sys.elements.filter((x) => isLine(x) && (x.a?.el === el.id || x.b?.el === el.id)).length;
        h += `<p class="muted">Masseloser Verbindungspunkt mit ${n} angeschlossenen Element${n === 1 ? '' : 'en'}. Zwei Elemente in Reihe werden zu einem Ersatzelement zusammengefasst (z. B. 1/k = 1/k₁ + 1/k₂). Der Knoten muss auf der Verbindungslinie der äußeren Enden liegen.</p>`;
        if (n !== 2) h += '<p class="msg warn">Für eine Reihenschaltung müssen genau zwei Elemente angeschlossen sein.</p>';
        break;
      }
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
        if (el.type !== 'rope' && !el.L0auto) h += exprField('Länge in der Zeichnung', 'Lz', el);
        {
          const endTxt = (r) => (r?.el ? (byId(r.el)?.type === 'fix' ? 'Lager/Festpunkt' : TYPES[byId(r.el)?.type]?.name + ' ' + (byId(r.el)?.label || '')) : '<b style="color:var(--warn)">frei</b>');
          h += `<div class="field"><label>Enden</label><span style="font-size:14px">${endTxt(el.a)} – ${endTxt(el.b)}</span></div>`;
          if (!el.a?.el || !el.b?.el) h += '<p class="msg warn">Ein freies Ende überträgt keine Kraft. Ende (□) auf einen Anschlusspunkt ziehen oder mit „Festlager“/„Festpunkt“ lagern.</p>';
          else h += '<p class="muted">Enden (□) lassen sich auf andere Anschlusspunkte ziehen oder lösen.</p>';
        }
        h += `<div class="field"><label></label><label class="row"><input type="checkbox" data-l0auto ${el.L0auto ? 'checked' : ''}> l₀ aus Zeichnung übernehmen</label></div>`;
        if (el.type !== 'rope' && !el.L0auto && el.props.Lz) h += '<p class="muted">Gezeichnete Länge ≠ l₀: Die Feder ist in der gezeichneten Lage vorgespannt (z. B. „im entspannten Zustand Länge r“). Die gezeichnete Länge wird aus der Zeichnung vorgeschlagen.</p>';
        h += '<p class="muted">Liegt ein Ende tangential an einer Scheibe, wird es als aufgewickelt behandelt.</p>';
        break;
      case 'tspring': h += exprField('Drehsteifigkeit', 'kt', el); break;
      case 'tdamper': h += exprField('Drehdämpfung', 'dt', el); break;
      case 'force': h += exprField('Kraft F(t)', 'F', el) + angleField('Richtung' + unitTag('°'), el) + '<p class="muted">Z. B. <code>F_0*cos(Omega*t)</code>. Richtung bleibt raumfest.</p>'; break;
      case 'moment':
        h += exprField('Moment M(t)', 'M', el);
        h += `<div class="field"><label>Drehsinn</label><div class="seg"><button data-mdir="1" class="${el.dir !== -1 ? 'on' : ''}">↺ gegen Uhrzeiger</button><button data-mdir="-1" class="${el.dir === -1 ? 'on' : ''}">↻ im Uhrzeiger</button></div></div>`;
        break;
    }
    if (['block', 'disk', 'point'].includes(el.type) && !state.sys.elements.some((x) => x.type === 'contact' && x.body === el.id)) {
      const gm = guideMode(el);
      h += `<div class="field"><label>Führung</label><div class="seg"><button data-guide="none" class="${gm === 'none' ? 'on' : ''}">frei</button><button data-guide="v" class="${gm === 'v' ? 'on' : ''}" title="nur senkrecht beweglich">↕ senkr.</button><button data-guide="h" class="${gm === 'h' ? 'on' : ''}" title="nur waagrecht beweglich">↔ waagr.</button></div></div>`;
      h += '<p class="muted">Geführte Körper bewegen sich nur in eine Richtung – z. B. eine hängende Masse, die sich nur auf und ab bewegt.</p>';
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
  const units = paramUnits();
  return '<table class="ptable">' + names.map((n) =>
    `<tr><td>${katexStr(nameTex(n))}</td><td><input type="number" step="any" data-param="${esc(n)}" value="${state.sys.params[n]}"></td><td class="unit-cell">${esc(units[n] || '')}</td></tr>`).join('') + '</table>';
}
function bindParamInputs(root) {
  root.querySelectorAll('[data-param]').forEach((inp) => inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    if (Number.isFinite(v)) { state.sys.params[inp.dataset.param] = v; inp.classList.remove('bad'); updateAutoL0(); changed({ typing: true }); }
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
      if (k === 'L0') { el.L0auto = false; updateAutoL0(); const lz = panel.querySelector('[data-prop="Lz"]'); if (lz && document.activeElement !== lz) lz.value = el.props.Lz || ''; }
      if (k === 'Lz') el.LzAuto = false;
      const bad = inp.value !== '' && tryParse(inp.value).error;
      inp.classList.toggle('bad', !!bad);
      if (!bad) { changed({ typing: true }); updateAutoL0(); }
    });
    inp.addEventListener('change', () => { const box = panel.querySelector('.ptable')?.closest('.card'); if (box) { panelModel(); } });
  });
  panel.querySelectorAll('[data-k]').forEach((inp) => inp.addEventListener('input', () => {
    const k = inp.dataset.k;
    if (k === 'label') {
      const v = inp.value.trim();
      if (v && !bodies().some((b) => b !== el && b.label === v)) { el.label = v; changed({ typing: true }); }
      return;
    }
    const v = parseFloat(inp.value);
    if (Number.isFinite(v)) { if (k === 'angle') setAngle(v); else el[k] = v; updateAutoL0(); changed({ typing: true }); }
  }));
  const setAngle = (ang) => setElAngle(el, ang);
  panel.querySelectorAll('[data-rot]').forEach((b) => b.addEventListener('click', () => rotateBy(el, Number(b.dataset.rot))));
  panel.querySelector('[data-bool]')?.addEventListener('change', (e) => { el.props[e.target.dataset.bool] = e.target.checked; changed(); panelModel(); });
  panel.querySelector('[data-l0auto]')?.addEventListener('change', (e) => { el.L0auto = e.target.checked; if (el.L0auto) { delete el.props.Lz; delete el.LzAuto; } updateAutoL0(); changed(); panelModel(); });
  panel.querySelectorAll('[data-fstyle]').forEach((b) => b.addEventListener('click', () => { if (b.dataset.fstyle === 'pin') { el.style = 'pin'; el.angle = -90; } else { delete el.style; } changed(); panelModel(); }));
  panel.querySelectorAll('[data-concave]').forEach((b) => b.addEventListener('click', () => {
    const cc = b.dataset.concave === '1';
    if (cc !== (el.concave !== false)) {
      // Bogen an der Waagrechten spiegeln; tiefster bzw. höchster Punkt bleibt an seiner Stelle
      const rho = propNum(el, 'rho', env(), 0.5);
      const a0 = el.a0 ?? 200, a1 = el.a1 ?? 340;
      el.a0 = 360 - a1; el.a1 = 360 - a0;
      if (el.a0 >= 360) { el.a0 -= 360; el.a1 -= 360; }
      el.y = round6(el.y + (cc ? 2 : -2) * rho);
      el.concave = cc;
      for (const c of state.sys.elements.filter((x) => x.type === 'contact' && x.ground === el.id)) placeOnGround(byId(c.body), el);
    }
    updateAutoL0(); changed(); panelModel();
  }));
  panel.querySelectorAll('[data-arc]').forEach((b) => b.addEventListener('click', () => {
    const up = el.concave === false;
    if (b.dataset.arc === 'half') { el.a0 = up ? 0 : 180; el.a1 = up ? 180 : 360; } else { el.a0 = up ? 20 : 200; el.a1 = up ? 160 : 340; }
    changed(); panelModel();
  }));
  panel.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { el.mode = b.dataset.mode; changed(); panelModel(); }));
  panel.querySelectorAll('[data-mdir]').forEach((b) => b.addEventListener('click', () => { el.dir = Number(b.dataset.mdir); changed(); panelModel(); }));
  panel.querySelector('[data-del]')?.addEventListener('click', () => deleteElement(el.id));
  panel.querySelectorAll('[data-guide]').forEach((b) => b.addEventListener('click', () => { setGuide(el, b.dataset.guide); changed(); panelModel(); }));
  panel.querySelectorAll('[data-gdir]').forEach((b) => b.addEventListener('click', () => { el.angle = b.dataset.gdir === 'v' ? 180 : -90; el.auto = false; changed(); panelModel(); }));
}

/** Winkel ändern; Körper dreht sich um seinen Gelenk-/Lagerpunkt, damit die Verbindung erhalten bleibt */
function setElAngle(el, ang) {
  const pv = isBody(el) ? pivotPort(el) : null;
  const before = pv ? portWorld(el, pv, env()) : null;
  el.angle = ang;
  if (pv) {
    const after = portWorld(el, pv, env());
    el.x = round6(el.x + before[0] - after[0]); el.y = round6(el.y + before[1] - after[1]);
  }
}
const ROTATABLE = new Set(['block', 'rod', 'ground', 'fix', 'pin', 'roller', 'force']);
function rotateBy(el, delta) {
  let a = (((el.angle ?? (el.type === 'pin' || el.type === 'roller' ? -90 : 0)) + delta) % 360 + 360) % 360;
  if (a > 180) a -= 360;
  setElAngle(el, a);
  updateAutoL0(); changed(); renderPanel();
}

// ---- Auswahl-Werkzeugleiste (schwebend an der Zeichnung)
const DUPLICABLE = new Set(['block', 'disk', 'rod', 'point', 'ground', 'curve', 'fix']);
function duplicateSelected() {
  const el = state.sel ? byId(state.sel) : null;
  if (!el || !DUPLICABLE.has(el.type)) return;
  const c = structuredClone(el);
  c.id = newId(el.id[0]);
  const e = env();
  const w = el.type === 'disk' ? 2 * propNum(el, 'R', e, 0.1) : el.type === 'block' ? propNum(el, 'a', e, 0.2) : el.type === 'rod' ? 0.15 : el.type === 'ground' ? 0 : 0.15;
  c.x = round6(el.x + w + 0.1);
  if (el.type === 'ground') c.y = round6(el.y - 0.3);
  if (isBody(el)) c.label = nextLabel();
  state.sys.elements.push(c);
  // Führung mitkopieren
  for (const g of state.sys.elements.filter((x) => x.guide && x.at?.el === el.id)) state.sys.elements.push({ ...structuredClone(g), id: newId('s'), at: { ...g.at, el: c.id } });
  state.sel = c.id;
  changed(); renderPanel(); updateHint();
  if (isBody(el)) toast('Kopie mit denselben Parametern (' + Object.values(el.props).filter((v) => typeof v === 'string' && v).join(', ') + ') – im Panel änderbar.');
}
function updateSelTools() {
  const box = $('#seltools');
  const el = state.sel ? byId(state.sel) : null;
  const show = el && state.step === 'model' && ['select', 'force', 'moment', 'pin', 'roller'].includes(state.tool) && !state.pending && !(gesture && gesture.moved);
  if (!show) { box.hidden = true; return; }
  const g = svg.querySelector(`[data-id="${CSS.escape(el.id)}"]`);
  if (!g) { box.hidden = true; return; }
  let bb;
  try { bb = g.getBBox(); } catch { box.hidden = true; return; }
  let h = '';
  if (ROTATABLE.has(el.type)) h += '<button data-st="rot+" title="15° gegen den Uhrzeigersinn drehen">↺</button><button data-st="rot-" title="15° im Uhrzeigersinn drehen">↻</button>';
  if (el.type === 'moment') h += '<button data-st="mdir" title="Drehsinn umkehren">⇄</button>';
  if (el.type === 'force') h += '<button data-st="flip" title="Richtung umkehren">⇄</button>';
  if (DUPLICABLE.has(el.type)) h += '<button data-st="dup" title="Duplizieren (Strg+D)">⧉</button>';
  h += '<button data-st="del" class="danger" title="Löschen (Entf)">🗑</button>';
  box.innerHTML = h;
  box.hidden = false;
  const W = svg.clientWidth, bw = box.offsetWidth, bh = box.offsetHeight;
  let x = bb.x + bb.width / 2 - bw / 2, y = bb.y - bh - 10;
  if (y < 44) y = bb.y + bb.height + 10;
  x = Math.max(6, Math.min(W - bw - 6, x));
  y = Math.max(6, Math.min(svg.clientHeight - bh - 6, y));
  box.style.left = x + 'px'; box.style.top = y + 'px';
}
$('#seltools').addEventListener('click', (e) => {
  const b = e.target.closest('[data-st]');
  const el = state.sel ? byId(state.sel) : null;
  if (!b || !el) return;
  switch (b.dataset.st) {
    case 'rot+': rotateBy(el, 15); break;
    case 'rot-': rotateBy(el, -15); break;
    case 'flip': rotateBy(el, 180); break;
    case 'mdir': el.dir = el.dir === -1 ? 1 : -1; changed(); renderPanel(); break;
    case 'dup': duplicateSelected(); break;
    case 'del': deleteElement(el.id); break;
  }
});
$('.edit-ctl').addEventListener('click', (e) => {
  const b = e.target.closest('[data-edit]');
  if (b) (b.dataset.edit === 'undo' ? undo : redo)();
});

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
      <div class="row"><span class="dof-title">${katexStr(nameTex(d.name))}</span><span class="muted">${d.coord === 'phi' ? (b?.type === 'point' ? 'Bahnwinkel' : 'Drehwinkel') : d.coord + '-Verschiebung'} von Körper ${esc(b?.label ?? '?')}</span></div>
      <div class="row" style="margin-top:6px"><input class="inp" style="width:110px" data-dname value="${esc(d.name)}" title="Name, z. B. phi_1, x, s">
      <div class="seg">${dirOpts.map(([v, t]) => `<button data-ddir="${v}" class="${d.dir === v ? 'on' : ''}">${t}</button>`).join('')}</div></div></div>
      <button class="btn small danger" data-drem title="Entfernen">×</button></div>`;
  }
  h += `<div class="row" style="margin-top:8px"><button class="btn small" data-suggest>Vorschlag übernehmen</button></div></div>`;

  h += '<h3>Körper</h3><div class="card">';
  for (const b of bodies()) {
    const rot = hasRotation(b) || pointOnCurve(sys, b, false);
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
      const m = buildModel({ ...sys, dofs: [] });
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
  h += '<h3>Anfangswerte</h3><div class="card"><table class="ptable"><tr><td></td><td class="muted" style="font-family:system-ui;font-style:normal;font-size:12px">q(0)</td><td class="muted" style="font-size:12px">q̇(0)</td><td></td></tr>';
  for (const d of sys.dofs) {
    const iv = sys.sim.init[d.id] || (sys.sim.init[d.id] = { q: '0', qd: '0' });
    h += `<tr><td>${katexStr(nameTex(d.name))}</td><td><input data-iq="${d.id}" value="${esc(iv.q)}"></td><td><input data-iqd="${d.id}" value="${esc(iv.qd)}"></td><td class="unit-cell">${d.coord === 'phi' ? 'rad<br>rad/s' : 'm<br>m/s'}</td></tr>`;
  }
  h += '</table><p class="muted">Winkel in rad (z. B. <code>10*pi/180</code>), Längen in m.</p></div>';
  h += '<h3>Zeitdiskretisierung</h3><div class="card">';
  h += `<div class="field"><label>Verfahren</label><select data-integ class="inp">${Object.entries(INTEGRATORS).map(([k, v]) => `<option value="${k}" ${sys.sim.integrator === k ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></div>`;
  h += `<div class="formula" style="font-size:13px">${katexStr(INTEGRATORS[sys.sim.integrator]?.tex || '', true)}</div>`;
  h += `<p class="muted">Zustand ${katexStr('\\mathbf{y} = [\\mathbf{q}, \\dot{\\mathbf{q}}]^T')}, ${katexStr('\\mathbf{F} = [\\dot{\\mathbf{q}}, \\ddot{\\mathbf{q}}]^T')}${r.numeric.type === 'dae' ? ' (q̈ und λ aus dem Gleichungssystem, mit Projektion auf die Bindungen)' : ' mit q̈ aus M(q) q̈ = F'}.</p>`;
  h += field('Schrittweite h' + unitTag('s'), 'h', sys.sim.h, { type: 'number', attrs: 'step="any" min="0"' });
  h += field('Endzeit T' + unitTag('s'), 'T', sys.sim.T, { type: 'number', attrs: 'step="any" min="0"' });
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
      unit: coordUnit(coords[i]) + (q === 'v' ? '/s' : ''),
      color: SERIES_COLORS[k % SERIES_COLORS.length], visible: !hiddenSeries.has(q + i) && (state.cm.type !== 'dae' || !!coords[i].dof || hiddenSeries.has('show' + q + i)),
    }));
  } else if (q === 'lam') {
    const m = out.lam[0]?.length || 0;
    series = Array.from({ length: m }, (_, j) => ({ key: 'l' + j, name: 'λ' + (j + 1), y: out.lam.map((r) => r[j]), color: SERIES_COLORS[j % SERIES_COLORS.length], visible: !hiddenSeries.has('l' + j) }));
  } else {
    series = ['T (kinetisch)', 'U (potentiell)', 'E = T + U'].map((n, j) => ({ key: 'E' + j, name: n, unit: 'J', y: out.E.map((r) => r[j]), color: SERIES_COLORS[j], visible: !hiddenSeries.has('E' + j) }));
  }
  const leg = $('#legend');
  leg.innerHTML = series.map((s) => `<label><input type="checkbox" data-s="${s.key}" ${s.visible ? 'checked' : ''}><i style="background:${s.color}"></i>${esc(s.name)}${s.unit ? ` <span class="unit">[${esc(s.unit)}]</span>` : ''}</label>`).join('');
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
  commitHistory();
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
hist.last = histSnap();
updateEditCtl();
setTool('select');
setStep('model');
if (state.fitOnStart) requestAnimationFrame(fitView);
window.__mks = state; // für Tests/Debugging
export { state, setStep, draw, propExpr };
