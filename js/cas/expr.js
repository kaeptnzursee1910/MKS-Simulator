// Kleines Computeralgebra-System (CAS) für die Herleitung der Bewegungsgleichungen.
// Ausdrücke sind unveränderliche Knoten: num, sym, add, mul, pow, fn.
// Die Konstruktoren add/mul/pow/fn bringen Ausdrücke automatisch in eine kanonische Form
// (Zusammenfassen gleichartiger Terme, Potenzen gleicher Basis, Zahlen falten).

const symCache = new Map();
/** Zusatzinformationen je Symbol: latex, kind, pos (positiv), order (Anzeige-Reihenfolge) */
export const symInfo = new Map();

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}
const LIMIT = 2 ** 50;

export const ZERO = { t: 'num', n: 0, d: 1, f: false, key: '0' };
export const ONE = { t: 'num', n: 1, d: 1, f: false, key: '1' };
export const MONE = { t: 'num', n: -1, d: 1, f: false, key: '-1' };
export const HALF = { t: 'num', n: 1, d: 2, f: false, key: '1/2' };
const EMPTY = new Set();

function mkRat(n, d) {
  if (d < 0) { n = -n; d = -d; }
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || Math.abs(n) > LIMIT || d > LIMIT) return mkFloat(n / d);
  if (n === 0) return ZERO;
  const g = gcd(n, d) || 1;
  n /= g; d /= g;
  if (d === 1) { if (n === 1) return ONE; if (n === -1) return MONE; }
  return { t: 'num', n, d, f: false, key: d === 1 ? String(n) : n + '/' + d };
}
function mkFloat(v) {
  if (!Number.isFinite(v)) throw new Error('Nicht-endliche Zahl im Ausdruck');
  if (Math.abs(v) < 1e-13) return ZERO;
  const r = Math.round(v);
  if (Math.abs(v - r) < 1e-11 * Math.max(1, Math.abs(v))) return mkRat(r, 1);
  for (const d of [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 50, 100]) {
    const x = v * d, rx = Math.round(x);
    if (Math.abs(x - rx) < 1e-10 * Math.max(1, Math.abs(x))) return mkRat(rx, d);
  }
  return { t: 'num', n: v, d: 1, f: true, key: '~' + v.toPrecision(10) };
}
export function num(n, d = 1) {
  if (Number.isInteger(n) && Number.isInteger(d)) return mkRat(n, d);
  return mkFloat(n / d);
}
export const numVal = (a) => a.n / a.d;
function numAdd(a, b) {
  if (a.f || b.f) return mkFloat(numVal(a) + numVal(b));
  return mkRat(a.n * b.d + b.n * a.d, a.d * b.d);
}
function numMul(a, b) {
  if (a.f || b.f) return mkFloat(numVal(a) * numVal(b));
  return mkRat(a.n * b.n, a.d * b.d);
}
export const isNum = (e) => e.t === 'num';
export const isZero = (e) => e.t === 'num' && e.n === 0;
export const isOne = (e) => e.t === 'num' && e.n === 1 && e.d === 1;
export const isInt = (e) => e.t === 'num' && !e.f && e.d === 1;

const cmp = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function mkAdd(terms) { return { t: 'add', terms, key: '(+ ' + terms.map((x) => x.key).join(' ') + ')' }; }
function mkMul(factors) { return { t: 'mul', factors, key: '(* ' + factors.map((x) => x.key).join(' ') + ')' }; }
function mkPow(base, exp) { return { t: 'pow', base, exp, key: '(^ ' + base.key + ' ' + exp.key + ')' }; }
function mkFn(name, arg) { return { t: 'fn', name, arg, key: '(' + name + ' ' + arg.key + ')' }; }

export function toExpr(a) {
  if (typeof a === 'number') return num(a);
  if (a && a.t) return a;
  throw new Error('Ungültiger Ausdruck: ' + a);
}

/** Symbol erzeugen bzw. Info aktualisieren */
export function sym(name, opts) {
  let s = symCache.get(name);
  if (!s) {
    s = { t: 'sym', name, key: '$' + name };
    symCache.set(name, s);
    symInfo.set(name, { latex: name, kind: 'param', pos: false, order: 0 });
  }
  if (opts) Object.assign(symInfo.get(name), opts);
  return s;
}
export const info = (name) => symInfo.get(name) || { latex: name, kind: 'param', pos: false, order: 0 };

export function children(e) {
  switch (e.t) {
    case 'add': return e.terms;
    case 'mul': return e.factors;
    case 'pow': return [e.base, e.exp];
    case 'fn': return [e.arg];
    default: return [];
  }
}

export function freeSyms(e) {
  if (e._s) return e._s;
  let s;
  if (e.t === 'num') return EMPTY;
  if (e.t === 'sym') s = new Set([e.name]);
  else {
    s = new Set();
    for (const c of children(e)) for (const n of freeSyms(c)) s.add(n);
  }
  e._s = s;
  return s;
}
export const has = (e, name) => freeSyms(e).has(typeof name === 'string' ? name : name.name);
export const hasAny = (e, names) => { const f = freeSyms(e); for (const n of names) if (f.has(n)) return true; return false; };

export function isPositive(e) {
  switch (e.t) {
    case 'num': return numVal(e) > 0;
    case 'sym': return !!info(e.name).pos;
    case 'mul': return e.factors.every(isPositive);
    case 'add': return e.terms.every(isPositive);
    case 'pow': return isPositive(e.base);
    case 'fn': return e.name === 'exp';
    default: return false;
  }
}

// ---------------------------------------------------------------- add
export function add(...args) {
  let c = ZERO;
  const acc = new Map();
  const visit = (e) => {
    if (e.t === 'add') { for (const x of e.terms) visit(x); return; }
    if (e.t === 'num') { c = numAdd(c, e); return; }
    let coef = ONE, rest = e;
    if (e.t === 'mul' && e.factors[0].t === 'num') {
      coef = e.factors[0];
      rest = e.factors.length === 2 ? e.factors[1] : mkMul(e.factors.slice(1));
    }
    const ex = acc.get(rest.key);
    if (ex) ex.coef = numAdd(ex.coef, coef); else acc.set(rest.key, { rest, coef });
  };
  for (const a of args) visit(toExpr(a));
  const terms = [];
  for (const { rest, coef } of acc.values()) {
    if (isZero(coef)) continue;
    if (isOne(coef)) terms.push(rest);
    else terms.push(rest.t === 'mul' ? mkMul([coef, ...rest.factors]) : mkMul([coef, rest]));
  }
  terms.sort(cmp);
  if (!isZero(c)) terms.unshift(c);
  if (!terms.length) return ZERO;
  if (terms.length === 1) return terms[0];
  return mkAdd(terms);
}
export const sub = (a, b) => add(a, mul(MONE, b));
export const neg = (a) => mul(MONE, a);

// ---------------------------------------------------------------- mul
export function mul(...args) {
  let c = ONE;
  const acc = new Map();
  const visit = (e) => {
    if (e.t === 'mul') { for (const x of e.factors) visit(x); return; }
    if (e.t === 'num') { c = numMul(c, e); return; }
    let base = e, exp = ONE;
    if (e.t === 'pow') { base = e.base; exp = e.exp; }
    const ex = acc.get(base.key);
    if (ex) ex.exp = add(ex.exp, exp); else acc.set(base.key, { base, exp });
  };
  for (const a of args) visit(toExpr(a));
  if (isZero(c)) return ZERO;
  const fs = [];
  let again = false;
  for (const { base, exp } of acc.values()) {
    const p = isOne(exp) ? base : pow(base, exp);
    if (p.t === 'num') c = numMul(c, p);
    else { if (p.t === 'mul') again = true; fs.push(p); }
  }
  if (isZero(c)) return ZERO;
  if (again) return mul(c, ...fs);
  if (!fs.length) return c;
  if (fs.length === 1) {
    if (isOne(c)) return fs[0];
    if (fs[0].t === 'add') return add(...fs[0].terms.map((t) => mul(c, t)));
  }
  fs.sort(cmp);
  return mkMul(isOne(c) ? fs : [c, ...fs]);
}
export const div = (a, b) => mul(a, pow(b, MONE));

// ---------------------------------------------------------------- pow
function intRoot(n, q) {
  const r = Math.round(Math.pow(n, 1 / q));
  for (const x of [r - 1, r, r + 1]) if (x >= 0 && x ** q === n) return x;
  return null;
}
function numPow(b, e) {
  if (b.f || e.f) {
    const v = Math.pow(numVal(b), numVal(e));
    return Number.isFinite(v) ? mkFloat(v) : null;
  }
  if (e.d === 1) {
    const k = Math.abs(e.n);
    if (k > 64) return mkFloat(Math.pow(numVal(b), e.n));
    let n = b.n ** k, d = b.d ** k;
    if (e.n < 0) { if (n === 0) return null; [n, d] = [d, n]; }
    return num(n, d);
  }
  if (b.n < 0) return null;
  const q = e.d, p = e.n;
  const rn = intRoot(b.n, q), rd = intRoot(b.d, q);
  if (rn !== null && rd !== null) return numPow(num(rn, rd), num(p));
  if (q === 2) {
    // b^(p/2) = b^((p-1)/2) * sqrt(b);  sqrt(n/d) = sqrt(n*d)/d;  sqrt(s^2 m) = s sqrt(m)
    const k = (p - 1) / 2;
    let N = b.n * b.d;
    if (!Number.isSafeInteger(N)) return null;
    let s = 1;
    for (let f = 2; f * f <= N; f++) while (N % (f * f) === 0) { N /= f * f; s *= f; }
    const pre = numMul(numPow(b, num(k)), num(s, b.d));
    if (N === 1) return pre;
    const root = mkPow(num(N), HALF);
    if (isOne(pre)) return root;
    return mkMul([pre, root]);
  }
  return null;
}

export function pow(b, e) {
  b = toExpr(b); e = toExpr(e);
  if (e.t === 'num') {
    if (isZero(e)) return ONE;
    if (isOne(e)) return b;
    if (b.t === 'num') {
      const r = numPow(b, e);
      if (r) return r;
      return mkPow(b, e);
    }
    if (b.t === 'pow' && (isInt(e) || isPositive(b.base))) return pow(b.base, mul(b.exp, e));
    if (b.t === 'mul') {
      if (isInt(e)) return mul(...b.factors.map((f) => pow(f, e)));
      const pos = [], rest = [];
      for (const f of b.factors) (isPositive(f) ? pos : rest).push(f);
      if (pos.length) {
        const r = rest.length === 0 ? ONE : rest.length === 1 ? pow(rest[0], e) : mkPow(mkMul(rest), e);
        return mul(...pos.map((f) => pow(f, e)), r);
      }
    }
  }
  if (isZero(b)) return ZERO;
  if (isOne(b)) return ONE;
  return mkPow(b, e);
}
export const sqrt = (a) => pow(a, HALF);

// ---------------------------------------------------------------- fn
const FN = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp, ln: Math.log,
  abs: Math.abs, sign: Math.sign,
};
export function leadingNegative(a) {
  if (a.t === 'num') return numVal(a) < 0;
  if (a.t === 'mul') return a.factors[0].t === 'num' && numVal(a.factors[0]) < 0;
  if (a.t === 'add') {
    let best = null, bestKey = null;
    for (const x of a.terms) {
      if (x.t === 'num') continue;
      const rest = x.t === 'mul' && x.factors[0].t === 'num' ? (x.factors.length === 2 ? x.factors[1].key : x.factors.slice(1).map((f) => f.key).join(' ')) : x.key;
      if (bestKey === null || rest < bestKey) { bestKey = rest; best = x; }
    }
    return best ? leadingNegative(best) : false;
  }
  return false;
}
export function fn(name, a) {
  a = toExpr(a);
  if (name === 'sqrt') return pow(a, HALF);
  if (a.t === 'num') {
    const v = numVal(a);
    if (v === 0) {
      if (name === 'sin' || name === 'tan' || name === 'abs' || name === 'sign') return ZERO;
      if (name === 'cos' || name === 'exp') return ONE;
    }
    if (name === 'ln' && v === 1) return ZERO;
    if (name === 'abs') return v < 0 ? numMul(a, MONE) : a;
    if (name === 'sign') return num(Math.sign(v));
    if (a.f) return mkFloat(FN[name](v));
  }
  if (name === 'sin' || name === 'tan' || name === 'cos') {
    if (leadingNegative(a)) {
      const na = mul(MONE, a);
      return name === 'cos' ? fn('cos', na) : mul(MONE, fn(name, na));
    }
  }
  if (name === 'abs' && isPositive(a)) return a;
  if (name === 'sign' && isPositive(a)) return ONE;
  if (name === 'ln' && a.t === 'fn' && a.name === 'exp') return a.arg;
  return mkFn(name, a);
}
export const sin = (a) => fn('sin', a);
export const cos = (a) => fn('cos', a);

// ---------------------------------------------------------------- Umformungen
export function termsOf(e) { return e.t === 'add' ? e.terms : isZero(e) ? [] : [e]; }

export function expand(e) {
  if (e._x) return e._x;
  let r;
  switch (e.t) {
    case 'num': case 'sym': return e;
    case 'add': r = add(...e.terms.map(expand)); break;
    case 'mul': {
      let acc = [ONE];
      for (const f of e.factors) {
        const ts = termsOf(expand(f));
        if (ts.length === 1) acc = acc.map((a) => mul(a, ts[0]));
        else {
          const n = [];
          for (const a of acc) for (const t of ts) n.push(mul(a, t));
          acc = n;
        }
        acc = termsOf(add(...acc));
        if (!acc.length) break;
      }
      r = add(...acc);
      break;
    }
    case 'pow': {
      const b = expand(e.base), x = expand(e.exp);
      if (b.t === 'add' && isInt(x) && x.n > 1 && x.n <= 12) {
        let acc = b.terms;
        for (let i = 1; i < x.n; i++) {
          const n = [];
          for (const a of acc) for (const t of b.terms) n.push(mul(a, t));
          acc = termsOf(add(...n));
        }
        r = add(...acc);
      } else r = pow(b, x);
      break;
    }
    case 'fn': r = fn(e.name, expand(e.arg)); break;
  }
  e._x = r;
  return r;
}

function pairSinCos(terms) {
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < terms.length; i++) {
      const t = terms[i];
      const fs = t.t === 'mul' ? t.factors : [t];
      for (const f of fs) {
        if (f.t === 'pow' && f.base.t === 'fn' && f.base.name === 'sin' && isInt(f.exp) && f.exp.n >= 2) {
          const a = f.base.arg;
          const rest = mul(t, pow(f.base, num(-2)));
          const target = mul(rest, pow(fn('cos', a), 2));
          const j = terms.findIndex((u, k) => k !== i && u.key === target.key);
          if (j >= 0) {
            const nt = terms.filter((_, k) => k !== i && k !== j);
            nt.push(rest);
            terms = termsOf(add(...nt));
            changed = true;
            break outer;
          }
        }
      }
    }
  }
  return terms;
}
function fnFactor(f, name) {
  return f.t === 'fn' && f.name === name ? f.arg : null;
}
/** c·cos a·cos b ± c·sin a·sin b -> c·cos(a ∓ b);  c·sin a·cos b ± c·cos a·sin b -> c·sin(a ± b) */
function pairAddition(terms) {
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    outer: for (let i = 0; i < terms.length; i++) {
      const t = terms[i];
      const fs = t.t === 'mul' ? t.factors : [t];
      const cosArgs = fs.map((f) => fnFactor(f, 'cos')).filter(Boolean);
      const sinArgs = fs.map((f) => fnFactor(f, 'sin')).filter(Boolean);
      const tryPair = (rest, partner, result) => {
        const j = terms.findIndex((u, k) => k !== i && u.key === partner.key);
        if (j < 0) return false;
        const nt = terms.filter((_, k) => k !== i && k !== j);
        nt.push(mul(rest, result));
        terms = termsOf(add(...nt));
        return true;
      };
      for (let x = 0; x < cosArgs.length; x++) for (let y = x + 1; y < cosArgs.length; y++) {
        const a = cosArgs[x], b = cosArgs[y];
        const rest = mul(t, pow(fn('cos', a), MONE), pow(fn('cos', b), MONE));
        const ss = mul(fn('sin', a), fn('sin', b));
        if (tryPair(rest, mul(rest, ss), fn('cos', add(a, mul(MONE, b))))) { changed = true; break outer; }
        if (tryPair(rest, mul(MONE, rest, ss), fn('cos', add(a, b)))) { changed = true; break outer; }
      }
      for (const a of sinArgs) for (const b of cosArgs) {
        if (a.key === b.key) continue;
        const rest = mul(t, pow(fn('sin', a), MONE), pow(fn('cos', b), MONE));
        const cs = mul(fn('cos', a), fn('sin', b));
        if (tryPair(rest, mul(MONE, rest, cs), fn('sin', add(a, mul(MONE, b))))) { changed = true; break outer; }
        if (tryPair(rest, mul(rest, cs), fn('sin', add(a, b)))) { changed = true; break outer; }
      }
    }
  }
  return terms;
}
export function trigsimp(e) {
  if (e._ts) return e._ts;
  let r;
  switch (e.t) {
    case 'add': r = add(...pairAddition(pairSinCos(e.terms.map(trigsimp)))); break;
    case 'mul': r = mul(...e.factors.map(trigsimp)); break;
    case 'pow': r = pow(trigsimp(e.base), trigsimp(e.exp)); break;
    case 'fn': r = fn(e.name, trigsimp(e.arg)); break;
    default: return e;
  }
  e._ts = r;
  return r;
}
export function simplify(e) { return trigsimp(expand(e)); }

export function subs(e, m) {
  if (!m.size) return e;
  const fs = freeSyms(e);
  let hit = false;
  for (const k of m.keys()) if (fs.has(k)) { hit = true; break; }
  if (!hit) return e;
  switch (e.t) {
    case 'sym': return m.get(e.name);
    case 'add': return add(...e.terms.map((x) => subs(x, m)));
    case 'mul': return mul(...e.factors.map((x) => subs(x, m)));
    case 'pow': return pow(subs(e.base, m), subs(e.exp, m));
    case 'fn': return fn(e.name, subs(e.arg, m));
    default: return e;
  }
}
export const subsObj = (e, obj) => subs(e, new Map(Object.entries(obj)));

export function diff(e, x) {
  const xn = typeof x === 'string' ? x : x.name;
  if (!freeSyms(e).has(xn)) return ZERO;
  if (!e._d) e._d = new Map();
  const c = e._d.get(xn);
  if (c) return c;
  let r;
  switch (e.t) {
    case 'sym': r = ONE; break;
    case 'add': r = add(...e.terms.map((t) => diff(t, xn))); break;
    case 'mul': {
      const terms = [];
      e.factors.forEach((f, i) => {
        const df = diff(f, xn);
        if (!isZero(df)) terms.push(mul(...e.factors.filter((_, k) => k !== i), df));
      });
      r = add(...terms);
      break;
    }
    case 'pow': {
      const { base: b, exp: p } = e;
      if (!freeSyms(p).has(xn)) r = mul(p, pow(b, add(p, MONE)), diff(b, xn));
      else r = mul(e, add(mul(diff(p, xn), fn('ln', b)), mul(p, diff(b, xn), pow(b, MONE))));
      break;
    }
    case 'fn': {
      const a = e.arg, da = diff(a, xn);
      switch (e.name) {
        case 'sin': r = mul(fn('cos', a), da); break;
        case 'cos': r = mul(MONE, fn('sin', a), da); break;
        case 'tan': r = mul(add(ONE, pow(fn('tan', a), 2)), da); break;
        case 'exp': r = mul(e, da); break;
        case 'ln': r = mul(pow(a, MONE), da); break;
        case 'abs': r = mul(fn('sign', a), da); break;
        case 'sign': r = ZERO; break;
        default: throw new Error('Ableitung von ' + e.name + ' unbekannt');
      }
      break;
    }
    default: r = ZERO;
  }
  e._d.set(xn, r);
  return r;
}

/** Numerische Auswertung; env: Map oder Objekt name -> Zahl */
export function evalNum(e, env) {
  switch (e.t) {
    case 'num': return numVal(e);
    case 'sym': {
      const v = env instanceof Map ? env.get(e.name) : env[e.name];
      if (v === undefined) {
        if (e.name === 'pi') return Math.PI;
        throw new Error('Kein Zahlenwert für ' + info(e.name).latex);
      }
      return v;
    }
    case 'add': { let s = 0; for (const t of e.terms) s += evalNum(t, env); return s; }
    case 'mul': { let s = 1; for (const t of e.factors) s *= evalNum(t, env); return s; }
    case 'pow': return Math.pow(evalNum(e.base, env), evalNum(e.exp, env));
    case 'fn': return FN[e.name](evalNum(e.arg, env));
  }
  return NaN;
}

/** JavaScript-Quelltext für einen Ausdruck; nm(name) liefert den Variablen-Ausdruck */
export function toJS(e, nm) {
  switch (e.t) {
    case 'num': { const v = numVal(e); return v < 0 ? '(' + v + ')' : String(v); }
    case 'sym': return nm(e.name);
    case 'add': return '(' + e.terms.map((x) => toJS(x, nm)).join('+') + ')';
    case 'mul': return '(' + e.factors.map((x) => toJS(x, nm)).join('*') + ')';
    case 'pow': {
      const b = toJS(e.base, nm);
      if (isInt(e.exp)) {
        const k = e.exp.n;
        if (k === 2) return 'sq(' + b + ')';
        if (k === -1) return '(1/' + b + ')';
        if (k === -2) return '(1/sq(' + b + '))';
        return 'Math.pow(' + b + ',' + k + ')';
      }
      if (e.exp.t === 'num' && numVal(e.exp) === 0.5) return 'Math.sqrt(' + b + ')';
      if (e.exp.t === 'num' && numVal(e.exp) === -0.5) return '(1/Math.sqrt(' + b + '))';
      return 'Math.pow(' + b + ',' + toJS(e.exp, nm) + ')';
    }
    case 'fn': {
      const m = { sin: 'Math.sin', cos: 'Math.cos', tan: 'Math.tan', exp: 'Math.exp', ln: 'Math.log', abs: 'Math.abs', sign: 'Math.sign' }[e.name];
      return m + '(' + toJS(e.arg, nm) + ')';
    }
  }
  throw new Error('toJS: unbekannter Knoten');
}

/** Ausdruck mit numerischen Parametern belegen (Koordinaten bleiben symbolisch) */
export function substNumbers(e, env) {
  const m = new Map();
  for (const n of freeSyms(e)) {
    const v = env instanceof Map ? env.get(n) : env[n];
    if (v !== undefined) m.set(n, num(v));
    else if (n === 'pi') m.set(n, num(Math.PI));
  }
  return subs(e, m);
}

export function size(e) {
  if (e._n) return e._n;
  let n = 1;
  for (const c of children(e)) n += size(c);
  e._n = n;
  return n;
}

/** Taylorentwicklung: Koeffizienten der Ordnungen 0..N bzgl. gemeinsamer Skalierung aller vars */
export function series(e, vars, N) {
  const eps = sym('__eps', { kind: 'eps' });
  const m = new Map(vars.map((v) => [v.name, mul(eps, v)]));
  let f = subs(e, m);
  const zero = new Map([[eps.name, ZERO]]);
  const out = [];
  let fact = 1;
  for (let k = 0; k <= N; k++) {
    if (k > 0) { f = diff(f, eps); fact *= k; }
    out.push(simplify(mul(num(1, fact), subs(f, zero))));
  }
  return out;
}
/** Abgebrochene Taylorreihe (Ordnung lo..hi) */
export function truncate(e, vars, hi, lo = 0) {
  const s = series(e, vars, hi);
  return add(...s.slice(lo));
}

// ------------------------------------------- Quadratwurzeln vollständiger Quadrate
function squareRootMonomial(t) {
  // liefert r mit r^2 = t (t > 0 als Monom) oder null
  let coef = ONE, fs = [t];
  if (t.t === 'mul') { fs = t.factors; if (fs[0].t === 'num') { coef = fs[0]; fs = fs.slice(1); } }
  else if (t.t === 'num') { coef = t; fs = []; }
  if (numVal(coef) <= 0) return null;
  const rc = numPow(coef, HALF);
  if (!rc || rc.t !== 'num') return null;
  const out = [rc];
  for (const f of fs) {
    if (f.t === 'pow' && isInt(f.exp) && f.exp.n % 2 === 0 && f.exp.n > 0) out.push(pow(f.base, num(f.exp.n / 2)));
    else return null;
  }
  return mul(...out);
}
export function perfectSquareRoot(Y) {
  Y = expand(Y);
  if (Y.t === 'pow' && isInt(Y.exp) && Y.exp.n === 2) return Y.base;
  if (Y.t !== 'add' || Y.terms.length > 12) return squareRootMonomial(Y);
  const roots = [];
  for (const t of Y.terms) { const r = squareRootMonomial(t); if (r) roots.push(r); }
  if (roots.length < 2 || roots.length > 6) return null;
  const keys = new Set(Y.terms.map((t) => t.key));
  const P = [roots[0]];
  for (let i = 1; i < roots.length; i++) {
    const plus = mul(2, roots[0], roots[i]), minus = mul(-2, roots[0], roots[i]);
    if (keys.has(plus.key)) P.push(roots[i]);
    else if (keys.has(minus.key)) P.push(mul(MONE, roots[i]));
    else return null;
  }
  const p = add(...P);
  if (expand(pow(p, 2)).key === Y.key) return p;
  return null;
}
/** sqrt(P^2) -> ±P, Vorzeichen aus der Referenzlage (refEnv) */
export function sqrtsimp(e, refEnv) {
  switch (e.t) {
    case 'add': return add(...e.terms.map((x) => sqrtsimp(x, refEnv)));
    case 'mul': return mul(...e.factors.map((x) => sqrtsimp(x, refEnv)));
    case 'fn': return fn(e.name, sqrtsimp(e.arg, refEnv));
    case 'pow': {
      const b = sqrtsimp(e.base, refEnv);
      if (e.exp.t === 'num' && !e.exp.f && e.exp.d === 2) {
        const P = perfectSquareRoot(b);
        if (P) {
          let v;
          try { v = evalNum(P, refEnv); } catch { v = NaN; }
          if (Number.isFinite(v) && Math.abs(v) > 1e-12) {
            const absP = v > 0 ? P : mul(MONE, P);
            return pow(absP, num(e.exp.n));
          }
        }
      }
      return pow(b, e.exp);
    }
    default: return e;
  }
}
