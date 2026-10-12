import type { ControlPoint } from '../../tracks/types';
import type { JunctionConfig, RegionConfig, RoadSegmentConfig } from '../types';

/**
 * 区域骨架（S1）：先把「多路段 + 路口 + 空气墙 + 闸口」这套架构跑通。
 *
 * 布局（俯视，+X 东，+Z 南）：
 *
 *                 ┌─────────────────────────────┐
 *                 │              ▲ 闸口(通下一区) │
 *                 │            ┌─┴─┐             │
 *                 │            │北 │             │
 *                 │            │主 │             │
 *                 │   西林道 ──┤环岛├── 东次干道   │
 *                 │            │南 │             │
 *                 │            │主 │             │
 *                 │            └─┬─┘             │
 *                 │         出生点               │
 *                 └─────────────────────────────┘
 *
 * 全长约 2.9 km（环岛环线 0.13 + 四条放射路 2.8）。
 * 景观与村庄在 S2 补，S1 只保证几何、碰撞、连通与边界正确。
 */

/** 生成环岛环线的控制点（闭合路段）。 */
function ringPoints(radius: number, count = 16, y = 0): ControlPoint[] {
  const out: ControlPoint[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out.push({ x: +(Math.cos(a) * radius).toFixed(2), y, z: +(Math.sin(a) * radius).toFixed(2) });
  }
  return out;
}

const RING_RADIUS = 21;
const ISLAND_RADIUS = 12;

const MAIN_SOUTH: ControlPoint[] = [
  { x: -6, y: 6.4, z: 640 },
  { x: 2, y: 5.6, z: 540 },
  { x: 0, y: 4.5, z: 430 },
  { x: 7, y: 4.0, z: 360 },
  { x: 11, y: 3.0, z: 288 },
  { x: 3, y: 2.2, z: 216 },
  { x: -10, y: 1.4, z: 148 },
  { x: -6, y: 0.6, z: 86 },
  { x: 0, y: 0, z: 26 },
];

const MAIN_NORTH: ControlPoint[] = [
  { x: 0, y: 0, z: -26 },
  { x: 9, y: 0.8, z: -92 },
  { x: 15, y: 1.8, z: -172 },
  { x: 7, y: 2.6, z: -252 },
  { x: -9, y: 3.2, z: -334 },
  { x: 0, y: 3.6, z: -430 },
  { x: 6, y: 4.4, z: -540 },
  { x: 0, y: 5.2, z: -680 },
  { x: -4, y: 5.8, z: -760 },
  { x: 0, y: 6.2, z: -860 },
];

const EAST_SECONDARY: ControlPoint[] = [
  { x: 26, y: 0, z: 0 },
  { x: 92, y: 0.4, z: 9 },
  { x: 172, y: 1.2, z: 17 },
  { x: 252, y: 1.6, z: 4 },
  { x: 332, y: 1.2, z: -15 },
  { x: 430, y: 0.6, z: -32 },
  { x: 540, y: 1.4, z: -56 },
  { x: 660, y: 2.4, z: -70 },
];

const WEST_DIRT: ControlPoint[] = [
  { x: -26, y: 0, z: 0 },
  { x: -92, y: 0.6, z: -7 },
  { x: -172, y: 1.6, z: -17 },
  { x: -252, y: 2.2, z: -4 },
  { x: -332, y: 2.0, z: 27 },
  { x: -430, y: 1.4, z: 62 },
  { x: -540, y: 2.6, z: 92 },
  { x: -660, y: 3.6, z: 104 },
];

const ROUNDABOUT: JunctionConfig = {
  id: 'roundabout-main',
  kind: 'roundabout',
  x: 0,
  z: 0,
  y: 0,
  radius: 30,
  islandRadius: ISLAND_RADIUS,
  islandHeight: 0.45,
};

const ROADS: RoadSegmentConfig[] = [
  {
    id: 'main-south',
    kind: 'primary',
    points: MAIN_SOUTH,
    ends: { start: 'gate', end: 'junction' },
    // 南段靠边界处临水，加一段护栏
    guardrails: [{ from: 0.0, to: 0.12, side: 'both', offset: 8.5 }],
  },
  {
    id: 'main-north',
    kind: 'primary',
    points: MAIN_NORTH,
    ends: { start: 'junction', end: 'gate' },
    guardrails: [{ from: 0.86, to: 1.0, side: 'both', offset: 8.5 }],
  },
  {
    id: 'east-secondary',
    kind: 'secondary',
    points: EAST_SECONDARY,
    ends: { start: 'junction', end: 'dead' },
  },
  {
    id: 'west-dirt',
    kind: 'dirt',
    points: WEST_DIRT,
    ends: { start: 'junction', end: 'dead' },
  },
  // 环岛环线放在最后：重叠处让直行路段在上层，车道线看起来是连续的
  {
    id: 'roundabout-ring',
    kind: 'secondary',
    points: ringPoints(RING_RADIUS),
    closed: true,
    width: 10,
  },
];

export const REGION_SKELETON: RegionConfig = {
  id: 'region-1-skeleton',
  name: '郊野试验区',
  subtitle: '路网骨架 · 环岛 · 通行闸口',
  theme: {
    biome: 'meadow',
    skyTop: 0x9ecbe8,
    skyBottom: 0xf3e6c8,
    ambient: 0xfdf3dd,
    sun: 0xfff2d0,
    sunIntensity: 2.05,
    ambientIntensity: 1.15,
    fog: 0xe8e0c8,
    fogNear: 300,
    fogFar: 1100,
    paperGround: 0xbfd98c,
    road: 0xb9b0a0,
    roadEdge: 0x8d8579,
    kerb: 0xd05a4e,
    grass: 0x9dc46a,
    accent: 0xf5f1e4,
    accent2: 0xf0b93f,
    accent3: 0xcf5b4a,
  },
  bounds: { minX: -700, minZ: -720, maxX: 700, maxZ: 680 },
  roads: ROADS,
  junctions: [ROUNDABOUT],
  gates: [
    {
      id: 'gate-north',
      x: 0,
      z: -700,
      heading: Math.PI,
      toRegion: 'region-2',
      label: '通往林地（尚未开放）',
    },
  ],
  collectibles: [],
  timeTrials: [],
  landmarks: [],
  spawn: { segment: 'main-south', t: 0.88, lateral: 2.5 },
  seed: 20260301,
  terrainAmplitude: 1.8,
  terrainScale: 0.0075,
  paperThickness: 0.05,
};

export const REGION_SKELETON_ROAD_IDS = ROADS.map((r) => r.id);
