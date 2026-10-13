import type { ControlPoint } from '../tracks/types';
import type { RoadSegmentConfig, RoadKind, RegionGateConfig } from './types';

/**
 * 路段生成器。
 *
 * 手工把 10+ km 路网的每个控制点都写出来既不现实也容易出错（端点对不齐 → 路不通）。
 * 这里把"连接两个锚点"变成一次函数调用：
 *  - 端点**精确**落在锚点坐标上，因此共享锚点的路段必然连通
 *  - 中间控制点按正弦横向偏移生成弯道（1 个波 = C 形弯，2 个波 = S 形弯）
 *  - 高程可两端分别给定，中间按正弦起伏
 * 全部为确定性计算（无随机），同参数结果完全一致。
 */

export interface LinkOptions {
  /** 控制点个数（含两端），默认 6 */
  nodes?: number;
  /** 侧向弯曲幅度（米）。正负决定弯向；0 = 直线 */
  bend?: number;
  /** 弯曲波数：1 = 单峰（C 形），2 = 双峰（S 形） */
  waves?: number;
  /** 高程起伏幅度（米） */
  lift?: number;
  /** 起点高程（米） */
  yStart?: number;
  /** 终点高程（米） */
  yEnd?: number;
  /** 该路段沿线的 biome（决定装饰种类） */
  biome?: RoadSegmentConfig['biome'];
}

/** 生成一条连接 from→to 的控制点序列（端点精确落在锚点上）。 */
export function linkPoints(
  from: readonly [number, number],
  to: readonly [number, number],
  opts: LinkOptions = {},
): ControlPoint[] {
  const nodes = Math.max(2, opts.nodes ?? 6);
  const bend = opts.bend ?? 0;
  const waves = opts.waves ?? 1;
  const lift = opts.lift ?? 0;
  const y0 = opts.yStart ?? 0;
  const y1 = opts.yEnd ?? 0;

  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const len = Math.max(Math.hypot(dx, dz), 1e-6);
  // 左法向（用于施加弯曲）
  const nx = -dz / len;
  const nz = dx / len;

  const out: ControlPoint[] = [];
  for (let i = 0; i < nodes; i++) {
    const t = i / (nodes - 1);
    // sin(πt) 在两端为 0 → 端点不偏移，保证连通
    const side = Math.sin(Math.PI * t * waves) * bend;
    const y = y0 + (y1 - y0) * t + Math.sin(Math.PI * t * waves) * lift;
    out.push({
      x: +(from[0] + dx * t + nx * side).toFixed(2),
      y: +y.toFixed(3),
      z: +(from[1] + dz * t + nz * side).toFixed(2),
    });
  }
  return out;
}

/** 便捷封装：直接产出一条路段配置。 */
export function link(
  id: string,
  kind: RoadKind,
  from: readonly [number, number],
  to: readonly [number, number],
  opts: LinkOptions & {
    closed?: boolean;
    width?: number;
    surface?: string;
    guardrails?: RoadSegmentConfig['guardrails'];
  } = {},
): RoadSegmentConfig {
  return {
    id,
    kind,
    points: linkPoints(from, to, opts),
    closed: opts.closed ?? false,
    biome: opts.biome,
    ...(opts.width !== undefined ? { width: opts.width } : {}),
    ...(opts.surface !== undefined ? { surface: opts.surface } : {}),
    ...(opts.guardrails !== undefined ? { guardrails: opts.guardrails } : {}),
    ends: opts.closed ? undefined : { start: 'junction', end: 'junction' },
  };
}

/** 生成一个闭合圆环的控制点（环岛环线、村庄小环）。 */
export function ringPoints(
  cx: number,
  cz: number,
  radius: number,
  y = 0,
  count = 20,
): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out.push({
      x: +(cx + Math.cos(a) * radius).toFixed(2),
      y,
      z: +(cz + Math.sin(a) * radius).toFixed(2),
    });
  }
  return out;
}

/** 便捷封装：闭合环线路段（两端自然相连）。 */
export function ring(
  id: string,
  kind: RoadKind,
  cx: number,
  cz: number,
  radius: number,
  opts: { y?: number; width?: number; surface?: string; biome?: RoadSegmentConfig['biome'] } = {},
): RoadSegmentConfig {
  return {
    id,
    kind,
    points: ringPoints(cx, cz, radius, opts.y ?? 0),
    closed: true,
    biome: opts.biome,
    ...(opts.width !== undefined ? { width: opts.width } : {}),
    ...(opts.surface !== undefined ? { surface: opts.surface } : {}),
  };
}

/** 便捷封装：区域出口闸口。 */
export function gate(
  id: string,
  x: number,
  z: number,
  heading: number,
  label: string,
  toRegion?: string,
): RegionGateConfig {
  return { id, x, z, heading, label, ...(toRegion !== undefined ? { toRegion } : {}) };
}

/** 平面距离（用于布局自检）。 */
export function dist2(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
