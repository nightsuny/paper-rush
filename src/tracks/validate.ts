import type { Centerline } from './Centerline';
import type { TrackConfig } from './types';

export interface ValidationIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  /** 出问题的归一化位置（可选） */
  t?: number;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  stats: {
    length: number;
    minCornerRadius: number;
    maxGrade: number;
    maxBank: number;
    minHalfWidth: number;
    maxHalfWidth: number;
  };
  ok: boolean;
}

/**
 * 赛道自检。运行在测试与开发启动时，保证配置不会产出无法驾驶的赛道。
 *
 * 检查项：
 *  1. 中心线无自交（同层重叠）——高架桥允许，靠竖直净空判定
 *  2. 弯道半径不小于道路半宽（否则路面会打结）
 *  3. 坡度在合理范围
 *  4. 护栏连续、无缺口，且不漏掉关键外侧弯
 *  5. 检查点顺序正确、首尾不重叠
 *  6. 赛程长度与目标时长匹配
 */
export function validateTrack(
  config: TrackConfig,
  centerline: Centerline,
  opts: { targetLapSeconds?: [number, number]; referenceSpeed?: number } = {},
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const samples = centerline.samples;
  const N = samples.length;

  let minRadius = Infinity;
  let minRadiusT = 0;
  let maxGrade = 0;
  let maxBank = 0;
  let minHalfWidth = Infinity;
  let maxHalfWidth = 0;

  for (let i = 0; i < N; i++) {
    const s = samples[i];
    const r = s.curvature > 1e-6 ? 1 / s.curvature : Infinity;
    if (r < minRadius) {
      minRadius = r;
      minRadiusT = s.s / centerline.totalLength;
    }
    maxGrade = Math.max(maxGrade, Math.abs(s.grade));
    maxBank = Math.max(maxBank, Math.abs(s.bank));
    minHalfWidth = Math.min(minHalfWidth, s.halfWidth);
    maxHalfWidth = Math.max(maxHalfWidth, s.halfWidth);
  }

  // 1) 弯道半径 vs 半宽
  // 半径过小会让内侧路面自交。经验阈值：半径 >= 1.6 × 半宽 才能生成干净的路面。
  const radiusThreshold = Math.max(minHalfWidth * 1.6, 5);
  if (minRadius < radiusThreshold) {
    issues.push({
      code: 'corner-too-tight',
      severity: 'error',
      message: `最小弯道半径 ${minRadius.toFixed(1)} m 小于安全阈值 ${radiusThreshold.toFixed(1)} m（会生成自交路面）`,
      t: minRadiusT,
    });
  }

  // 2) 坡度
  if (maxGrade > 0.42) {
    issues.push({
      code: 'grade-too-steep',
      severity: 'error',
      message: `最大坡度 ${(Math.atan(maxGrade) * 180 / Math.PI).toFixed(1)}° 超过 23° 上限`,
    });
  } else if (maxGrade > 0.3) {
    issues.push({
      code: 'grade-steep',
      severity: 'warning',
      message: `最大坡度 ${(Math.atan(maxGrade) * 180 / Math.PI).toFixed(1)}°，接近上限`,
    });
  }

  // 3) 超高不应过大（纸艺风格下过大会让车滑出去）
  if (maxBank > config.maxBank + 1e-3) {
    issues.push({
      code: 'bank-exceeds-max',
      severity: 'error',
      message: `实际超高 ${maxBank.toFixed(3)} rad 超过配置上限 ${config.maxBank}`,
    });
  }

  // 4) 自交 / 高架重叠检查（只在 XZ 平面接近时才算问题，除非竖直净空足够）
  const step = Math.max(1, Math.round(N / 420));
  const minClearance = 4.5;
  const sampled: number[] = [];
  for (let i = 0; i < N; i += step) sampled.push(i);
  let overlapCount = 0;
  let worstOverlap = Infinity;
  let worstT = 0;
  for (let a = 0; a < sampled.length; a++) {
    for (let b = a + 1; b < sampled.length; b++) {
      const i = sampled[a];
      const j = sampled[b];
      // 沿赛道距离太近的两点本来就该挨在一起，按弧长间隔排除
      const si0 = samples[i];
      const sj0 = samples[j];
      const alongTrack = Math.abs(i - j) * (centerline.totalLength / N);
      const alongTrackWrapped = Math.min(alongTrack, centerline.totalLength - alongTrack);
      if (alongTrackWrapped < (si0.halfWidth + sj0.halfWidth) * 1.2 + 12) continue;
      const si = samples[i];
      const sj = samples[j];
      const planar = Math.hypot(si.x - sj.x, si.z - sj.z);
      const need = (si.halfWidth + sj.halfWidth) * 0.9;
      if (planar < need) {
        const vertical = Math.abs(si.y - sj.y);
        if (vertical < minClearance) {
          overlapCount++;
          if (vertical < worstOverlap) {
            worstOverlap = vertical;
            worstT = si.s / centerline.totalLength;
          }
        }
      }
    }
  }
  if (overlapCount > 0) {
    issues.push({
      code: 'self-overlap',
      severity: 'error',
      message: `中心线有 ${overlapCount} 处同层自重叠（最近竖直净空仅 ${worstOverlap.toFixed(2)} m，需要 ≥ ${minClearance} m 才能当高架处理）`,
      t: worstT,
    });
  }

  // 5) 检查点顺序与分布
  const cps = config.checkpoints;
  if (cps.length < 4) {
    issues.push({ code: 'too-few-checkpoints', severity: 'error', message: `检查点只有 ${cps.length} 个，至少需要 4 个才能防止抄近道` });
  }
  for (let i = 0; i < cps.length; i++) {
    if (cps[i].t <= 0 || cps[i].t >= 1) {
      issues.push({ code: 'checkpoint-range', severity: 'error', message: `检查点 #${i} 的 t=${cps[i].t} 必须在 (0,1) 内` });
    }
    if (i > 0 && cps[i].t <= cps[i - 1].t) {
      issues.push({ code: 'checkpoint-order', severity: 'error', message: `检查点 #${i} (t=${cps[i].t}) 顺序错误，必须严格递增` });
    }
    if (cps[i].halfWidth < samples[0].halfWidth * 0.95) {
      issues.push({
        code: 'checkpoint-narrow',
        severity: 'warning',
        message: `检查点 #${i} 判定半宽 ${cps[i].halfWidth} 小于道路半宽，正常行驶可能漏判`,
      });
    }
  }
  if (cps.length > 0) {
    const last = cps[cps.length - 1].t;
    if (last > 0.97) {
      issues.push({ code: 'checkpoint-tail', severity: 'warning', message: `最后一个检查点 t=${last} 太靠近终点线，容易与计圈重叠` });
    }
    const first = cps[0].t;
    if (first < 0.02) {
      issues.push({ code: 'checkpoint-head', severity: 'warning', message: `第一个检查点 t=${first} 太靠近起点线` });
    }
  }

  // 6) 护栏：连续覆盖 + 无缺口
  for (const g of config.guardrails) {
    if (g.to <= g.from) {
      issues.push({ code: 'guardrail-range', severity: 'error', message: `护栏段 [${g.from}, ${g.to}] 区间无效` });
    }
    const spanMeters = (g.to - g.from) * centerline.totalLength;
    if (spanMeters < 3) {
      issues.push({ code: 'guardrail-short', severity: 'warning', message: `护栏段 [${g.from}, ${g.to}] 只有 ${spanMeters.toFixed(1)} m，起不到防护作用` });
    }
  }
  // 陡坡/急弯外侧没有护栏要提示
  for (let i = 0; i < N; i += Math.max(1, Math.floor(N / 200))) {
    const s = samples[i];
    const t = s.s / centerline.totalLength;
    const needsGuard = (s.signedCurvature > 0.012 || s.signedCurvature < -0.012) && Math.abs(s.grade) > 0.06;
    if (!needsGuard) continue;
    const covered = config.guardrails.some((g) => {
      const span = g.to > g.from ? t >= g.from && t <= g.to : t >= g.from || t <= g.to;
      const sideOk = g.side === 'both' || (g.side === 'right' ? s.signedCurvature > 0 : s.signedCurvature < 0);
      return span && sideOk;
    });
    if (!covered) {
      issues.push({
        code: 'guardrail-gap',
        severity: 'warning',
        message: `t=${t.toFixed(3)} 处是带坡度的弯道外侧，但没有护栏`,
        t,
      });
      break;
    }
  }

  // 7) 赛程时长估算
  const [lo, hi] = opts.targetLapSeconds ?? [180, 300];
  const refSpeed = opts.referenceSpeed ?? 22; // m/s，约 80 km/h 的赛道平均速度
  const lapSeconds = centerline.totalLength / refSpeed;
  const totalSeconds = lapSeconds * config.laps;
  if (totalSeconds < lo || totalSeconds > hi) {
    issues.push({
      code: 'race-duration-out-of-range',
      severity: totalSeconds < lo * 0.7 || totalSeconds > hi * 1.3 ? 'error' : 'warning',
      message:
        `预计赛程 ${totalSeconds.toFixed(0)} s（单圈 ${lapSeconds.toFixed(0)} s × ${config.laps} 圈）` +
        `不在目标 ${lo}–${hi} s 区间内`,
    });
  }

  return {
    issues,
    stats: {
      length: centerline.totalLength,
      minCornerRadius: minRadius,
      maxGrade,
      maxBank,
      minHalfWidth,
      maxHalfWidth,
    },
    ok: !issues.some((i) => i.severity === 'error'),
  };
}

/** 估算赛程时长（秒），供选赛道界面与平衡文档使用。 */
export function estimateRaceSeconds(lengthMeters: number, laps: number, avgSpeedMs = 22): number {
  return (lengthMeters / avgSpeedMs) * laps;
}
