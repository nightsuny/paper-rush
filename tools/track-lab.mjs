/**
 * 赛道几何实验室（开发工具，不参与运行时构建）。
 *
 *   node tools/track-lab.mjs            评估内置候选
 *   node tools/track-lab.mjs --emit S3  输出 S3 候选的控制点 TS 代码
 *
 * 用途：在写进 src/tracks/catalog/*.ts 之前，先用数值方式确认
 * 长度、最小弯道半径、坡度、自重叠、曲率分布是否可驾驶。
 */
import { writeFileSync } from 'node:fs';

function buildPoints(Rx, Rz, p, harmonics, elev, count) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const th = (i / count) * Math.PI * 2;
    const c = Math.abs(Math.cos(th));
    const s = Math.abs(Math.sin(th));
    let r = 1 / Math.pow(Math.pow(c, p) + Math.pow(s, p), 1 / p);
    let pert = 1;
    for (const h of harmonics) pert += h.a * Math.cos(h.n * th + h.phase);
    r *= pert;
    let y = 0;
    for (const e of elev) y += e.a * Math.sin(e.n * th + e.phase);
    pts.push({
      x: +(r * Math.cos(th) * Rx).toFixed(2),
      y: +y.toFixed(3),
      z: +(r * Math.sin(th) * Rz).toFixed(2),
    });
  }
  return pts;
}

function cr(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** 以 1 米等弧长重采样中心线。 */
function resample(pts) {
  const n = pts.length;
  const sub = 14;
  const rx = [];
  const ry = [];
  const rz = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    const d = pts[(i + 2) % n];
    for (let k = 0; k < sub; k++) {
      const t = k / sub;
      rx.push(cr(a.x, b.x, c.x, d.x, t));
      ry.push(cr(a.y, b.y, c.y, d.y, t));
      rz.push(cr(a.z, b.z, c.z, d.z, t));
    }
  }
  const m = rx.length;
  const cum = [0];
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    cum.push(cum[i] + Math.hypot(rx[j] - rx[i], rz[j] - rz[i]));
  }
  const total = cum[m];
  const cnt = Math.max(64, Math.round(total));
  const step = total / cnt;
  const S = [];
  let cur = 0;
  for (let i = 0; i < cnt; i++) {
    const tg = i * step;
    while (cur < m - 1 && cum[cur + 1] < tg) cur++;
    const seg = Math.max(cum[cur + 1] - cum[cur], 1e-9);
    const f = (tg - cum[cur]) / seg;
    const a = cur % m;
    const b = (cur + 1) % m;
    S.push({
      x: rx[a] + (rx[b] - rx[a]) * f,
      y: ry[a] + (ry[b] - ry[a]) * f,
      z: rz[a] + (rz[b] - rz[a]) * f,
    });
  }
  return S;
}

function analyze(pts, halfWidth = 6) {
  const S = resample(pts);
  const N = S.length;
  const T = [];
  for (let i = 0; i < N; i++) {
    const pv = S[(i - 1 + N) % N];
    const nx = S[(i + 1) % N];
    let dx = nx.x - pv.x;
    let dz = nx.z - pv.z;
    const l = Math.max(Math.hypot(dx, dz), 1e-9);
    T.push({ x: dx / l, z: dz / l });
  }
  let minR = Infinity;
  let minRt = 0;
  let maxGrade = 0;
  const radii = [];
  for (let i = 0; i < N; i++) {
    const pv = S[(i - 1 + N) % N];
    const nx = S[(i + 1) % N];
    maxGrade = Math.max(maxGrade, Math.abs((nx.y - pv.y) / 2));
    const a = T[(i - 1 + N) % N];
    const b = T[(i + 1) % N];
    const dTx = b.x - a.x;
    const dTz = b.z - a.z;
    // 右向 = (-tz, tx)，曲率 = 切向变化在右向上的投影 / 弧长
    const k = Math.abs(dTx * T[i].z - dTz * T[i].x) / 2;
    const r = k > 1e-6 ? 1 / k : 99999;
    radii.push(r);
    if (r < minR) {
      minR = r;
      minRt = i / N;
    }
  }
  let overlap = 0;
  let worst = Infinity;
  const minSep = halfWidth * 2 * 1.2 + 12;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const along = Math.abs(i - j);
      const wrapped = Math.min(along, N - along);
      if (wrapped < minSep) continue;
      const d = Math.hypot(S[i].x - S[j].x, S[i].z - S[j].z);
      if (d < halfWidth * 2 * 0.9) {
        const v = Math.abs(S[i].y - S[j].y);
        if (v < 4.5) {
          overlap++;
          if (v < worst) worst = v;
        }
      }
    }
  }
  const sorted = [...radii].sort((a, b) => a - b);
  const q = (f) => sorted[Math.floor(f * (sorted.length - 1))];
  return {
    total: S.length,
    minR,
    minRt,
    maxGrade,
    overlap,
    worst,
    q05: q(0.05),
    q25: q(0.25),
    median: q(0.5),
    q75: q(0.75),
    straightRatio: radii.filter((r) => r > 150).length / N,
    cornerRatio: radii.filter((r) => r < 60).length / N,
  };
}

const CANDIDATES = [
  ['S1', [200, 155, 3.0, [{ a: 0.14, n: 3, phase: 0.45 }, { a: 0.08, n: 4, phase: 1.15 }, { a: 0.05, n: 2, phase: 2.4 }], [{ a: 3.0, n: 2, phase: 0.25 }, { a: 1.8, n: 3, phase: 1.05 }, { a: 0.7, n: 5, phase: 0.35 }], 26]],
  ['S2', [185, 145, 2.8, [{ a: 0.15, n: 3, phase: 0.45 }, { a: 0.09, n: 4, phase: 1.15 }, { a: 0.05, n: 2, phase: 2.4 }], [{ a: 3.2, n: 2, phase: 0.25 }, { a: 1.9, n: 3, phase: 1.05 }, { a: 0.7, n: 5, phase: 0.35 }], 26]],
  ['S3', [175, 140, 2.8, [{ a: 0.16, n: 3, phase: 0.45 }, { a: 0.10, n: 4, phase: 1.15 }, { a: 0.06, n: 2, phase: 2.4 }], [{ a: 3.4, n: 2, phase: 0.25 }, { a: 2.0, n: 3, phase: 1.05 }, { a: 0.8, n: 5, phase: 0.35 }], 26]],
  ['S4', [195, 150, 3.0, [{ a: 0.16, n: 3, phase: 0.45 }, { a: 0.10, n: 4, phase: 1.15 }, { a: 0.04, n: 2, phase: 2.4 }], [{ a: 3.0, n: 2, phase: 0.25 }, { a: 1.8, n: 3, phase: 1.05 }, { a: 0.7, n: 5, phase: 0.35 }], 26]],
  ['S5', [170, 135, 2.6, [{ a: 0.15, n: 3, phase: 0.45 }, { a: 0.09, n: 4, phase: 1.15 }, { a: 0.05, n: 2, phase: 2.4 }], [{ a: 3.2, n: 2, phase: 0.25 }, { a: 1.8, n: 3, phase: 1.05 }, { a: 0.7, n: 5, phase: 0.35 }], 26]],
  ['S6', [180, 145, 3.0, [{ a: 0.18, n: 3, phase: 0.45 }, { a: 0.11, n: 4, phase: 1.15 }, { a: 0.05, n: 2, phase: 2.4 }], [{ a: 3.4, n: 2, phase: 0.25 }, { a: 2.0, n: 3, phase: 1.05 }, { a: 0.8, n: 5, phase: 0.35 }], 26]],
];

const emitArg = process.argv.indexOf('--emit');
const emitted = emitArg >= 0 ? process.argv[emitArg + 1] : null;

let lines = [];
for (const [name, cfg] of CANDIDATES) {
  const pts = buildPoints(...cfg);
  const a = analyze(pts);
  lines.push(
    `${name}: 长度=${a.total.toFixed(0)}m 最小半径=${a.minR.toFixed(1)}m@t=${a.minRt.toFixed(2)} ` +
      `坡度=${((Math.atan(a.maxGrade) * 180) / Math.PI).toFixed(1)}° 重叠=${a.overlap} ` +
      `半径分位[5%=${a.q05.toFixed(0)} 25%=${a.q25.toFixed(0)} 中位=${a.median.toFixed(0)} 75%=${a.q75.toFixed(0)}] ` +
      `近直线=${(a.straightRatio * 100).toFixed(0)}% 弯道=${(a.cornerRatio * 100).toFixed(0)}%`,
  );
}
console.log(lines.join('\n'));

if (emitted) {
  const entry = CANDIDATES.find((c) => c[0] === emitted);
  if (!entry) {
    console.error(`没有候选 ${emitted}`);
    process.exit(1);
  }
  const pts = buildPoints(...entry[1]);
  const body =
    `// ${emitted} 参数: ${JSON.stringify(entry[1].slice(0, 3))} 谐波=${JSON.stringify(entry[1][3])} 高程=${JSON.stringify(entry[1][4])}\n` +
    `const POINTS_${emitted} = [\n` +
    pts.map((p) => `  { x: ${p.x}, y: ${p.y}, z: ${p.z} },`).join('\n') +
    `\n];\n`;
  writeFileSync(new URL(`../tools/emit-${emitted}.txt`, import.meta.url), body);
  console.log(`\n已写出 tools/emit-${emitted}.txt`);
}
