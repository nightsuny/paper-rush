import type { TrackConfig } from '../types';
import { MEADOW } from './meadow';

/**
 * 赛道目录。
 *
 * 阶段一只有"雏菊草甸"一条完整赛道；另外三张地图（纸桥海湾 / 秋叶山道 / 星光环城）
 * 属于阶段四，此处不预先放占位配置，避免出现"看起来有但进不去"的选项。
 */
export const TRACKS: readonly TrackConfig[] = [MEADOW];

export function findTrack(id: string): TrackConfig | undefined {
  return TRACKS.find((t) => t.id === id);
}

export { MEADOW };
