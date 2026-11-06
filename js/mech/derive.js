// Herleitung der Bewegungsgleichungen: Lagrange 1. Art, Lagrange 2. Art, d'Alembert-Lagrange
import {
  fn, ratsimp, trigsimp, leadingNegative, add, mul, pow, MONE, ZERO, num, sym, diff, subs, simplify, sqrtsimp, series, truncate, isZero, termsOf, freeSyms, evalNum, info,
} from '../cas/expr.js';
import { tex, eqTex, matTex as matTex0, vecTex as vecTex0 } from '../cas/latex.js';
import { paramSym } from '../cas/parse.js';
import { buildModel } from './model.js';
import { setupDofs, analyze, linearKinematics, exactKinematics } from './kinematics.js';
import { gaussSolve, makeTestEnvs, independentRows } from './linalg.js';

export const METHODS = {
  L1: 'Lagrange 1. Art',
  L2: 'Lagrange 2. Art',
  DAL: "d'Alembert-Lagrange (Prinzip der virtuellen Arbeit)",
};

const T_SYM = () => paramSym('t');

/** totale Zeitableitung */
export function ddt(e, coords) {
  const parts = [];
  for (const c of coords) {
    parts.push(mul(diff(e, c.s), c.d));
    parts.push(mul(diff(e, c.d), c.dd));
  }
  parts.push(diff(e, T_SYM()));
  return add(...parts);
}
const allVars = (coords) => coords.flatMap((c) => [c.s, c.d, c.dd]);
const S = (e) => trigsimp(ratsimp(simplify(e)));

// Abkürzungen ℓ für aktuelle Längen (Wurzelausdrücke) in der Anzeige
let ABBR = new Map();
function abbreviate(e) {
  switch (e.t) {
    case 'pow': {
      const a = ABBR.get(e.base.key);
      if (a) return pow(a.s, mul(2, e.exp));
      return pow(abbreviate(e.base), e.exp);
    }
    case 'add': return add(...e.terms.map(abbreviate));
    case 'mul': return mul(...e.factors.map(abbreviate));
    case 'fn': return fn(e.name, abbreviate(e.arg));
    default: return e;
  }
}
const TX = (e) => (typeof e === 'string' ? e : tex(ABBR.size ? abbreviate(e) : e));
const matTex = (M) => matTex0(M.map((r) => r.map(TX)));
const vecTex = (v) => vecTex0(v.map(TX));
function setupAbbr(doc, model, toX) {
  ABBR = new Map();
  let i = 0;
  for (const [, L] of model.lineInfo) {
    const dx = toX(L.dx), dy = toX(L.dy);
    const X = S(add(pow(dx, 2), pow(dy, 2)));
    if (![...freeSyms(X)].some((n) => info(n).kind === 'coord')) continue;
    if (ABBR.has(X.key)) continue;
    i++;
    const s = sym('ell_' + i, { kind: 'abbr', latex: '\\ell_{' + i + '}', order: 900 + i });
    ABBR.set(X.key, { s, def: '\\ell_{' + i + '} = \\sqrt{\\left(' + tex(dx) + '\\right)^2 + \\left(' + tex(dy) + '\\right)^2}' });
  }
  if (ABBR.size) {
    doc.text('Abkürzungen für die aktuellen Längen der Feder-/Seilelemente:');
    for (const a of ABBR.values()) doc.math(a.def);
  }
}

class Doc {
  constructor() { this.sections = []; }
  sec(title, intro) { this.cur = { title, intro, rows: [] }; this.sections.push(this.cur); return this; }
  math(t, note) { this.cur.rows.push({ tex: t, note }); return this; }
  text(t) { this.cur.rows.push({ text: t }); return this; }
}

function paren(e) { return e.t === 'add' ? '\\left(' + TX(e) + '\\right)' : TX(e); }
function coefTerm(c, s) {
  if (isZero(c)) return null;
  if (c.t === 'num' && c.n === 1 && c.d === 1) return { neg: false, t: TX(s) };
  if (c.t === 'num' && c.n === -1 && c.d === 1) return { neg: true, t: TX(s) };
  if (c.t === 'mul' && c.factors[0].t === 'num' && c.factors[0].n < 0) return { neg: true, t: paren(mul(MONE, c)) + ' ' + TX(s) };
  if (c.t === 'num' && c.n < 0) return { neg: true, t: paren(mul(MONE, c)) + ' ' + TX(s) };
  return { neg: false, t: paren(c) + ' ' + TX(s) };
}
/** Gleichung mit nach Ableitungen sortierten Koeffizienten darstellen */
function collectedEqTex(eq, groups, linear) {
  let rest = eq;
  const parts = [];
  for (const s of groups) {
    const c = S(diff(eq, s));
    if (!linear && freeSyms(c).has(s.name)) continue;
    if (isZero(c)) continue;
    rest = S(add(rest, mul(MONE, c, s)));
    const ct = coefTerm(c, s);
    if (ct) parts.push(ct);
  }
  let lhs = parts.map((p, i) => (p.neg ? (i ? ' - ' : '-') : i ? ' + ' : '') + p.t).join('');
  // Rest: Terme mit Koordinaten links, reine Zeit-/Parameterterme rechts
  const L = [], R = [];
  for (const t of termsOf(rest)) {
    let hasC = false;
    for (const n of freeSyms(t)) { const k = info(n).kind; if (k === 'coord' || k === 'vel' || k === 'acc' || k === 'lambda') hasC = true; }
    (hasC ? L : R).push(t);
  }
  if (L.length) {
    const lt = TX(add(...L));
    lhs += lhs ? (lt.startsWith('-') ? ' ' + lt.replace(/^-/, '- ') : ' + ' + lt) : lt;
  }
  const rhs = R.length ? TX(S(mul(MONE, add(...R)))) : '0';
  return (lhs || '0') + ' = ' + rhs;
}

function bodyKinRows(doc, model, P, label) {
  for (const b of model.bodies) {
    const cs = [b.X, b.Y, b.TH].filter(Boolean);
    const zero = cs.filter((c) => isZero(P(c)));
    const nz = cs.filter((c) => !isZero(P(c)));
    let t = nz.map((c) => c.tex + ' = ' + TX(P(c))).join(', \\quad ');
    if (zero.length) t += (t ? ', \\quad ' : '') + zero.map((c) => c.tex).join(' = ') + ' = 0';
    doc.math(t, label ? 'Körper ' + b.label : null);
  }
}

export function derive(sys) {
  const model = buildModel(sys);
  const dofs = setupDofs(model, sys);
  const an = analyze(model, dofs);
  if (!an.ok) throw new Error(an.messages.filter((m) => m.type === 'error').map((m) => m.text).join(' ') || 'Freiheitsgrade ungültig.');
  const lin = sys.mode === 'linear';
  const method = sys.method || 'L2';
  ABBR = new Map();
  let res;
  if (method === 'L1') res = deriveL1(model, dofs, lin, an);
  else {
    const kin = lin ? linearKinematics(model, dofs) : exactKinematics(model, dofs);
    res = deriveL2DAL(model, dofs, kin, lin, method, an);
  }
  res.method = method;
  res.mode = lin ? 'linear' : 'nonlinear';
  res.model = model;
  res.dofs = dofs;
  res.analysis = an;
  return res;
}

function introRows(doc, model, dofs, lin, an) {
  doc.sec('Freiheitsgrade und Koordinaten');
  doc.text(`Das System besteht aus ${model.bodies.length} Körper${model.bodies.length === 1 ? '' : 'n'} mit insgesamt n = ${an.n} Lagekoordinaten (Verschiebungen x, y und Verdrehung ϑ gegenüber der gezeichneten Lage) und ${an.rank} unabhängigen Bindungen. Damit hat es f = n − r = ${an.f} Freiheitsgrad${an.f === 1 ? '' : 'e'}.`);
  doc.math('\\mathbf{q} = ' + vecTex(dofs.coords.map((q) => q.s)));
  for (const q of dofs.coords) {
    const d = q.dof;
    const dir = d.coord === 'phi' ? (q.sign === 1 ? 'positiv gegen den Uhrzeigersinn' : 'positiv im Uhrzeigersinn')
      : d.coord === 'x' ? (q.sign === 1 ? 'positiv nach rechts' : 'positiv nach links')
        : (q.sign === 1 ? 'positiv nach oben' : 'positiv nach unten');
    doc.math(q.tex + ' = ' + (q.sign === 1 ? '' : '-') + q.abs.tex, `${d.coord === 'phi' ? 'Drehwinkel' : 'Verschiebung'} von Körper ${model.bodies.find((b) => [b.X, b.Y, b.TH].includes(q.abs)).label}, ${dir}`);
  }
  for (const w of model.warnings || []) doc.text('Hinweis: ' + w);
  if (lin) doc.text('Linearisierung: kleine Auslenkungen um die gezeichnete Lage q = 0. Energien werden bis zur 2. Ordnung entwickelt, die Bewegungsgleichungen sind damit linear.');
}

// ===================================================================== Lagrange 2 / d'Alembert
function deriveL2DAL(model, dofs, kin, lin, method, an) {
  const doc = new Doc();
  const qc = dofs.coords;
  const qs = qc.map((c) => c.s);
  const vars = allVars(qc);
  const map = lin ? kin.map2 : kin.map;
  const toQd = new Map(qc.map((c) => [c.s.name, c.d]));
  const toQdd = new Map(qc.map((c) => [c.s.name, c.dd]));
  const P = (c) => map.get(c.name);
  const P1 = (c) => (lin ? kin.map1.get(c.name) : map.get(c.name));
  const V = (c) => (lin ? subs(kin.map1.get(c.name), toQd) : S(ddt(map.get(c.name), qc)));
  const Mpos = new Map();
  for (const c of model.absCoords) {
    Mpos.set(c.s.name, P(c));
    Mpos.set(c.d.name, V(c));
  }
  const toQ = (e) => S(sqrtsimp(subs(e, Mpos), dofs.refEnv));

  introRows(doc, model, dofs, lin, an);
  if (!lin) setupAbbr(doc, model, toQ);

  doc.sec('Kinematik', lin ? 'Lage der Schwerpunkte und Drehwinkel (linearisiert):' : 'Lage der Schwerpunkte und Drehwinkel in Abhängigkeit der Freiheitsgrade (aus den Bindungen aufgelöst):');
  bodyKinRows(doc, model, P1, true);
  if (lin && model.g) {
    const extra = model.bodies.filter((b) => P(b.Y).key !== P1(b.Y).key);
    if (extra.length) {
      doc.text('Für die Lageenergie der Gewichtskraft wird die Höhe bis zur 2. Ordnung benötigt:');
      for (const b of extra) doc.math(b.Y.tex + ' \\approx ' + TX(P(b.Y)));
    }
  }
  if (kin.cons.length) {
    doc.text('Verwendete Bindungen:');
    for (const c of kin.cons) doc.math(TX(S(lin ? truncate(c.g, qs.concat(dofs.deps.map((d) => d.s)), 1, 1) : c.g)) + ' = 0', c.label);
  }

  doc.sec('Geschwindigkeiten');
  for (const b of model.bodies) {
    const cs = [b.X, b.Y, b.TH].filter(Boolean);
    const parts = cs.filter((c) => !isZero(V(c))).map((c) => info(c.d.name).latex + ' = ' + TX(V(c)));
    if (parts.length) doc.math(parts.join(', \\quad '), 'Körper ' + b.label);
  }

  // ---- Federn/Dämpfer
  const dLq = new Map(), dLdq = new Map();
  for (const s of [...model.springs, ...model.dampers]) {
    if (dLq.has(s.el.id)) continue;
    let dl = toQ(s.dL);
    if (lin) dl = truncate(dl, qs, 1, 1);
    dLq.set(s.el.id, dl);
    dLdq.set(s.el.id, lin ? subs(dl, toQd) : S(ddt(dl, qc)));
  }
  const relq = (r) => toQ(r);
  const reldq = (r) => (lin ? subs(toQ(r), toQd) : S(ddt(toQ(r), qc)));

  // ---- generalisierte Kräfte äußerer Lasten
  const Qext = qc.map((q) => {
    const parts = [];
    for (const L of model.loads) {
      const d = [toQ(L.d[0]), toQ(L.d[1])];
      parts.push(mul(L.Fv[0], diff(d[0], q.s)), mul(L.Fv[1], diff(d[1], q.s)));
    }
    for (const M of model.moments) parts.push(mul(M.M, diff(toQ(M.th), q.s)));
    let Q = S(add(...parts));
    if (lin) Q = truncate(Q, vars, 1);
    return Q;
  });

  let eqs;
  if (method === 'L2') {
    // ---- Energien
    const Tparts = model.bodies.map((b) => {
      const tr = mul(num(1, 2), b.m, add(pow(V(b.X), 2), pow(V(b.Y), 2)));
      const ro = b.TH ? mul(num(1, 2), b.J, pow(V(b.TH), 2)) : ZERO;
      return { b, T: S(add(tr, ro)) };
    });
    const T = S(add(...Tparts.map((x) => x.T)));
    doc.sec('Kinetische Energie', 'T = Σ ½ m (ẋ² + ẏ²) + ½ J ϑ̇²');
    for (const x of Tparts) if (!isZero(x.T)) doc.math('T_{' + x.b.label + '} = ' + TX(x.T));
    doc.math('T = ' + TX(T));

    doc.sec('Potentielle Energie', lin ? 'Bis zur 2. Ordnung entwickelt:' : null);
    const Uparts = [];
    if (model.g) for (const b of model.bodies) {
      const u = toQ(mul(b.m, model.g, b.Y.s));
      const ul = lin ? truncate(u, qs, 2, 1) : u;
      if (!isZero(ul)) Uparts.push({ label: 'U_{G,' + b.label + '}', U: ul });
    }
    for (const s of model.springs) {
      const dl = dLq.get(s.el.id);
      doc.math('\\Delta l_{' + texName(s.k) + '} = ' + TX(dl), 'Längenänderung ' + model.elName(s.el));
      Uparts.push({ label: 'U_{' + texName(s.k) + '}', U: S(mul(num(1, 2), s.k, pow(dl, 2))) });
    }
    for (const s of model.tsprings) Uparts.push({ label: 'U_{' + texName(s.k) + '}', U: S(mul(num(1, 2), s.k, pow(relq(s.rel), 2))) });
    for (const u of Uparts) doc.math(u.label + ' = ' + TX(u.U));
    let U = S(add(...Uparts.map((u) => u.U)));
    doc.math('U = ' + TX(U));

    const Dparts = [];
    for (const s of model.dampers) Dparts.push({ label: 'D_{' + texName(s.d) + '}', D: S(mul(num(1, 2), s.d, pow(dLdq.get(s.el.id), 2))) });
    for (const s of model.tdampers) Dparts.push({ label: 'D_{' + texName(s.d) + '}', D: S(mul(num(1, 2), s.d, pow(reldq(s.rel), 2))) });
    const D = S(add(...Dparts.map((d) => d.D)));
    if (Dparts.length) {
      doc.sec('Dissipationsfunktion (Rayleigh)', 'D = Σ ½ d (Δl̇)²');
      for (const s of model.dampers) if (!model.springs.find((x) => x.el === s.el)) doc.math('\\Delta l_{' + texName(s.d) + '} = ' + TX(dLq.get(s.el.id)));
      for (const d of Dparts) doc.math(d.label + ' = ' + TX(d.D));
      doc.math('D = ' + TX(D));
    }
    if (model.loads.length || model.moments.length) {
      doc.sec('Generalisierte Kräfte', 'Q_i = Σ F · ∂r_F/∂q_i + Σ M · ∂ϑ/∂q_i');
      qc.forEach((q, i) => doc.math('Q_{' + q.tex + '} = ' + TX(Qext[i])));
    }

    doc.sec('Lagrange-Gleichungen 2. Art',
      'd/dt (∂T/∂q̇ᵢ) − ∂T/∂qᵢ + ∂U/∂qᵢ + ∂D/∂q̇ᵢ = Qᵢ');
    eqs = qc.map((q, i) => {
      const dTdqd = S(diff(T, q.d));
      const dt = S(ddt(dTdqd, qc));
      const dTdq = S(diff(T, q.s));
      const dU = S(diff(U, q.s));
      const dD = S(diff(D, q.d));
      doc.math('\\frac{\\partial T}{\\partial ' + info(q.d.name).latex + '} = ' + TX(dTdqd) +
        ', \\qquad \\frac{\\mathrm{d}}{\\mathrm{d}t}\\frac{\\partial T}{\\partial ' + info(q.d.name).latex + '} = ' + TX(dt), 'Koordinate $' + q.tex + '$');
      doc.math('\\frac{\\partial T}{\\partial ' + q.tex + '} = ' + TX(dTdq) + ', \\qquad \\frac{\\partial U}{\\partial ' + q.tex + '} = ' + TX(dU) +
        (Dparts.length ? ', \\qquad \\frac{\\partial D}{\\partial ' + info(q.d.name).latex + '} = ' + TX(dD) : ''));
      return S(add(dt, mul(MONE, dTdq), dU, dD, mul(MONE, Qext[i])));
    });
    eqs.T = T; eqs.U = U;
  } else {
    // ---- d'Alembert-Lagrange
    doc.sec('Jacobi-Matrizen', 'Virtuelle Verschiebungen: δr = J_T δq, δϑ = J_R δq');
    const qsT = vecTex(qs);
    for (const b of model.bodies) {
      const JT = [b.X, b.Y].map((c) => qc.map((q) => S(diff(P1(c), q.s))));
      let t = '\\mathbf{J}_{T,' + b.label + '} = ' + matTex(JT);
      if (b.TH) t += ', \\qquad \\mathbf{J}_{R,' + b.label + '} = ' + matTex([qc.map((q) => S(diff(P1(b.TH), q.s)))]);
      doc.math(t);
    }
    doc.sec('Beschleunigungen', 'r̈ = J_T q̈ + J̇_T q̇');
    const A = (c) => (lin ? subs(kin.map1.get(c.name), toQdd) : S(ddt(V(c), qc)));
    for (const b of model.bodies) {
      const parts = [b.X, b.Y, b.TH].filter(Boolean).filter((c) => !isZero(A(c))).map((c) => info(c.dd.name).latex + ' = ' + TX(A(c)));
      if (parts.length) doc.math(parts.join(', \\quad '), 'Körper ' + b.label);
    }
    doc.sec('Eingeprägte Kräfte und virtuelle Arbeit');
    if (model.g) doc.text('Gewichtskräfte G = m g wirken in negativer y-Richtung.');
    for (const s of model.springs) doc.math('F_{' + texName(s.k) + '} = ' + TX(s.k) + ' \\, \\Delta l, \\quad \\Delta l = ' + TX(dLq.get(s.el.id)), 'Federkraft ' + model.elName(s.el));
    for (const s of model.dampers) doc.math('F_{' + texName(s.d) + '} = ' + TX(s.d) + ' \\, \\Delta \\dot l, \\quad \\Delta \\dot l = ' + TX(dLdq.get(s.el.id)), 'Dämpferkraft ' + model.elName(s.el));
    for (const s of model.tsprings) doc.math('M_{' + texName(s.k) + '} = ' + TX(S(mul(s.k, relq(s.rel)))), 'Drehfeder');
    for (const s of model.tdampers) doc.math('M_{' + texName(s.d) + '} = ' + TX(S(mul(s.d, reldq(s.rel)))), 'Drehdämpfer');
    for (const L of model.loads) doc.math('\\mathbf{F} = ' + TX(L.F) + vecTex(L.dir), 'äußere Kraft');
    for (const M of model.moments) doc.math('M = ' + TX(M.M), 'äußeres Moment (positiv gegen Uhrzeigersinn)');
    doc.text("Prinzip von d'Alembert in der Lagrangeschen Fassung: Σ (m r̈ − F)·δr + Σ (J ϑ̈ − M) δϑ = 0 für alle δq ⇒ für jede Koordinate qᵢ:");

    // Gleichungen (exakt in map; bei Linearisierung abgeschnitten)
    const Vx = (c) => S(ddt(map.get(c.name), qc));
    const Ax = (c) => S(ddt(Vx(c), qc));
    eqs = qc.map((q, i) => {
      const parts = [];
      for (const b of model.bodies) {
        parts.push(mul(b.m, Ax(b.X), diff(P(b.X), q.s)), mul(b.m, Ax(b.Y), diff(P(b.Y), q.s)));
        if (b.TH) parts.push(mul(b.J, Ax(b.TH), diff(P(b.TH), q.s)));
        if (model.g) parts.push(mul(b.m, model.g, diff(P(b.Y), q.s)));
      }
      for (const s of model.springs) { const dl = toQ(s.dL); parts.push(mul(s.k, dl, diff(dl, q.s))); }
      for (const s of model.dampers) { const dl = toQ(s.dL); parts.push(mul(s.d, ddt(dl, qc), diff(dl, q.s))); }
      for (const s of model.tsprings) { const r = toQ(s.rel); parts.push(mul(s.k, r, diff(r, q.s))); }
      for (const s of model.tdampers) { const r = toQ(s.rel); parts.push(mul(s.d, ddt(r, qc), diff(r, q.s))); }
      let e = S(add(...parts));
      if (lin) e = truncate(e, vars, 1);
      return S(add(e, mul(MONE, Qext[i])));
    });
    // Energien für die Energiekontrolle
    const T = S(add(...model.bodies.map((b) => add(mul(num(1, 2), b.m, add(pow(V(b.X), 2), pow(V(b.Y), 2))), b.TH ? mul(num(1, 2), b.J, pow(V(b.TH), 2)) : ZERO))));
    let U = toQ(model.U);
    if (lin) U = truncate(U, qs, 2, 1);
    eqs.T = T; eqs.U = U;
    void qsT;
  }

  // ---- Ergebnis
  const T = eqs.T, U = eqs.U;
  doc.sec('Bewegungsgleichungen');
  const groups = lin ? [...qc.map((q) => q.dd), ...qc.map((q) => q.d), ...qs] : qc.map((q) => q.dd);
  eqs.forEach((e) => doc.math(collectedEqTex(e, groups, lin)));

  const Mm = eqs.map((e) => qc.map((q) => S(diff(e, q.dd))));
  if (lin) {
    const Dm = eqs.map((e) => qc.map((q) => S(diff(e, q.d))));
    const Km = eqs.map((e) => qc.map((q) => S(diff(e, q.s))));
    const zero = new Map(vars.map((v) => [v.name, ZERO]));
    const f = eqs.map((e) => S(mul(MONE, subs(e, zero))));
    doc.sec('Matrizenform', 'M q̈ + D q̇ + K q = f(t)');
    doc.math('\\mathbf{M} = ' + matTex(Mm) + ', \\qquad \\mathbf{D} = ' + matTex(Dm));
    doc.math('\\mathbf{K} = ' + matTex(Km) + ', \\qquad \\mathbf{f} = ' + vecTex(f));
  } else {
    doc.sec('Matrizenform', 'M(q) q̈ = F(q, q̇, t)');
    const zero = new Map(qc.map((q) => [q.dd.name, ZERO]));
    const F = eqs.map((e) => S(mul(MONE, subs(e, zero))));
    doc.math('\\mathbf{M}(\\mathbf{q}) = ' + matTex(Mm));
    doc.math('\\mathbf{F}(\\mathbf{q},\\dot{\\mathbf{q}},t) = ' + vecTex(F));
  }

  const absMap = new Map();
  for (const c of model.absCoords) absMap.set(c.name, P(c));
  return {
    doc,
    numeric: { type: 'ode', energyValid: true, coords: qc, eqs: [...eqs], absMap, T, U },
  };
}

function texName(e) { return TX(e); }

// ===================================================================== Lagrange 1. Art
function deriveL1(model, dofs, lin, an) {
  const doc = new Doc();
  // Koordinaten p: Freiheitsgrade + übrige absolute Koordinaten
  const pc = [];
  const mass = [];
  for (const b of model.bodies) {
    for (const [c, m] of [[b.X, b.m], [b.Y, b.m], [b.TH, b.J]]) {
      if (!c) continue;
      const q = dofs.coords.find((x) => x.abs === c);
      pc.push(q || c);
      mass.push(m);
    }
  }
  const pvars = allVars(pc);
  const ps = pc.map((c) => c.s);
  const toP = (e) => S(sqrtsimp(subs(e, dofs.absSubs), dofs.refEnv));

  introRows(doc, model, dofs, lin, an);
  doc.sec('Lagrange 1. Art – Koordinaten', 'Alle Lagekoordinaten bleiben erhalten; die Bindungen werden über Lagrange-Multiplikatoren λ (Zwangskräfte) berücksichtigt.');
  doc.math('\\mathbf{p} = ' + vecTex(ps) + ', \\qquad \\mathbf{M} = \\operatorname{diag}' + '\\left(' + mass.map(tex).join(',\\; ') + '\\right)');

  if (!lin) setupAbbr(doc, model, toP);
  // Bindungen
  const Gnum = model.cons.map((c) => model.absCoords.map((a) => evalNum(diff(c.expr, a.s), model.refEnv)));
  const keep = Gnum.length ? independentRows(Gnum) : [];
  const cons = keep.map((i) => { let g = toP(model.cons[i].expr); if (leadingNegative(g)) g = S(mul(MONE, g)); return { ...model.cons[i], g }; });
  const zeroP = new Map(pvars.map((v) => [v.name, ZERO]));
  const gList = cons.map((c) => (lin ? truncate(c.g, ps, 1, 1) : c.g));
  const G = gList.map((g) => pc.map((c) => S(diff(g, c.s))));
  const lam = cons.map((_, j) => sym('lam' + (j + 1), { kind: 'lambda', latex: '\\lambda_{' + (j + 1) + '}', order: 5000 + j }));

  doc.sec('Bindungsgleichungen', lin ? 'linearisiert:' : null);
  cons.forEach((c, j) => doc.math('g_{' + (j + 1) + '} = ' + TX(gList[j]) + ' = 0', c.label));
  if (cons.length) doc.math('\\mathbf{G} = \\frac{\\partial \\mathbf{g}}{\\partial \\mathbf{p}} = ' + matTex(G));

  // eingeprägte Kräfte
  const U = toP(model.U);
  const dampD = [];
  for (const s of model.dampers) { const dl = toP(s.dL); dampD.push(mul(num(1, 2), s.d, pow(ddt(dl, pc), 2))); }
  for (const s of model.tdampers) { const r = toP(s.rel); dampD.push(mul(num(1, 2), s.d, pow(ddt(r, pc), 2))); }
  const D = S(add(...dampD));
  const f = pc.map((c) => {
    const parts = [mul(MONE, diff(U, c.s)), mul(MONE, diff(D, c.d))];
    for (const L of model.loads) {
      const d = [toP(L.d[0]), toP(L.d[1])];
      parts.push(mul(L.Fv[0], diff(d[0], c.s)), mul(L.Fv[1], diff(d[1], c.s)));
    }
    for (const M of model.moments) parts.push(mul(M.M, diff(toP(M.th), c.s)));
    let fk = S(add(...parts));
    if (lin) fk = truncate(fk, pvars, 1);
    return fk;
  });
  doc.sec('Eingeprägte Kräfte', 'f = −∂U/∂p − ∂D/∂ṗ + Q (Gewicht, Federn, Dämpfer, äußere Lasten)');
  let fDisp = f;
  if (!lin && ABBR.size) {
    // Darstellung mit Kraftsymbolen F_i für Feder-/Dämpferelemente mit veränderlicher Richtung
    const lines = new Map();
    for (const s of model.springs) lines.set(s.el.id, { ...(lines.get(s.el.id) || {}), el: s.el, k: s.k, dL: s.dL });
    for (const s of model.dampers) lines.set(s.el.id, { ...(lines.get(s.el.id) || {}), el: s.el, d: s.d, dL: s.dL });
    const parts = pc.map(() => []);
    let idx = 0;
    for (const L of lines.values()) {
      const dl = toP(L.dL);
      const dld = S(ddt(dl, pc));
      const usesAbbr = [...freeSyms(abbreviate(dl))].some((n) => n.startsWith('ell_'));
      if (usesAbbr) {
        idx++;
        const Fs = sym('Fs_' + idx, { kind: 'abbr', latex: 'F_{' + idx + '}', order: 950 + idx });
        const mag = add(L.k ? mul(L.k, sym('dl_' + idx, { kind: 'abbr', latex: '\\Delta l_{' + idx + '}', order: 960 + idx })) : ZERO,
          L.d ? mul(L.d, sym('dld_' + idx, { kind: 'abbr', latex: '\\Delta \\dot l_{' + idx + '}', order: 970 + idx })) : ZERO);
        doc.math('F_{' + idx + '} = ' + tex(mag) + ', \\quad \\Delta l_{' + idx + '} = ' + TX(dl), model.elName(L.el));
        pc.forEach((c, k) => parts[k].push(mul(MONE, Fs, diff(dl, c.s))));
      } else {
        const F = add(L.k ? mul(L.k, dl) : ZERO, L.d ? mul(L.d, dld) : ZERO);
        pc.forEach((c, k) => parts[k].push(mul(MONE, F, diff(dl, c.s))));
      }
    }
    const Ug = toP(model.Ug);
    fDisp = pc.map((c, k) => {
      const pp = [...parts[k], mul(MONE, diff(Ug, c.s))];
      for (const s of model.tsprings) { const r = toP(s.rel); pp.push(mul(MONE, s.k, r, diff(r, c.s))); }
      for (const s of model.tdampers) { const r = toP(s.rel); pp.push(mul(MONE, s.d, ddt(r, pc), diff(r, c.s))); }
      for (const L of model.loads) { const d = [toP(L.d[0]), toP(L.d[1])]; pp.push(mul(L.Fv[0], diff(d[0], c.s)), mul(L.Fv[1], diff(d[1], c.s))); }
      for (const M of model.moments) pp.push(mul(M.M, diff(toP(M.th), c.s)));
      return S(add(...pp));
    });
  }
  doc.math('\\mathbf{f} = ' + vecTex(fDisp));

  let geo = pc.map(() => ZERO);
  let lam0 = null;
  if (lin && cons.length) {
    // statische Zwangskräfte λ0 und geometrische Steifigkeit
    const f0 = f.map((fk) => S(add(...termsOf(subs(fk, zeroP)).filter((t) => !freeSyms(t).has('t')))));
    if (f0.some((x) => !isZero(x))) {
      const envs = makeTestEnvs(dofs.refEnv, []);
      const A = pc.map((_, k) => cons.map((_, j) => G[j][k]));
      const sol = gaussSolve(A, f0.map((x) => [S(mul(MONE, x))]), envs);
      if (!sol.error) {
        lam0 = sol.X.map((r) => r[0]);
        const s = add(...cons.map((c, j) => mul(lam0[j], c.g)));
        geo = pc.map((c) => truncate(diff(s, c.s), ps, 1, 1));
      }
    }
  }
  if (lam0 && lam0.some((x) => !isZero(x)) && geo.some((x) => !isZero(x))) {
    doc.sec('Statische Zwangskräfte', 'Für die Linearisierung werden die Zwangskräfte der Ruhelage λ₀ benötigt (geometrische Steifigkeit, z. B. beim Pendel):');
    doc.math('\\boldsymbol{\\lambda}_0 = ' + vecTex(lam0));
    doc.math('\\left(\\frac{\\partial \\mathbf{G}^T \\boldsymbol{\\lambda}_0}{\\partial \\mathbf{p}}\\right) \\mathbf{p} = ' + vecTex(geo));
  }

  const eqs = pc.map((c, k) => S(add(mul(mass[k], c.dd), mul(MONE, f[k]), mul(MONE, geo[k]),
    ...cons.map((_, j) => mul(MONE, G[j][k], lam[j])))));
  doc.sec('Bewegungsgleichungen (Lagrange 1. Art)', 'M p̈ = f + Gᵀ λ,  g(p) = 0');
  pc.forEach((c, k) => {
    const rhs = S(add(fDisp[k], geo[k], ...cons.map((_, j) => mul(G[j][k], lam[j]))));
    doc.math(TX(S(mul(mass[k], c.dd))) + ' = ' + TX(rhs));
  });
  cons.forEach((c, j) => doc.math(TX(gList[j]) + ' = 0'));
  doc.text(`Das sind ${pc.length} + ${cons.length} Gleichungen für ${pc.length} Koordinaten und ${cons.length} Multiplikatoren (Differential-algebraisches System, f = ${pc.length - cons.length}).`);
  doc.sec('Numerische Lösung', 'Zweimaliges Ableiten der Bindungen (Index-Reduktion) ergibt ein lineares Gleichungssystem für p̈ und λ:');
  doc.math('\\begin{bmatrix} \\mathbf{M} & -\\mathbf{G}^T \\\\ \\mathbf{G} & \\mathbf{0} \\end{bmatrix} \\begin{bmatrix} \\ddot{\\mathbf{p}} \\\\ \\boldsymbol{\\lambda} \\end{bmatrix} = \\begin{bmatrix} \\mathbf{f} \\\\ -\\dot{\\mathbf{G}}\\dot{\\mathbf{p}} \\end{bmatrix}');

  // numerische Daten
  const gamma = lin ? cons.map(() => ZERO) : cons.map((c, j) => {
    const Gp = add(...pc.map((cc, k) => mul(G[j][k], cc.d)));
    return S(add(...pc.map((cc) => mul(diff(Gp, cc.s), cc.d))));
  });
  const fFull = pc.map((_, k) => S(add(f[k], geo[k])));
  const absMap = new Map();
  for (const c of model.absCoords) absMap.set(c.name, dofs.absSubs.get(c.s.name) || c.s);
  const T = S(add(...pc.map((c, k) => mul(num(1, 2), mass[k], pow(c.d, 2)))));
  return {
    doc,
    numeric: { type: 'dae', energyValid: !lin, coords: pc, mass, f: fFull, G, g: gList, gamma, lam, absMap, T, U: lin ? truncate(U, ps, 2, 1) : U, eqs },
  };
}
