// Aufbau des mechanischen Modells aus der Zeichnung:
// Körperkoordinaten (Verschiebungen x, y und Verdrehung ϑ gegenüber der gezeichneten Lage),
// Bindungsgleichungen, Federn/Dämpfer, Lasten.
import { sym, num, add, mul, pow, MONE, ZERO, ONE, sqrt, simplify, sqrtsimp, evalNum, cos, sin } from '../cas/expr.js';
import { paramNames } from '../cas/parse.js';
import { TYPES, isBody, isLine, hasRotation, propExpr, propNum, ports, exactTrig, rot, portWorld, defaultParamValue } from './elements.js';

export function dotTex(tex, n) {
  const acc = n === 1 ? '\\dot' : '\\ddot';
  const m = /^(\\[a-zA-Z]+|[A-Za-z])(.*)$/.exec(tex);
  if (!m) return acc + '{' + tex + '}';
  return acc + '{' + m[1] + '}' + m[2];
}
export function makeCoord(name, tex, order) {
  const s = sym(name, { kind: 'coord', latex: tex, order, pos: false });
  const d = sym(name + '__d', { kind: 'vel', latex: dotTex(tex, 1), order, pos: false });
  const dd = sym(name + '__dd', { kind: 'acc', latex: dotTex(tex, 2), order, pos: false });
  return { name, tex, s, d, dd };
}

/** Alle Parameter-Namen, die in den Elementen vorkommen */
export function usedParams(sys) {
  const names = new Set();
  const errors = [];
  for (const el of sys.elements) {
    for (const [k, v] of Object.entries(el.props || {})) {
      if (v === '' || v === undefined || v === null || typeof v === 'boolean') continue;
      try { for (const n of paramNames(propExpr(el, k))) names.add(n); } catch (e) { errors.push(e.message); }
    }
  }
  if (sys.gravity) names.add('g');
  return { names: [...names].sort(), errors };
}
export function ensureParams(sys) {
  const { names } = usedParams(sys);
  sys.params = sys.params || {};
  for (const n of names) if (sys.params[n] === undefined) sys.params[n] = defaultParamValue(n);
  return names;
}
export function paramEnv(sys) {
  const env = {};
  for (const [k, v] of Object.entries(sys.params || {})) env[k] = Number(v);
  env.pi = Math.PI;
  return env;
}

/** Reihenschaltungen über masselose Knoten zu Ersatzelementen zusammenfassen.
 *  Liefert { skip: Set(Linien-IDs), lines: [Ersatzelemente], series: [Info], warnings, errors } */
export function resolveSeries(sys, env) {
  const byId = new Map(sys.elements.map((e) => [e.id, e]));
  const isNode = (ref) => ref?.el && byId.get(ref.el)?.type === 'node';
  const lines = sys.elements.filter((e) => isLine(e));
  const atNode = new Map();
  for (const l of lines) for (const k of ['a', 'b']) if (isNode(l[k])) {
    if (!atNode.has(l[k].el)) atNode.set(l[k].el, []);
    atNode.get(l[k].el).push({ l, k });
  }
  const out = { skip: new Set(), lines: [], series: [], warnings: [] };
  const used = new Set();
  const wrap = (x) => '(' + x + ')';
  for (const l0 of lines) {
    if (used.has(l0.id) || (!isNode(l0.a) && !isNode(l0.b))) continue;
    // Kette in beide Richtungen verfolgen
    const chain = [l0];
    used.add(l0.id);
    let ok = true;
    const walk = (line, endKey, pushFront) => {
      let ref = line[endKey];
      let cur = line;
      while (isNode(ref)) {
        const list = atNode.get(ref.el) || [];
        if (list.length !== 2) {
          ok = false;
          out.warnings.push(list.length === 1
            ? 'Knoten mit nur einem angeschlossenen Element: ' + TYPES[cur.type].name + ' hat damit ein freies Ende und überträgt keine Kraft.'
            : 'Knoten mit ' + list.length + ' Elementen wird nicht unterstützt (nur zwei Elemente in Reihe). Die Elemente werden ignoriert.');
          return null;
        }
        const nxt = list.find((x) => x.l !== cur);
        if (!nxt || used.has(nxt.l.id)) { ok = false; return null; }
        used.add(nxt.l.id);
        pushFront ? chain.unshift(nxt.l) : chain.push(nxt.l);
        const farKey = nxt.k === 'a' ? 'b' : 'a';
        ref = nxt.l[farKey];
        cur = nxt.l;
      }
      return ref;
    };
    const endB = walk(l0, 'b', false);
    const endA = walk(l0, 'a', true);
    for (const c of chain) out.skip.add(c.id);
    if (!ok) continue;
    if (!endA?.el || !endB?.el) { out.warnings.push('Reihenschaltung ' + chain.map((c) => TYPES[c.type].name).join(' – ') + ' hat ein freies Ende und überträgt keine Kraft.'); continue; }
    // Art der Ersatzschaltung
    const ks = chain.filter((c) => c.type === 'spring').map((c) => c.props.k);
    const ds = chain.filter((c) => c.type === 'damper').map((c) => c.props.d);
    const sd = chain.filter((c) => c.type === 'springdamper');
    const label = chain.map((c) => c.props.k || c.props.d || 'Seil').join(' – ');
    if ((ks.length && ds.length) || sd.length > 1 || (sd.length && (ks.length || ds.length))) {
      throw new Error('Reihenschaltung ' + label + ': Feder und Dämpfer in Reihe (Maxwell-Element) besitzen einen inneren Freiheitsgrad und werden nicht unterstützt.');
    }
    const seriesOf = (list) => {
      if (list.length === 1) return list[0];
      const prod = list.map(wrap).join('*');
      const sum = list.map((_, j) => list.filter((__, i) => i !== j).map(wrap).join('*')).join('+');
      return prod + '/(' + sum + ')';
    };
    const L0 = chain.map((c) => wrap(c.props.L0)).join('+');
    let el;
    if (sd.length) el = { type: 'springdamper', props: { k: sd[0].props.k, d: sd[0].props.d, L0 } };
    else if (ks.length) el = { type: 'spring', props: { k: seriesOf(ks), L0 } };
    else if (ds.length) el = { type: 'damper', props: { d: seriesOf(ds), L0 } };
    else el = { type: 'rope', props: { L0 } };
    // Knoten müssen auf der Verbindungslinie liegen
    const A = portWorld(byId.get(endA.el), endA.port, env), B = portWorld(byId.get(endB.el), endB.port, env);
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    for (const c of chain) for (const k of ['a', 'b']) if (isNode(c[k])) {
      const n = byId.get(c[k].el);
      const dist = Math.abs((B[0] - A[0]) * (A[1] - n.y) - (A[0] - n.x) * (B[1] - A[1])) / len;
      if (dist > 0.01 * len + 1e-4) throw new Error('Reihenschaltung ' + label + ': Der Knoten muss auf der Verbindungslinie der äußeren Enden liegen (ein masseloser Knoten stellt sich gerade ein).');
    }
    Object.assign(el, { id: 'ser_' + chain[0].id, a: endA, b: endB, label: '(Reihe ' + label + ')', chain });
    out.lines.push(el);
    out.series.push({ chain, el });
  }
  return out;
}

/** Kreisförmige Gleitbahn: Mittelpunkt (Welt), Winkel β des Gleitpunkts (Grad), ggf. zugehörige Kreisbahn */
export function circleTrackInfo(sys, el, env) {
  const B = sys.elements.find((e) => e.id === el.at?.el);
  const P = B ? portWorld(B, el.at.port, env) : [0, 0];
  const curve = el.curveRef ? sys.elements.find((e) => e.id === el.curveRef) : null;
  let C, beta;
  if (curve) {
    C = [curve.x, curve.y];
    beta = (Math.atan2(P[1] - C[1], P[0] - C[0]) * 180) / Math.PI;
  } else {
    // Kreis berührt die Bahntangente im Gleitpunkt; Mittelpunkt auf der Seite side·n
    const rhoN = propNum(el, 'rho', env, 0.3);
    const a = ((el.angle ?? -90) * Math.PI) / 180, s = el.side === -1 ? -1 : 1;
    C = [P[0] + s * rhoN * Math.cos(a), P[1] + s * rhoN * Math.sin(a)];
    beta = (el.angle ?? -90) + (s === 1 ? 180 : 0);
  }
  return { C, beta, P, curve, rhoN: curve ? propNum(curve, 'rho', env, 0.5) : propNum(el, 'rho', env, 0.3) };
}

/** Gleitet eine Punktmasse auf einer Kreisbahn? (dann ist der Bahnwinkel eine Koordinate) */
export function pointOnCurve(sys, el, onlyIfChosen = true) {
  if (el.type !== 'point') return false;
  const on = sys.elements.some((c) => c.type === 'contact' && c.body === el.id && sys.elements.find((g) => g.id === c.ground)?.type === 'curve');
  if (!on || !onlyIfChosen) return on;
  // Bahnwinkel nur als Koordinate führen, wenn er gewählt ist (oder noch nichts gewählt ist → Vorschlag),
  // sonst bleibt z. B. x als Freiheitsgrad geschlossen auflösbar
  const dofs = sys.dofs || [];
  return !dofs.some((d) => d.body === el.id) || dofs.some((d) => d.body === el.id && d.coord === 'phi');
}

const angleDeg = (a, b) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;

export function buildModel(sys) {
  const env = paramEnv(sys);
  const byId = new Map(sys.elements.map((e) => [e.id, e]));
  const bodies = [];
  const bodyOf = new Map();
  let idx = 0;
  for (const el of sys.elements) {
    if (!isBody(el)) continue;
    idx++;
    const lab = el.label || String(idx);
    const o = idx * 10;
    // Punktmasse auf Kreisbahn: Bahnwinkel ψ als zusätzliche Lagekoordinate (ohne Drehträgheit)
    const onCurve = pointOnCurve(sys, el);
    const b = {
      el, label: lab,
      // masselose Stäbe: keine Masse/Trägheit – tauchen in T, U_G und den Gleichungen nicht auf
      m: el.massless ? ZERO : propExpr(el, 'm'),
      J: hasRotation(el) ? (el.massless ? ZERO : propExpr(el, 'J')) : onCurve ? ZERO : null,
      massless: !!el.massless,
      X: makeCoord('X_' + el.id, 'x_{' + lab + '}', o + 1),
      Y: makeCoord('Y_' + el.id, 'y_{' + lab + '}', o + 2),
      TH: hasRotation(el) ? makeCoord('T_' + el.id, '\\vartheta_{' + lab + '}', o + 3) : onCurve ? makeCoord('T_' + el.id, '\\psi_{' + lab + '}', o + 3) : null,
      pathAngle: onCurve,
    };
    bodies.push(b);
    bodyOf.set(el.id, b);
  }
  const absCoords = [];
  for (const b of bodies) { absCoords.push(b.X, b.Y); if (b.TH) absCoords.push(b.TH); }
  // Gleitbahnen: Verschiebung des Gleitpunkts entlang der Bahn als zusätzliche Koordinate,
  // sofern sie als Freiheitsgrad gewählt ist
  const trackCoords = new Map();
  let ti = 0;
  for (const el of sys.elements) {
    if (el.type !== 'roller' || !el.track) continue;
    ti++;
    if (!(sys.dofs || []).some((d) => d.body === el.id && d.coord === 's')) continue;
    const c = makeCoord('S_' + el.id, el.circle ? '\\psi_{B' + ti + '}' : 's_{' + ti + '}', 900 + ti);
    c.track = el;
    trackCoords.set(el.id, c);
    absCoords.push(c);
  }

  const refEnv = { ...env };
  for (const c of absCoords) { refEnv[c.s.name] = 0; refEnv[c.d.name] = 0; refEnv[c.dd.name] = 0; }

  const elName = (el) => {
    if (el.track) { const b = byId.get(el.at?.el); return 'Gleitbahn' + (b?.label ? ' Körper ' + b.label : ''); }
    if (el.guide) { const b = byId.get(el.at?.el); return 'Führung' + (b?.label ? ' Körper ' + b.label : ''); }
    return TYPES[el.type].name + (el.label ? ' ' + el.label : '');
  };
  const anchor = (ref) => {
    const el = byId.get(ref?.el);
    if (!el) throw new Error('Ein Element ist nicht (mehr) verbunden.');
    if (el.type === 'fix') return { el, body: null, port: { id: 'c', s: [ZERO, ZERO], w: [0, 0], rim: null } };
    const body = bodyOf.get(el.id);
    if (!body) throw new Error('Anschluss an ' + elName(el) + ' nicht möglich.');
    const p = ports(el, env).find((x) => x.id === ref.port);
    if (!p) throw new Error('Anschlusspunkt „' + ref.port + '“ an Körper ' + body.label + ' existiert nicht.');
    return { el, body, port: p };
  };
  // exakte Verschiebung eines körperfesten Punktes mit Versatz s
  const disp = (body, s) => {
    if (!body) return [ZERO, ZERO];
    if (!body.TH) return [body.X.s, body.Y.s];
    const th = body.TH.s;
    const r = rot(s, [cos(th), sin(th)]);
    return [add(body.X.s, r[0], mul(MONE, s[0])), add(body.Y.s, r[1], mul(MONE, s[1]))];
  };
  const worldOf = (a) => portWorld(a.el, a.port.id, env);

  const cons = [];
  const springs = [], dampers = [], tsprings = [], tdampers = [], loads = [], moments = [];
  const lineInfo = new Map();
  const warnings = [];

  /** Kontakt mit einer Kreisbahn (Mulde: Körper innen, Kuppe: Körper außen) */
  function curveContact(el, b, g, nm) {
    if (b.el.type !== 'disk' && b.el.type !== 'point') throw new Error(nm + ': Auf einer Kreisbahn können nur Scheiben und Punktmassen laufen.');
    const rho = propExpr(g, 'rho');
    const rhoN = propNum(g, 'rho', env, 0.5);
    const dx = b.el.x - g.x, dy = b.el.y - g.y;
    const sIn = Math.hypot(dx, dy) < rhoN ? 1 : -1; // +1: innen (Mulde)
    const R = b.el.type === 'disk' ? propExpr(b.el, 'R') : ZERO;
    const rc = add(rho, mul(-sIn, R)); // Bahnradius des Schwerpunkts
    const beta = (Math.atan2(dy, dx) * 180) / Math.PI;
    const [cb, sb] = exactTrig(beta, 0.5);
    if (b.pathAngle) {
      // Punktmasse: Lage über den Bahnwinkel ψ (Auslenkung aus der gezeichneten Lage β)
      const c = cos(b.TH.s), sn = sin(b.TH.s);
      cons.push({ expr: add(b.X.s, mul(MONE, rc, add(mul(cb, c), mul(MONE, sb, sn), mul(MONE, cb)))), label: nm + ' (auf Kreisbahn, x)', el });
      cons.push({ expr: add(b.Y.s, mul(MONE, rc, add(mul(sb, c), mul(cb, sn), mul(MONE, sb)))), label: nm + ' (auf Kreisbahn, y)', el });
    } else if (el.mode === 'roll') {
      if (b.el.type !== 'disk') throw new Error('Rollen ohne Gleiten ist nur für Scheiben möglich.');
      // Rollbedingung integriert: Bahnwinkel ψ − β = −s·R·ϑ / r_c
      const dpsi = mul(-sIn, R, b.TH.s, pow(rc, MONE));
      const c = cos(dpsi), sn = sin(dpsi);
      cons.push({ expr: add(b.X.s, mul(MONE, rc, add(mul(cb, c), mul(MONE, sb, sn), mul(MONE, cb)))), label: nm + ' (Rollen auf Kreisbahn, x)', el });
      cons.push({ expr: add(b.Y.s, mul(MONE, rc, add(mul(sb, c), mul(cb, sn), mul(MONE, sb)))), label: nm + ' (Rollen auf Kreisbahn, y)', el });
    } else {
      const ex = add(pow(add(mul(rc, cb), b.X.s), 2), pow(add(mul(rc, sb), b.Y.s), 2), mul(MONE, pow(rc, 2)));
      cons.push({ expr: simplify(ex), label: nm + ' (auf Kreisbahn)', el });
    }
  }

  function elongation(el) {
    const A = anchor(el.a), B = anchor(el.b);
    if (A.body && B.body && A.body === B.body) throw new Error(elName(el) + ': beide Enden am selben Körper.');
    const pa = worldOf(A), pb = worldOf(B);
    const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    if (len < 1e-6) throw new Error(elName(el) + ': Länge null – Enden liegen aufeinander.');
    const ang = angleDeg(pa, pb);
    const e = exactTrig(ang, 1.0);
    const en = [Math.cos((ang * Math.PI) / 180), Math.sin((ang * Math.PI) / 180)];
    const L0 = propExpr(el, 'L0');
    const part = (X) => {
      if (!X.body) return { d: [ZERO, ZERO], w: ZERO, wound: false };
      const p = X.port;
      let wound = false;
      if (p.rim && X.body.TH) {
        const rn = Math.hypot(p.w[0], p.w[1]) || 1;
        const c = (p.w[0] * en[0] + p.w[1] * en[1]) / rn;
        wound = Math.abs(c) < 0.15;
      }
      if (wound) {
        // aufgewickeltes Seil: Tangentenpunkt verschiebt sich mit dem Mittelpunkt, Abwickeln = R·ϑ
        const zs = [mul(MONE, p.s[1]), p.s[0]];
        const w = mul(add(mul(e[0], zs[0]), mul(e[1], zs[1])), X.body.TH.s);
        return { d: [X.body.X.s, X.body.Y.s], w, wound: true };
      }
      return { d: disp(X.body, p.s), w: ZERO, wound: false };
    };
    const a = part(A), b = part(B);
    // Länge in der Zeichnung: standardmäßig entspannt (= l₀), bei Vorspannung eigene Angabe
    const Ld = el.props.Lz !== undefined && String(el.props.Lz).trim() ? propExpr(el, 'Lz') : L0;
    const dx = add(mul(Ld, e[0]), b.d[0], mul(MONE, a.d[0]));
    const dy = add(mul(Ld, e[1]), b.d[1], mul(MONE, a.d[1]));
    let dL = add(sqrt(add(pow(dx, 2), pow(dy, 2))), mul(MONE, L0), b.w, mul(MONE, a.w));
    dL = simplify(sqrtsimp(simplify(dL), refEnv));
    const infoL = { A, B, e, ang, wound: [a.wound, b.wound], L0, dx, dy };
    lineInfo.set(el.id, infoL);
    return dL;
  }

  const ser = resolveSeries(sys, env);
  warnings.push(...ser.warnings);
  const series = ser.series;
  for (const el of [...sys.elements.filter((e) => !ser.skip.has(e.id)), ...ser.lines]) {
    const nm = elName(el);
    switch (el.type) {
      case 'pin': {
        const A = anchor(el.at);
        if (!A.body) throw new Error('Festlager muss an einem Körper sitzen.');
        const d = disp(A.body, A.port.s);
        cons.push({ expr: d[0], label: nm + ' (horizontal)', el });
        cons.push({ expr: d[1], label: nm + ' (vertikal)', el });
        break;
      }
      case 'roller': {
        const A = anchor(el.at);
        if (!A.body) throw new Error('Loslager muss an einem Körper sitzen.');
        const d = disp(A.body, A.port.s);
        if (el.track && el.circle) {
          // kreisförmige Gleitbahn: Gleitpunkt bleibt im Abstand ρ vom Mittelpunkt
          const ci = circleTrackInfo(sys, el, env);
          const rho = ci.curve ? propExpr(ci.curve, 'rho') : propExpr(el, 'rho');
          const [cb, sb] = exactTrig(ci.beta, 0.5);
          const sc = trackCoords.get(el.id);
          if (sc) {
            // Bahnwinkel ψ (gegen den Uhrzeigersinn) als Koordinate
            const c = cos(sc.s), sn = sin(sc.s);
            cons.push({ expr: add(d[0], mul(MONE, rho, add(mul(cb, c), mul(MONE, sb, sn), mul(MONE, cb)))), label: nm + ' (auf Kreisbahn, x)', el });
            cons.push({ expr: add(d[1], mul(MONE, rho, add(mul(sb, c), mul(cb, sn), mul(MONE, sb)))), label: nm + ' (auf Kreisbahn, y)', el });
          } else {
            cons.push({ expr: simplify(add(pow(add(mul(rho, cb), d[0]), 2), pow(add(mul(rho, sb), d[1]), 2), mul(MONE, pow(rho, 2)))), label: nm + ' (auf Kreisbahn)', el });
          }
          break;
        }
        const n = exactTrig((el.angle ?? -90));
        cons.push({ expr: add(mul(n[0], d[0]), mul(n[1], d[1])), label: nm, el });
        const sc = trackCoords.get(el.id);
        // Bahnrichtung t = n um −90° gedreht: s = t · Verschiebung des Gleitpunkts
        if (sc) cons.push({ expr: add(sc.s, mul(MONE, add(mul(n[1], d[0]), mul(MONE, n[0], d[1])))), label: nm + ' (Weg entlang der Bahn)', el });
        break;
      }
      case 'hinge': {
        const A = anchor(el.a), B = anchor(el.b);
        const da = disp(A.body, A.port.s), db = disp(B.body, B.port.s);
        cons.push({ expr: add(da[0], mul(MONE, db[0])), label: nm + ' (x)', el });
        cons.push({ expr: add(da[1], mul(MONE, db[1])), label: nm + ' (y)', el });
        break;
      }
      case 'contact': {
        const b = bodyOf.get(el.body), g = byId.get(el.ground);
        if (!b || !g) throw new Error(nm + ': Körper oder Boden fehlt.');
        if (g.type === 'curve') { curveContact(el, b, g, nm); break; }
        const tr = exactTrig(g.angle || 0);
        const t = tr, n = [mul(MONE, tr[1]), tr[0]];
        const ga = ((g.angle || 0) * Math.PI) / 180;
        const side = (-Math.sin(ga) * (b.el.x - g.x) + Math.cos(ga) * (b.el.y - g.y)) >= 0 ? 1 : -1;
        cons.push({ expr: add(mul(n[0], b.X.s), mul(n[1], b.Y.s)), label: nm + ' (Normalrichtung)', el });
        if (el.mode === 'roll') {
          if (b.el.type !== 'disk') throw new Error('Rollen ohne Gleiten ist nur für Scheiben möglich.');
          const R = propExpr(b.el, 'R');
          cons.push({ expr: add(mul(t[0], b.X.s), mul(t[1], b.Y.s), mul(side, R, b.TH.s)), label: nm + ' (Rollen ohne Gleiten)', el });
        } else if (b.TH && b.el.type === 'block') {
          cons.push({ expr: b.TH.s, label: nm + ' (keine Verdrehung)', el });
        }
        break;
      }
      case 'rope': case 'spring': case 'damper': case 'springdamper': {
        if (!el.a?.el || !el.b?.el) {
          warnings.push(nm + ' hat ein freies Ende und überträgt deshalb keine Kraft – Ende an einen Körper anschließen oder ein Lager setzen.');
          break;
        }
        const dL = elongation(el);
        if (el.type === 'rope') cons.push({ expr: dL, label: nm + ' (Seillänge konstant)', el, line: el });
        if (el.type === 'spring' || el.type === 'springdamper') springs.push({ el, k: propExpr(el, 'k'), dL });
        if (el.type === 'damper' || el.type === 'springdamper') dampers.push({ el, d: propExpr(el, 'd'), dL });
        break;
      }
      case 'tspring': case 'tdamper': {
        const A = bodyOf.get(el.a), B = el.b ? bodyOf.get(el.b) : null;
        if (!A || !A.TH || (el.b && (!B || !B.TH))) throw new Error(nm + ': nur zwischen drehbaren Körpern (bzw. Körper und Umgebung).');
        const rel = B ? add(A.TH.s, mul(MONE, B.TH.s)) : A.TH.s;
        if (el.type === 'tspring') tsprings.push({ el, k: propExpr(el, 'kt'), rel });
        else tdampers.push({ el, d: propExpr(el, 'dt'), rel });
        break;
      }
      case 'force': {
        const A = anchor(el.at);
        if (!A.body) throw new Error('Kraft muss an einem Körper angreifen.');
        const F = propExpr(el, 'F');
        const dir = exactTrig(el.angle ?? 0);
        loads.push({ el, F, dir, Fv: [mul(F, dir[0]), mul(F, dir[1])], d: disp(A.body, A.port.s), body: A.body });
        break;
      }
      case 'moment': {
        const b = bodyOf.get(el.body);
        if (!b || !b.TH) throw new Error('Moment nur an drehbaren Körpern.');
        const M = mul(el.dir === -1 ? MONE : ONE, propExpr(el, 'M'));
        moments.push({ el, M, th: b.TH.s, body: b });
        break;
      }
    }
  }

  const g = sys.gravity ? sym('g', { kind: 'param', latex: 'g', pos: true }) : null;
  const Ug = g ? add(...bodies.map((b) => mul(b.m, g, b.Y.s))) : ZERO;
  const Us = add(...springs.map((s) => mul(num(1, 2), s.k, pow(s.dL, 2))));
  const Ut = add(...tsprings.map((s) => mul(num(1, 2), s.k, pow(s.rel, 2))));
  const U = add(Ug, Us, Ut);

  return { sys, env, refEnv, warnings, series, bodies, bodyOf, trackCoords, absCoords, cons, springs, dampers, tsprings, tdampers, loads, moments, g, U, Ug, lineInfo, elName };
}

/** Numerische Jacobi-Matrix der Bindungen in der Bezugslage */
export function numericJacobian(model, exprs, coords) {
  return exprs.map((e) => coords.map((c) => {
    try { return evalNum(diffAt(e, c.s), model.refEnv); } catch { return NaN; }
  }));
}
import { diff } from '../cas/expr.js';
function diffAt(e, s) { return diff(e, s); }
