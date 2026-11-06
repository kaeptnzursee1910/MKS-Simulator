// Einfacher Liniendiagramm-Renderer (Canvas) mit Fadenkreuz, Tooltip und Zeitmarke
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#7a5af5', '#5c5c5c'];

function niceTicks(min, max, n = 5) {
  if (!(max > min)) { max = min + 1; min -= 1; }
  const span = max - min;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || mag * 10;
  const t = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) t.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { ticks: t, step };
}
const fmt = (v) => {
  if (v === 0) return '0';
  const a = Math.abs(v);
  const s = a >= 1e4 || a < 1e-3 ? v.toExponential(1) : String(+v.toPrecision(4));
  return s.replace('.', ',');
};

export class Plot {
  constructor(wrap) {
    this.wrap = wrap;
    this.canvas = document.createElement('canvas');
    this.tip = document.createElement('div');
    this.tip.className = 'plot-tip';
    Object.assign(this.tip.style, {
      position: 'absolute', pointerEvents: 'none', background: '#fff', border: '1px solid #d9d7d0', borderRadius: '6px',
      padding: '4px 8px', fontSize: '12px', boxShadow: '0 2px 8px rgba(0,0,0,.1)', display: 'none', whiteSpace: 'nowrap', zIndex: 2,
    });
    wrap.append(this.canvas, this.tip);
    this.series = [];
    this.t = [];
    this.cursor = null;
    this.hover = null;
    const move = (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.hover = e.clientX - r.left;
      this.draw();
    };
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerdown', (e) => {
      move(e);
      if (this.onSeek && this.hover !== null) this.onSeek(this.xToT(this.hover));
    });
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.tip.style.display = 'none'; this.draw(); });
    new ResizeObserver(() => this.draw()).observe(wrap);
  }
  setData(t, series, unit) { this.t = t; this.series = series; this.unit = unit || ''; this.draw(); }
  setCursor(tc) { this.cursor = tc; this.draw(); }
  xToT(x) { const { L, R } = this.box; const t0 = this.t[0], t1 = this.t[this.t.length - 1]; return t0 + ((x - L) / (R - L)) * (t1 - t0); }
  draw() {
    const W = this.wrap.clientWidth, H = this.wrap.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    const cv = this.canvas;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const vis = this.series.filter((s) => s.visible !== false);
    const t = this.t;
    if (!t.length) return;
    let ymin = Infinity, ymax = -Infinity;
    for (const s of vis) for (const v of s.y) if (Number.isFinite(v)) { if (v < ymin) ymin = v; if (v > ymax) ymax = v; }
    if (!Number.isFinite(ymin)) { ymin = -1; ymax = 1; }
    if (ymax - ymin < 1e-12) { ymin -= 1e-3 + Math.abs(ymin) * 0.1; ymax += 1e-3 + Math.abs(ymax) * 0.1; }
    const pad = (ymax - ymin) * 0.06; ymin -= pad; ymax += pad;
    const yt = niceTicks(ymin, ymax, 4), xt = niceTicks(t[0], t[t.length - 1], 6);
    g.font = '11px system-ui, sans-serif';
    const L = Math.max(...yt.ticks.map((v) => g.measureText(fmt(v)).width)) + 12, R = W - 10, T = 10, B = H - 24;
    this.box = { L, R, T, B };
    const X = (v) => L + ((v - t[0]) / (t[t.length - 1] - t[0] || 1)) * (R - L);
    const Y = (v) => B - ((v - ymin) / (ymax - ymin)) * (B - T);
    // Raster & Achsen (zurückhaltend)
    g.strokeStyle = '#ecebe6'; g.lineWidth = 1; g.fillStyle = '#6b6b70';
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (const v of yt.ticks) { if (v < ymin || v > ymax) continue; const y = Math.round(Y(v)) + 0.5; g.beginPath(); g.moveTo(L, y); g.lineTo(R, y); g.stroke(); g.fillText(fmt(v), L - 6, y); }
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const v of xt.ticks) { if (v < t[0] - 1e-12 || v > t[t.length - 1] + 1e-12) continue; const x = Math.round(X(v)) + 0.5; g.fillText(fmt(v), x, B + 6); }
    g.textAlign = 'right'; g.fillText('t in s', R, B + 6 - 0);
    if (ymin < 0 && ymax > 0) { g.strokeStyle = '#c9c7c0'; g.beginPath(); g.moveTo(L, Y(0)); g.lineTo(R, Y(0)); g.stroke(); }
    // Linien
    g.lineWidth = 2; g.lineJoin = 'round'; g.lineCap = 'round';
    const stride = Math.max(1, Math.floor(t.length / (R - L) / 2));
    for (const s of vis) {
      g.strokeStyle = s.color; g.beginPath();
      let started = false;
      for (let i = 0; i < t.length; i += stride) {
        const v = s.y[i]; if (!Number.isFinite(v)) { started = false; continue; }
        const x = X(t[i]), y = Y(v);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      g.stroke();
    }
    // Zeitmarke
    if (this.cursor !== null && this.cursor !== undefined) {
      const x = X(this.cursor);
      g.strokeStyle = 'rgba(29,29,31,.45)'; g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(x, T); g.lineTo(x, B); g.stroke(); g.setLineDash([]);
    }
    // Fadenkreuz + Tooltip
    if (this.hover !== null && this.hover >= L && this.hover <= R) {
      const tt = this.xToT(this.hover);
      let i = 0, lo = 0, hi = t.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < tt) lo = m + 1; else hi = m; }
      i = lo;
      const x = X(t[i]);
      g.strokeStyle = 'rgba(29,29,31,.6)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, T); g.lineTo(x, B); g.stroke();
      for (const s of vis) {
        const v = s.y[i]; if (!Number.isFinite(v)) continue;
        g.fillStyle = '#fff'; g.beginPath(); g.arc(x, Y(v), 5, 0, 7); g.fill();
        g.fillStyle = s.color; g.beginPath(); g.arc(x, Y(v), 4, 0, 7); g.fill();
      }
      this.tip.innerHTML = `<div style="color:#6b6b70">t = ${fmt(t[i])} s</div>` + vis.map((s) =>
        `<div><span style="display:inline-block;width:10px;height:3px;border-radius:2px;background:${s.color};vertical-align:middle;margin-right:5px"></span>${s.name} = <b>${fmt(s.y[i])}</b>${s.unit ? ' ' + s.unit : ''}</div>`).join('');
      this.tip.style.display = 'block';
      const tw = this.tip.offsetWidth;
      this.tip.style.left = (x + 12 + tw > W ? x - 12 - tw : x + 12) + 'px';
      this.tip.style.top = '8px';
    } else this.tip.style.display = 'none';
  }
}
