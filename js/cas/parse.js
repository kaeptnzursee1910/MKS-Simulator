// Parser für Benutzereingaben wie "2*r", "m_1", "F_0*cos(Omega*t)", "1/2 m r^2"
import { num, sym, add, mul, pow, fn, MONE, freeSyms, info } from './expr.js';
import { nameToLatex } from './latex.js';

const FUNCS = new Set(['sin', 'cos', 'tan', 'sqrt', 'exp', 'ln', 'abs']);

export function paramSym(name) {
  if (name === 't') return sym('t', { kind: 'time', latex: 't', pos: true, order: 0 });
  if (name === 'pi') return sym('pi', { kind: 'param', latex: '\\pi', pos: true, order: 0 });
  return sym(name, { kind: 'param', latex: nameToLatex(name), pos: true, order: 0 });
}

function tokenize(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    let m;
    const rest = s.slice(i);
    if ((m = /^(\d+([.,]\d*)?|[.,]\d+)([eE][-+]?\d+)?/.exec(rest))) {
      toks.push({ k: 'num', v: m[0].replace(',', '.') });
      i += m[0].length; continue;
    }
    if ((m = /^[A-Za-z][A-Za-z0-9]*(_(\{[^}]*\}|[A-Za-z0-9]+))?/.exec(rest))) {
      toks.push({ k: 'id', v: m[0].replace(/[{}]/g, '') });
      i += m[0].length; continue;
    }
    if ('+-*/^()'.includes(c)) { toks.push({ k: c }); i++; continue; }
    if (c === '·') { toks.push({ k: '*' }); i++; continue; }
    throw new Error('Unerwartetes Zeichen „' + c + '“');
  }
  return toks;
}

function decToRational(str) {
  const v = Number(str);
  if (!Number.isFinite(v)) throw new Error('Ungültige Zahl ' + str);
  const m = /^(\d*)\.(\d+)$/.exec(str);
  if (m && m[2].length <= 8) {
    const d = 10 ** m[2].length;
    return num(Math.round(v * d), d);
  }
  return num(v);
}

export function parse(str) {
  if (typeof str === 'number') return num(str);
  str = String(str ?? '').trim();
  if (!str) throw new Error('Leerer Ausdruck');
  const toks = tokenize(str);
  let p = 0;
  const peek = () => toks[p];
  const eat = (k) => {
    if (!toks[p] || toks[p].k !== k) throw new Error('„' + k + '“ erwartet');
    return toks[p++];
  };
  function expr() {
    let left = term();
    while (peek() && (peek().k === '+' || peek().k === '-')) {
      const op = toks[p++].k;
      const r = term();
      left = op === '+' ? add(left, r) : add(left, mul(MONE, r));
    }
    return left;
  }
  function term() {
    let left = unary();
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.k === '*') { p++; left = mul(left, unary()); }
      else if (t.k === '/') { p++; left = mul(left, pow(unary(), MONE)); }
      else if (t.k === 'num' || t.k === 'id' || t.k === '(') left = mul(left, power());
      else break;
    }
    return left;
  }
  function unary() {
    const t = peek();
    if (t && t.k === '-') { p++; return mul(MONE, unary()); }
    if (t && t.k === '+') { p++; return unary(); }
    return power();
  }
  function power() {
    const b = atom();
    if (peek() && peek().k === '^') { p++; return pow(b, unary()); }
    return b;
  }
  function atom() {
    const t = toks[p++];
    if (!t) throw new Error('Ausdruck unvollständig');
    if (t.k === 'num') return decToRational(t.v);
    if (t.k === '(') { const e = expr(); eat(')'); return e; }
    if (t.k === 'id') {
      if (FUNCS.has(t.v) && peek() && peek().k === '(') {
        p++;
        const a = expr();
        eat(')');
        return fn(t.v, a);
      }
      return paramSym(t.v);
    }
    throw new Error('Unerwartetes „' + t.k + '“');
  }
  const e = expr();
  if (p < toks.length) throw new Error('Unerwartetes „' + (toks[p].v || toks[p].k) + '“');
  return e;
}

const cache = new Map();
/** Gecachter Parser; liefert {expr} oder {error} */
export function tryParse(str) {
  const k = String(str ?? '');
  if (cache.has(k)) return cache.get(k);
  let r;
  try { r = { expr: parse(k) }; } catch (e) { r = { error: e.message }; }
  cache.set(k, r);
  return r;
}

/** Parameternamen (ohne t, pi) eines Ausdrucks */
export function paramNames(e) {
  return [...freeSyms(e)].filter((n) => n !== 't' && n !== 'pi' && info(n).kind === 'param');
}
