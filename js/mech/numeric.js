// Numerik: Übersetzen der Gleichungen in JS-Funktionen, Zeitdiskretisierung, Integration
import { diff, subs, ZERO, MONE, mul, toJS, substNumbers, simplify, evalNum } from '../cas/expr.js';
import { solveDense } from './linalg.js';
import { tryParse } from '../cas/parse.js';

export const INTEGRATORS = {
  euler: {
    name: 'Explizites Euler-Verfahren (1. Ordnung)',
    tex: '\\mathbf{y}_{n+1} = \\mathbf{y}_n + h\\,\\mathbf{F}(t_n,\\mathbf{y}_n)',
  },
  symplectic: {
    name: 'Semi-implizites (symplektisches) Euler-Verfahren',
    tex: '\\dot{\\mathbf{q}}_{n+1} = \\dot{\\mathbf{q}}_n + h\\,\\ddot{\\mathbf{q}}(t_n,\\mathbf{q}_n,\\dot{\\mathbf{q}}_n), \\quad \\mathbf{q}_{n+1} = \\mathbf{q}_n + h\\,\\dot{\\mathbf{q}}_{n+1}',
  },
  heun: {
    name: 'Heun-Verfahren (2. Ordnung)',
    tex: '\\begin{aligned} \\mathbf{k}_1 &= \\mathbf{F}(t_n,\\mathbf{y}_n), \\quad \\mathbf{k}_2 = \\mathbf{F}(t_n + h,\\mathbf{y}_n + h\\mathbf{k}_1) \\\\ \\mathbf{y}_{n+1} &= \\mathbf{y}_n + \\tfrac{h}{2}(\\mathbf{k}_1 + \\mathbf{k}_2) \\end{aligned}',
  },
  rk4: {
    name: 'Klassisches Runge-Kutta-Verfahren (4. Ordnung)',
    tex: '\\begin{aligned} \\mathbf{y}_{n+1} &= \\mathbf{y}_n + \\tfrac{h}{6}(\\mathbf{k}_1 + 2\\mathbf{k}_2 + 2\\mathbf{k}_3 + \\mathbf{k}_4) \\\\ \\mathbf{k}_1 &= \\mathbf{F}(t_n,\\mathbf{y}_n), \\quad \\mathbf{k}_2 = \\mathbf{F}(t_n+\\tfrac h2,\\mathbf{y}_n+\\tfrac h2\\mathbf{k}_1) \\\\ \\mathbf{k}_3 &= \\mathbf{F}(t_n+\\tfrac h2,\\mathbf{y}_n+\\tfrac h2\\mathbf{k}_2), \\quad \\mathbf{k}_4 = \\mathbf{F}(t_n+h,\\mathbf{y}_n+h\\mathbf{k}_3) \\end{aligned}',
  },
};

function compileList(exprs, names, env, extraArgs) {
  const nm = (n) => {
    if (names.has(n)) return names.get(n);
    if (n === 't') return 't';
    throw new Error('Kein Zahlenwert für Parameter „' + n + '“');
  };
  const body = exprs.map((e) => toJS(substNumbers(e, env), nm));
  // eslint-disable-next-line no-new-func
  return new Function('sq', ...extraArgs, 'return [' + body.join(',\n') + '];').bind(null, (x) => x * x);
}

/** Erzeugt ein numerisches Modell aus dem Herleitungsergebnis */
export function compile(res, env) {
  const N = res.numeric;
  const model = res.model;
  const n = N.coords.length;
  const names = new Map();
  N.coords.forEach((c, i) => { names.set(c.s.name, 'q[' + i + ']'); names.set(c.d.name, 'v[' + i + ']'); });
  const bodyExprs = [];
  for (const b of model.bodies) {
    bodyExprs.push(N.absMap.get(b.X.name), N.absMap.get(b.Y.name), b.TH ? N.absMap.get(b.TH.name) : ZERO);
  }
  const absFn = compileList(bodyExprs, names, env, ['q']);
  const energyFn = compileList([N.T, N.U], names, env, ['q', 'v', 't']);
  const out = { n, type: N.type, absFn, energyFn, coords: N.coords, bodies: model.bodies };

  if (N.type === 'ode') {
    const Mex = [], rex = [];
    const zero = new Map(N.coords.map((c) => [c.dd.name, ZERO]));
    for (const e of N.eqs) {
      for (const c of N.coords) Mex.push(diff(e, c.dd));
      rex.push(simplify(mul(MONE, subs(e, zero))));
    }
    const fM = compileList(Mex, names, env, ['q', 'v', 't']);
    const fr = compileList(rex, names, env, ['q', 'v', 't']);
    out.accel = (t, q, v) => {
      const Mf = fM(q, v, t), r = fr(q, v, t);
      const M = [];
      for (let i = 0; i < n; i++) M.push(Mf.slice(i * n, i * n + n));
      return { a: solveDense(M, r) };
    };
  } else {
    const m = N.g.length;
    const mass = N.mass.map((e) => evalNum(substNumbers(e, env), env));
    const fF = compileList(N.f, names, env, ['q', 'v', 't']);
    const fG = compileList(N.G.flat(), names, env, ['q', 'v', 't']);
    const fg = compileList(N.g, names, env, ['q', 'v', 't']);
    const fgam = compileList(N.gamma, names, env, ['q', 'v', 't']);
    const alpha = 10;
    const isDof = N.coords.map((c) => !!c.dof);
    out.isDof = isDof;
    out.m = m;
    const Gmat = (q, v, t) => { const Gf = fG(q, v, t); const G = []; for (let j = 0; j < m; j++) G.push(Gf.slice(j * n, j * n + n)); return G; };
    out.Gmat = Gmat;
    out.gfun = (q) => fg(q, q, 0);
    out.accel = (t, q, v) => {
      const f = fF(q, v, t), G = Gmat(q, v, t), g = fg(q, v, t), gam = fgam(q, v, t);
      const K = [], b = [];
      for (let i = 0; i < n; i++) {
        const row = new Array(n + m).fill(0);
        row[i] = mass[i];
        for (let j = 0; j < m; j++) row[n + j] = -G[j][i];
        K.push(row); b.push(f[i]);
      }
      for (let j = 0; j < m; j++) {
        const row = new Array(n + m).fill(0);
        let Gv = 0;
        for (let i = 0; i < n; i++) { row[i] = G[j][i]; Gv += G[j][i] * v[i]; }
        K.push(row);
        b.push(-gam[j] - 2 * alpha * Gv - alpha * alpha * g[j]);
      }
      const x = solveDense(K, b);
      return { a: x.slice(0, n), lam: x.slice(n) };
    };
    // Projektion auf die Bindungen (abhängige Koordinaten anpassen)
    const dep = isDof.map((d, i) => (d ? -1 : i)).filter((i) => i >= 0);
    out.project = (q, v, iters = 4) => {
      if (!m || !dep.length) return;
      for (let it = 0; it < iters; it++) {
        const g = fg(q, v, 0);
        if (Math.max(...g.map(Math.abs)) < 1e-12) break;
        const G = Gmat(q, v, 0);
        const { A, rows } = squareSub(G, dep);
        const dz = solveLS(A, rows.map((j) => -g[j]));
        dep.forEach((i, k) => { q[i] += dz[k]; });
      }
      const G = Gmat(q, v, 0);
      const { A, rows } = squareSub(G, dep);
      const rhs = rows.map((j) => { let s = 0; for (let i = 0; i < n; i++) if (isDof[i]) s -= G[j][i] * v[i]; return s; });
      const vz = solveLS(A, rhs);
      dep.forEach((i, k) => { v[i] = vz[k]; });
    };
  }
  return out;
}

function squareSub(G, dep) {
  return { A: G.map((row) => dep.map((i) => row[i])), rows: G.map((_, j) => j) };
}
/** Kleinste-Quadrate-Lösung (Normalgleichungen) */
function solveLS(A, b) {
  const m = A.length, k = A[0]?.length || 0;
  if (!k) return [];
  const N = [], r = [];
  for (let i = 0; i < k; i++) {
    const row = new Array(k).fill(0);
    let s = 0;
    for (let j = 0; j < m; j++) { s += A[j][i] * b[j]; for (let l = 0; l < k; l++) row[l] += A[j][i] * A[j][l]; }
    N.push(row); r.push(s);
  }
  return solveDense(N, r);
}

export function evalInput(str, env, fallback = 0) {
  const r = tryParse(str === '' || str === undefined ? String(fallback) : str);
  if (r.error) throw new Error('Anfangswert „' + str + '“: ' + r.error);
  return evalNum(r.expr, env);
}

/** Zeitintegration */
export function simulate(cm, opts) {
  const { method = 'rk4', h = 0.001, T = 5, q0, v0 } = opts;
  const n = cm.n;
  const q = [...q0], v = [...v0];
  if (cm.type === 'dae') cm.project(q, v, 30);
  const steps = Math.max(1, Math.ceil(T / h));
  if (steps > 2e6) throw new Error('Zu viele Zeitschritte (' + steps + ') – Schrittweite vergrößern.');
  const stride = Math.max(1, Math.floor(steps / 3000));
  const out = { t: [], q: [], v: [], lam: [], abs: [], E: [] };
  const F = (t, qq, vv) => cm.accel(t, qq, vv);
  const record = (t) => {
    out.t.push(t); out.q.push([...q]); out.v.push([...v]);
    out.abs.push(cm.absFn(q));
    try { const [Te, Ue] = cm.energyFn(q, v, t); out.E.push([Te, Ue, Te + Ue]); } catch { out.E.push([NaN, NaN, NaN]); }
    if (cm.type === 'dae') { try { out.lam.push(F(t, q, v).lam); } catch { out.lam.push([]); } }
  };
  record(0);
  let t = 0;
  const add = (a, b, s) => a.map((x, i) => x + s * b[i]);
  for (let k = 1; k <= steps; k++) {
    let hk = Math.min(h, T - t);
    if (hk <= 0) break;
    if (method === 'euler') {
      const a = F(t, q, v).a;
      for (let i = 0; i < n; i++) { q[i] += hk * v[i]; v[i] += hk * a[i]; }
    } else if (method === 'symplectic') {
      const a = F(t, q, v).a;
      for (let i = 0; i < n; i++) { v[i] += hk * a[i]; q[i] += hk * v[i]; }
    } else if (method === 'heun') {
      const a1 = F(t, q, v).a;
      const q1 = add(q, v, hk), v1 = add(v, a1, hk);
      const a2 = F(t + hk, q1, v1).a;
      for (let i = 0; i < n; i++) { q[i] += (hk / 2) * (v[i] + v1[i]); v[i] += (hk / 2) * (a1[i] + a2[i]); }
    } else {
      const k1v = v, k1a = F(t, q, v).a;
      const q2 = add(q, k1v, hk / 2), v2 = add(v, k1a, hk / 2);
      const k2a = F(t + hk / 2, q2, v2).a;
      const q3 = add(q, v2, hk / 2), v3 = add(v, k2a, hk / 2);
      const k3a = F(t + hk / 2, q3, v3).a;
      const q4 = add(q, v3, hk), v4 = add(v, k3a, hk);
      const k4a = F(t + hk, q4, v4).a;
      for (let i = 0; i < n; i++) {
        q[i] += (hk / 6) * (k1v[i] + 2 * v2[i] + 2 * v3[i] + v4[i]);
        v[i] += (hk / 6) * (k1a[i] + 2 * k2a[i] + 2 * k3a[i] + k4a[i]);
      }
    }
    t += hk;
    if (cm.type === 'dae') cm.project(q, v, 3);
    if (!q.every(Number.isFinite) || !v.every(Number.isFinite)) throw new Error('Die Lösung divergiert bei t = ' + t.toFixed(4) + ' s – Schrittweite verkleinern oder Verfahren wechseln.');
    if (k % stride === 0 || k === steps) record(t);
  }
  return out;
}
