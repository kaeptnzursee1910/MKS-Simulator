// LaTeX-Ausgabe für CAS-Ausdrücke (für KaTeX)
import { info, numVal, isInt, mul, pow, num, MONE, freeSyms, termsOf } from './expr.js';

const RANK = { param: 1, time: 2, abbr: 3.8, coord: 4, vel: 5, acc: 6, lambda: 7, eps: 8 };

function symRank(name) { return RANK[info(name).kind] ?? 1; }
function factorRank(f) {
  if (f.t === 'num') return 0;
  if (f.t === 'sym') {
    const r = symRank(f.name);
    if (r === 1 && /^(m|J|M)(_|$)/.test(f.name)) return 0.9;
    return r;
  }
  if (f.t === 'pow') {
    if (f.base.t === 'num') return 0.5;
    return factorRank(f.base);
  }
  if (f.t === 'fn') return 3;
  if (f.t === 'add') return 3.5;
  return 3;
}
function factorOrder(f) {
  const b = f.t === 'pow' ? f.base : f;
  if (b.t === 'sym') return info(b.name).order || 0;
  return 0;
}
function sortFactors(fs) {
  return [...fs].sort((a, b) => factorRank(a) - factorRank(b) || factorOrder(a) - factorOrder(b) ||
    (dispName(a) < dispName(b) ? -1 : dispName(a) > dispName(b) ? 1 : 0));
}
function dispName(f) {
  const b = f.t === 'pow' ? f.base : f;
  return b.t === 'sym' ? info(b.name).latex : b.key;
}

/** Klassifikation eines Summanden für die Anzeige-Reihenfolge */
function termClass(t) {
  let cls = 9, order = 1e9;
  for (const n of freeSyms(t)) {
    const k = info(n).kind;
    const c = k === 'acc' ? 0 : k === 'vel' ? 1 : k === 'coord' || k === 'abbr' ? 2 : k === 'lambda' ? 3 : 8;
    if (c < cls || (c === cls && (info(n).order || 0) < order)) { cls = c; order = info(n).order || 0; }
  }
  return [cls, order];
}
export function sortTerms(terms) {
  return [...terms].map((t) => [t, termClass(t)]).sort((a, b) =>
    a[1][0] - b[1][0] || a[1][1] - b[1][1] || (a[0].key < b[0].key ? -1 : 1)).map((x) => x[0]);
}

export function fmtNum(v) {
  if (Number.isInteger(v)) return String(v);
  let s = Math.abs(v) >= 1e-3 && Math.abs(v) < 1e5 ? String(+v.toPrecision(5)) : v.toExponential(3);
  return s.replace('.', '{,}');
}
function numTex(a) {
  if (a.f) return fmtNum(numVal(a));
  if (a.d === 1) return String(a.n);
  return (a.n < 0 ? '-' : '') + '\\frac{' + Math.abs(a.n) + '}{' + a.d + '}';
}

function isNegTerm(t) {
  if (t.t === 'num') return numVal(t) < 0;
  if (t.t === 'mul') return t.factors[0].t === 'num' && numVal(t.factors[0]) < 0;
  return false;
}

function symTex(name) { return info(name).latex; }

function wrap(s) { return '\\left(' + s + '\\right)'; }

function fnTex(e, exponent) {
  const names = { sin: '\\sin', cos: '\\cos', tan: '\\tan', ln: '\\ln', exp: '\\exp', sign: '\\operatorname{sgn}' };
  if (e.name === 'abs') return '\\left|' + tex(e.arg) + '\\right|' + (exponent ? '^{' + exponent + '}' : '');
  const head = names[e.name] + (exponent ? '^{' + exponent + '}' : '');
  const a = e.arg;
  if (a.t === 'sym') return head + ' ' + symTex(a.name);
  return head + wrap(tex(a));
}

function powTex(b, ex) {
  // ex: Zahl (positiv) oder Ausdruck
  if (ex.t === 'num' && !ex.f) {
    if (ex.n === 1 && ex.d === 1) return atomTex(b);
    if (ex.d === 2 && ex.n === 1) return '\\sqrt{' + tex(b) + '}';
    if (ex.d === 2) return '\\sqrt{' + tex(b) + '}^{' + ex.n + '}';
    if (ex.d === 3 && ex.n === 1) return '\\sqrt[3]{' + tex(b) + '}';
    if (b.t === 'fn' && ex.d === 1 && b.name !== 'abs') return fnTex(b, ex.n);
    const e = ex.d === 1 ? String(ex.n) : ex.n + '/' + ex.d;
    return atomTex(b, true) + '^{' + e + '}';
  }
  return atomTex(b, true) + '^{' + tex(ex) + '}';
}

function atomTex(e, forPow = false) {
  switch (e.t) {
    case 'sym': return symTex(e.name);
    case 'num': {
      if (numVal(e) < 0 || (!e.f && e.d !== 1) || (forPow && e.f)) return wrap(numTex(e));
      return numTex(e);
    }
    case 'fn': return forPow ? wrap(fnTex(e)) : fnTex(e);
    case 'pow': return forPow ? wrap(tex(e)) : tex(e);
    default: return wrap(tex(e));
  }
}

function mulTex(e) {
  // e: mul (Vorzeichen bereits positiv oder wird vorangestellt)
  let fs = e.t === 'mul' ? e.factors : [e];
  let coef = { n: 1, d: 1, f: false };
  if (fs[0].t === 'num') { coef = fs[0]; fs = fs.slice(1); }
  let sign = '';
  if (numVal(coef) < 0) { sign = '-'; coef = coef.f ? { n: -coef.n, d: 1, f: true } : { n: -coef.n, d: coef.d, f: false }; }
  const numer = [], denom = [];
  for (const f of fs) {
    if (f.t === 'pow' && f.exp.t === 'num' && numVal(f.exp) < 0) denom.push(pow(f.base, mul(MONE, f.exp)));
    else numer.push(f);
  }
  const fTex = (list) => sortFactors(list).map((f) => {
    if (f.t === 'add') return wrap(tex(f));
    if (f.t === 'pow') return powTex(f.base, f.exp);
    return atomTex(f);
  }).join(' ');
  const cn = coef.f ? fmtNum(coef.n) : String(coef.n);
  const cd = coef.f ? '1' : String(coef.d);
  if (!denom.length) {
    let pre = '';
    if (coef.f) pre = cn === '1' ? '' : cn;
    else if (coef.d !== 1) pre = '\\frac{' + coef.n + '}{' + coef.d + '}';
    else if (coef.n !== 1) pre = cn;
    const body = fTex(numer);
    if (!body) return sign + (pre || '1');
    return sign + (pre ? pre + (/^[0-9{]/.test(body) || /^\\sqrt/.test(body) ? ' \\cdot ' : ' ') : '') + body;
  }
  const top = (cn !== '1' ? cn + (numer.length ? ' ' : '') : '') + fTex(numer);
  const bot = (cd !== '1' ? cd + ' ' : '') + (denom.length === 1 && denom[0].t === 'add' && cd === '1' ? tex(denom[0]) : fTex(denom));
  return sign + '\\frac{' + (top || '1') + '}{' + bot + '}';
}

export function tex(e) {
  switch (e.t) {
    case 'num': return numTex(e);
    case 'sym': return symTex(e.name);
    case 'fn': return fnTex(e);
    case 'pow': {
      if (e.exp.t === 'num' && numVal(e.exp) < 0) return mulTex(e);
      return powTex(e.base, e.exp);
    }
    case 'mul': return mulTex(e);
    case 'add': {
      const ts = sortTerms(e.terms);
      let s = '';
      ts.forEach((t, i) => {
        if (isNegTerm(t)) s += (i ? ' - ' : '-') + tex(mul(MONE, t));
        else s += (i ? ' + ' : '') + tex(t);
      });
      return s;
    }
  }
  return '?';
}
export const latex = tex;

/** Gleichung: Terme ohne Koordinaten auf die rechte Seite */
export function eqTex(e, { zeroRhs = false } = {}) {
  const lhs = [], rhs = [];
  for (const t of termsOf(e)) {
    let hasCoord = false;
    for (const n of freeSyms(t)) { const k = info(n).kind; if (k === 'coord' || k === 'vel' || k === 'acc' || k === 'lambda' || k === 'abbr') hasCoord = true; }
    (hasCoord || zeroRhs ? lhs : rhs).push(t);
  }
  const L = lhs.length ? tex(lhs.length === 1 ? lhs[0] : { t: 'add', terms: lhs }) : '0';
  const R = rhs.length ? tex(rhs.length === 1 ? mul(MONE, rhs[0]) : { t: 'add', terms: rhs.map((x) => mul(MONE, x)) }) : '0';
  return L + ' = ' + R;
}

export function matTex(rows) {
  return '\\begin{bmatrix}' + rows.map((r) => r.map((x) => (typeof x === 'string' ? x : tex(x))).join(' & ')).join(' \\\\ ') + '\\end{bmatrix}';
}
export function vecTex(list) { return matTex(list.map((x) => [x])); }

// -------------------------------------------- Namen -> LaTeX / Unicode
const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta', 'iota', 'kappa',
  'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Phi', 'Psi', 'Omega'];
const UNI = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ',
  Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
function baseTex(b) {
  if (GREEK.includes(b)) return '\\' + (b === 'phi' ? 'varphi' : b);
  if (b.length === 2 && /^[A-Za-z][a-z]$/.test(b)) return b[0] + '_{' + b[1] + '}';
  return b.length > 1 ? '\\mathit{' + b + '}' : b;
}
/** z. B. "J_2" -> "J_{2}", "phi_1" -> "\varphi_{1}", "kt_1" -> "k_{t1}" */
export function nameToLatex(name) {
  const i = name.indexOf('_');
  if (i < 0) return baseTex(name);
  const b = name.slice(0, i), s = name.slice(i + 1).replace(/[{}]/g, '');
  const subTex = GREEK.includes(s) ? baseTex(s) : s.replace(/_/g, ',');
  if (b.length === 2 && /^[A-Za-z][a-z]$/.test(b) && !GREEK.includes(b)) return b[0] + '_{' + b[1] + subTex + '}';
  return baseTex(b) + '_{' + subTex + '}';
}
/** Unicode-Darstellung: {main, sub} */
export function nameToUni(name) {
  const i = name.indexOf('_');
  const conv = (b) => UNI[b] || b;
  if (i < 0) {
    if (name.length === 2 && /^[A-Za-z][a-z]$/.test(name) && !UNI[name]) return { main: name[0], sub: name[1] };
    return { main: conv(name), sub: '' };
  }
  const b = name.slice(0, i), s = name.slice(i + 1).replace(/[{}]/g, '');
  if (b.length === 2 && /^[A-Za-z][a-z]$/.test(b) && !UNI[b]) return { main: b[0], sub: b[1] + conv(s) };
  return { main: conv(b), sub: conv(s) };
}
