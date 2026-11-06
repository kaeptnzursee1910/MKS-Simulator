// Definition der Strukturelemente: Parameter, Anschlusspunkte (Ports), Geometrie
import { num, mul, add, pow, MONE, ZERO, evalNum, sqrt } from '../cas/expr.js';
import { tryParse } from '../cas/parse.js';

export const TYPES = {
  block: { name: 'Klotz (Masse)', body: true },
  disk: { name: 'Scheibe / Rolle', body: true },
  rod: { name: 'Stab', body: true },
  point: { name: 'Punktmasse', body: true },
  ground: { name: 'Boden / Bahn' },
  fix: { name: 'Festpunkt / Wand' },
  pin: { name: 'Festlager' },
  roller: { name: 'Loslager (Gleitlager)' },
  hinge: { name: 'Gelenk' },
  contact: { name: 'Kontakt Boden' },
  rope: { name: 'Seil (dehnstarr)', line: true },
  spring: { name: 'Feder', line: true },
  damper: { name: 'Dämpfer', line: true },
  springdamper: { name: 'Feder ∥ Dämpfer', line: true },
  tspring: { name: 'Drehfeder' },
  tdamper: { name: 'Drehdämpfer' },
  force: { name: 'Kraft' },
  moment: { name: 'Moment' },
};
export const isBody = (el) => !!TYPES[el.type]?.body;
export const isLine = (el) => !!TYPES[el.type]?.line;
export const hasRotation = (el) => el.type === 'disk' || el.type === 'rod' || (el.type === 'block' && el.props.rot);

/** Ausdruck einer Eigenschaft (String) -> CAS-Ausdruck; wirft verständliche Fehler */
export function propExpr(el, key) {
  const s = el.props?.[key];
  const r = tryParse(s);
  if (r.error) throw new Error(`${TYPES[el.type].name} ${el.label || ''}: „${key}“ = „${s}“ – ${r.error}`);
  return r.expr;
}
export function propNum(el, key, env, fallback = 0.1) {
  try { const v = evalNum(propExpr(el, key), env); return Number.isFinite(v) ? v : fallback; } catch { return fallback; }
}

// ----------------------------------------------- exakte Winkelfunktionen
const S2 = () => pow(num(2), num(1, 2));
const S3 = () => pow(num(3), num(1, 2));
const S6 = () => pow(num(6), num(1, 2));
function baseTable(b) {
  switch (b) {
    case 0: return [num(1), ZERO];
    case 15: return [mul(num(1, 4), add(S6(), S2())), mul(num(1, 4), add(S6(), mul(MONE, S2())))];
    case 30: return [mul(num(1, 2), S3()), num(1, 2)];
    case 45: return [mul(num(1, 2), S2()), mul(num(1, 2), S2())];
    case 60: return [num(1, 2), mul(num(1, 2), S3())];
    case 75: return [mul(num(1, 4), add(S6(), mul(MONE, S2()))), mul(num(1, 4), add(S6(), S2()))];
    case 90: return [ZERO, num(1)];
  }
  return null;
}
/** [cos, sin] eines Winkels in Grad – exakt für Vielfache von 15° */
export function exactTrig(deg, tol = 0.5) {
  let a = ((deg % 360) + 360) % 360;
  const r = Math.round(a / 15) * 15;
  if (Math.abs(a - r) <= tol) {
    a = r % 360;
    const q = Math.floor(a / 90), b = a - 90 * q;
    const [c, s] = baseTable(b);
    const n = (x) => mul(MONE, x);
    switch (q) {
      case 0: return [c, s];
      case 1: return [n(s), c];
      case 2: return [n(c), n(s)];
      case 3: return [s, n(c)];
    }
  }
  const rad = (deg * Math.PI) / 180;
  const rd = (v) => num(Math.round(v * 1e6) / 1e6);
  return [rd(Math.cos(rad)), rd(Math.sin(rad))];
}
export const rot = ([x, y], [c, s]) => [add(mul(c, x), mul(MONE, s, y)), add(mul(s, x), mul(c, y))];

// ----------------------------------------------- Ports
const DIRS8 = [0, 45, 90, 135, 180, 225, 270, 315];

/** Anschlusspunkte eines Körpers/Elements. s: symbolischer Versatz zum Schwerpunkt (Bezugslage),
 *  w: numerischer Versatz (Weltkoordinaten), rim: Radius falls Punkt auf dem Scheibenumfang. */
export function ports(el, env) {
  const P = (k) => propExpr(el, k);
  const N = (k, fb) => propNum(el, k, env, fb);
  const out = [];
  const push = (id, s, rimR = null, rimN = 0) => {
    let w;
    try { w = [evalNum(s[0], env), evalNum(s[1], env)]; } catch { w = [0, 0]; }
    out.push({ id, s, w, rim: rimR ? { R: rimR, Rn: rimN } : null });
  };
  switch (el.type) {
    case 'disk': {
      push('c', [ZERO, ZERO]);
      for (const key of ['R', 'Ri']) {
        if (!el.props[key] || !String(el.props[key]).trim()) continue;
        let R; try { R = P(key); } catch { continue; }
        const Rn = N(key, 0.1);
        for (const d of DIRS8) {
          const [c, s] = exactTrig(d);
          push(key + ':' + d, [mul(R, c), mul(R, s)], R, Rn);
        }
      }
      break;
    }
    case 'block': {
      let a, b;
      try { a = mul(num(1, 2), P('a')); b = mul(num(1, 2), P('b')); } catch { a = num(1, 10); b = num(1, 20); }
      const tr = exactTrig(el.angle || 0);
      const pts = { c: [0, 0], l: [-1, 0], r: [1, 0], t: [0, 1], b: [0, -1], tl: [-1, 1], tr: [1, 1], bl: [-1, -1], br: [1, -1] };
      for (const [id, [i, j]] of Object.entries(pts)) push(id, rot([mul(i, a), mul(j, b)], tr));
      break;
    }
    case 'rod': {
      let h; try { h = mul(num(1, 2), P('l')); } catch { h = num(1, 4); }
      const tr = exactTrig(el.angle || 0);
      push('c', [ZERO, ZERO]);
      push('e1', rot([mul(MONE, h), ZERO], tr));
      push('e2', rot([h, ZERO], tr));
      push('q1', rot([mul(num(-1, 2), h), ZERO], tr));
      push('q2', rot([mul(num(1, 2), h), ZERO], tr));
      break;
    }
    case 'point': case 'fix':
      push('c', [ZERO, ZERO]);
      break;
  }
  return out;
}
export function findPort(el, id, env) { return ports(el, env).find((p) => p.id === id) || null; }

/** Weltposition eines Ports, optional verschoben (u, v, th) */
export function portWorld(el, portId, env, disp) {
  const p = findPort(el, portId, env);
  const w = p ? p.w : [0, 0];
  const u = disp?.u || 0, v = disp?.v || 0, th = disp?.th || 0;
  const c = Math.cos(th), s = Math.sin(th);
  return [el.x + u + c * w[0] - s * w[1], el.y + v + s * w[0] + c * w[1]];
}

/** Standardwerte für neue Parameter (nach Anfangsbuchstabe) */
export function defaultParamValue(name) {
  const b = name.split('_')[0];
  if (b === 'g') return 9.81;
  if (b === 'm') return 1;
  if (b === 'J') return 0.01;
  if (b === 'k' || b === 'c') return 200;
  if (b === 'kt') return 5;
  if (b === 'd') return 2;
  if (b === 'dt') return 0.05;
  if (b === 'r' || b === 'R') return 0.1;
  if (b === 'l' || b === 'L') return 0.5;
  if (b === 'a' || b === 'b' || b === 'h') return 0.2;
  if (b === 'F') return 10;
  if (b === 'M') return 1;
  if (b === 'Omega' || b === 'omega') return 5;
  return 1;
}

export { sqrt };
