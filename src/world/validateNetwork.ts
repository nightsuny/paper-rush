import type { RoadNetwork } from './RoadNetwork';
import { ROAD_KINDS, type RegionConfig, type RoadSegmentConfig } from './types';

/**
 * 路网自检。
 *
 * 开放世界最怕的不是"画错了"，而是**路不通**或**悄悄重叠**：
 * 前者玩家开到一半发现是死路，后者会出现两块路面互相穿插的鬼影。
 * 这两类问题都很难靠肉眼看出来，所以在测试里数值化检查。
 *
 * 检查项：
 *  1. 连通性：所有路段必须属于同一个连通分量（通过端点相接或端点丁在另一条路上）
 *  2. 悬空端：开放路段的端头必须接上别的路，或者是闸口/断头路
 *  3. 非路口重叠：两条路的中心线不得在**非路口**处靠得比两者半宽之和还近
 *  4. 路口有效性：声明的每个路口都必须真的有路接过来
 */

export interface NetworkIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  /** 涉及的路段 id */
  segments?: string[];
}

export interface NetworkReport {
  issues: NetworkIssue[];
  stats: {
    segmentCount: number;
    totalLength: number;
    /** 连通分量个数（应为 1） */
    components: number;
    junctionCount: number;
    gateCount: number;
    deadEndCount: number;
    /** 最长的连通分量包含多少条路段 */
    largestComponent: number;
    /** 相接处高差超限的接点个数（应为 0） */
    elevationMismatches: number;
  };
  ok: boolean;
}

export interface ValidateNetworkOptions {
  /** 端点视为"接上"的距离容差（米） */
  joinTolerance?: number;
  /** 判定"属于某个路口"的半径（米），该范围内的重叠不报错 */
  junctionRadius?: number;
  /**
   * 相接的两条路在接点处的**允许高差**（米）。超过即报错。
   * 真实世界里路口/丁字口必然同高；高差不一致是"地形把较低那条路埋掉"的直接根因。
   */
  elevationTolerance?: number;
}

export function validateNetwork(
  config: RegionConfig,
  network: RoadNetwork,
  opts: ValidateNetworkOptions = {},
): NetworkReport {
  const joinTol = opts.joinTolerance ?? 6;
  const issues: NetworkIssue[] = [];
  const segs = config.roads;
  const n = segs.length;

  // ---- 端点世界坐标 ----
  const endpoints: Array<{ x: number; z: number; y: number; seg: number; which: 0 | 1 }> = [];
  for (let i = 0; i < n; i++) {
    const cfg = segs[i];
    if (cfg.closed === true) continue;
    const pts = cfg.points;
    const a = pts[0];
    const b = pts[pts.length - 1];
    endpoints.push({ x: a.x, z: a.z, y: a.y, seg: i, which: 0 });
    endpoints.push({ x: b.x, z: b.z, y: b.y, seg: i, which: 1 });
  }

  // ---- 并查集 ----
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => {
    let x = a;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // 端点与端点相接
  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      const a = endpoints[i];
      const b = endpoints[j];
      if (a.seg === b.seg) continue;
      if (Math.hypot(a.x - b.x, a.z - b.z) <= joinTol) union(a.seg, b.seg);
    }
  }
  // 端点丁在另一条路上（T 字口）
  const teeJoins: Array<{ from: number; to: number; d: number }> = [];
  for (const ep of endpoints) {
    for (let k = 0; k < n; k++) {
      if (k === ep.seg) continue;
      const proj = network.projectOnSegment(k, ep.x, ep.z);
      if (proj.distance <= joinTol + 1) {
        union(ep.seg, k);
        teeJoins.push({ from: ep.seg, to: k, d: proj.distance });
      }
    }
  }

  // ---- 1) 高程一致性 ----
  // 实测出来的穿模根因：两条路在接点高差 1~6 m 时，地形"走廊压平"只能取一个高度，
  // 于是较低那条被草地埋掉（实测最严重 5.81 m）、较高那条的边坡悬空。
  // 真实世界里路口与丁字口必然同高，所以这里按错误处理，逼着布局数据自己长对。
  const elevTol = opts.elevationTolerance ?? 0.75;
  const elevBad: Array<{ a: string; b: string; dy: number; at: string }> = [];
  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      const a = endpoints[i];
      const b = endpoints[j];
      if (a.seg === b.seg) continue;
      if (Math.hypot(a.x - b.x, a.z - b.z) > joinTol) continue;
      const dy = Math.abs(a.y - b.y);
      if (dy > elevTol) {
        elevBad.push({
          a: segs[a.seg].id,
          b: segs[b.seg].id,
          dy,
          at: `端点 (${a.x.toFixed(0)},${a.z.toFixed(0)})`,
        });
      }
    }
  }
  // 丁字口：端点高程 vs 被丁上去那条路在该点的高程
  for (const e of endpoints) {
    for (let k = 0; k < n; k++) {
      if (k === e.seg) continue;
      const proj = network.projectOnSegment(k, e.x, e.z);
      if (proj.distance > joinTol + 1) continue;
      const hostY = network.curves[k].samples[proj.index].y;
      const dy = Math.abs(e.y - hostY);
      if (dy > elevTol) {
        elevBad.push({
          a: segs[e.seg].id,
          b: segs[k].id,
          dy,
          at: `丁字口 (${e.x.toFixed(0)},${e.z.toFixed(0)})`,
        });
      }
    }
  }
  const elevSeen = new Set<string>();
  const elevUnique = elevBad.filter((p) => {
    const key = `${p.a}|${p.b}|${p.at}`;
    if (elevSeen.has(key)) return false;
    elevSeen.add(key);
    return true;
  });
  if (elevUnique.length > 0) {
    issues.push({
      code: 'elevation',
      severity: 'error',
      message:
        `有 ${elevUnique.length} 处接点两侧高程不一致（容差 ${elevTol} m），` +
        `会让地形埋掉较低的那条路：` +
        elevUnique
          .slice(0, 8)
          .map((p) => `${p.a}↔${p.b} 差 ${p.dy.toFixed(2)}m @ ${p.at}`)
          .join('；'),
      segments: [...new Set(elevUnique.flatMap((p) => [p.a, p.b]))],
    });
  }

  // ---- 2) 连通性 ----
  const roots = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = roots.get(r) ?? [];
    list.push(i);
    roots.set(r, list);
  }
  const components = roots.size;
  let largest = 0;
  for (const list of roots.values()) largest = Math.max(largest, list.length);
  if (components > 1) {
    const groups = [...roots.values()].map((list) => list.map((i) => segs[i].id).join(','));
    issues.push({
      code: 'disconnected',
      severity: 'error',
      message: `路网有 ${components} 个互不相连的部分：${groups.map((g) => `[${g}]`).join(' ')}`,
    });
  }

  // ---- 2) 悬空端 ----
  let deadEnds = 0;
  for (const ep of endpoints) {
    const cfg = segs[ep.seg];
    const isStart = Math.hypot(cfg.points[0].x - ep.x, cfg.points[0].z - ep.z) < 1e-6;
    const endKind = isStart ? cfg.ends?.start : cfg.ends?.end;
    if (endKind === 'dead') {
      deadEnds++;
      continue;
    }
    let connected = false;
    for (const other of endpoints) {
      if (other.seg === ep.seg) continue;
      if (Math.hypot(other.x - ep.x, other.z - ep.z) <= joinTol) {
        connected = true;
        break;
      }
    }
    if (!connected) {
      // 端点是否落在任意另一条路上（含闭合环线的中段）
      let onOther = false;
      for (let k = 0; k < n && !onOther; k++) {
        if (k === ep.seg) continue;
        if (network.projectOnSegment(k, ep.x, ep.z).distance <= joinTol + 1) onOther = true;
      }
      // 是否靠近某个闸口（闸口允许是悬空端，它通向下一区域）
      const nearGate = config.gates.some((g) => Math.hypot(g.x - ep.x, g.z - ep.z) <= joinTol + 8);
      if (!onOther && !nearGate) {
        issues.push({
          code: 'dangling-end',
          severity: 'error',
          message: `路段 ${segs[ep.seg].id} 的端头 (${ep.x.toFixed(0)}, ${ep.z.toFixed(0)}) 没有接上任何路，也不是闸口`,
          segments: [segs[ep.seg].id],
        });
      }
    }
  }

  // ---- 3) 非路口重叠 ----
  // 沿每条路等距采样，检查与其它路的距离。落在路口半径内、或属于丁字口附近的近距接触，
  // 都视为正常；其余近距接触说明两条路真的插在一起了。
  let overlapCount = 0;
  let overlapWorst = Infinity;
  let overlapDesc = '';
  for (let i = 0; i < n; i++) {
    const ci = network.curves[i];
    const hwi = (segs[i].width ?? ROAD_KINDS[segs[i].kind].width) / 2;
    const step = Math.max(1, Math.floor(ci.samples.length / 90));
    for (let s = 0; s < ci.samples.length; s += step) {
      const p = ci.samples[s];
      for (let k = i + 1; k < n; k++) {
        const hwk = (segs[k].width ?? ROAD_KINDS[segs[k].kind].width) / 2;
        const proj = network.projectOnSegment(k, p.x, p.z);
        const near = proj.distance;
        const need = (hwi + hwk) * 0.92;
        if (near >= need) continue;
        // 该处是否属于某个真实路口（两条路都靠近同一个路口中心）
        const isJunction = config.junctions.some((j) => {
          const di = Math.hypot(p.x - j.x, p.z - j.z);
          const dk = Math.hypot(proj.t * 0 + (network.curves[k].samples[proj.index].x - j.x), network.curves[k].samples[proj.index].z - j.z);
          return di <= j.radius + 2 && dk <= j.radius + 2;
        });
        // 或者该处靠近某条路的端头（T 字口：一条路的端头插进另一条路）
        const nearAnEnd =
          endpoints.some((ep) => Math.hypot(ep.x - p.x, ep.z - p.z) <= joinTol + 4) ||
          teeJoins.some((tj) => tj.d <= joinTol + 1);
        if (isJunction || nearAnEnd) continue;
        overlapCount++;
        if (near < overlapWorst) {
          overlapWorst = near;
          overlapDesc = `${segs[i].id} 与 ${segs[k].id} 在 (${p.x.toFixed(0)}, ${p.z.toFixed(0)}) 处仅相距 ${near.toFixed(1)} m（需要 ≥ ${need.toFixed(1)} m）`;
        }
      }
    }
  }
  if (overlapCount > 0) {
    issues.push({
      code: 'segment-overlap',
      severity: 'error',
      message: `有 ${overlapCount} 处非路口重叠：${overlapDesc}`,
    });
  }

  // ---- 4) 路口有效性 ----
  for (const j of config.junctions) {
    let touching = 0;
    for (let i = 0; i < n; i++) {
      const proj = network.projectOnSegment(i, j.x, j.z);
      if (proj.distance <= j.radius + 6) touching++;
    }
    if (touching < 2) {
      issues.push({
        code: 'empty-junction',
        severity: 'error',
        message: `路口 ${j.id} (${j.x}, ${j.z}) 只有 ${touching} 条路经过，接头少于 2 条`,
      });
    }
  }

  return {
    issues,
    stats: {
      segmentCount: n,
      totalLength: network.totalLength,
      components,
      junctionCount: config.junctions.length,
      gateCount: config.gates.length,
      deadEndCount: deadEnds,
      largestComponent: largest,
      elevationMismatches: elevUnique.length,
    },
    ok: !issues.some((i) => i.severity === 'error'),
  };
}

/** 供布局自检使用：把路段端点列出来。 */
export function segmentEndpoints(seg: RoadSegmentConfig): {
  start: { x: number; z: number };
  end: { x: number; z: number };
} {
  const pts = seg.points;
  return {
    start: { x: pts[0].x, z: pts[0].z },
    end: { x: pts[pts.length - 1].x, z: pts[pts.length - 1].z },
  };
}
