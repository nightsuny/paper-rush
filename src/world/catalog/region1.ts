import type { ControlPoint } from '../../tracks/types';
import { gate, link, ring } from '../linkFactory';
import type { JunctionConfig, LandmarkConfig, RegionConfig, RoadSegmentConfig } from '../types';

/**
 * 区域 1「青野乡」——郊野 + 林地 + 村庄。
 *
 * 布局（俯视，+X 东，+Z 南；单位米）：
 *
 *                      北闸口(通第二区)
 *                           │N2
 *            NW ............N1............ NE
 *             \             │             / \
 *         林区 W3 ── W2     │环岛 HUB     E1 ──┴─┐
 *                                              └─ SE ─ ⇢ 【草甸环线】(闭合,单点接驳,可绕圈)
 *               │    \      │             │
 *               └ W1 ───────┤             │
 *                      S1 ──┘             │
 *                     /  \                │
 *          SW ......./    \.......  SE ...┘
 *                               │
 *                              S2 ── 村口牌坊 ── 【村庄小环】(闭合)
 *
 * 结构：中央环岛枢纽 + 四条主放射 + 一圈外环 + 林区小网 + 村庄小环 + 并入的草甸环线。
 * 所有路口都是"端点对端点"或"端点丁在另一条路上"（link 的端点精确落在锚点上），
 * 连通性与重叠由 validateNetwork 数值校验，不靠肉眼。
 * 全长约 11 km。
 */

// ---------------------------------------------------------------- 锚点
const HUB: [number, number] = [0, 0];
/** 环岛环线半径（中心线） */
const HUB_RING_RADIUS = 21;
/** 主放射路的起点：落在环岛中心线外侧 5 m，保证两者路面临界重叠且端点被判定为相接 */
const HUB_STUB = 26;

const N1: [number, number] = [0, -430];
const N2: [number, number] = [0, -970];
const NW: [number, number] = [-680, -620];
const NE: [number, number] = [680, -620];
const E1: [number, number] = [680, -70];
const SE: [number, number] = [680, 680];
const S1: [number, number] = [0, 430];
const S2: [number, number] = [0, 830];
const VIL: [number, number] = [0, 1010];
const VIL_RADIUS = 80;
const SW: [number, number] = [-680, 680];
const W1: [number, number] = [-430, 30];
const W2: [number, number] = [-830, 210];
const W3: [number, number] = [-830, -210];
/** 草甸环线的平移量：把原来那条 1194 m 的闭环搬到区域东部作为可绕行的环线。 */
const MEADOW_OFFSET: [number, number] = [940, 90];

/**
 * 原「雏菊草甸」赛道的 26 个控制点，整体平移后并入路网。
 * 这样之前已经验证过的那条闭环（长度/曲率/坡度都实测过）直接成为区域的一部分。
 */
const MEADOW_LOOP_POINTS: ControlPoint[] = [
  { x: 210.63, y: 2.85, z: 0 },
  { x: 172.65, y: 5.034, z: 34.28 },
  { x: 134.78, y: 4.679, z: 56.98 },
  { x: 111.39, y: 2.613, z: 79.49 },
  { x: 94.74, y: 0.623, z: 110.57 },
  { x: 67.28, y: -0.357, z: 142.91 },
  { x: 24.68, y: -0.8, z: 163.74 },
  { x: -25.51, y: -1.458, z: 169.21 },
  { x: -76.16, y: -2.187, z: 161.78 },
  { x: -122.4, y: -2.235, z: 142.85 },
  { x: -156.56, y: -1.471, z: 111.73 },
  { x: -169.93, y: -0.751, z: 71.85 },
  { x: -164.42, y: -0.819, z: 32.65 },
  { x: -152.28, y: -1.168, z: 0 },
  { x: -147.79, y: -0.483, z: -29.34 },
  { x: -154.81, y: 1.699, z: -65.45 },
  { x: -158.64, y: 4.13, z: -113.21 },
  { x: -134.54, y: 4.941, z: -157.02 },
  { x: -81.65, y: 3.467, z: -173.43 },
  { x: -23.99, y: 0.743, z: -159.18 },
  { x: 19.8, y: -1.752, z: -131.34 },
  { x: 52.03, y: -3.442, z: -110.52 },
  { x: 91.06, y: -4.522, z: -106.28 },
  { x: 148.22, y: -4.867, z: -105.78 },
  { x: 203.41, y: -3.716, z: -86 },
  { x: 226.47, y: -0.753, z: -44.97 },
].map((p) => ({
  x: +(p.x + MEADOW_OFFSET[0]).toFixed(2),
  y: +(p.y + 0.5).toFixed(3),
  z: +(p.z + MEADOW_OFFSET[1]).toFixed(2),
}));

/**
 * 在环线控制点里找离 (x,z) 最近的顶点。
 *
 * 丁字口必须**精确落在环线上、且与环线同高**。之前这两个接驳点是手写的猜测坐标
 * （[790,88] / [786,20]），实测与环线差 2.25 m 与 1.80 m —— 而地形"走廊压平"只能取
 * 一个高度，于是较低的那条路被草地埋掉。现在位置和高度都从环线数据推导，不可能再错开。
 */
function loopVertexNear(x: number, z: number): ControlPoint {
  let best = MEADOW_LOOP_POINTS[0];
  let bestD = Number.POSITIVE_INFINITY;
  for (const p of MEADOW_LOOP_POINTS) {
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * 草甸环线的接驳点（西南侧）。
 *
 * 环线只留**一条**接入路。原先还有一条 e-conn 从 E1 丁上来，但两条接入路都从同一侧
 * 靠近这个小半径环线（r=21），必然收敛到 9~13 m 且高差 1.9 m —— 实测这是"草地高出
 * 路面"残余 10 处的唯一来源，几何上无法两全。少一条接入路的观感与现实逻辑都更干净。
 */
const MEADOW_TEE_SW = loopVertexNear(786, 20);

// ---------------------------------------------------------------- 路段
const ROADS_BUILT: RoadSegmentConfig[] = [
  // --- 中央环岛枢纽 ---
  ring('hub-ring', 'secondary', HUB[0], HUB[1], HUB_RING_RADIUS, { y: 0.5, width: 10, biome: 'farm' }),

  // --- 四条主放射 ---
  link('hub-n', 'primary', [HUB[0], HUB[1] - HUB_STUB], N1, {
    nodes: 6, bend: 14, lift: 1.2, yStart: 0.5, yEnd: 2.6, biome: 'farm',
  }),
  link('hub-e', 'primary', [HUB[0] + HUB_STUB, HUB[1]], E1, {
    nodes: 6, bend: -16, lift: 1.0, yStart: 0.5, yEnd: 2.0, biome: 'meadow',
  }),
  link('hub-s', 'primary', [HUB[0], HUB[1] + HUB_STUB], S1, {
    nodes: 6, bend: 12, lift: 1.4, yStart: 0.5, yEnd: 3.2, biome: 'farm',
  }),
  link('hub-w', 'secondary', [HUB[0] - HUB_STUB, HUB[1]], W1, {
    nodes: 6, bend: -12, lift: 0.8, yStart: 0.5, yEnd: 1.8, biome: 'meadow',
  }),

  // --- 北主干道 → 闸口 ---
  link('n-mid', 'primary', N1, N2, {
    nodes: 6, bend: 16, lift: 1.6, yStart: 2.6, yEnd: 5.4, biome: 'meadow',
  }),

  // --- 外环：北侧 ---
  link('nw-arc', 'secondary', N1, NW, {
    nodes: 7, bend: -26, lift: 3.0, yStart: 2.6, yEnd: 5.8, biome: 'forest',
  }),
  link('ne-arc', 'secondary', N1, NE, {
    nodes: 7, bend: 26, lift: 2.6, yStart: 2.6, yEnd: 4.4, biome: 'meadow',
  }),
  link('outer-ne', 'secondary', NE, E1, {
    nodes: 6, bend: 18, lift: 1.4, yStart: 4.4, yEnd: 2.0, biome: 'meadow',
  }),

  // --- 外环：南侧 ---
  link('sw-arc', 'secondary', S1, SW, {
    nodes: 7, bend: -22, lift: 2.4, yStart: 3.2, yEnd: 5.0, biome: 'farm',
  }),
  link('se-arc', 'secondary', S1, SE, {
    nodes: 7, bend: 22, lift: 2.2, yStart: 3.2, yEnd: 4.2, biome: 'village',
  }),
  link('outer-s', 'secondary', SE, S2, {
    nodes: 7, bend: -20, lift: 1.8, yStart: 4.2, yEnd: 3.0, biome: 'village',
  }),

  // --- 村庄 ---
  // 村里的路一律是**土路**（kind:'dirt'）：无路缘、无车道线、明显坑洼、窄。
  // 之前这里用的是 'secondary'（8 m 沥青 + 城市车道线 + 红路缘），
  // 所以"村庄"看起来像城市路口 —— 这是最直接的错误。
  link('vil-conn', 'dirt', S2, [VIL[0], VIL[1] - VIL_RADIUS], {
    nodes: 3, lift: 0.4, yStart: 3.0, yEnd: 2.6, biome: 'village',
  }),
  // 村中主街：从南口一路向北穿过整个村子，在环线的**南顶点与北顶点**各形成一个十字口
  // （正好落在环线顶点上，高程也一致，不需要另外对高度）
  link('vil-main', 'dirt', [VIL[0], VIL[1] - VIL_RADIUS], [VIL[0], VIL[1] + VIL_RADIUS + 30], {
    nodes: 4, lift: 0.15, yStart: 2.6, yEnd: 2.5, biome: 'village',
  }),
  ring('village-ring', 'dirt', VIL[0], VIL[1], VIL_RADIUS, {
    y: 2.6, biome: 'village',
  }),
  // 两条东西向小巷：把房子串到主街与环线上，形成"街—巷—院"的层次
  link('vil-lane-west', 'dirt', [VIL[0] - VIL_RADIUS, VIL[1]], [VIL[0] - VIL_RADIUS - 62, VIL[1] + 14], {
    nodes: 3, lift: 0.2, yStart: 2.6, yEnd: 2.35, biome: 'village',
  }),
  link('vil-lane-east', 'dirt', [VIL[0] + VIL_RADIUS, VIL[1]], [VIL[0] + VIL_RADIUS + 58, VIL[1] - 12], {
    nodes: 3, lift: 0.2, yStart: 2.6, yEnd: 2.4, biome: 'village',
  }),

  // --- 林区 ---
  link('w-forest', 'dirt', W1, W2, {
    nodes: 6, bend: 20, lift: 1.6, yStart: 1.8, yEnd: 3.4, biome: 'forest',
  }),
  link('forest-north', 'dirt', W2, W3, {
    nodes: 5, bend: 22, lift: 1.2, yStart: 3.4, yEnd: 4.0, biome: 'forest',
  }),
  link('forest-ne', 'dirt', W3, NW, {
    nodes: 6, bend: -24, lift: 2.0, yStart: 4.0, yEnd: 5.8, biome: 'forest',
  }),
  link('forest-arc', 'dirt', W2, SW, {
    nodes: 6, bend: -22, lift: 2.6, yStart: 3.4, yEnd: 5.0, biome: 'forest',
  }),
  link('forest-spur', 'dirt', W2, [-965, 520], {
    nodes: 5, bend: 24, lift: 1.4, yStart: 3.4, yEnd: 4.6, biome: 'forest',
  }),

  // --- 草甸环线（并入的旧赛道）+ 两头接驳 ---
  {
    id: 'meadow-loop',
    kind: 'secondary',
    points: MEADOW_LOOP_POINTS,
    closed: true,
    width: 9,
    biome: 'meadow',
  },
  // 南东主干道 → 草甸环线西南丁字口。
  // 这里用显式控制点而不是 link()：这条路必须**从环线外侧**绕到丁字口，
  // 全程与环线保持 35 m 以上，并在接近时平缓降到与环线同高。
  // 旧版它径直穿过环线内侧、两路高差 6 m —— 那正是"草地高出路面 5.81 m"的根因，
  // 也让驾驶员在丁字口被卡住（实测 6 次倒车脱困）。
  {
    id: 'se-meadow',
    kind: 'secondary',
    width: 9,
    biome: 'meadow',
    ends: { start: 'junction', end: 'junction' },
    points: [
      { x: SE[0], y: 4.2, z: SE[1] },
      { x: 688, y: 3.75, z: 520 },
      { x: 700, y: 3.3, z: 360 },
      { x: 712, y: 2.9, z: 230 },
      { x: 730, y: 2.55, z: 130 },
      { x: 755, y: 2.3, z: 65 },
      { x: MEADOW_TEE_SW.x, y: MEADOW_TEE_SW.y, z: MEADOW_TEE_SW.z },
    ],
  },
];

/**
 * 断头路的端头。都不是"没接上的路"，而是**有意终止**：
 *  - forest-spur：林间空地
 *  - vil-lane-west / vil-lane-east：村中小巷，止于最后一户农家院
 *  - vil-main：主街南端止于打谷场（场院）
 * 校验器会把未声明的端头报成错误，所以意图必须写在这里。
 */
const DEAD_END_IDS = new Set([
  'forest-spur',
  'vil-main',
  'vil-lane-west',
  'vil-lane-east',
]);
const ROADS: RoadSegmentConfig[] = ROADS_BUILT.map((r) =>
  DEAD_END_IDS.has(r.id) ? { ...r, ends: { start: 'junction', end: 'dead' as const } } : r,
);

// ---------------------------------------------------------------- 路口
const JUNCTIONS: JunctionConfig[] = [
  {
    id: 'hub-roundabout',
    kind: 'roundabout',
    x: HUB[0],
    z: HUB[1],
    y: 0.5,
    radius: 30,
    islandRadius: 12,
    islandHeight: 0.45,
  },
  { id: 'village-gate-junction', kind: 'tee', x: S2[0], z: S2[1], y: 3.0, radius: 16 },
  { id: 'forest-tee', kind: 'tee', x: W2[0], z: W2[1], y: 3.4, radius: 16 },
];

// ---------------------------------------------------------------- 闸口
const GATES = [
  gate('gate-north', N2[0], N2[1], Math.PI, '通往雪山（尚未开放）', 'region-2-snow'),
  gate('gate-east', MEADOW_OFFSET[0] + 330, MEADOW_OFFSET[1] - 240, -Math.PI / 2, '通往城市（尚未开放）', 'region-3-city'),
];

// ---------------------------------------------------------------- 地标
const LANDMARKS: LandmarkConfig[] = [
  // 大纸风车：立在草甸环线内侧中央，绕环线时全程可见
  { kind: 'windmill', x: MEADOW_OFFSET[0] + 20, z: MEADOW_OFFSET[1] - 10, scale: 2.6, heading: 0.6 },
  // 水车：村庄环线西侧
  { kind: 'waterwheel', x: VIL[0] - VIL_RADIUS - 30, z: VIL[1] + 8, scale: 1.5, heading: 0.9 },
  // 村口牌坊：村庄北口
  { kind: 'villageArch', x: S2[0], z: S2[1] + 12, scale: 1.1, heading: 0 },
];

export const REGION_QINGYE: RegionConfig = {
  id: 'region-1-qingye',
  name: '青野乡',
  subtitle: '郊野公路 · 林地小径 · 村庄与草甸环线',
  theme: {
    biome: 'meadow',
    skyTop: 0x9ecbe8,
    skyBottom: 0xf3e6c8,
    ambient: 0xfdf3dd,
    sun: 0xfff2d0,
    sunIntensity: 2.05,
    ambientIntensity: 1.15,
    fog: 0xe8e0c8,
    // 2.7 km 的地图，雾从 420 m 才开始等于近中景完全没有空气感，所有东西都像积木。
    fogNear: 120,
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
  bounds: { minX: -1100, minZ: -1000, maxX: 1280, maxZ: 1240 },
  roads: ROADS,
  junctions: JUNCTIONS,
  gates: GATES,
  collectibles: [],
  timeTrials: [],
  landmarks: LANDMARKS,
  // 出生点放在**村里**而不是空旷的环岛：先让玩家看到的是一处有设计的地方。
  // 等到区域重做成"以村庄为核心的 1 km² 街区"时，这里就是村庄主街。
  spawn: { segment: 'vil-main', t: 0.42, lateral: 0 },
  seed: 20260315,
  // 2.2 m 的起伏等于平地。7 m（叠加后实际 ±30 m 量级）才有地形可言。
  terrainAmplitude: 7,
  terrainScale: 0.0068,
  paperThickness: 0.05,
};
