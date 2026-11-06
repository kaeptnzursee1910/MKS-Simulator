// Lineare Algebra: symbolisch (Gauß-Jordan) und numerisch
import { simplify, mul, pow, add, MONE, isZero, evalNum, size } from '../cas/expr.js';

/** Zufällige Belegungen für Null-Tests */
export function makeTestEnvs(refEnv, symNames, count = 2) {
  const envs = [];
  let seed = 12345;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < count; i++) {
    const e = { ...refEnv };
    for (const [k, v] of Object.entries(refEnv)) if (typeof v === 'number' && v !== 0 && k !== 'pi') e[k] = v * (0.7 + 0.6 * rnd());
    for (const n of symNames) e[n] = (rnd() - 0.5) * 0.6;
    envs.push(e);
  }
  return envs;
}
export function numericallyZero(e, envs, tol = 1e-9) {
  if (isZero(e)) return true;
  for (const env of envs) {
    let v;
    try { v = evalNum(e, env); } catch { return false; }
    if (!Number.isFinite(v) || Math.abs(v) > tol) return false;
  }
  return true;
}

/** Löst A X = B symbolisch (A: m×n, B: m×k). Liefert {X, residual} oder {error, col} */
export function gaussSolve(A, B, envs) {
  const m = A.length, n = A[0]?.length || 0, k = B[0]?.length || 0;
  const M = A.map((row, i) => [...row, ...B[i]]);
  const isZ = (e) => numericallyZero(e, envs);
  let r = 0;
  const pivCols = [];
  for (let c = 0; c < n; c++) {
    let best = -1;
    for (let i = r; i < m; i++) {
      if (!isZ(M[i][c]) && (best < 0 || size(M[i][c]) < size(M[best][c]))) best = i;
    }
    if (best < 0) return { error: 'singular', col: c };
    [M[r], M[best]] = [M[best], M[r]];
    const inv = pow(M[r][c], MONE);
    for (let j = c; j < n + k; j++) M[r][j] = simplify(mul(M[r][j], inv));
    for (let i = 0; i < m; i++) {
      if (i === r || isZero(M[i][c])) continue;
      const f = M[i][c];
      for (let j = c; j < n + k; j++) M[i][j] = simplify(add(M[i][j], mul(MONE, f, M[r][j])));
    }
    pivCols.push(c);
    r++;
  }
  const X = M.slice(0, n).map((row) => row.slice(n));
  const residual = M.slice(n).map((row) => row.slice(n));
  return { X, residual };
}

// ---------------------------------------------------- numerisch
export function rank(Ain, tol = 1e-9) {
  const A = Ain.map((r) => [...r]);
  const m = A.length, n = A[0]?.length || 0;
  let r = 0;
  const scale = Math.max(1e-300, ...A.flat().map(Math.abs));
  for (let c = 0; c < n && r < m; c++) {
    let p = r;
    for (let i = r + 1; i < m; i++) if (Math.abs(A[i][c]) > Math.abs(A[p][c])) p = i;
    if (Math.abs(A[p][c]) <= tol * scale) continue;
    [A[r], A[p]] = [A[p], A[r]];
    for (let i = r + 1; i < m; i++) {
      const f = A[i][c] / A[r][c];
      for (let j = c; j < n; j++) A[i][j] -= f * A[r][j];
    }
    r++;
  }
  return r;
}
/** Indizes linear unabhängiger Zeilen */
export function independentRows(A, tol = 1e-9) {
  const keep = [];
  let cur = [];
  for (let i = 0; i < A.length; i++) {
    const test = [...cur, A[i]];
    if (rank(test, tol) > cur.length) { cur = test; keep.push(i); }
  }
  return keep;
}
/** Löst A x = b (dicht, Pivotsuche). A wird überschrieben. */
export function solveDense(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(A[i][c]) > Math.abs(A[p][c])) p = i;
    if (Math.abs(A[p][c]) < 1e-300) throw new Error('Singuläre Matrix in der numerischen Lösung');
    if (p !== c) { [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]]; }
    const piv = A[c][c];
    for (let i = c + 1; i < n; i++) {
      const f = A[i][c] / piv;
      if (f === 0) continue;
      for (let j = c; j < n; j++) A[i][j] -= f * A[c][j];
      b[i] -= f * b[c];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x;
}
