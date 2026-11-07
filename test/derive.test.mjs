import { EXAMPLES } from '../js/examples.js';
import { derive } from '../js/mech/derive.js';
import { compile, simulate } from '../js/mech/numeric.js';
import { paramEnv } from '../js/mech/model.js';
const only = process.argv[2];
const verbose = process.argv.includes('-v');
const results = {}; let mismatch = 0;
for (const [i, ex] of EXAMPLES.entries()) {
  if (only !== undefined && only !== 'all' && String(i) !== only) continue;
  // Beispiele, deren gezeichnete Lage keine Gleichgewichtslage ist, werden nur nichtlinear verglichen
  for (const method of ['L2', 'DAL', 'L1']) for (const mode of ex.nonlinearOnly ? ['nonlinear'] : ['linear', 'nonlinear']) {
    const sys = structuredClone(ex.sys); sys.method = method; sys.mode = mode;
    const t0 = Date.now();
    try {
      const res = derive(sys);
      const eqSec = res.doc.sections.find(s => s.title.startsWith('Bewegungsgleichungen'));
      console.log(`--- ${ex.name} | ${method} | ${mode} (${Date.now()-t0} ms)`);
      for (const r of eqSec.rows) console.log('   ', r.tex || r.text);
      if (verbose) for (const s of res.doc.sections) { console.log('  #', s.title); for (const r of s.rows) console.log('     ', r.tex || r.text); }
      const env = paramEnv(sys);
      const cm = compile(res, env);
      const q0 = sys.dofs.map(d => Number(sys.sim.init[d.id].q)); const v0 = sys.dofs.map(()=>0);
      let qq0 = q0, vv0 = v0;
      if (cm.type === 'dae') { qq0 = res.numeric.coords.map(c => c.dof ? q0[sys.dofs.indexOf(c.dof)] : 0); vv0 = qq0.map(()=>0); }
      const out = simulate(cm, { method: 'rk4', h: 0.001, T: 1, q0: qq0, v0: vv0 });
      const last = out.q[out.q.length-1];
      const dofVals = cm.type==='dae' ? res.numeric.coords.map((c,k)=>c.dof?last[k]:null).filter(x=>x!==null) : last;
      const key = ex.name + '|' + mode; (results[key] ||= []).push([method, dofVals]);
      console.log('    q(1s) =', dofVals.map(x=>x.toFixed(5)).join(', '), ' E0=', out.E[0][2].toFixed(4), ' E1=', out.E[out.E.length-1][2].toFixed(4));
    } catch (e) { console.log(`--- ${ex.name} | ${method} | ${mode}: FEHLER ${e.message}`); if (verbose) console.log(e.stack); }
  }
}

for (const [k, list] of Object.entries(results)) {
  const ref = list[0][1];
  for (const [m, v] of list) {
    const sorted = (a) => [...a].sort((x, y) => x - y);
    const d = Math.max(...sorted(v).map((x, i) => Math.abs(x - sorted(ref)[i])));
    if (d > 1e-6) { mismatch++; console.log('ABWEICHUNG', k, m, d); }
  }
}
console.log(mismatch ? mismatch + ' Abweichungen' : 'Alle Methoden stimmen überein.');
process.exitCode = mismatch ? 1 : 0;
