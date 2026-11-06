// Beispielsysteme
export const EXAMPLES = [
  {
    name: 'Klausurbeispiel: Stufenrolle mit Feder/Dämpfer',
    sys: {
      elements: [
        { id: 'g1', type: 'ground', x: -0.3, y: 0, angle: 0, len: 0.9 },
        { id: 'b2', type: 'disk', label: '2', x: -0.3, y: 0.2, props: { m: 'm', J: 'J_2', R: '2*r', Ri: 'r' } },
        { id: 'b1', type: 'disk', label: '1', x: 0.4, y: 0.2, props: { m: 'm_1', J: 'J_1', R: 'r', Ri: '' } },
        { id: 'p1', type: 'pin', at: { el: 'b1', port: 'c' }, angle: -90 },
        { id: 'c1', type: 'contact', body: 'b2', ground: 'g1', mode: 'roll' },
        { id: 's1', type: 'springdamper', a: { el: 'b2', port: 'Ri:90' }, b: { el: 'b1', port: 'R:90' }, props: { k: 'k', d: 'd', L0: '0.7' } },
        { id: 's2', type: 'spring', a: { el: 'b2', port: 'Ri:270' }, b: { el: 'b1', port: 'R:270' }, props: { k: 'k', L0: '0.7' } },
      ],
      params: { m: 2, J_2: 0.04, r: 0.1, m_1: 1, J_1: 0.005, k: 500, d: 2 },
      gravity: false,
      dofs: [
        { id: 'q1', body: 'b1', coord: 'phi', dir: -1, name: 'phi_1' },
        { id: 'q2', body: 'b2', coord: 'phi', dir: -1, name: 'phi_2' },
      ],
      method: 'L2', mode: 'linear',
      sim: { init: { q1: { q: '0.2', qd: '0' }, q2: { q: '0', qd: '0' } }, T: 3, h: 0.002, integrator: 'rk4' },
    },
  },
  {
    name: 'Feder-Masse-Dämpfer mit Erregung',
    sys: {
      elements: [
        { id: 'g1', type: 'ground', x: 0.1, y: 0, angle: 0, len: 1.0 },
        { id: 'w1', type: 'fix', x: -0.4, y: 0.06, angle: 0 },
        { id: 'b1', type: 'block', label: '1', x: 0.1, y: 0.06, angle: 0, props: { m: 'm', a: '0.2', b: '0.12', rot: false, J: 'J_1' } },
        { id: 'c1', type: 'contact', body: 'b1', ground: 'g1', mode: 'slide' },
        { id: 's1', type: 'spring', a: { el: 'w1', port: 'c' }, b: { el: 'b1', port: 'l' }, props: { k: 'k', L0: '0.4' } },
        { id: 'f1', type: 'force', at: { el: 'b1', port: 'r' }, angle: 0, props: { F: 'F_0*cos(Omega*t)' } },
      ],
      params: { m: 1, k: 400, F_0: 5, Omega: 15, g: 9.81 },
      gravity: true,
      dofs: [{ id: 'q1', body: 'b1', coord: 'x', dir: 1, name: 'x' }],
      method: 'L2', mode: 'linear',
      sim: { init: { q1: { q: '0', qd: '0' } }, T: 4, h: 0.002, integrator: 'rk4' },
    },
  },
  {
    name: 'Stabpendel (nichtlinear)',
    sys: {
      elements: [
        { id: 'b1', type: 'rod', label: '1', x: 0, y: 0, angle: 90, props: { m: 'm', J: 'm*l^2/12', l: 'l' } },
        { id: 'p1', type: 'pin', at: { el: 'b1', port: 'e2' }, angle: 90 },
      ],
      params: { m: 1, l: 0.5, g: 9.81 },
      gravity: true,
      dofs: [{ id: 'q1', body: 'b1', coord: 'phi', dir: 1, name: 'phi' }],
      method: 'L2', mode: 'nonlinear',
      sim: { init: { q1: { q: '2', qd: '0' } }, T: 5, h: 0.002, integrator: 'rk4' },
    },
  },
  {
    name: 'Doppelpendel (nichtlinear)',
    sys: {
      elements: [
        { id: 'b1', type: 'rod', label: '1', x: 0, y: 0.1, angle: 90, props: { m: 'm', J: 'm*l^2/12', l: 'l' } },
        { id: 'b2', type: 'rod', label: '2', x: 0, y: -0.4, angle: 90, props: { m: 'm', J: 'm*l^2/12', l: 'l' } },
        { id: 'p1', type: 'pin', at: { el: 'b1', port: 'e2' }, angle: 90 },
        { id: 'h1', type: 'hinge', a: { el: 'b1', port: 'e1' }, b: { el: 'b2', port: 'e2' } },
      ],
      params: { m: 1, l: 0.5, g: 9.81 },
      gravity: true,
      dofs: [
        { id: 'q1', body: 'b1', coord: 'phi', dir: 1, name: 'phi_1' },
        { id: 'q2', body: 'b2', coord: 'phi', dir: 1, name: 'phi_2' },
      ],
      method: 'L2', mode: 'nonlinear',
      sim: { init: { q1: { q: '1.5', qd: '0' }, q2: { q: '0', qd: '0' } }, T: 8, h: 0.001, integrator: 'rk4' },
    },
  },
  {
    name: 'Seil über Rolle mit Masse und Feder',
    sys: {
      elements: [
        { id: 'b1', type: 'disk', label: '1', x: 0, y: 0.4, props: { m: 'm_1', J: 'J_1', R: 'r', Ri: '' } },
        { id: 'p1', type: 'pin', at: { el: 'b1', port: 'c' }, angle: 90 },
        { id: 'b2', type: 'block', label: '2', x: -0.1, y: 0.0, angle: 0, props: { m: 'm_2', a: '0.12', b: '0.12', rot: false, J: 'J_2' } },
        { id: 'r1', type: 'roller', at: { el: 'b2', port: 'l' }, angle: 180 },
        { id: 's0', type: 'rope', a: { el: 'b1', port: 'R:180' }, b: { el: 'b2', port: 't' }, props: { L0: '0.34' } },
        { id: 'w1', type: 'fix', x: 0.1, y: 0.0, angle: 90 },
        { id: 's1', type: 'spring', a: { el: 'b1', port: 'R:0' }, b: { el: 'w1', port: 'c' }, props: { k: 'k', L0: '0.4' } },
      ],
      params: { m_1: 1, J_1: 0.005, r: 0.1, m_2: 2, k: 300, g: 9.81 },
      gravity: true,
      dofs: [{ id: 'q1', body: 'b2', coord: 'y', dir: -1, name: 'x' }],
      method: 'L2', mode: 'linear',
      sim: { init: { q1: { q: '0.02', qd: '0' } }, T: 3, h: 0.002, integrator: 'rk4' },
    },
  },
];
