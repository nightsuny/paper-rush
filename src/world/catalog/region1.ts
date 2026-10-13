import type { ControlPoint } from '../../tracks/types';
import { gate } from '../linkFactory';
import type {
  JunctionConfig,
  LandmarkConfig,
  PlacementConfig,
  RegionConfig,
  RoadSegmentConfig,
} from '../types';

/**
 * 区域 1「青野乡」——一个**设计过的**约 1.2 km² 村庄街区。
 *
 * ## 这一版和之前完全不同
 *
 * 之前那 24 条路段 / 11.6 km 是用 `link()` 生成的：在两个锚点之间连一条直线，
 * 再按 `sin(πt)·bend` 加一个正弦弯。所以每条路都是一根近乎直线的长条 ——
 * 这就是"道路怎么还是这个样"的根源。**那些路段已经全部删除。**
 *
 * 现在**每一条路的中心线都是逐点写出来的**（见 ROADS 里的 points），高程也是
 * 逐点设计的。区域范围收缩到约 1.2 km²，不再把"总长度"当目标。
 *
 * ## 布局（俯视，+X 东，+Z 南，单位米）
 *
 * ```
 *                      北闸口 (通雪山)
 *                        │
 *                   ╭────┴────╮   过境公路：下坡 → 贴村西侧 → 南爬升 → 南闸口
 *        林道 ⇠─────┤         │
 *                   │         │
 *          西巷 ────┤  ╭──────╯
 *                   │  │  ╭──────────╮
 *                   │  └──┤  村庄    ├──→ 东巷 ──→ 田间道 ⇢ 地头
 *                   │     │  环线    │
 *                   │     ╰────┬─────╯
 *                   │    主街  │ (村中心向西让出 9 m 空地 → 水塘)
 *                   │          │
 *                   │       打谷场 ⇢ 断头
 *                   ╰──────────╯
 *                      南闸口 (通城市)
 * ```
 *
 * 结构：1 条过境公路（骨架）+ 进村路 + 村中主街 + 村内环线 + 两条小巷
 * + 田间道 + 林道。所有路联通，连通性与高程由 validateNetwork 数值校验。
 */

// ---------------------------------------------------------------- 环线控制点
// 16 个点、半径在 74~86 m 之间起伏。**刻意不是正圆**：村庄环路不是圆规画的。
// 索引 0 / 4 / 8 / 12 分别是东（接东巷）、南、西（接西巷）、北（接主街）四个丁字口，
// 半径取 80 使它们正好落在 (±80,1010) 与 (0,1090) / (0,930) 上。
const VILLAGE_RING_RADII = [80, 83, 85, 81, 80, 77, 79, 82, 80, 84, 85, 80, 80, 77, 79, 82];
const VILLAGE_RING: ControlPoint[] = VILLAGE_RING_RADII.map((r, i) => {
  const a = (i * 22.5 * Math.PI) / 180;
  return {
    x: +(Math.cos(a) * r).toFixed(2),
    y: 2.6,
    z: +(1010 + Math.sin(a) * r).toFixed(2),
  };
});

// ---------------------------------------------------------------- 路段
const ROADS: RoadSegmentConfig[] = [
  // ---------------- 过境公路（乡道沥青）----------------
  // 街区的骨架：从北闸口下坡，贴着村子西侧过去，再向南爬升出南闸口。
  // 高程是设计过的：北端 7.4 m 下到村边 2.8 m（与西巷同高），再升到南端 5.2 m。
  // 索引 1 是林道的丁字口，索引 3 是进村路的丁字口，索引 4 是西巷的丁字口。
  {
    id: 'trunk',
    kind: 'secondary',
    biome: 'farm',
    points: [
      { x: -178, y: 7.4, z: 520 },
      { x: -158, y: 6.6, z: 640 },
      { x: -140, y: 5.8, z: 770 },
      { x: -129, y: 4.4, z: 900 },
      { x: -118, y: 2.8, z: 1010 },
      { x: -124, y: 2.6, z: 1120 },
      { x: -140, y: 3.4, z: 1240 },
      { x: -176, y: 4.4, z: 1360 },
      { x: -232, y: 5.2, z: 1470 },
    ],
  },

  // ---------------- 村庄（一律土路）----------------
  // 村道都用 kind:'dirt'：窄（4.6 m）、无路缘、无标线、明显坑洼。
  // 进村路：从过境公路的丁字口折向村北口
  {
    id: 'vil-conn',
    kind: 'dirt',
    biome: 'village',
    points: [
      { x: -129, y: 4.4, z: 900 },
      { x: -86, y: 3.9, z: 908 },
      { x: -42, y: 3.3, z: 918 },
      { x: 0, y: 2.6, z: 930 },
    ],
  },
  // 村中主街：先直，到村中心**向西让出 9 m**（那里留作空地放水塘），再回到东侧，
  // 最后收在打谷场。刻意不是一条直线 —— 村庄街道不会像激光一样直。
  {
    id: 'vil-main',
    kind: 'dirt',
    biome: 'village',
    ends: { start: 'junction', end: 'dead' },
    points: [
      { x: 0, y: 2.6, z: 930 },
      { x: 0, y: 2.6, z: 968 },
      { x: -7, y: 2.6, z: 1004 },
      { x: -9, y: 2.6, z: 1040 },
      { x: -3, y: 2.5, z: 1076 },
      { x: 6, y: 2.45, z: 1108 },
      { x: 10, y: 2.4, z: 1130 },
    ],
  },
  // 村内环线：半径起伏的闭合土路。四个丁字口落在 (±80,1010) 与 (0,1090) / (0,930)。
  {
    id: 'village-ring',
    kind: 'dirt',
    biome: 'village',
    closed: true,
    points: VILLAGE_RING,
  },
  // 西巷：环线西顶点 → 过境公路。这是村子对外的主要出口。
  {
    id: 'vil-lane-west',
    kind: 'dirt',
    biome: 'village',
    points: [
      { x: -80, y: 2.6, z: 1010 },
      { x: -100, y: 2.7, z: 1010 },
      { x: -118, y: 2.8, z: 1010 },
    ],
  },
  // 东巷：从环线东顶点向东南，接田间道
  {
    id: 'vil-lane-east',
    kind: 'dirt',
    biome: 'village',
    points: [
      { x: 80, y: 2.6, z: 1010 },
      { x: 148, y: 2.3, z: 1036 },
      { x: 215, y: 2.0, z: 1062 },
    ],
  },
  // 田间道：绕过田埂到地头，止于地头的栅门（有意断头）
  {
    id: 'field-track',
    kind: 'dirt',
    biome: 'farm',
    ends: { start: 'junction', end: 'dead' },
    points: [
      { x: 215, y: 2.0, z: 1062 },
      { x: 262, y: 1.7, z: 1030 },
      { x: 300, y: 1.5, z: 985 },
      { x: 330, y: 1.4, z: 950 },
    ],
  },
  // 林道：从过境公路向北进林子，止于林间空地（有意断头）
  {
    id: 'forest-track',
    kind: 'dirt',
    biome: 'forest',
    ends: { start: 'junction', end: 'dead' },
    points: [
      { x: -158, y: 6.6, z: 640 },
      { x: -90, y: 6.9, z: 682 },
      { x: -10, y: 7.1, z: 700 },
      { x: 60, y: 7.3, z: 688 },
      { x: 140, y: 7.6, z: 630 },
    ],
  },
];

// ---------------------------------------------------------------- 路口
const JUNCTIONS: JunctionConfig[] = [
  // 进村路丁在过境公路上
  { id: 'trunk-conn-tee', kind: 'tee', x: -129, z: 900, y: 4.4, radius: 15 },
  // 西巷丁在过境公路上：村子对外的主要出口
  { id: 'trunk-lane-tee', kind: 'tee', x: -118, z: 1010, y: 2.8, radius: 14 },
  // 村北口：进村路、主街、环线北顶点 三路相交
  { id: 'village-north-tee', kind: 'tee', x: 0, z: 930, y: 2.6, radius: 13 },
  // 村南：主街穿过环线南顶点
  { id: 'village-south-cross', kind: 'tee', x: 0, z: 1090, y: 2.6, radius: 13 },
];

// ---------------------------------------------------------------- 闸口
const GATES = [
  gate('gate-north', -178, 520, 0, '通往雪山（尚未开放）', 'region-2-snow'),
  gate('gate-south', -232, 1470, Math.PI, '通往城市（尚未开放）', 'region-3-city'),
];

// ---------------------------------------------------------------- 地标
const LANDMARKS: LandmarkConfig[] = [
  // 大纸风车：立在村东的田野里，从东巷与田间道上全程可见
  { kind: 'windmill', x: 400, z: 880, scale: 2.4, heading: 0.5 },
  // 水车：村中心水塘边（主街让出的那块空地）
  { kind: 'waterwheel', x: 46, z: 1058, scale: 1.5, heading: 0.9 },
  // 村口牌坊：跨在村北口的主街上
  { kind: 'villageArch', x: 0, z: 922, scale: 1.1, heading: 0 },
];

/**
 * 村庄的手工摆放清单。
 *
 * **逐点设计的，不是程序的产物。** 每一条都能回答"它为什么在这里"：
 * 主街两侧的住户正面朝街、退线统一 9.6 m；环线外八户农家各带一间偏房；
 * 南端是打谷场（谷仓 + 草垛 + 谷斗 + 院墙）；村中心留出空地放水塘；
 * 巷子止于最后一户农家院；村口的花贴着街边，树刻意不成排。
 *
 * 坐标跟着**设计好的街道走**：主街在村中心向西偏了 9 m，所以那一段两侧的住户、
 * 院墙、花簇也一起西移，仍然贴着街 —— 手写坐标不等于随手写坐标。
 *
 * 相对地，林地/旷野用"人定的范围 + 规则填充"（见 RegionView 的 BIOME_RULES）——
 * 成片的树没法逐棵手写，但范围与边界是人定的。
 */
const VILLAGE_PLACEMENTS: PlacementConfig[] = [
  // --- 主街东侧 6 户（正面朝街，即朝 -X）---
  { kind: 'house', x: 9.6, z: 948, heading: -1.5708, width: 5.6, depth: 4.4, height: 2.9, roofHeight: 1.6, roof: 'tile', wall: 0xe8dcc0, windows: 2, doorOffset: 0.2, note: '主街东侧第1户，正面朝街；退线 9.6 m 留出院落' },
  { kind: 'house', x: 9.6, z: 966, heading: -1.5708, width: 4.8, depth: 4, height: 2.6, roofHeight: 1.4, roof: 'slate', wall: 0xdcc9a6, windows: 2, doorOffset: -0.3, note: '主街东侧第2户：比邻居矮一档，门偏到另一侧' },
  { kind: 'house', x: 6.49, z: 984, heading: -1.5708, width: 6.2, depth: 4.8, height: 3.1, roofHeight: 1.8, roof: 'thatch', wall: 0xe3d3b4, windows: 3, doorOffset: 0, note: '主街东侧第3户：村里最大的茅草顶正房，三扇窗' },
  { kind: 'house', x: 1.04, z: 1032, heading: -1.5708, width: 5.2, depth: 4.2, height: 2.7, roofHeight: 1.5, roof: 'tile', wall: 0xcfc0a0, windows: 2, doorOffset: 0.35, note: '主街东侧第4户：门开在靠水塘那一侧' },
  { kind: 'house', x: 2.27, z: 1050, heading: -1.5708, width: 5.8, depth: 4.6, height: 3, roofHeight: 1.7, roof: 'slate', wall: 0xe6d9bc, windows: 3, doorOffset: -0.15, note: '主街东侧第5户：正对水塘，三扇窗' },
  { kind: 'house', x: 5.27, z: 1068, heading: -1.5708, width: 5, depth: 4.1, height: 2.6, roofHeight: 1.4, roof: 'tile', wall: 0xd8c6a2, windows: 2, doorOffset: 0.1, note: '主街东侧第6户：主街南段第一户' },

  // --- 主街西侧 6 户（正面朝街，即朝 +X）---
  { kind: 'house', x: -9.6, z: 956, heading: 1.5708, width: 5, depth: 4.1, height: 2.7, roofHeight: 1.5, roof: 'thatch', wall: 0xe3d3b4, windows: 2, doorOffset: -0.25, note: '主街西侧第1户，正面朝街' },
  { kind: 'house', x: -10.77, z: 974, heading: 1.5708, width: 5.8, depth: 4.6, height: 3, roofHeight: 1.7, roof: 'tile', wall: 0xcfc0a0, windows: 3, doorOffset: 0.1, note: '主街西侧第2户：与东侧第5户互为对面的大宅' },
  { kind: 'house', x: -14.27, z: 992, heading: 1.5708, width: 4.6, depth: 3.9, height: 2.5, roofHeight: 1.3, roof: 'slate', wall: 0xe6d9bc, windows: 1, doorOffset: 0.4, note: '主街西侧第3户：院里最小的一间，只有一扇窗' },
  { kind: 'house', x: -18.6, z: 1040, heading: 1.5708, width: 6, depth: 4.7, height: 3.1, roofHeight: 1.8, roof: 'tile', wall: 0xd8c6a2, windows: 3, doorOffset: 0, note: '主街西侧第4户：主街在这里向西让出空地，这户退得最远' },
  { kind: 'house', x: -15.6, z: 1058, heading: 1.5708, width: 5.4, depth: 4.3, height: 2.8, roofHeight: 1.6, roof: 'tile', wall: 0xe8dcc0, windows: 2, doorOffset: 0.2, note: '主街西侧第5户' },
  { kind: 'house', x: -12.6, z: 1076, heading: 1.5708, width: 4.9, depth: 4, height: 2.6, roofHeight: 1.4, roof: 'slate', wall: 0xdcc9a6, windows: 2, doorOffset: -0.35, note: '主街西侧第6户：西侧最后一户，再南就是打谷场' },

  // --- 环线外八户农家（正面朝环线，即向内）+ 各自背后一间偏房 ---
  { kind: 'house', x: 83.9, z: 1049.1, heading: -2.007, width: 5.2, depth: 4.4, height: 2.8, roofHeight: 1.6, roof: 'slate', wall: 0xcfc0a0, windows: 2, doorOffset: 0.2, note: '环线外 25 度 农家：环线半径在此处 83 m' },
  { kind: 'shed', x: 90.2, z: 1052.1, heading: -2.007, width: 3.6, depth: 3, height: 2.1, roofHeight: 1.1, roof: 'thatch', wall: 0xc9b48e, windows: 1, chimney: false, note: '25 度 农家的偏房（柴房/农具），在正屋背后外侧' },
  { kind: 'house', x: 60.8, z: 1082.5, heading: -2.443, width: 6, depth: 4.4, height: 3, roofHeight: 1.7, roof: 'tile', wall: 0xe8dcc0, windows: 2, doorOffset: -0.2, note: '环线外 50 度 农家：环线半径 85 m' },
  { kind: 'shed', x: 65.3, z: 1087.9, heading: -2.443, width: 4, depth: 3, height: 2.3, roofHeight: 1.1, roof: 'thatch', wall: 0xc9b48e, windows: 1, chimney: false, note: '50 度 农家的偏房' },
  { kind: 'house', x: -56.95, z: 1077.9, heading: 2.443, width: 4.8, depth: 4.4, height: 2.6, roofHeight: 1.4, roof: 'thatch', wall: 0xdcc9a6, windows: 2, doorOffset: 0.3, note: '环线外 130 度 农家：环线半径 79 m' },
  { kind: 'shed', x: -61.5, z: 1083.3, heading: 2.443, width: 3.4, depth: 3, height: 2, roofHeight: 1.1, roof: 'thatch', wall: 0xc9b48e, windows: 1, chimney: false, note: '130 度 农家的偏房' },
  { kind: 'house', x: -83, z: 1048.7, heading: 2.007, width: 5.6, depth: 4.4, height: 2.9, roofHeight: 1.6, roof: 'tile', wall: 0xe3d3b4, windows: 2, doorOffset: 0, note: '环线外 155 度 农家：环线半径 82 m' },
  { kind: 'shed', x: -89.3, z: 1051.7, heading: 2.007, width: 3.8, depth: 3, height: 2.2, roofHeight: 1.1, roof: 'thatch', wall: 0xc9b48e, windows: 1, chimney: false, note: '155 度 农家的偏房' },
  { kind: 'house', x: -84.8, z: 970.4, heading: 1.134, width: 5.4, depth: 4.4, height: 2.7, roofHeight: 1.5, roof: 'slate', wall: 0xcfc0a0, windows: 2, doorOffset: -0.3, note: '环线外 205 度 农家：环线半径 84 m' },
  { kind: 'shed', x: -91.1, z: 967.4, heading: 1.134, width: 3.6, depth: 3, height: 2.1, roofHeight: 1.1, roof: 'thatch', wall: 0xc9b48e, windows: 1, chimney: false, note: '205 度 农家的偏房' },
  { kind: 'house', x: -60.8, z: 937.5, heading: 0.698, width: 6.2, depth: 4.4, height: 3.1, roofHeight: 1.8, roof: 'tile', wall: 0xe6d9bc, windows: 2, doorOffset: 0.25, note: '环线外 230 度 农家：环线半径 85 m' },
  { kind: 'shed', x: -65.3, z: 932.1, heading: 0.698, width: 4.2, depth: 3, height: 2.4, roofHeight: 1.1, roof: 'thatch', wall: 0xc9b48e, windows: 1, chimney: false, note: '230 度 农家的偏房' },
  { kind: 'house', x: 56.95, z: 942.1, heading: -0.698, width: 5, depth: 4.4, height: 2.6, roofHeight: 1.4, roof: 'thatch', wall: 0xd8c6a2, windows: 2, doorOffset: 0.1, note: '环线外 310 度 农家：环线半径 79 m' },
  { kind: 'shed', x: 61.5, z: 936.7, heading: -0.698, width: 3.4, depth: 3, height: 2, roofHeight: 1.1, roof: 'thatch', wall: 0xc9b48e, windows: 1, chimney: false, note: '310 度 农家的偏房' },
  { kind: 'house', x: 83, z: 971.3, heading: -1.134, width: 5.8, depth: 4.4, height: 2.8, roofHeight: 1.7, roof: 'tile', wall: 0xe8dcc0, windows: 2, doorOffset: -0.1, note: '环线外 335 度 农家：环线半径 82 m' },
  { kind: 'shed', x: 89.3, z: 968.3, heading: -1.134, width: 3.8, depth: 3, height: 2.2, roofHeight: 1.1, roof: 'thatch', wall: 0xc9b48e, windows: 1, chimney: false, note: '335 度 农家的偏房' },

  // --- 进村路南侧 2 户：进村先看到的两栋 ---
  { kind: 'house', x: -92.8, z: 919.7, heading: 2.913, width: 5.4, depth: 4.3, height: 2.8, roofHeight: 1.5, roof: 'slate', wall: 0xe8dcc0, windows: 2, doorOffset: -0.2, note: '进村路第1户：正面朝来路，是进村第一眼' },
  { kind: 'house', x: -51.5, z: 929.3, heading: 2.913, width: 4.8, depth: 4.3, height: 2.6, roofHeight: 1.4, roof: 'tile', wall: 0xdcc9a6, windows: 2, doorOffset: 0.3, note: '进村路第2户' },

  // --- 西巷 2 户（巷子只有 38 m，正好够两户）---
  { kind: 'house', x: -92, z: 1001, heading: 3.1416, width: 5, depth: 4.2, height: 2.7, roofHeight: 1.5, roof: 'thatch', wall: 0xdcc9a6, windows: 2, note: '西巷北侧住户，正面朝巷（朝 -Z）' },
  { kind: 'house', x: -104, z: 1019, heading: 0, width: 4.6, depth: 4.2, height: 2.5, roofHeight: 1.4, roof: 'tile', wall: 0xe3d3b4, windows: 2, note: '西巷南侧住户，正面朝巷（朝 +Z）' },

  // --- 东巷 2 户 ---
  { kind: 'house', x: 133.3, z: 1040.7, heading: 2.775, width: 4.8, depth: 4.2, height: 2.6, roofHeight: 1.4, roof: 'slate', wall: 0xe6d9bc, windows: 2, note: '东巷第1户，正面朝巷' },
  { kind: 'house', x: 181.9, z: 1059.4, heading: 2.775, width: 5.4, depth: 4.2, height: 2.8, roofHeight: 1.6, roof: 'tile', wall: 0xd8c6a2, windows: 2, note: '东巷第2户：东巷最后一户，再往前就是田间道' },

  // --- 南端打谷场：谷仓 + 草垛 + 谷斗，院墙围合 ---
  { kind: 'barn', x: 21.5, z: 1108, heading: -1.5708, scale: 1, note: '主街南端的谷仓：打谷场的主体建筑，正面朝街' },
  { kind: 'haystack', x: -5.6, z: 1104, note: '打谷场的草垛第1堆，沿场院边缘堆放' },
  { kind: 'haystack', x: -3.4, z: 1114, note: '打谷场的草垛第2堆' },
  { kind: 'haystack', x: 21.1, z: 1122, note: '打谷场的草垛第3堆，靠着谷仓南墙' },
  { kind: 'haystack', x: -8, z: 1119, note: '打谷场的草垛第4堆' },
  { kind: 'crate', x: 10.7, z: 1098, scale: 1.3, note: '打谷场的木箱/谷斗第1个，放在谷仓门旁' },
  { kind: 'crate', x: -2.8, z: 1100, scale: 1.1, note: '打谷场的木箱/谷斗第2个' },

  // --- 村中心水塘：主街让出的那块空地 ---
  { kind: 'pond', x: 30, z: 1046, radius: 7.5, note: '村中心的水塘：主街在这里向西让出 9 m，那片空地正好放水塘' },

  // --- 院墙：沿街分隔相邻两家的院子；南端围住打谷场 ---
  { kind: 'fence', x: 9.6, z: 940, x2: 9.6, z2: 958, note: '院墙第1段：主街东侧，分隔第1、2户' },
  { kind: 'fence', x: 9.6, z: 958, x2: 9.6, z2: 976, note: '院墙第2段：主街东侧第2、3户之间' },
  { kind: 'fence', x: -9.6, z: 948, x2: -9.6, z2: 968, note: '院墙第3段：主街西侧，分隔第1、2户' },
  { kind: 'fence', x: -12.7, z: 984, x2: -12.7, z2: 1002, note: '院墙第4段：主街西侧第3户院子外沿（这一段街已西移）' },
  { kind: 'fence', x: 1.2, z: 1024, x2: 0.73, z2: 1042, note: '院墙第5段：主街东侧第4户院子外沿' },
  { kind: 'fence', x: 8.51, z: 1060, x2: 7.16, z2: 1078, note: '院墙第6段：主街东侧第5、6户院子外沿' },
  { kind: 'fence', x: -11.87, z: 1050, x2: -13.93, z2: 1068, note: '院墙第7段：主街西侧第5、6户院子外沿' },
  { kind: 'fence', x: 12.5, z: 1102, x2: 30.5, z2: 1102, note: '院墙第8段：打谷场北侧' },
  { kind: 'fence', x: 30.5, z: 1102, x2: 30.5, z2: 1122, note: '院墙第9段：打谷场东侧' },
  { kind: 'fence', x: 8.6, z: 1094, x2: -15.9, z2: 1094, note: '院墙第10段：打谷场西侧，与主街相接' },

  // --- 村内的树：只在院边/村口，刻意不成排 ---
  { kind: 'tree', x: 16, z: 940, tree: 'broadleaf', scale: 1.5, note: '村内第1棵树：村北口东侧，给入口一点遮挡' },
  { kind: 'tree', x: -17, z: 942, tree: 'conifer', scale: 1.2, note: '村内第2棵树：村北口西侧' },
  { kind: 'tree', x: 20, z: 1000, tree: 'broadleaf', scale: 1.6, note: '村内第3棵树：环内东侧空地' },
  { kind: 'tree', x: -20, z: 1024, tree: 'broadleaf', scale: 1.3, note: '村内第4棵树：主街西侧第4户院前' },
  { kind: 'tree', x: 26, z: 1030, tree: 'conifer', scale: 1.4, note: '村内第5棵树：水塘北岸' },
  { kind: 'tree', x: -27, z: 1000, tree: 'broadleaf', scale: 1.5, note: '村内第6棵树：环内西侧' },
  { kind: 'tree', x: 18, z: 1082, tree: 'broadleaf', scale: 1.2, note: '村内第7棵树：打谷场附近' },
  { kind: 'tree', x: -19, z: 1084, tree: 'conifer', scale: 1.6, note: '村内第8棵树：环内西南角' },
  { kind: 'tree', x: 34, z: 1072, tree: 'broadleaf', scale: 1.4, note: '村内第9棵树：水塘南侧' },
  { kind: 'tree', x: -36, z: 1058, tree: 'broadleaf', scale: 1.3, note: '村内第10棵树：环内西南' },
  { kind: 'tree', x: 30, z: 972, tree: 'conifer', scale: 1.5, note: '村内第11棵树：环内东北' },
  { kind: 'tree', x: -33, z: 980, tree: 'broadleaf', scale: 1.4, note: '村内第12棵树：环内西北' },
  { kind: 'tree', x: 11, z: 1126, tree: 'conifer', scale: 1.2, note: '村内第13棵树：打谷场南端' },
  { kind: 'tree', x: -14, z: 1128, tree: 'broadleaf', scale: 1.5, note: '村内第14棵树：打谷场西南' },

  // --- 街边的野花 ---
  { kind: 'flower', x: 7, z: 962, scale: 1.1, note: '第1簇野花：主街东侧院门口' },
  { kind: 'flower', x: -10.7, z: 986, scale: 0.9, note: '第2簇野花：主街西侧' },
  { kind: 'flower', x: 0.2, z: 1046, scale: 1.2, note: '第3簇野花：主街让出的空地上，水塘边' },
  { kind: 'flower', x: -13, z: 1064, scale: 1, note: '第4簇野花：主街西侧' },
  { kind: 'flower', x: -6.1, z: 1090, scale: 1.1, note: '第5簇野花：主街南段' },
  { kind: 'flower', x: -96, z: 1006, scale: 0.9, note: '第6簇野花：西巷口' },
];

export const REGION_QINGYE: RegionConfig = {
  id: 'region-1-qingye',
  name: '青野乡',
  subtitle: '一座村子 · 一条过境公路 · 田埂与林道',
  theme: {
    biome: 'meadow',
    skyTop: 0x9ecbe8,
    skyBottom: 0xf3e6c8,
    ambient: 0xfdf3dd,
    sun: 0xfff2d0,
    sunIntensity: 2.05,
    ambientIntensity: 1.15,
    fog: 0xe8e0c8,
    // 近中景也需要空气感：从 420 m 才开始起雾等于没有雾，所有东西都像积木。
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
  // 约 1.2 km²。这一版不再用"总长度"当目标，而是把范围收成一个设计过的街区。
  // 0.99 km²（1040 x 950 m）。边界**紧贴路网**：两个闸口分别落在北墙与南墙上，
  // 这样闸口是真的开口；之前闸口离墙 100 m，车会先撞上墙。
  bounds: { minX: -520, minZ: 520, maxX: 520, maxZ: 1470 },
  roads: ROADS,
  junctions: JUNCTIONS,
  gates: GATES,
  collectibles: [],
  timeTrials: [],
  landmarks: LANDMARKS,
  placements: VILLAGE_PLACEMENTS,
  // 出生点放在村中主街上
  spawn: { segment: 'vil-main', t: 0.1, lateral: 0 },
  seed: 20260315,
  terrainAmplitude: 7,
  terrainScale: 0.0068,
  paperThickness: 0.05,
};
