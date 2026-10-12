import type { TrackConfig } from '../types';

/**
 * A. 雏菊草甸 —— 温暖白天，纸花、卡纸山丘、玩具农舍，大弯道为主。
 *
 * 中心线由 tools/track-lab.mjs 生成并校验（配置里保存成显式控制点，方便手工微调）：
 *   长度 1194 m，最小弯道半径 26.7 m，最大坡度 4.6°，无自重叠
 *   半径分位：5% = 47 m，25% = 83 m，中位 132 m，75% = 264 m
 *   近直线段 44%，急弯段（<60 m）12%
 */
const MEADOW_POINTS = [
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
];

/** 检查点：均匀分布在整圈上，防止抄近道。 */
const MEADOW_CHECKPOINTS = [0.08, 0.16, 0.25, 0.33, 0.42, 0.5, 0.58, 0.67, 0.75, 0.83, 0.92].map((t) => ({
  t,
  halfWidth: 7.5,
}));

/** 护栏：只在陡坡 + 弯道外侧增设，其余路段保留草地缓冲区（可以跑出去再回来）。 */
const MEADOW_GUARDRAILS = [
  { from: 0.0, to: 0.09, side: 'right' as const, offset: 10.4 },
  { from: 0.13, to: 0.2, side: 'left' as const, offset: 10.4 },
  { from: 0.28, to: 0.35, side: 'right' as const, offset: 10.4 },
  { from: 0.4, to: 0.47, side: 'left' as const, offset: 10.4 },
  { from: 0.55, to: 0.63, side: 'both' as const, offset: 10.4 },
  { from: 0.68, to: 0.76, side: 'right' as const, offset: 10.4 },
  { from: 0.8, to: 0.88, side: 'both' as const, offset: 10.4 },
  { from: 0.92, to: 0.99, side: 'left' as const, offset: 10.4 },
];

export const MEADOW: TrackConfig = {
  id: 'meadow',
  chapter: 1,
  name: '雏菊草甸',
  subtitle: '春日清晨，风车与溪流',
  difficulty: 1,
  laps: 4,
  theme: {
    skyTop: 0x9ecbe8,
    skyBottom: 0xf3e6c8,
    ambient: 0xfdf3dd,
    sun: 0xfff2d0,
    sunIntensity: 2.05,
    ambientIntensity: 1.15,
    fog: 0xe8e0c8,
    fogNear: 260,
    fogFar: 900,
    paperGround: 0xbfd98c,
    road: 0xb9b0a0,
    roadEdge: 0x8d8579,
    kerb: 0xd05a4e,
    grass: 0x9dc46a,
    accent: 0xf5f1e4,
    accent2: 0xf0b93f,
    accent3: 0xcf5b4a,
  },
  points: MEADOW_POINTS,
  width: 12,
  shoulder: 1.8,
  checkpoints: MEADOW_CHECKPOINTS,
  guardrails: MEADOW_GUARDRAILS,
  decorations: [
    { from: 0.0, to: 0.14, side: 'both', kind: 'flowers', density: 9 },
    { from: 0.1, to: 0.22, side: 'left', kind: 'houses', density: 1.1 },
    { from: 0.18, to: 0.34, side: 'both', kind: 'trees', density: 6 },
    { from: 0.3, to: 0.46, side: 'right', kind: 'flowers', density: 8 },
    { from: 0.44, to: 0.6, side: 'both', kind: 'hills', density: 2.4 },
    { from: 0.58, to: 0.72, side: 'left', kind: 'trees', density: 7 },
    { from: 0.66, to: 0.8, side: 'both', kind: 'flowers', density: 9 },
    { from: 0.78, to: 0.94, side: 'right', kind: 'houses', density: 1.0 },
    { from: 0.86, to: 1.0, side: 'both', kind: 'trees', density: 6 },
  ],
  paperThickness: 0.05,
  startT: 0,
  maxBank: 0.055,
  seed: 20251012,
  terrainAmplitude: 1.35,
  terrainScale: 0.0075,
};
