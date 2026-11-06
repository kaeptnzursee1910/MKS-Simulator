// Validierung: Programm-Ergebnisse gegen handgerechnete Lehrbuch-Bewegungsgleichungen.
// Referenzgleichungen in den Freiheitsgraden Q1, Q2 (Geschwindigkeit Q1d, Beschleunigung Q1dd).
// Geprüft wird (a) symbolische Identität (L2, DAL) und (b) gleiche Beschleunigungen q̈ in zufälligen Zuständen (alle Methoden).
import { derive } from '../js/mech/derive.js';
import { compile } from '../js/mech/numeric.js';
import { paramEnv, ensureParams } from '../js/mech/model.js';
import { parse } from '../js/cas/parse.js';
import { subs, simplify, isZero, diff, evalNum, add, mul, MONE, ZERO } from '../js/cas/expr.js';
import { solveDense } from '../js/mech/linalg.js';

const ground = (x, y, angle = 0, len = 1.6) => ({ id: 'g' + x + y, type: 'ground', x, y, angle, len });
const CASES = [
  {
    name: 'Zweimassenschwinger (Wand–k₁–m₁–k₂–m₂–d–Wand)',
    modes: ['linear', 'nonlinear'],
    sys: {
      elements: [
        ground(0.5, 0),
        { id: 'w1', type: 'fix', x: -0.1, y: 0.06, angle: 0 },
        { id: 'w2', type: 'fix', x: 1.0, y: 0.06, angle: 180 },
        { id: 'b1', type: 'block', label: '1', x: 0.2, y: 0.06, props: { m: 'm_1', a: '0.2', b: '0.12', rot: false } },
        { id: 'b2', type: 'block', label: '2', x: 0.6, y: 0.06, props: { m: 'm_2', a: '0.2', b: '0.12', rot: false } },
        { id: 'c1', type: 'contact', body: 'b1', ground: 'g0.50', mode: 'slide' },
        { id: 'c2', type: 'contact', body: 'b2', ground: 'g0.50', mode: 'slide' },
        { id: 's1', type: 'spring', a: { el: 'w1', port: 'c' }, b: { el: 'b1', port: 'l' }, props: { k: 'k_1', L0: '0.2' } },
        { id: 's2', type: 'spring', a: { el: 'b1', port: 'r' }, b: { el: 'b2', port: 'l' }, props: { k: 'k_2', L0: '0.2' } },
        { id: 'd1', type: 'damper', a: { el: 'b2', port: 'r' }, b: { el: 'w2', port: 'c' }, props: { d: 'd', L0: '0.3' } },
      ],
      params: { m_1: 1.3, m_2: 0.7, k_1: 300, k_2: 150, d: 3, g: 9.81 }, gravity: true,
      dofs: [{ id: 'q1', body: 'b1', coord: 'x', dir: 1, name: 'x_1' }, { id: 'q2', body: 'b2', coord: 'x', dir: 1, name: 'x_2' }],
    },
    ref: ['m_1*Q1dd + (k_1 + k_2)*Q1 - k_2*Q2', 'm_2*Q2dd - k_2*Q1 + k_2*Q2 + d*Q2d'],
  },
  {
    name: 'Physikalisches Pendel (Steiner: J_S + m l²/4)',
    modes: ['nonlinear'],
    sys: {
      elements: [
        { id: 'b1', type: 'rod', label: '1', x: 0, y: 0, angle: 90, props: { m: 'm', J: 'J', l: 'l' } },
        { id: 'p1', type: 'pin', at: { el: 'b1', port: 'e2' }, angle: 90 },
      ],
      params: { m: 1.2, J: 0.03, l: 0.6, g: 9.81 }, gravity: true,
      dofs: [{ id: 'q1', body: 'b1', coord: 'phi', dir: 1, name: 'phi' }],
    },
    ref: ['(J + m*l^2/4)*Q1dd + m*g*l/2*sin(Q1)'],
    refLin: ['(J + m*l^2/4)*Q1dd + m*g*l/2*Q1'],
  },
  {
    name: 'Pendel mit Feder am unteren Ende (linearisiert)',
    modes: ['linear'],
    sys: {
      elements: [
        { id: 'b1', type: 'rod', label: '1', x: 0, y: 0, angle: 90, props: { m: 'm', J: 'J', l: 'l' } },
        { id: 'p1', type: 'pin', at: { el: 'b1', port: 'e2' }, angle: 90 },
        { id: 'w1', type: 'fix', x: 0.3, y: -0.25, angle: 180 },
        { id: 's1', type: 'spring', a: { el: 'b1', port: 'e1' }, b: { el: 'w1', port: 'c' }, props: { k: 'k', L0: '0.3' } },
      ],
      params: { m: 1.2, J: 0.025, l: 0.5, k: 80, g: 9.81 }, gravity: true,
      dofs: [{ id: 'q1', body: 'b1', coord: 'phi', dir: 1, name: 'phi' }],
    },
    ref: ['(J + m*l^2/4)*Q1dd + (m*g*l/2 + k*l^2)*Q1'],
  },
  {
    name: 'Rollende Scheibe auf schiefer Ebene (30°)',
    modes: ['linear', 'nonlinear'],
    sys: {
      elements: [
        { id: 'g1', type: 'ground', x: 0, y: 0, angle: -30, len: 1.2 },
        { id: 'b1', type: 'disk', label: '1', x: 0.05, y: 0.0866025404, props: { m: 'm', J: 'J', R: 'R', Ri: '' } },
        { id: 'c1', type: 'contact', body: 'b1', ground: 'g1', mode: 'roll' },
      ],
      params: { m: 2, J: 0.01, R: 0.1, g: 9.81 }, gravity: true,
      dofs: [{ id: 'q1', body: 'b1', coord: 'phi', dir: -1, name: 'phi' }],
    },
    ref: ['(J + m*R^2)*Q1dd - m*g*R/2'],
  },
  {
    name: 'Atwood-Maschine mit Umlenkrolle (J)',
    modes: ['linear', 'nonlinear'],
    sys: {
      elements: [
        { id: 'b0', type: 'disk', label: '0', x: 0, y: 0.5, props: { m: 'm_0', J: 'J', R: 'r', Ri: '' } },
        { id: 'p0', type: 'pin', at: { el: 'b0', port: 'c' }, angle: 90 },
        { id: 'b1', type: 'block', label: '1', x: -0.1, y: 0, props: { m: 'm_1', a: '0.1', b: '0.1', rot: false } },
        { id: 'b2', type: 'block', label: '2', x: 0.1, y: 0.1, props: { m: 'm_2', a: '0.1', b: '0.1', rot: false } },
        { id: 'r1', type: 'roller', at: { el: 'b1', port: 'l' }, angle: 180 },
        { id: 'r2', type: 'roller', at: { el: 'b2', port: 'r' }, angle: 0 },
        { id: 's1', type: 'rope', a: { el: 'b0', port: 'R:180' }, b: { el: 'b1', port: 't' }, props: { L0: '0.45' } },
        { id: 's2', type: 'rope', a: { el: 'b0', port: 'R:0' }, b: { el: 'b2', port: 't' }, props: { L0: '0.35' } },
      ],
      params: { m_0: 1, J: 0.004, r: 0.1, m_1: 1.5, m_2: 1, g: 9.81 }, gravity: true,
      dofs: [{ id: 'q1', body: 'b1', coord: 'y', dir: -1, name: 's' }],
    },
    ref: ['(m_1 + m_2 + J/r^2)*Q1dd - (m_1 - m_2)*g'],
  },
  {
    name: 'Rollende Scheibe, Feder oben (Hebel 2R ⇒ 4k)',
    modes: ['linear', 'nonlinear'],
    sys: {
      elements: [
        ground(0, 0),
        { id: 'b1', type: 'disk', label: '1', x: 0, y: 0.1, props: { m: 'm', J: 'J', R: 'R', Ri: '' } },
        { id: 'c1', type: 'contact', body: 'b1', ground: 'g00', mode: 'roll' },
        { id: 'w1', type: 'fix', x: -0.4, y: 0.2, angle: 0 },
        { id: 's1', type: 'spring', a: { el: 'w1', port: 'c' }, b: { el: 'b1', port: 'R:90' }, props: { k: 'k', L0: '0.4' } },
      ],
      params: { m: 2, J: 0.01, R: 0.1, k: 200, g: 9.81 }, gravity: true,
      dofs: [{ id: 'q1', body: 'b1', coord: 'x', dir: 1, name: 'x' }],
    },
    ref: ['(m + J/R^2)*Q1dd + 4*k*Q1'],
  },
  {
    name: 'Hängender Klotz an Feder (statische Last m g)',
    modes: ['linear', 'nonlinear'],
    sys: {
      elements: [
        { id: 'w1', type: 'fix', x: 0, y: 0.5, angle: -90 },
        { id: 'b1', type: 'block', label: '1', x: 0, y: 0, props: { m: 'm', a: '0.1', b: '0.1', rot: false } },
        { id: 'r1', type: 'roller', at: { el: 'b1', port: 'l' }, angle: 180 },
        { id: 's1', type: 'spring', a: { el: 'w1', port: 'c' }, b: { el: 'b1', port: 't' }, props: { k: 'k', L0: '0.45' } },
      ],
      params: { m: 2, k: 400, g: 9.81 }, gravity: true,
      dofs: [{ id: 'q1', body: 'b1', coord: 'y', dir: -1, name: 'x' }],
    },
    ref: ['m*Q1dd + k*Q1 - m*g'],
  },
  {
    name: 'Drehschwinger mit Drehfeder, -dämpfer und Moment M₀cos(Ωt)',
    modes: ['linear', 'nonlinear'],
    sys: {
      elements: [
        { id: 'b1', type: 'disk', label: '1', x: 0, y: 0, props: { m: 'm', J: 'J', R: 'r', Ri: '' } },
        { id: 'p1', type: 'pin', at: { el: 'b1', port: 'c' }, angle: -90 },
        { id: 't1', type: 'tspring', a: 'b1', b: null, props: { kt: 'c_t' } },
        { id: 't2', type: 'tdamper', a: 'b1', b: null, props: { dt: 'd_t' } },
        { id: 'M1', type: 'moment', body: 'b1', dir: 1, props: { M: 'M_0*cos(Omega*t)' } },
      ],
      params: { m: 1, J: 0.02, r: 0.1, c_t: 4, d_t: 0.1, M_0: 0.5, Omega: 7 }, gravity: false,
      dofs: [{ id: 'q1', body: 'b1', coord: 'phi', dir: 1, name: 'phi' }],
    },
    ref: ['J*Q1dd + d_t*Q1d + c_t*Q1 - M_0*cos(Omega*t)'],
  },
  {
    name: 'Doppelpendel aus zwei Stäben',
    modes: ['linear', 'nonlinear'],
    sys: {
      elements: [
        { id: 'b1', type: 'rod', label: '1', x: 0, y: 0.1, angle: 90, props: { m: 'm', J: 'm*l^2/12', l: 'l' } },
        { id: 'b2', type: 'rod', label: '2', x: 0, y: -0.4, angle: 90, props: { m: 'm', J: 'm*l^2/12', l: 'l' } },
        { id: 'p1', type: 'pin', at: { el: 'b1', port: 'e2' }, angle: 90 },
        { id: 'h1', type: 'hinge', a: { el: 'b1', port: 'e1' }, b: { el: 'b2', port: 'e2' } },
      ],
      params: { m: 1, l: 0.5, g: 9.81 }, gravity: true,
      dofs: [{ id: 'q1', body: 'b1', coord: 'phi', dir: 1, name: 'phi_1' }, { id: 'q2', body: 'b2', coord: 'phi', dir: 1, name: 'phi_2' }],
    },
    ref: [
      '4/3*m*l^2*Q1dd + 1/2*m*l^2*cos(Q1-Q2)*Q2dd + 1/2*m*l^2*sin(Q1-Q2)*Q2d^2 + 3/2*m*g*l*sin(Q1)',
      '1/2*m*l^2*cos(Q1-Q2)*Q1dd + 1/3*m*l^2*Q2dd - 1/2*m*l^2*sin(Q1-Q2)*Q1d^2 + 1/2*m*g*l*sin(Q2)',
    ],
    refLin: ['4/3*m*l^2*Q1dd + 1/2*m*l^2*Q2dd + 3/2*m*g*l*Q1', '1/2*m*l^2*Q1dd + 1/3*m*l^2*Q2dd + 1/2*m*g*l*Q2'],
  },
  {
    name: 'Anwendungsbeispiel: Stufenrolle + Rolle, k ∥ d und k',
    modes: ['linear', 'nonlinear'],
    sys: {
      elements: [
        ground(-0.3, 0, 0, 0.9),
        { id: 'b2', type: 'disk', label: '2', x: -0.3, y: 0.2, props: { m: 'm', J: 'J_2', R: '2*r', Ri: 'r' } },
        { id: 'b1', type: 'disk', label: '1', x: 0.4, y: 0.2, props: { m: 'm_1', J: 'J_1', R: 'r', Ri: '' } },
        { id: 'p1', type: 'pin', at: { el: 'b1', port: 'c' }, angle: -90 },
        { id: 'c1', type: 'contact', body: 'b2', ground: 'g-0.30', mode: 'roll' },
        { id: 's1', type: 'springdamper', a: { el: 'b2', port: 'Ri:90' }, b: { el: 'b1', port: 'R:90' }, props: { k: 'k', d: 'd', L0: '0.7' } },
        { id: 's2', type: 'spring', a: { el: 'b2', port: 'Ri:270' }, b: { el: 'b1', port: 'R:270' }, props: { k: 'k', L0: '0.7' } },
      ],
      params: { m: 2, J_2: 0.04, r: 0.1, m_1: 1, J_1: 0.005, k: 500, d: 2 }, gravity: false,
      dofs: [{ id: 'q1', body: 'b1', coord: 'phi', dir: -1, name: 'phi_1' }, { id: 'q2', body: 'b2', coord: 'phi', dir: -1, name: 'phi_2' }],
    },
    ref: ['J_1*Q1dd + d*r^2*(Q1d - 3*Q2d) + 2*k*r^2*(Q1 - Q2)', '(J_2 + 4*m*r^2)*Q2dd - 3*d*r^2*(Q1d - 3*Q2d) + k*r^2*(-2*Q1 + 10*Q2)'],
  },
  {
    name: 'Punktmasse gleitet in Kreismulde (Radius ρ), Koordinate x',
    modes: ['linear', 'nonlinear'],
    symbolic: false,
    sys: {
      elements: [
        { id: 'k1', type: 'curve', x: 0, y: 0.5, a0: 200, a1: 340, concave: true, props: { rho: 'rho' } },
        { id: 'b1', type: 'point', label: '1', x: 0, y: 0, props: { m: 'm' } },
        { id: 'c1', type: 'contact', body: 'b1', ground: 'k1', mode: 'slide' },
      ],
      params: { m: 1.5, rho: 0.5, g: 9.81 }, gravity: true,
      dofs: [{ id: 'q1', body: 'b1', coord: 'x', dir: 1, name: 'x' }],
    },
    ref: ['m*rho^2/(rho^2-Q1^2)*Q1dd + m*rho^2*Q1*Q1d^2/(rho^2-Q1^2)^2 + m*g*Q1/sqrt(rho^2-Q1^2)'],
    refLin: ['m*Q1dd + m*g/rho*Q1'],
  },
  {
    name: 'Scheibe rollt in Kreismulde',
    modes: ['linear', 'nonlinear'],
    sys: {
      elements: [
        { id: 'k1', type: 'curve', x: 0, y: 0.5, a0: 200, a1: 340, concave: true, props: { rho: 'rho' } },
        { id: 'b1', type: 'disk', label: '1', x: 0, y: 0.1, props: { m: 'm', J: 'J', R: 'R', Ri: '' } },
        { id: 'c1', type: 'contact', body: 'b1', ground: 'k1', mode: 'roll' },
      ],
      params: { m: 2, J: 0.01, R: 0.1, rho: 0.5, g: 9.81 }, gravity: true,
      dofs: [{ id: 'q1', body: 'b1', coord: 'phi', dir: -1, name: 'phi' }],
    },
    ref: ['(J + m*R^2)*Q1dd + m*g*R*sin(R*Q1/(rho-R))'],
    refLin: ['(J + m*R^2)*Q1dd + m*g*R^2/(rho-R)*Q1'],
  },
  {
    name: 'Scheibe rollt auf Zylinder (Kuppe, instabil)',
    modes: ['linear', 'nonlinear'],
    sys: {
      elements: [
        { id: 'k1', type: 'curve', x: 0, y: 0, a0: 20, a1: 160, concave: false, props: { rho: 'rho' } },
        { id: 'b1', type: 'disk', label: '1', x: 0, y: 0.6, props: { m: 'm', J: 'J', R: 'R', Ri: '' } },
        { id: 'c1', type: 'contact', body: 'b1', ground: 'k1', mode: 'roll' },
      ],
      params: { m: 2, J: 0.01, R: 0.1, rho: 0.5, g: 9.81 }, gravity: true,
      dofs: [{ id: 'q1', body: 'b1', coord: 'phi', dir: -1, name: 'phi' }],
    },
    ref: ['(J + m*R^2)*Q1dd - m*g*R*sin(R*Q1/(rho+R))'],
    refLin: ['(J + m*R^2)*Q1dd - m*g*R^2/(rho+R)*Q1'],
  },
  {
    name: 'Schief gezeichnetes Pendel (Stab 30° ausgelenkt)',
    modes: ['linear', 'nonlinear'],
    sys: {
      elements: [
        { id: 'b1', type: 'rod', label: '1', x: -0.15, y: -0.2598076211, angle: 60, props: { m: 'm', J: 'J', l: 'l' } },
        { id: 'p1', type: 'pin', at: { el: 'b1', port: 'e2' }, angle: 90 },
      ],
      params: { m: 1.2, J: 0.03, l: 0.6, g: 9.81 }, gravity: true,
      dofs: [{ id: 'q1', body: 'b1', coord: 'phi', dir: 1, name: 'phi' }],
    },
    ref: ['(J + m*l^2/4)*Q1dd + m*g*l/2*(sqrt(3)/2*sin(Q1) - 1/2*cos(Q1))'],
    refLin: ['(J + m*l^2/4)*Q1dd + sqrt(3)/4*m*g*l*Q1 - m*g*l/4'],
  },
  {
    name: 'Zwei Federn in Reihe über masselosen Knoten',
    modes: ['linear', 'nonlinear'],
    sys: {
      elements: [
        ground(0, 0),
        { id: 'w1', type: 'fix', x: -0.4, y: 0.06, angle: 0 },
        { id: 'n1', type: 'node', x: -0.2, y: 0.06 },
        { id: 'b1', type: 'block', label: '1', x: 0.1, y: 0.06, props: { m: 'm', a: '0.2', b: '0.12', rot: false } },
        { id: 'c1', type: 'contact', body: 'b1', ground: 'g00', mode: 'slide' },
        { id: 's1', type: 'spring', a: { el: 'w1', port: 'c' }, b: { el: 'n1', port: 'c' }, props: { k: 'k_1', L0: '0.2' } },
        { id: 's2', type: 'spring', a: { el: 'n1', port: 'c' }, b: { el: 'b1', port: 'l' }, props: { k: 'k_2', L0: '0.1' } },
      ],
      params: { m: 1.5, k_1: 120, k_2: 300 }, gravity: false,
      dofs: [{ id: 'q1', body: 'b1', coord: 'x', dir: 1, name: 'x' }],
    },
    ref: ['m*Q1dd + k_1*k_2/(k_1 + k_2)*Q1'],
  },
  {
    name: 'Hängende Masse: Seil – Knoten – Feder – Knoten – Feder',
    modes: ['linear', 'nonlinear'],
    sys: {
      elements: [
        { id: 'w1', type: 'fix', x: 0, y: 0.9, angle: -90 },
        { id: 'n1', type: 'node', x: 0, y: 0.7 },
        { id: 'n2', type: 'node', x: 0, y: 0.4 },
        { id: 'b1', type: 'block', label: '1', x: 0, y: 0, props: { m: 'm', a: '0.1', b: '0.1', rot: false } },
        { id: 'r1', type: 'roller', at: { el: 'b1', port: 'l' }, angle: 180 },
        { id: 's0', type: 'rope', a: { el: 'w1', port: 'c' }, b: { el: 'n1', port: 'c' }, props: { L0: '0.2' } },
        { id: 's1', type: 'spring', a: { el: 'n1', port: 'c' }, b: { el: 'n2', port: 'c' }, props: { k: 'k_1', L0: '0.3' } },
        { id: 's2', type: 'spring', a: { el: 'n2', port: 'c' }, b: { el: 'b1', port: 't' }, props: { k: 'k_2', L0: '0.35' } },
      ],
      params: { m: 2, k_1: 400, k_2: 600, g: 9.81 }, gravity: true,
      dofs: [{ id: 'q1', body: 'b1', coord: 'y', dir: -1, name: 'x' }],
    },
    ref: ['m*Q1dd + k_1*k_2/(k_1 + k_2)*Q1 - m*g'],
  },
];

// ------------------------------------------------------------------
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
let fails = 0, checks = 0;
const rows = [];

for (const C of CASES) {
  for (const mode of C.modes) {
    const refStr = mode === 'linear' && C.refLin ? C.refLin : C.ref;
    for (const method of ['L2', 'DAL', 'L1']) {
      const sys = { ...structuredClone(C.sys), method, mode, sim: {} };
      ensureParams(sys);
      const env = paramEnv(sys);
      let status = '', symb = '–';
      try {
        const res = derive(sys);
        const qc = sys.dofs.map((d) => res.dofs.coords.find((c) => c.dof.id === d.id));
        const m = new Map();
        qc.forEach((c, i) => { m.set('Q' + (i + 1), c.s); m.set('Q' + (i + 1) + 'd', c.d); m.set('Q' + (i + 1) + 'dd', c.dd); });
        const ref = refStr.map((s) => simplify(subs(parse(s), m)));
        // (a) symbolisch
        if (method !== 'L1' && C.symbolic !== false) {
          const ok = res.numeric.eqs.every((e, i) => isZero(simplify(add(e, mul(MONE, ref[i])))));
          symb = ok ? 'identisch' : 'abweichend';
          if (!ok) { fails++; console.log('  symbolisch:', res.numeric.eqs.map(String).length); }
          checks++;
        }
        // (b) numerisch: Beschleunigungen
        const cm = compile(res, env);
        const n = qc.length;
        let maxErr = 0;
        for (let k = 0; k < 6; k++) {
          // Winkel bis ±0,6 rad (nichtlinear), Verschiebungen bis ±0,075 m (kleiner als Feder-/Seillängen)
          const q = qc.map((c) => rnd() * (c.dof.coord === 'phi' ? (mode === 'linear' ? 0.2 : 1.2) : 0.15));
          const v = qc.map(() => rnd() * 2);
          const t = Math.abs(rnd()) * 3;
          // Referenz: M_ref q̈ = -ref|_{q̈=0}
          const e2 = { ...env, t };
          qc.forEach((c, i) => { e2[c.s.name] = q[i]; e2[c.d.name] = v[i]; e2[c.dd.name] = 0; });
          const Mr = ref.map((r) => qc.map((c) => evalNum(diff(r, c.dd), e2)));
          const br = ref.map((r) => -evalNum(r, e2));
          const aRef = solveDense(Mr, br);
          let aApp;
          if (cm.type === 'ode') aApp = cm.accel(t, q, v).a;
          else {
            const pc = res.numeric.coords;
            const P = pc.map((c) => (c.dof ? q[qc.indexOf(c)] : 0));
            const PV = pc.map((c) => (c.dof ? v[qc.indexOf(c)] : 0));
            cm.project(P, PV, 40);
            const a = cm.accel(t, P, PV).a;
            aApp = qc.map((c) => a[pc.indexOf(c)]);
          }
          for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(aApp[i] - aRef[i]) / (1 + Math.abs(aRef[i])));
        }
        checks++;
        const ok = maxErr < 1e-6;
        if (!ok) fails++;
        status = ok ? `ok (rel. Fehler ${maxErr.toExponential(1)})` : `FEHLER (rel. Fehler ${maxErr.toExponential(2)})`;
      } catch (e) {
        fails++; checks++;
        status = 'FEHLER: ' + e.message;
      }
      rows.push([C.name, mode === 'linear' ? 'linear' : 'nichtlinear', method, symb, status]);
    }
  }
}
const w = [52, 12, 4, 11];
for (const r of rows) console.log(r[0].padEnd(w[0]).slice(0, w[0]), r[1].padEnd(w[1]), r[2].padEnd(w[2]), r[3].padEnd(w[3]), r[4]);
console.log(`\n${checks - fails}/${checks} Prüfungen bestanden.`);
process.exitCode = fails ? 1 : 0;

// ------------------------------------------------------------------ Simulation gegen analytische Lösungen
import { simulate } from '../js/mech/numeric.js';
function simCase(C, method, mode, init, T, exact, label) {
  const sys = { ...structuredClone(C.sys), method, mode, sim: {} };
  ensureParams(sys);
  const env = paramEnv(sys);
  const res = derive(sys);
  const cm = compile(res, env);
  const coords = res.numeric.coords;
  const q0 = coords.map((c) => (c.dof ? init : 0)), v0 = coords.map(() => 0);
  const out = simulate(cm, { method: 'rk4', h: 1e-3, T, q0, v0 });
  const k = coords.findIndex((c) => c.dof);
  let err = 0;
  out.t.forEach((t, i) => { err = Math.max(err, Math.abs(out.q[i][k] - exact(t, env))); });
  const ok = err < 1e-6;
  console.log((ok ? 'ok    ' : 'FEHLER') + ' ' + label + ` (${method}, ${mode}): max. Abweichung ${err.toExponential(1)}`);
  if (!ok) process.exitCode = 1;
}
const hang = CASES.find((c) => c.name.startsWith('Hängender'));
simCase(hang, 'L2', 'linear', 0, 2, (t, e) => (e.m * e.g / e.k) * (1 - Math.cos(Math.sqrt(e.k / e.m) * t)), 'Hängender Klotz: x(t) = mg/k (1 − cos ωt)');
simCase(hang, 'L1', 'nonlinear', 0, 2, (t, e) => (e.m * e.g / e.k) * (1 - Math.cos(Math.sqrt(e.k / e.m) * t)), 'Hängender Klotz: x(t) = mg/k (1 − cos ωt)');
const incl = CASES.find((c) => c.name.startsWith('Rollende Scheibe auf'));
simCase(incl, 'DAL', 'nonlinear', 0, 1, (t, e) => 0.5 * (e.m * e.g * e.R / 2 / (e.J + e.m * e.R * e.R)) * t * t, 'Rollende Scheibe: φ(t) = ½ α t²');
const atw = CASES.find((c) => c.name.startsWith('Atwood'));
simCase(atw, 'L1', 'nonlinear', 0, 0.4, (t, e) => 0.5 * ((e.m_1 - e.m_2) * e.g / (e.m_1 + e.m_2 + e.J / e.r ** 2)) * t * t, 'Atwood: s(t) = ½ a t²');

// ------------------------------------------------------------------ freie Enden
{
  const sys = { elements: [
    { id: 'b1', type: 'point', label: '1', x: 0, y: 0, props: { m: 'm' } },
    { id: 's1', type: 'spring', a: { el: 'b1', port: 'c' }, b: { x: 0.3, y: 0 }, props: { k: 'k', L0: '0.3' } },
  ], params: { m: 1, k: 10 }, gravity: false, dofs: [] };
  const { buildModel } = await import('../js/mech/model.js');
  const m = buildModel(sys);
  const ok = m.warnings.length === 1 && m.springs.length === 0;
  console.log((ok ? 'ok    ' : 'FEHLER') + ' Feder mit freiem Ende: wird ignoriert, Warnung ausgegeben');
  if (!ok) process.exitCode = 1;
}

// ------------------------------------------------------------------ Reihenschaltung: Fehlerfälle
{
  const base = (extra) => ({ elements: [
    { id: 'w1', type: 'fix', x: -0.4, y: 0, angle: 0 },
    { id: 'n1', type: 'node', x: -0.2, y: 0 },
    { id: 'b1', type: 'point', label: '1', x: 0.1, y: 0, props: { m: 'm' } },
    ...extra,
  ], params: { m: 1, k: 10, d: 1 }, gravity: false, dofs: [] });
  const { buildModel } = await import('../js/mech/model.js');
  let msg = '';
  try { buildModel(base([
    { id: 's1', type: 'spring', a: { el: 'w1', port: 'c' }, b: { el: 'n1', port: 'c' }, props: { k: 'k', L0: '0.2' } },
    { id: 's2', type: 'damper', a: { el: 'n1', port: 'c' }, b: { el: 'b1', port: 'c' }, props: { d: 'd', L0: '0.3' } }])); } catch (e) { msg = e.message; }
  let ok = msg.includes('Maxwell');
  console.log((ok ? 'ok    ' : 'FEHLER') + ' Feder + Dämpfer in Reihe: verständliche Fehlermeldung');
  if (!ok) process.exitCode = 1;
  const m = buildModel(base([
    { id: 's1', type: 'spring', a: { el: 'w1', port: 'c' }, b: { el: 'n1', port: 'c' }, props: { k: 'k', L0: '0.2' } }]));
  ok = m.warnings.length === 1 && m.springs.length === 0;
  console.log((ok ? 'ok    ' : 'FEHLER') + ' Knoten mit nur einer Feder: Warnung, keine Kraft');
  if (!ok) process.exitCode = 1;
}
