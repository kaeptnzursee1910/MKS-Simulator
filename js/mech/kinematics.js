// Freiheitsgrade, Freiheitsgradanalyse und Auflösen der Bindungen (Kinematik)
import { ratsimp, trigsimp, leadingNegative, add, mul, pow, MONE, ZERO, num, diff, subs, simplify, sqrtsimp, evalNum, has, hasAny, freeSyms, series, isZero, expand, sqrt, sym, fn } from '../cas/expr.js';
import { nameToLatex } from '../cas/latex.js';
import { makeCoord } from './model.js';
import { rank, gaussSolve, makeTestEnvs, numericallyZero, independentRows } from './linalg.js';

export const COORD_LABEL = { x: 'x', y: 'y', phi: 'φ' };

/** Freiheitsgrade des Benutzers -> Koordinaten-Objekte und Abbildung absolute Koordinate -> ±q */
export function setupDofs(model, sys) {
  const coords = [];
  const absToQ = new Map(); // abs name -> {k, sign}
  const seen = new Set();
  (sys.dofs || []).forEach((d, i) => {
    let abs, blabel = '?';
    if (d.coord === 's') {
      abs = model.trackCoords?.get(d.body);
      if (!abs) throw new Error('Freiheitsgrad „' + d.name + '“ gehört zu keiner Gleitbahn mehr.');
    } else {
      const b = model.bodyOf.get(d.body);
      if (!b) throw new Error('Freiheitsgrad „' + d.name + '“ gehört zu keinem Körper mehr.');
      abs = d.coord === 'x' ? b.X : d.coord === 'y' ? b.Y : b.TH;
      blabel = b.label;
    }
    if (!abs) throw new Error('Körper ' + blabel + ' ist nicht drehbar – φ kann kein Freiheitsgrad sein.');
    if (seen.has(abs.name)) throw new Error('Koordinate doppelt als Freiheitsgrad gewählt (Körper ' + blabel + ').');
    seen.add(abs.name);
    const q = makeCoord('q' + (i + 1), nameToLatex(d.name || 'q_' + (i + 1)), 1000 + i);
    q.dof = d;
    q.abs = abs;
    q.sign = d.dir === -1 ? -1 : 1;
    coords.push(q);
    absToQ.set(abs.name, { k: i, sign: q.sign });
  });
  const absSubs = new Map();
  for (const q of coords) {
    absSubs.set(q.abs.s.name, mul(q.sign, q.s));
    absSubs.set(q.abs.d.name, mul(q.sign, q.d));
    absSubs.set(q.abs.dd.name, mul(q.sign, q.dd));
  }
  const deps = model.absCoords.filter((c) => !absToQ.has(c.name));
  const refEnv = { ...model.refEnv };
  for (const q of coords) { refEnv[q.s.name] = 0; refEnv[q.d.name] = 0; refEnv[q.dd.name] = 0; }
  return { coords, absToQ, absSubs, deps, refEnv };
}

/** Numerische Freiheitsgradanalyse in der gezeichneten Lage */
export function analyze(model, dofs) {
  const n = model.absCoords.length;
  const G = model.cons.map((c) => model.absCoords.map((a) => {
    try { return evalNum(diff(c.expr, a.s), model.refEnv); } catch { return NaN; }
  }));
  const bad = G.flat().some((v) => !Number.isFinite(v));
  const r = G.length && !bad ? rank(G) : 0;
  const f = n - r;
  const res = { n, m: model.cons.length, rank: r, f, redundant: model.cons.length - r, messages: [], ok: false, G };
  if (bad) { res.messages.push({ type: 'error', text: 'Bindungsgleichungen lassen sich nicht auswerten (fehlende Zahlenwerte?).' }); return res; }
  if (dofs) {
    const chosen = dofs.coords.length;
    const depIdx = model.absCoords.map((a, i) => (dofs.absToQ.has(a.name) ? -1 : i)).filter((i) => i >= 0);
    const Gz = G.map((row) => depIdx.map((i) => row[i]));
    const rz = Gz.length && depIdx.length ? rank(Gz) : 0;
    if (chosen < f) res.messages.push({ type: 'error', text: `Es sind ${chosen} von ${f} Freiheitsgraden gewählt – bitte ${f - chosen} weitere festlegen.` });
    else if (chosen > f) res.messages.push({ type: 'error', text: `Zu viele Freiheitsgrade gewählt (${chosen}, das System hat f = ${f}).` });
    else if (rz < r) res.messages.push({ type: 'error', text: 'Die gewählten Koordinaten sind durch Bindungen voneinander abhängig – bitte andere Koordinaten wählen.' });
    else { res.ok = true; res.messages.push({ type: 'ok', text: `f = ${f} Freiheitsgrad${f === 1 ? '' : 'e'} – Wahl ist zulässig.` }); }
  }
  for (const w of model.warnings || []) res.messages.push({ type: 'warn', text: w });
  if (res.redundant > 0) res.messages.push({ type: 'warn', text: `${res.redundant} Bindung(en) sind redundant (statisch überbestimmt) und werden ignoriert.` });
  return res;
}

/** Vorschlag für Freiheitsgrade (bevorzugt Drehwinkel von Scheiben/Stäben, dann x, dann y) */
export function suggestDofs(model) {
  const a = analyze(model, null);
  const coords = model.absCoords;
  const pref = (c) => (c.name.startsWith('T_') ? 0 : c.name.startsWith('X_') ? 1 : 2);
  const order = coords.map((c, i) => i).sort((i, j) => pref(coords[i]) - pref(coords[j]) || i - j);
  const chosen = [];
  for (const i of order) {
    if (chosen.length >= a.f) break;
    const rest = coords.map((_, k) => k).filter((k) => k !== i && !chosen.includes(k));
    const Gz = a.G.map((row) => rest.map((k) => row[k]));
    if ((Gz.length && rest.length ? rank(Gz) : 0) === a.rank) chosen.push(i);
  }
  return chosen.map((i) => coords[i]);
}

function prepConstraints(model, dofs) {
  // redundante Bindungen entfernen
  const G = model.cons.map((c) => model.absCoords.map((a) => evalNum(diff(c.expr, a.s), model.refEnv)));
  const keep = G.length ? independentRows(G) : [];
  return keep.map((i) => {
    let g = simplify(sqrtsimp(subs(model.cons[i].expr, dofs.absSubs), dofs.refEnv));
    if (leadingNegative(g)) g = simplify(mul(MONE, g));
    return { ...model.cons[i], g };
  });
}

/** Linearisierte Kinematik: abhängige Koordinaten bis zur 2. Ordnung in q */
export function linearKinematics(model, dofs) {
  const cons = prepConstraints(model, dofs);
  const qs = dofs.coords.map((q) => q.s);
  const deps = dofs.deps;
  const zero = new Map([...qs, ...deps.map((d) => d.s)].map((s) => [s.name, ZERO]));
  const envs = makeTestEnvs(dofs.refEnv, qs.map((s) => s.name));
  const map1 = new Map(), map2 = new Map();
  for (const q of dofs.coords) { map1.set(q.abs.name, mul(q.sign, q.s)); map2.set(q.abs.name, mul(q.sign, q.s)); }
  if (deps.length) {
    if (!cons.length) throw new Error('Zu wenige Bindungen/Freiheitsgrade: ' + deps.map((d) => '$' + d.tex + '$').join(', ') + ' unbestimmt.');
    const Gz = cons.map((c) => deps.map((z) => simplify(subs(diff(c.g, z.s), zero))));
    const B1 = cons.map((c) => [simplify(mul(MONE, add(...qs.map((q) => mul(subs(diff(c.g, q), zero), q)))))]);
    const s1 = gaussSolve(Gz, B1, envs);
    if (s1.error) throw new Error('Kinematik nicht eindeutig: Koordinate $' + deps[s1.col].tex + '$ ist durch die gewählten Freiheitsgrade nicht festgelegt. Bitte Freiheitsgrade prüfen.');
    if (s1.residual.some((r) => !numericallyZero(r[0], envs))) throw new Error('Die gewählten Freiheitsgrade sind nicht unabhängig.');
    deps.forEach((z, i) => map1.set(z.name, ratsimp(s1.X[i][0])));
    // 2. Ordnung
    const m1 = new Map(deps.map((z, i) => [z.s.name, s1.X[i][0]]));
    const B2 = cons.map((c) => [simplify(mul(MONE, series(subs(c.g, m1), qs, 2)[2]))]);
    const s2 = gaussSolve(Gz, B2, envs);
    deps.forEach((z, i) => map2.set(z.name, ratsimp(simplify(add(s1.X[i][0], s2.X ? s2.X[i][0] : ZERO)))));
  }
  return { map1, map2, cons };
}

// ----------------------------------------- exakte (nichtlineare) Auflösung
function quadRoots(e, z, refEnv, envs) {
  const A = simplify(mul(num(1, 2), diff(diff(e, z), z)));
  if (!numericallyZero(simplify(diff(A, z)), envs)) return null;
  const Bc = simplify(subs(diff(e, z), new Map([[z.name, ZERO]])));
  const C = simplify(subs(e, new Map([[z.name, ZERO]])));
  if (hasAny(A, [z.name]) || hasAny(Bc, [z.name]) || hasAny(C, [z.name])) return null;
  if (numericallyZero(A, envs)) return null;
  const disc = sqrtsimp(simplify(add(pow(Bc, 2), mul(-4, A, C))), refEnv);
  const r1 = simplify(mul(add(mul(MONE, Bc), sqrt(disc)), pow(mul(2, A), MONE)));
  const r2 = simplify(mul(add(mul(MONE, Bc), mul(MONE, sqrt(disc))), pow(mul(2, A), MONE)));
  let v1 = Infinity, v2 = Infinity;
  try { v1 = Math.abs(evalNum(r1, refEnv)); } catch { /* */ }
  try { v2 = Math.abs(evalNum(r2, refEnv)); } catch { /* */ }
  if (!Number.isFinite(Math.min(v1, v2))) return null;
  return v1 <= v2 ? r1 : r2;
}
function findSqrt(e, z) {
  let found = null;
  const walk = (x) => {
    if (found) return;
    if (x.t === 'pow' && x.exp.t === 'num' && x.exp.d === 2 && has(x.base, z)) { found = x; return; }
    for (const c of (x.t === 'add' ? x.terms : x.t === 'mul' ? x.factors : x.t === 'pow' ? [x.base] : x.t === 'fn' ? [x.arg] : [])) walk(c);
  };
  walk(e);
  return found;
}
function solveFor(e, z, refEnv, envs) {
  e = expand(e);
  const a = simplify(diff(e, z));
  if (!has(a, z)) {
    let a0;
    try { a0 = evalNum(a, refEnv); } catch { return null; }
    if (Math.abs(a0) < 1e-12) return null;
    const rest = simplify(subs(e, new Map([[z.name, ZERO]])));
    return simplify(mul(MONE, rest, pow(a, MONE)));
  }
  // Winkel aus  A·cos z + B·sin z + C = 0  (z. B. gleitendes Stabende) → arcsin/arctan
  const tr = solveTrig(e, z, refEnv, envs);
  if (tr) return tr;
  // Wurzel isolieren: e = C*sqrt(X) + R
  const S = findSqrt(e, z);
  if (S) {
    const Cs = [], Rs = [];
    for (const t of (e.t === 'add' ? e.terms : [e])) {
      const fs = t.t === 'mul' ? t.factors : [t];
      const i = fs.findIndex((f) => f.key === S.key);
      if (i >= 0) Cs.push(mul(...fs.filter((_, k) => k !== i)));
      else Rs.push(t);
    }
    const Cc = add(...Cs), R = add(...Rs);
    if (!has(Cc, z) && !has(R, z)) {
      const poly = simplify(add(mul(S.base, pow(Cc, 2)), mul(MONE, pow(R, 2))));
      const r = solveLinear(poly, z, refEnv) || quadRoots(poly, z, refEnv, envs);
      if (r) return r;
    }
  }
  return quadRoots(e, z, refEnv, envs);
}
/** sin z, cos z durch Hilfssymbole ersetzen */
function replaceTrig(x, z, S, C) {
  switch (x.t) {
    case 'fn':
      if (x.arg.key === z.key && x.name === 'sin') return S;
      if (x.arg.key === z.key && x.name === 'cos') return C;
      return fn(x.name, replaceTrig(x.arg, z, S, C));
    case 'add': return add(...x.terms.map((t) => replaceTrig(t, z, S, C)));
    case 'mul': return mul(...x.factors.map((t) => replaceTrig(t, z, S, C)));
    case 'pow': return pow(replaceTrig(x.base, z, S, C), replaceTrig(x.exp, z, S, C));
    default: return x;
  }
}
/** A·cos z + B·sin z + C = 0 nach z auflösen; Zweig so, dass z in der gezeichneten Lage 0 ist */
function solveTrig(e, z, refEnv, envs) {
  const S = sym('__trigS'), C = sym('__trigC');
  const f = expand(replaceTrig(e, z, S, C));
  if (has(f, z)) return null;
  // direkte Lösung z = u, wenn u als Winkel in der Gleichung vorkommt (z. B. sin z = sin ψ ⇒ z = ψ):
  // gilt für alle Lagen, nicht nur im Hauptzweig des arcsin
  const cands = new Map();
  const walk = (x) => {
    if (x.t === 'fn' && (x.name === 'sin' || x.name === 'cos') && !has(x.arg, z)) cands.set(x.arg.key, x.arg);
    for (const c of (x.t === 'add' ? x.terms : x.t === 'mul' ? x.factors : x.t === 'pow' ? [x.base, x.exp] : x.t === 'fn' ? [x.arg] : [])) walk(c);
  };
  walk(e);
  for (const u of cands.values()) {
    try {
      if (Math.abs(evalNum(u, refEnv)) > 1e-9) continue;
      if (envs && numericallyZero(simplify(subs(e, new Map([[z.name, u]]))), envs, 1e-9)) return u;
    } catch { /* nächster Kandidat */ }
  }
  let A = simplify(diff(f, C)), B = simplify(diff(f, S));
  if (hasAny(A, [S.name, C.name]) || hasAny(B, [S.name, C.name])) return null;
  let R = simplify(subs(f, new Map([[S.name, ZERO], [C.name, ZERO]])));
  let B0;
  try { B0 = evalNum(B, refEnv); } catch { return null; }
  if (!Number.isFinite(B0) || Math.abs(B0) < 1e-12) return null; // nur cos z: Zweig nicht eindeutig
  if (B0 < 0) { A = simplify(mul(MONE, A)); B = simplify(mul(MONE, B)); R = simplify(mul(MONE, R)); }
  const r = isZero(A)
    ? fn('asin', simplify(mul(MONE, R, pow(B, MONE))))
    : add(fn('asin', simplify(mul(MONE, R, pow(add(pow(A, 2), pow(B, 2)), num(-1, 2))))), mul(MONE, fn('atan', simplify(mul(A, pow(B, MONE))))));
  try { if (Math.abs(evalNum(r, refEnv)) > 1e-6) return null; } catch { return null; }
  return r;
}
function solveLinear(e, z, refEnv) {
  const a = simplify(diff(e, z));
  if (has(a, z)) return null;
  let a0; try { a0 = evalNum(a, refEnv); } catch { return null; }
  if (Math.abs(a0) < 1e-12) return null;
  return simplify(mul(MONE, subs(e, new Map([[z.name, ZERO]])), pow(a, MONE)));
}

/** Exakte Kinematik: abhängige Koordinaten als Funktionen der Freiheitsgrade */
export function exactKinematics(model, dofs) {
  const cons = prepConstraints(model, dofs);
  const qs = dofs.coords.map((q) => q.s);
  const envs = makeTestEnvs(dofs.refEnv, qs.map((s) => s.name), 3);
  const sol = new Map();
  const depNames = new Set(dofs.deps.map((d) => d.s.name));
  const used = new Set();
  let progress = true;
  while (progress) {
    progress = false;
    for (const pass of [1, 2]) {
      for (let i = 0; i < cons.length; i++) {
        if (used.has(i)) continue;
        const e = simplify(sqrtsimp(subs(cons[i].g, sol), dofs.refEnv));
        const unk = [...freeSyms(e)].filter((n) => depNames.has(n) && !sol.has(n));
        if (!unk.length) {
          if (!numericallyZero(e, envs, 1e-7)) throw new Error('Die gewählten Freiheitsgrade sind nicht unabhängig (Bindung „' + cons[i].label + '“ verknüpft sie).');
          used.add(i); continue;
        }
        if (pass === 1 && unk.length > 1) continue;
        for (const zn of unk) {
          const z = dofs.deps.find((d) => d.s.name === zn).s;
          const r = solveFor(e, z, dofs.refEnv, envs);
          if (r) {
            const m = new Map([[zn, r]]);
            for (const [k, v] of sol) sol.set(k, simplify(sqrtsimp(subs(v, m), dofs.refEnv)));
            sol.set(zn, r);
            used.add(i);
            progress = true;
            break;
          }
        }
        if (progress) break;
      }
      if (progress) break;
    }
  }
  const missing = dofs.deps.filter((d) => !sol.has(d.s.name));
  if (missing.length) {
    throw new Error('Die Bindungen lassen sich nicht geschlossen nach ' + missing.map((d) => '$' + d.tex + '$').join(', ') +
      ' auflösen. Tipp: andere Freiheitsgrade wählen, „linearisiert“ verwenden oder Lagrange 1. Art nutzen.');
  }
  const map = new Map();
  for (const q of dofs.coords) map.set(q.abs.name, mul(q.sign, q.s));
  for (const d of dofs.deps) map.set(d.name, trigsimp(ratsimp(simplify(sol.get(d.s.name)))));
  return { map, cons };
}
