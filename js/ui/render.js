// Skizzenhafte SVG-Darstellung der Strukturelemente
import { TYPES, isBody, isLine, ports, portWorld, propNum, findPort, hasRotation } from '../mech/elements.js';
import { nameToUni } from '../cas/latex.js';

const INK = '#1d1d1f';
const ACC = '#1f5fbf';
const f1 = (x) => Math.round(x * 10) / 10;
let Z = 1; // Symbolgröße abhängig vom Zoom

// ------------------------------------------------------------ Beschriftung
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
/** Ausdruck (Benutzereingabe) -> SVG-tspans mit Indizes */
export function labelSpans(str) {
  if (str === undefined || str === null) return '';
  str = String(str).trim();
  const toks = str.match(/[A-Za-z][A-Za-z0-9]*(_(\{[^}]*\}|[A-Za-z0-9]+))?|\d+([.,]\d+)?|\^\d|\S/g) || [];
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^[A-Za-z]/.test(t)) {
      const fnName = ['sin', 'cos', 'tan', 'sqrt', 'exp', 'ln', 'abs'].includes(t);
      if (fnName) { out += `<tspan font-style="normal">${t}</tspan>`; continue; }
      const { main, sub } = nameToUni(t.replace(/[{}]/g, ''));
      out += esc(main) + (sub ? `<tspan baseline-shift="sub" font-size="70%">${esc(sub)}</tspan>` : '');
    } else if (t === '*') {
      const prev = toks[i - 1] || '', next = toks[i + 1] || '';
      if (/^\d/.test(prev) && /^[A-Za-z(]/.test(next)) continue;
      out += '·';
    } else if (/^\^\d$/.test(t)) out += SUP[t[1]];
    else if (t === '^') out += '^';
    else out += esc(t.replace('.', ','));
  }
  return out;
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function text(x, y, content, opts = {}) {
  const anchor = opts.anchor || 'middle';
  const cls = opts.cls || 'lbl';
  const fill = opts.color ? ` fill="${opts.color}"` : '';
  const fs = cls === 'lbl' && Z !== 1 ? ` style="font-size:${f1(17 * Z)}px"` : '';
  return `<text x="${f1(x)}" y="${f1(y)}" text-anchor="${anchor}" dominant-baseline="middle" class="${cls}"${fill}${fs}>${content}</text>`;
}

// ------------------------------------------------------------ Grundformen
function seg(a, b, c = INK, w = 1.4, extra = '') {
  return `<line x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"${extra}/>`;
}
function poly(pts, c = INK, w = 1.4, fill = 'none', close = false) {
  const d = pts.map((p, i) => (i ? 'L' : 'M') + f1(p[0]) + ' ' + f1(p[1])).join(' ') + (close ? ' Z' : '');
  return `<path d="${d}" stroke="${c}" stroke-width="${w}" fill="${fill}" stroke-linejoin="round" stroke-linecap="round"/>`;
}
function circ(c, r, col = INK, w = 1.4, fill = 'transparent') {
  return `<circle cx="${f1(c[0])}" cy="${f1(c[1])}" r="${f1(r)}" stroke="${col}" stroke-width="${w}" fill="${fill}"/>`;
}
const add2 = (a, b, s = 1) => [a[0] + s * b[0], a[1] + s * b[1]];
const norm = (v) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
const perp = (v) => [-v[1], v[0]];
function arrowHead(tip, dir, c = INK, size = 9) {
  size *= Math.max(0.7, Math.min(Z, 1.2));
  const d = norm(dir), n = perp(d);
  const b = add2(tip, d, -size);
  return `<path d="M${f1(tip[0])} ${f1(tip[1])} L${f1(b[0] + n[0] * size * 0.38)} ${f1(b[1] + n[1] * size * 0.38)} L${f1(b[0] - n[0] * size * 0.38)} ${f1(b[1] - n[1] * size * 0.38)} Z" fill="${c}" stroke="none"/>`;
}
function arrow(a, b, c = INK, w = 1.4) { return seg(a, add2(b, norm([b[0] - a[0], b[1] - a[1]]), -4), c, w) + arrowHead(b, [b[0] - a[0], b[1] - a[1]], c); }
/** Schraffur an einer Strecke a-b, Seite s (Einheitsvektor, Bildschirm) */
function hatch(a, b, side, c = INK, step = 10, len = 9) {
  const t = norm([b[0] - a[0], b[1] - a[1]]);
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const dir = norm(add2(side, t, -0.9));
  let s = '';
  for (let x = 4; x <= L - 1; x += step) {
    const p = add2(a, t, x);
    s += seg(p, add2(p, dir, len), c, 1.1);
  }
  return s;
}
function arcPath(c, r, a0, a1, col = INK, w = 1.4, head = true) {
  // Winkel in Grad, mathematisch (Bildschirm: y nach unten)
  const P = (a) => [c[0] + r * Math.cos((a * Math.PI) / 180), c[1] - r * Math.sin((a * Math.PI) / 180)];
  const p0 = P(a0), p1 = P(a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 0 : 1;
  let s = `<path d="M${f1(p0[0])} ${f1(p0[1])} A${f1(r)} ${f1(r)} 0 ${large} ${sweep} ${f1(p1[0])} ${f1(p1[1])}" fill="none" stroke="${col}" stroke-width="${w}"/>`;
  if (head) {
    const sgn = a1 > a0 ? 1 : -1;
    const a = (a1 * Math.PI) / 180;
    const tangent = [-Math.sin(a) * sgn, -Math.cos(a) * sgn];
    s += arrowHead(p1, tangent, col, 10);
  }
  return s;
}

// ------------------------------------------------------------ Ansicht
export function makeView(view, W, H) {
  const { cx, cy, s } = view;
  return {
    W, H, s,
    S: (x, y) => [(x - cx) * s + W / 2, -(y - cy) * s + H / 2],
    toWorld: (X, Y) => [(X - W / 2) / s + cx, -(Y - H / 2) / s + cy],
    dir: (a) => [Math.cos((a * Math.PI) / 180), -Math.sin((a * Math.PI) / 180)],
  };
}

// ------------------------------------------------------------ Szene
/** Bezugsdaten einer Linien-Verbindung: wird das Seil aufgewickelt? */
export function lineGeometry(sys, el, env) {
  const byId = (id) => sys.elements.find((e) => e.id === id);
  // Ende: an Körper/Festpunkt angeschlossen ({el, port}) oder frei ({x, y})
  const end = (ref) => {
    if (ref?.el) { const X = byId(ref.el); return X ? { X, p: portWorld(X, ref.port, env) } : null; }
    if (ref && Number.isFinite(ref.x)) return { X: null, p: [ref.x, ref.y] };
    return null;
  };
  const ea = end(el.a), eb = end(el.b);
  if (!ea || !eb) return null;
  const pa = ea.p, pb = eb.p;
  const e = norm([pb[0] - pa[0], pb[1] - pa[1]]);
  const wound = (X, ref) => {
    if (!X || X.type !== 'disk') return false;
    const p = findPort(X, ref.port, env);
    if (!p || !p.rim) return false;
    const rn = Math.hypot(p.w[0], p.w[1]) || 1;
    return Math.abs((p.w[0] * e[0] + p.w[1] * e[1]) / rn) < 0.15;
  };
  return { A: ea.X, B: eb.X, pa, pb, wa: wound(ea.X, el.a), wb: wound(eb.X, el.b), len: Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) };
}

function anchorPos(el, portId, env, d, wound) {
  if (!d || el.type === 'fix') return portWorld(el, portId, env, d);
  if (wound) {
    const p = findPort(el, portId, env);
    return [el.x + (d.u || 0) + p.w[0], el.y + (d.v || 0) + p.w[1]];
  }
  return portWorld(el, portId, env, d);
}

function bodyExtent(el, env, V) {
  switch (el.type) {
    case 'disk': return propNum(el, 'R', env, 0.1) * V.s;
    case 'block': return (Math.max(propNum(el, 'a', env, 0.2), propNum(el, 'b', env, 0.1)) / 2) * V.s;
    case 'rod': return 18;
    default: return 8;
  }
}

export function renderScene(sys, V, opts = {}) {
  const env = opts.env || {};
  const disp = opts.disp || null; // Map bodyId -> {u,v,th}
  const sel = opts.selected;
  const step = opts.step;
  Z = Math.max(0.45, Math.min(1.4, V.s / 400));
  const out = { grid: '', ground: '', bodies: '', lines: '', supports: '', loads: '', dofs: '', ports: '', overlay: '' };
  const D = (id) => (disp ? disp.get(id) : null) || null;
  const col = (el) => (el.id === sel ? ACC : INK);
  const byId = new Map(sys.elements.map((e) => [e.id, e]));
  // Animation: masselose Knoten liegen anteilig zwischen ihren Nachbarenden
  const nodePos = new Map();
  if (disp) {
    const nodes = sys.elements.filter((e) => e.type === 'node');
    const endPos = (ref, ref0) => {
      if (!ref?.el) return ref0 ? [ref.x, ref.y] : [ref.x, ref.y];
      const X = byId.get(ref.el);
      if (!X) return [0, 0];
      if (X.type === 'node') return ref0 ? [X.x, X.y] : (nodePos.get(X.id) || [X.x, X.y]);
      return ref0 ? portWorld(X, ref.port, env) : portWorld(X, ref.port, env, D(X.id));
    };
    for (let it = 0; it < 12; it++) {
      for (const n of nodes) {
        const att = sys.elements.filter((l) => isLine(l) && (l.a?.el === n.id || l.b?.el === n.id));
        if (att.length !== 2) continue;
        const far = att.map((l) => (l.a?.el === n.id ? l.b : l.a));
        const A0 = endPos(far[0], true), B0 = endPos(far[1], true);
        const L = Math.hypot(B0[0] - A0[0], B0[1] - A0[1]) || 1;
        const t = Math.hypot(n.x - A0[0], n.y - A0[1]) / L;
        const A = endPos(far[0], false), B = endPos(far[1], false);
        nodePos.set(n.id, [A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])]);
      }
    }
  }

  // Raster
  if (opts.grid) {
    let g = 0.05;
    while (g * V.s < 14) g *= 2;
    const [x0, y1] = V.toWorld(0, 0), [x1, y0] = V.toWorld(V.W, V.H);
    let s = '';
    for (let x = Math.ceil(x0 / g) * g; x <= x1; x += g) { const X = V.S(x, 0)[0]; s += `<line class="grid" x1="${f1(X)}" y1="0" x2="${f1(X)}" y2="${V.H}"/>`; }
    for (let y = Math.ceil(y0 / g) * g; y <= y1; y += g) { const Y = V.S(0, y)[1]; s += `<line class="grid" x1="0" y1="${f1(Y)}" x2="${V.W}" y2="${f1(Y)}"/>`; }
    out.grid = s;
  }

  for (const el of sys.elements) {
    const c = col(el);
    const g0 = `<g class="el" data-id="${el.id}">`;
    try {
      switch (el.type) {
        case 'ground': {
          const L = (el.len || 1) / 2, a = ((el.angle || 0) * Math.PI) / 180;
          const p0 = V.S(el.x - L * Math.cos(a), el.y - L * Math.sin(a)), p1 = V.S(el.x + L * Math.cos(a), el.y + L * Math.sin(a));
          const n = V.dir((el.angle || 0) - 90);
          out.ground += g0 + seg(p0, p1, 'transparent', 14) + seg(p0, p1, c, 1.6) + hatch(p0, p1, n, c) + '</g>';
          break;
        }
        case 'curve': {
          const C = [el.x, el.y], rho = propNum(el, 'rho', env, 0.5);
          let a0 = el.a0 ?? 200, a1 = el.a1 ?? 340;
          if (a1 < a0) a1 += 360;
          const N = Math.max(8, Math.ceil(((a1 - a0) / 360) * 2 * Math.PI * rho * V.s / 6));
          const pts = [];
          for (let i = 0; i <= N; i++) { const a = ((a0 + ((a1 - a0) * i) / N) * Math.PI) / 180; pts.push([C[0] + rho * Math.cos(a), C[1] + rho * Math.sin(a)]); }
          const sp = pts.map((p) => V.S(...p));
          let h = '';
          const step = Math.max(1, Math.round(N / Math.max(4, ((a1 - a0) / 360) * 2 * Math.PI * rho * V.s / 10)));
          for (let i = 0; i < N; i += step) {
            const a = ((a0 + ((a1 - a0) * i) / N) * Math.PI) / 180;
            const out_ = [Math.cos(a), -Math.sin(a)];
            const side = el.concave === false ? [-out_[0], -out_[1]] : out_;
            const tan = [-out_[1], out_[0]];
            const dir = norm(add2(side, tan, 0.9));
            h += seg(sp[i], add2(sp[i], dir, 9), c, 1.1);
          }
          const d = sp.map((p, i) => (i ? 'L' : 'M') + f1(p[0]) + ' ' + f1(p[1])).join(' ');
          out.ground += g0 + `<path d="${d}" stroke="transparent" stroke-width="14" fill="none"/><path d="${d}" stroke="${c}" stroke-width="1.6" fill="none"/>` + h + '</g>';
          break;
        }
        case 'fix': {
          const P = V.S(el.x, el.y);
          if (el.style === 'pin') { out.supports += g0 + drawSupport(P, V.dir(el.angle ?? -90), false, c) + '</g>'; break; }
          const n = V.dir(el.angle || 0), t = perp(n);
          const a = add2(P, t, 16), b = add2(P, t, -16);
          out.ground += g0 + circ(P, 12, 'transparent', 1, 'transparent') + seg(a, b, c, 1.8) + hatch(b, a, [-n[0], -n[1]], c, 8, 8) + '</g>';
          break;
        }
        case 'node': {
          const P = V.S(...(nodePos.get(el.id) || [el.x, el.y]));
          out.supports += g0 + circ(P, 10, 'transparent', 1, 'transparent') + circ(P, 3.8, c, 1.2, c) + '</g>';
          break;
        }
        case 'disk': out.bodies += g0 + drawDisk(el, V, env, D(el.id), c) + '</g>'; break;
        case 'block': out.bodies += g0 + drawBlock(el, V, env, D(el.id), c) + '</g>'; break;
        case 'rod': out.bodies += g0 + drawRod(el, V, env, D(el.id), c) + '</g>'; break;
        case 'point': {
          const d = D(el.id) || {};
          const P = V.S(el.x + (d.u || 0), el.y + (d.v || 0));
          out.bodies += g0 + circ(P, 12, 'transparent', 1, 'transparent') + circ(P, 6, c, 1.4, c) + text(P[0] + 14, P[1] - 12, labelSpans(el.props.m), { anchor: 'start', color: c }) + bodyNo(el, P[0] - 12, P[1] - 14) + '</g>';
          break;
        }
        case 'pin': case 'roller': {
          const B = byId.get(el.at?.el); if (!B) break;
          const P = V.S(...portWorld(B, el.at.port, env, D(B.id)));
          out.supports += g0 + drawSupport(P, V.dir(el.angle ?? -90), el.type === 'roller', c) + '</g>';
          break;
        }
        case 'hinge': {
          const A = byId.get(el.a?.el); if (!A) break;
          const P = V.S(...portWorld(A, el.a.port, env, D(A.id)));
          out.supports += g0 + circ(P, 9, 'transparent', 1, 'transparent') + circ(P, 4, c, 1.5, '#fff') + '</g>';
          break;
        }
        case 'contact': {
          const B = byId.get(el.body), G = byId.get(el.ground);
          if (!B || !G) break;
          if (G.type === 'curve') {
            const d = D(B.id) || {};
            const S = [B.x + (d.u || 0), B.y + (d.v || 0)];
            const u = norm([S[0] - G.x, S[1] - G.y]);
            const rho = propNum(G, 'rho', env, 0.5);
            const R = B.type === 'disk' ? propNum(B, 'R', env, 0.1) : 0;
            const inside = Math.hypot(B.x - G.x, B.y - G.y) < rho;
            const cpw = [S[0] + (inside ? R : -R) * u[0], S[1] + (inside ? R : -R) * u[1]];
            const cp = V.S(...cpw);
            const t = [-u[1], -u[0]];
            const mark = el.mode === 'roll' ? circ(cp, 2.2, c, 1, c) : seg(add2(cp, [u[1], u[0]], -7), add2(cp, [u[1], u[0]], 7), c, 2.6);
            void t;
            out.supports += g0 + circ(cp, 8, 'transparent', 1, 'transparent') + mark + '</g>';
            break;
          }
          // kleine Markierung am Berührpunkt
          const d = D(B.id) || {};
          const ga = G.angle || 0;
          const R = B.type === 'disk' ? propNum(B, 'R', env, 0.1) : propNum(B, 'b', env, 0.1) / 2;
          const nrm = [-Math.sin((ga * Math.PI) / 180), Math.cos((ga * Math.PI) / 180)];
          const side = (nrm[0] * (B.x - G.x) + nrm[1] * (B.y - G.y)) >= 0 ? 1 : -1;
          const cp = V.S(B.x + (d.u || 0) - side * R * nrm[0], B.y + (d.v || 0) - side * R * nrm[1]);
          const mark = el.mode === 'roll' ? circ(cp, 2.2, c, 1, c) : seg(add2(cp, V.dir(ga), -7), add2(cp, V.dir(ga), 7), c, 2.6);
          out.supports += g0 + circ(cp, 8, 'transparent', 1, 'transparent') + mark + '</g>';
          break;
        }
        case 'rope': case 'spring': case 'damper': case 'springdamper': {
          const geo = lineGeometry(sys, el, env);
          if (!geo) break;
          const endW = (X, ref, wnd, p0) => (!X ? p0 : X.type === 'node' ? (nodePos.get(X.id) || p0) : anchorPos(X, ref.port, env, D(X.id), wnd));
          const pa = V.S(...endW(geo.A, el.a, geo.wa, geo.pa));
          const pb = V.S(...endW(geo.B, el.b, geo.wb, geo.pb));
          let ends = '';
          if (!geo.A) ends += circ(pa, 3.5, c, 1.3, '#fff');
          if (!geo.B) ends += circ(pb, 3.5, c, 1.3, '#fff');
          out.lines += g0 + seg(pa, pb, 'transparent', 14) + drawLine(el, pa, pb, c) + ends + '</g>';
          if (el.id === sel && opts.handles) {
            for (const [k, P] of [['a', pa], ['b', pb]]) {
              out.overlay += `<g data-handle="${el.id}|${k}"><circle cx="${f1(P[0])}" cy="${f1(P[1])}" r="14" fill="transparent"/><rect x="${f1(P[0] - 5)}" y="${f1(P[1] - 5)}" width="10" height="10" fill="#fff" stroke="${ACC}" stroke-width="1.8"/></g>`;
            }
          }
          break;
        }
        case 'tspring': case 'tdamper': {
          const A = byId.get(el.a); if (!A) break;
          const dA = D(A.id) || {};
          const C = V.S(A.x + (dA.u || 0), A.y + (dA.v || 0));
          let T;
          if (el.b) { const B = byId.get(el.b); if (!B) break; const dB = D(B.id) || {}; T = V.S(B.x + (dB.u || 0), B.y + (dB.v || 0)); }
          out.supports += g0 + drawTorsion(el, C, T, c) + '</g>';
          break;
        }
        case 'force': {
          const B = byId.get(el.at?.el); if (!B) break;
          const P = V.S(...portWorld(B, el.at.port, env, D(B.id)));
          const dv = V.dir(el.angle || 0);
          const Q = add2(P, dv, 46);
          out.loads += g0 + seg(P, Q, 'transparent', 12) + arrow(P, Q, c, 1.8) + text(Q[0] + dv[0] * 8, Q[1] + dv[1] * 8 - (Math.abs(dv[0]) > 0.3 ? 12 : 0), labelSpans(el.props.F), { color: c, anchor: dv[0] > 0.3 ? 'start' : dv[0] < -0.3 ? 'end' : 'middle' }) + '</g>';
          break;
        }
        case 'moment': {
          const B = byId.get(el.body); if (!B) break;
          const d = D(B.id) || {};
          const C = V.S(B.x + (d.u || 0), B.y + (d.v || 0));
          const r = bodyExtent(B, env, V) + 14;
          const a0 = el.dir === -1 ? 150 : 30, a1 = el.dir === -1 ? 30 : 150;
          out.loads += g0 + arcPath(C, r, a0, a1, c, 1.6) + text(C[0], C[1] - r - 12, labelSpans(el.props.M), { color: c }) + '</g>';
          break;
        }
      }
    } catch { /* Element unvollständig */ }
  }

  // Freiheitsgrade
  if (opts.showDofs) {
    for (const d of sys.dofs || []) {
      const B = byId.get(d.body); if (!B) continue;
      const dd = D(B.id) || {};
      const C = V.S(B.x + (dd.u || 0), B.y + (dd.v || 0));
      const r = bodyExtent(B, env, V);
      const lab = labelSpans(d.name);
      const cc = '#c2410c';
      if (d.coord === 'phi') {
        const R = r + 16;
        const [a0, a1] = d.dir === -1 ? [168, 100] : [100, 168];
        out.dofs += arcPath(C, R, a0, a1, cc, 1.6) + text(C[0] + R * Math.cos(2.4) - 10, C[1] - R * Math.sin(2.4) - 10, lab, { color: cc });
      } else if (d.coord === 'x') {
        const y = C[1] - r - 18;
        const a = [C[0] - 20 * d.dir, y], b = [C[0] + 20 * d.dir, y];
        out.dofs += arrow(a, b, cc, 1.6) + seg([C[0] - 20 * d.dir, y - 5], [C[0] - 20 * d.dir, y + 5], cc, 1.4) + text(b[0] + 12 * d.dir, y - 2, lab, { color: cc });
      } else {
        const x = C[0] + r + 18;
        const a = [x, C[1] + 20 * d.dir], b = [x, C[1] - 20 * d.dir];
        out.dofs += arrow(a, b, cc, 1.6) + seg([x - 5, a[1]], [x + 5, a[1]], cc, 1.4) + text(x + 14, b[1], lab, { color: cc, anchor: 'start' });
      }
    }
  }

  // Anschlusspunkte
  if (opts.showPorts) {
    for (const el of sys.elements) {
      if (!isBody(el) && el.type !== 'fix' && el.type !== 'node') continue;
      if (opts.portFilter && !opts.portFilter(el)) continue;
      for (const p of ports(el, env)) {
        if (el.type === 'rod' && (p.id === 'q1' || p.id === 'q2') && !opts.allPorts) continue;
        const P = V.S(el.x + p.w[0], el.y + p.w[1]);
        const hot = opts.hotPort === el.id + '|' + p.id;
        out.ports += `<g data-port="${el.id}|${p.id}"><circle class="port-hit" cx="${f1(P[0])}" cy="${f1(P[1])}" r="11"/><circle class="port${hot ? ' hot' : ''}" cx="${f1(P[0])}" cy="${f1(P[1])}" r="${hot ? 5.5 : 4}"/></g>`;
      }
    }
  }
  if (opts.preview) {
    const [a, b] = opts.preview;
    out.overlay += seg(V.S(...a), V.S(...b), ACC, 1.4, ' stroke-dasharray="5 4"');
  }
  return out.grid + out.ground + out.lines + out.bodies + out.supports + out.loads + out.dofs + out.ports + out.overlay;
}

function bodyNo(el, x, y) { return `<text x="${f1(x)}" y="${f1(y)}" class="bodyno" text-anchor="middle">${esc(el.label || '')}</text>`; }

function drawDisk(el, V, env, d, c) {
  d = d || {};
  const C = V.S(el.x + (d.u || 0), el.y + (d.v || 0));
  const th = d.th || 0;
  const R = propNum(el, 'R', env, 0.1) * V.s;
  const hasRi = el.props.Ri && String(el.props.Ri).trim();
  const Ri = hasRi ? propNum(el, 'Ri', env, 0.05) * V.s : 0;
  let s = circ(C, R, c, 1.4, 'transparent');
  if (Ri) s += circ(C, Ri, c, 1.3, 'transparent');
  s += circ(C, 3.5, c, 1.2, '#fff');
  const rad = (a) => ((a * Math.PI) / 180) + th;
  const radiusArrow = (r, a, label, la) => {
    const e = [Math.cos(rad(a)), -Math.sin(rad(a))];
    const tip = add2(C, e, r);
    const m = add2(C, e, r * la);
    const n = perp(e);
    return arrow(add2(C, e, 4), tip, c, 1.1) + text(m[0] + n[0] * 12, m[1] + n[1] * 12, labelSpans(label), { color: c });
  };
  if (Ri) {
    s += radiusArrow(Ri, 120, el.props.Ri, 0.6);
    s += radiusArrow(R, 225, el.props.R, 1.12);
  } else s += radiusArrow(R, 45, el.props.R, 0.62);
  const lbl = labelSpans(el.props.m) + ', ' + labelSpans(el.props.J);
  if (R > 46) s += text(C[0] + (Ri ? R * 0.1 : 0), C[1] + R * 0.6, lbl, { color: c });
  else s += text(C[0] + R * 0.75 + 8, C[1] + R * 0.85 + 6, lbl, { anchor: 'start', color: c });
  s += bodyNo(el, C[0] - R * 0.72, C[1] - R * 0.72);
  return s;
}
function drawBlock(el, V, env, d, c) {
  d = d || {};
  const a = propNum(el, 'a', env, 0.2) / 2, b = propNum(el, 'b', env, 0.1) / 2;
  const ang = ((el.angle || 0) * Math.PI) / 180 + (d.th || 0);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const cx = el.x + (d.u || 0), cy = el.y + (d.v || 0);
  const P = (i, j) => V.S(cx + ca * i - sa * j, cy + sa * i + ca * j);
  const pts = [P(-a, -b), P(a, -b), P(a, b), P(-a, b)];
  const C = V.S(cx, cy);
  let s = poly(pts, c, 1.4, 'rgba(255,255,255,0.75)', true) + text(C[0], C[1], labelSpans(el.props.m), { color: c });
  if (el.props.rot) s += text(C[0], C[1] + 16, labelSpans(el.props.J), { color: c });
  s += bodyNo(el, pts[3][0] + 7, pts[3][1] + 8);
  return s;
}
function drawRod(el, V, env, d, c) {
  d = d || {};
  const h = propNum(el, 'l', env, 0.5) / 2;
  const ang = ((el.angle || 0) * Math.PI) / 180 + (d.th || 0);
  const cx = el.x + (d.u || 0), cy = el.y + (d.v || 0);
  const e1 = V.S(cx - h * Math.cos(ang), cy - h * Math.sin(ang)), e2 = V.S(cx + h * Math.cos(ang), cy + h * Math.sin(ang));
  const t = norm([e2[0] - e1[0], e2[1] - e1[1]]), n = perp(t);
  const w = 4;
  const pts = [add2(e1, n, w), add2(e2, n, w), add2(e2, n, -w), add2(e1, n, -w)];
  const C = V.S(cx, cy);
  let s = seg(e1, e2, 'transparent', 16) + poly(pts, c, 1.3, '#fff', true);
  s += text(C[0] + n[0] * 22, C[1] + n[1] * 22, labelSpans(el.props.m) + ', ' + labelSpans(el.props.l), { color: c });
  s += bodyNo(el, C[0] - n[0] * 14, C[1] - n[1] * 14);
  return s;
}
function drawSupport(P, d, roller, c, z = Z) {
  const n = perp(d);
  const k = Math.max(0.6, Math.min(z, 1.2));
  const B = add2(P, d, 20 * k);
  let s = circ(P, 12, 'transparent', 1, 'transparent');
  s += poly([P, add2(B, n, 12 * k), add2(B, n, -12 * k)], c, 1.4, 'transparent', true);
  let G = add2(B, d, 0);
  if (roller) {
    s += seg(add2(B, n, 15 * k), add2(B, n, -15 * k), c, 1.4);
    G = add2(B, d, 5 * k);
  }
  const g1 = add2(G, n, 18 * k), g2 = add2(G, n, -18 * k);
  s += seg(g1, g2, c, 1.4) + hatch(g2, g1, d, c, 8 * k, 8 * k);
  s += circ(P, 4, c, 1.4, '#fff');
  return s;
}
function zigzag(a, b, amp = 7, turns = 4) {
  const u = norm([b[0] - a[0], b[1] - a[1]]), n = perp(u);
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const pts = [a];
  const N = turns * 2;
  for (let i = 1; i < N; i++) pts.push(add2(add2(a, u, (L * i) / N), n, (i % 2 ? 1 : -1) * amp));
  pts.push(b);
  return pts;
}
function springPath(P, Q, c) {
  const L = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
  const u = norm([Q[0] - P[0], Q[1] - P[1]]);
  const coil = Math.min(L * 0.55, 80 * Z), s0 = (L - coil) / 2;
  const a = add2(P, u, s0), b = add2(P, u, s0 + coil);
  return seg(P, a, c) + poly(zigzag(a, b, 8 * Z, 4), c, 1.3) + seg(b, Q, c);
}
function damperPath(P, Q, c) {
  const L = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
  const u = norm([Q[0] - P[0], Q[1] - P[1]]), n = perp(u);
  const cl = Math.min(30 * Z, L * 0.45), h = 10 * Z;
  const c0 = add2(P, u, (L - cl) / 2);
  let s = seg(P, c0, c);
  s += poly([add2(add2(c0, u, cl), n, h), add2(c0, n, h), add2(c0, n, -h), add2(add2(c0, u, cl), n, -h)], c, 1.3);
  const p0 = add2(c0, u, cl * 0.45);
  s += seg(add2(p0, n, h * 0.7), add2(p0, n, -h * 0.7), c, 1.6) + seg(p0, Q, c);
  return s;
}
function drawLine(el, P, Q, c) {
  const L = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
  const u = norm([Q[0] - P[0], Q[1] - P[1]]), n = perp(u);
  const mid = add2(P, u, L / 2);
  const lab = (k, off) => text(mid[0] + n[0] * off, mid[1] + n[1] * off, labelSpans(k), { color: c });
  switch (el.type) {
    case 'rope': return seg(P, Q, c, 1.3);
    case 'spring': return springPath(P, Q, c) + lab(el.props.k, 22 * Z);
    case 'damper': return damperPath(P, Q, c) + lab(el.props.d, -22 * Z);
    case 'springdamper': {
      const h = 24 * Z, lead = Math.min(L * 0.22, 40 * Z);
      const b1 = add2(P, u, lead), b2 = add2(Q, u, -lead);
      let s = seg(P, b1, c) + seg(b2, Q, c);
      s += seg(add2(b1, n, h), add2(b1, n, -h), c) + seg(add2(b2, n, h), add2(b2, n, -h), c);
      s += damperPath(add2(b1, n, -h), add2(b2, n, -h), c) + springPath(add2(b1, n, h), add2(b2, n, h), c);
      const m = add2(P, u, L / 2);
      s += text(m[0] - n[0] * (h + 20 * Z), m[1] - n[1] * (h + 20 * Z), labelSpans(el.props.d), { color: c });
      s += text(m[0] + n[0] * (h + 20 * Z), m[1] + n[1] * (h + 20 * Z), labelSpans(el.props.k), { color: c });
      return s;
    }
  }
  return '';
}
function drawTorsion(el, C, T, c) {
  let s = '';
  const pts = [];
  for (let i = 0; i <= 60; i++) {
    const a = (i / 60) * Math.PI * 3.5;
    const r = 4 + (i / 60) * 11;
    pts.push([C[0] + r * Math.cos(a), C[1] - r * Math.sin(a)]);
  }
  const end = pts[pts.length - 1];
  if (el.type === 'tspring') s += poly(pts, c, 1.2);
  else {
    s += arcPath(C, 10, 200, 340, c, 1.2, false) + arcPath(C, 15, 200, 340, c, 1.2, false);
    s += seg([C[0] - 15, C[1] + 6], [C[0] - 10, C[1] + 4], c, 1.2);
  }
  const start = el.type === 'tspring' ? end : [C[0] + 15 * Math.cos(Math.PI * 1.9), C[1] - 15 * Math.sin(Math.PI * 1.9)];
  if (T) s += seg(start, T, c, 1.1, ' stroke-dasharray="3 3"');
  else {
    const g = [start[0] + 14, start[1] + 16];
    s += seg(start, g, c, 1.2) + seg([g[0] - 9, g[1]], [g[0] + 9, g[1]], c, 1.4) + hatch([g[0] - 9, g[1]], [g[0] + 9, g[1]], [0, 1], c, 6, 6);
  }
  s += text(C[0] - 22, C[1] - 18, labelSpans(el.type === 'tspring' ? el.props.kt : el.props.dt), { color: c });
  return s;
}

/** Kleine Symbole für die Palette */
export function paletteIcon(tool) {
  const c = INK;
  Z = 1;
  const W = (inner) => `<svg viewBox="0 0 40 30" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
  switch (tool) {
    case 'select': return W(`<path d="M13 4 L13 24 L18 19 L22 27 L25 26 L21 18 L28 18 Z" fill="#fff" stroke="${c}" stroke-width="1.4" stroke-linejoin="round"/>`);
    case 'delete': return W(`<path d="M12 8h16M17 8V5h6v3M14 8l1 18h10l1-18" fill="none" stroke="#b42318" stroke-width="1.5"/>`);
    case 'block': return W(poly([[9, 8], [31, 8], [31, 23], [9, 23]], c, 1.4, '#fff', true) + text(20, 16, 'm'));
    case 'disk': return W(circ([20, 15], 11, c) + circ([20, 15], 2, c, 1.2, '#fff'));
    case 'stepdisk': return W(circ([20, 15], 12, c) + circ([20, 15], 6, c) + circ([20, 15], 1.6, c, 1, '#fff'));
    case 'rod': return W(poly([[7, 24], [33, 6], [35, 9], [9, 27]], c, 1.3, '#fff', true));
    case 'point': return W(circ([20, 15], 5, c, 1.4, c));
    case 'node': return W(springPath([2, 15], [18, 15], c) + springPath([22, 15], [38, 15], c) + circ([20, 15], 3, c, 1.2, c));
    case 'ground': return W(seg([4, 14], [36, 14], c, 1.6) + hatch([4, 14], [36, 14], [0, 1], c, 6, 7));
    case 'curve': return W('<path d="M4 6 A17 17 0 0 0 36 6" fill="none" stroke="' + c + '" stroke-width="1.6"/>' + [[8, 13], [14, 18], [20, 20], [26, 18], [32, 13]].map(([x, y]) => seg([x, y], [x - 3, y + 5], c, 1)).join(''));
    case 'fix': return W(seg([16, 5], [16, 25], c, 1.8) + hatch([16, 25], [16, 5], [-1, 0], c, 5, 6) + seg([16, 15], [34, 15], c, 1.2));
    case 'pin': return W(drawSupport([20, 6], [0, 1], false, c, 1));
    case 'roller': return W(drawSupport([20, 5], [0, 1], true, c, 1));
    case 'hinge': return W(seg([6, 22], [20, 12], c, 1.3) + seg([20, 12], [34, 22], c, 1.3) + circ([20, 12], 4, c, 1.4, '#fff'));
    case 'roll': return W(circ([20, 13], 9, c) + seg([4, 22], [36, 22], c, 1.4) + hatch([4, 22], [36, 22], [0, 1], c, 6, 5) + arcPath([20, 13], 13, 140, 60, c, 1, true));
    case 'slide': return W(poly([[12, 8], [28, 8], [28, 20], [12, 20]], c, 1.3, '#fff', true) + seg([4, 21], [36, 21], c, 1.4) + hatch([4, 21], [36, 21], [0, 1], c, 6, 5));
    case 'rope': return W(seg([4, 15], [36, 15], c, 1.4));
    case 'spring': return W(springPath([3, 15], [37, 15], c));
    case 'damper': return W(damperPath([3, 15], [37, 15], c));
    case 'springdamper': return W(seg([3, 15], [9, 15], c) + seg([31, 15], [37, 15], c) + seg([9, 6], [9, 24], c) + seg([31, 6], [31, 24], c) + damperPath([9, 6], [31, 6], c) + springPath([9, 24], [31, 24], c));
    case 'tspring': return W(drawTorsion({ type: 'tspring', props: {} }, [17, 14], null, c));
    case 'tdamper': return W(drawTorsion({ type: 'tdamper', props: {} }, [17, 14], null, c));
    case 'force': return W(arrow([6, 15], [34, 15], c, 1.8));
    case 'moment': return W(arcPath([20, 17], 10, -20, 200, c, 1.6));
  }
  return W('');
}

export { hasRotation, TYPES, isLine };
