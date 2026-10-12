import * as THREE from 'three';
import type { Centerline, CenterlineSample } from './Centerline';
import type { TrackConfig } from './types';

/**
 * 道路几何生成。
 *
 * 这里只产出 BufferGeometry 与碰撞用三角形数据（纯计算，不依赖 DOM），
 * 素材/材质在 scenery 层贴上去，方便在 Node 里对几何做自动化测试。
 *
 * 道路横断面（lateral = 距中心线横向偏移，dy = 相对路面高度）：
 *
 *   p0 ---------- p1            p1/p5: 路肩（kerb）外沿抬起
 *        kerb  |   ↑ kerbHeight
 *              p2 --------- p4      路面（中间 p3 有很小的路拱）
 *                 p3
 *   p0/p6 是卡纸侧壁的底边，向下 paperThickness，形成可见的"纸板厚度"
 */

export interface RoadProfile {
  /** 半宽（不含路肩） */
  halfWidth: number;
  kerbWidth: number;
  kerbHeight: number;
  paperThickness: number;
  /** 路拱高度 */
  crown: number;
  /** 路堤：路缘外侧平铺的纸带宽度（米） */
  apronWidth: number;
  /** 路堤内侧相对路面的下沉量（米） */
  apronDrop: number;
  /** 路堤外侧再向下收边的宽度（米） */
  apronSkirtWidth: number;
  /** 路堤外缘相对路面的下沉量（米） */
  apronSkirtDrop: number;
}

export interface RibbonData {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export interface RoadGeometryResult {
  /** 路面（沥青纸）条带 */
  road: RibbonData;
  /** 左右路肩条带 */
  kerbLeft: RibbonData;
  kerbRight: RibbonData;
  /** 左右卡纸侧壁条带 */
  wallLeft: RibbonData;
  wallRight: RibbonData;
  /** 用于碰撞的完整可行驶表面（p1..p5） */
  collision: { vertices: Float32Array; indices: Uint32Array };
  /** 侧壁碰撞（p0-p1 / p5-p6），让车撞到路缘时有真实反馈 */
  edgeWalls: { vertices: Float32Array; indices: Uint32Array };
  /** 路堤纸带：从路缘外侧平铺出去，盖住地形在赛道走廊里被挖掉的洞 */
  apronLeft: RibbonData;
  apronRight: RibbonData;
  /** 路堤的可行驶碰撞面（草地） */
  apronCollision: { vertices: Float32Array; indices: Uint32Array };
  /** 地形被挖空走廊的半径（米）。地形三角面不会出现在这个半径以内。 */
  corridorCutRadius: number;
  totalLength: number;
}

function makeProfile(config: TrackConfig): RoadProfile {
  return {
    halfWidth: config.width / 2,
    kerbWidth: 0.9,
    kerbHeight: 0.055,
    paperThickness: config.paperThickness,
    crown: 0.004,
    apronWidth: 9,
    apronDrop: 0.12,
    apronSkirtWidth: 2.6,
    apronSkirtDrop: 0.40,
  };
}

/** 由中心线采样生成一条条带（每个采样点给出若干个断面点）。 */
function buildRibbon(
  samples: CenterlineSample[],
  profile: ReadonlyArray<{ lateral: number; dy: number }>,
  uAcross: number[],
  vRepeatMeters: number,
  closed: boolean,
): RibbonData {
  const n = samples.length;
  const p = profile.length;
  const count = closed ? n + 1 : n;
  const positions = new Float32Array(count * p * 3);
  const uvs = new Float32Array(count * p * 2);
  const quads = closed ? n : n - 1;
  const indices = new Uint32Array(quads * (p - 1) * 6);

  for (let i = 0; i < count; i++) {
    const s = samples[i % n];
    for (let j = 0; j < p; j++) {
      const off = profile[j];
      const idx = (i * p + j) * 3;
      positions[idx] = s.x + s.rx * off.lateral + s.ux * off.dy;
      positions[idx + 1] = s.y + s.ry * off.lateral + s.uy * off.dy;
      positions[idx + 2] = s.z + s.rz * off.lateral + s.uz * off.dy;
      const uv = (i * p + j) * 2;
      uvs[uv] = uAcross[j];
      uvs[uv + 1] = s.s / vRepeatMeters;
    }
  }

  // 绕序必须让法线朝上。断面点按 lateral 递增排列时，
  //   面法线 = (断面方向) × (行进方向) = right × T = up
  // 因此三角形顺序为 (a,b,c) / (b,d,c)，写反了整个路面会朝下而不可见。
  let ii = 0;
  for (let i = 0; i < quads; i++) {
    for (let j = 0; j < p - 1; j++) {
      const a = i * p + j;
      const b = i * p + j + 1;
      const c = (i + 1) * p + j;
      const d = (i + 1) * p + j + 1;
      indices[ii++] = a;
      indices[ii++] = b;
      indices[ii++] = c;
      indices[ii++] = b;
      indices[ii++] = d;
      indices[ii++] = c;
    }
  }

  return { positions, uvs, indices };
}

/** 无 UV 的纯三角面片（供碰撞使用）。 */
function toTrimesh(ribbon: RibbonData): { vertices: Float32Array; indices: Uint32Array } {
  return { vertices: ribbon.positions, indices: ribbon.indices };
}

export function buildRoadGeometry(
  config: TrackConfig,
  centerline: Centerline,
): RoadGeometryResult {
  const profile = makeProfile(config);
  const hw = profile.halfWidth;
  const kw = profile.kerbWidth;
  const kh = profile.kerbHeight;
  const th = profile.paperThickness;

  // 完整断面：p0..p6
  const full = [
    { lateral: -(hw + kw), dy: -th },
    { lateral: -(hw + kw), dy: kh },
    { lateral: -hw, dy: 0 },
    { lateral: 0, dy: profile.crown },
    { lateral: hw, dy: 0 },
    { lateral: hw + kw, dy: kh },
    { lateral: hw + kw, dy: -th },
  ];

  const samples = centerline.samples;
  const vRepeat = 12;

  // 每个断面点对应的 u（用于贴图）
  const u = (lat: number) => (lat + hw + kw) / (2 * (hw + kw));

  const road = buildRibbon(
    samples,
    [full[2], full[3], full[4]],
    [u(full[2].lateral), u(full[3].lateral), u(full[4].lateral)],
    vRepeat,
    true,
  );
  const kerbLeft = buildRibbon(
    samples,
    [full[1], full[2]],
    [0, 1],
    3,
    true,
  );
  const kerbRight = buildRibbon(
    samples,
    [full[4], full[5]],
    [0, 1],
    3,
    true,
  );
  const wallLeft = buildRibbon(samples, [full[0], full[1]], [0, 1], 3, true);
  const wallRight = buildRibbon(samples, [full[5], full[6]], [0, 1], 3, true);

  // 碰撞面：p1..p5（路肩外沿 → 路面 → 另一侧路肩），连续无孔洞
  const collision = toTrimesh(
    buildRibbon(
      samples,
      [full[1], full[2], full[3], full[4], full[5]],
      [0, 0.25, 0.5, 0.75, 1],
      vRepeat,
      true,
    ),
  );
  const edgeWalls = toTrimesh(
    buildRibbon(samples, [full[0], full[1]], [0, 1], 3, true),
  );
  const edgeWalls2 = toTrimesh(
    buildRibbon(samples, [full[5], full[6]], [0, 1], 3, true),
  );

  // 路堤：路缘外沿 → 平铺纸带 → 收边，形成"纸板赛道压在一张桌子上"的边缘
  const kerbOuterLeft = full[0];
  const kerbOuterRight = full[6];
  const apronInner = profile.apronDrop;
  const apronOuter = profile.apronDrop;
  const apronEnd = profile.apronSkirtDrop;
  const apronFar = profile.apronWidth + profile.apronSkirtWidth;
  // 断面点一律按 lateral 递增排列，保证绕序一致（法线朝上）
  const bands = [
    { lateral: 0.6, dy: -apronInner, u: 0.1 },
    { lateral: profile.apronWidth, dy: -apronOuter, u: 0.8 },
    { lateral: apronFar, dy: -apronEnd, u: 1 },
  ];
  const apronLeft = buildRibbon(
    samples,
    [
      { lateral: -(hw + kw + apronFar), dy: -apronEnd },
      { lateral: -(hw + kw + profile.apronWidth), dy: -apronOuter },
      { lateral: -(hw + kw + 0.6), dy: -apronInner },
      { lateral: -(hw + kw), dy: -profile.paperThickness },
    ],
    [0, 0.2, 0.9, 1],
    8,
    true,
  );
  const apronRight = buildRibbon(
    samples,
    [
      { lateral: hw + kw, dy: -profile.paperThickness },
      { lateral: hw + kw + 0.6, dy: -apronInner },
      { lateral: hw + kw + profile.apronWidth, dy: -apronOuter },
      { lateral: hw + kw + apronFar, dy: -apronEnd },
    ],
    [0, 0.1, 0.8, 1],
    8,
    true,
  );
  const apronCollisionBand = [
    { lateral: -(hw + kw + apronFar), dy: -apronEnd },
    { lateral: -(hw + kw + profile.apronWidth), dy: -apronOuter },
    { lateral: -(hw + kw + 0.2), dy: -apronInner },
  ];
  const apronCollisionBandRight = [
    { lateral: hw + kw + 0.2, dy: -apronInner },
    { lateral: hw + kw + profile.apronWidth, dy: -apronOuter },
    { lateral: hw + kw + apronFar, dy: -apronEnd },
  ];
  void bands;
  const a1 = toTrimesh(buildRibbon(samples, apronCollisionBand, [0, 0.8, 1], 8, true));
  const a2 = toTrimesh(buildRibbon(samples, apronCollisionBandRight, [0, 0.2, 1], 8, true));
  const apronVerts = new Float32Array(a1.vertices.length + a2.vertices.length);
  apronVerts.set(a1.vertices, 0);
  apronVerts.set(a2.vertices, a1.vertices.length);
  const apronOffset = a1.vertices.length / 3;
  const apronIdx = new Uint32Array(a1.indices.length + a2.indices.length);
  apronIdx.set(a1.indices, 0);
  for (let i = 0; i < a2.indices.length; i++) {
    apronIdx[a1.indices.length + i] = a2.indices[i] + apronOffset;
  }
  void kerbOuterLeft;
  void kerbOuterRight;

  // 合并两侧侧壁
  const wallVerts = new Float32Array(edgeWalls.vertices.length + edgeWalls2.vertices.length);
  wallVerts.set(edgeWalls.vertices, 0);
  wallVerts.set(edgeWalls2.vertices, edgeWalls.vertices.length);
  const offset = edgeWalls.vertices.length / 3;
  const wallIdx = new Uint32Array(edgeWalls.indices.length + edgeWalls2.indices.length);
  wallIdx.set(edgeWalls.indices, 0);
  for (let i = 0; i < edgeWalls2.indices.length; i++) {
    wallIdx[edgeWalls.indices.length + i] = edgeWalls2.indices[i] + offset;
  }

  return {
    road,
    kerbLeft,
    kerbRight,
    wallLeft,
    wallRight,
    collision,
    edgeWalls: { vertices: wallVerts, indices: wallIdx },
    apronLeft,
    apronRight,
    apronCollision: { vertices: apronVerts, indices: apronIdx },
    // 地形网格在这个半径内不能有三角面，否则插值误差会让地面穿出路面
    corridorCutRadius: hw + kw + apronFar,
    totalLength: centerline.totalLength,
  };
}

/** 把条带数据转成 THREE.BufferGeometry。 */
export function ribbonToGeometry(ribbon: RibbonData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(ribbon.positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(ribbon.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(ribbon.indices, 1));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// 护栏：立柱（实例化）+ 横栏（条带）
// ---------------------------------------------------------------------------

export interface GuardrailData {
  postPositions: Float32Array;
  postRotations: Float32Array;
  /** 横栏条带：上沿与下沿两排顶点 */
  railRibbon: RibbonData;
  /** 用于碰撞的盒体（中心点 + 半长 + 朝向） */
  boxes: Array<{ x: number; y: number; z: number; heading: number; halfLength: number; halfHeight: number; halfThickness: number }>;
}

export function buildGuardrails(config: TrackConfig, centerline: Centerline): GuardrailData {
  const total = centerline.totalLength;
  const samples = centerline.samples;
  const n = samples.length;
  const postSpacing = 4;
  const railHeight = 0.62;
  const railThickness = 0.12;
  const posts: number[] = [];
  const rotations: number[] = [];
  const railProfile: Array<{ lateral: number; dy: number }> = [];
  const boxes: GuardrailData['boxes'] = [];

  const idxForT = (t: number) => {
    const tt = ((t % 1) + 1) % 1;
    return Math.min(n - 1, Math.max(0, Math.round(tt * n)));
  };

  const sides: Array<'left' | 'right'> = [];
  for (const g of config.guardrails) {
    const list: Array<'left' | 'right'> = g.side === 'both' ? ['left', 'right'] : [g.side];
    for (const side of list) {
      sides.push(side);
      const i0 = idxForT(g.from);
      const i1 = idxForT(g.to);
      const spanIdx = i1 > i0 ? i1 - i0 : n - i0 + i1;
      const step = Math.max(1, Math.round(postSpacing / (total / n)));
      for (let k = 0; k <= spanIdx; k += step) {
        const i = (i0 + k) % n;
        const s = samples[i];
        const sign = side === 'right' ? 1 : -1;
        const lat = sign * (s.halfWidth + g.offset - s.halfWidth);
        const lateral = sign * g.offset;
        void lat;
        const px = s.x + s.rx * lateral;
        const py = s.y + s.ry * lateral;
        const pz = s.z + s.rz * lateral;
        posts.push(px, py, pz);
        rotations.push(Math.atan2(s.tx, s.tz));
      }
      // 碰撞盒：按 4 米一段铺设
      for (let k = 0; k < spanIdx; k += step) {
        const i = (i0 + k) % n;
        const j = (i0 + Math.min(k + step, spanIdx)) % n;
        const a = samples[i];
        const b = samples[j];
        const sign = side === 'right' ? 1 : -1;
        const ax = a.x + a.rx * sign * g.offset;
        const ay = a.y + a.ry * sign * g.offset;
        const az = a.z + a.rz * sign * g.offset;
        const bx = b.x + b.rx * sign * g.offset;
        const by = b.y + b.ry * sign * g.offset;
        const bz = b.z + b.rz * sign * g.offset;
        const dx = bx - ax;
        const dz = bz - az;
        const len = Math.hypot(dx, dz);
        boxes.push({
          x: (ax + bx) / 2,
          y: (ay + by) / 2 + railHeight / 2,
          z: (az + bz) / 2,
          heading: Math.atan2(dx, dz),
          halfLength: Math.max(len / 2 - 0.02, 0.1),
          halfHeight: railHeight / 2,
          halfThickness: railThickness / 2,
        });
      }
    }
  }

  void railProfile;

  return {
    postPositions: new Float32Array(posts),
    postRotations: new Float32Array(rotations),
    railRibbon: { positions: new Float32Array(0), uvs: new Float32Array(0), indices: new Uint32Array(0) },
    boxes,
  };
}

// ---------------------------------------------------------------------------
// 起终点线 + 检查点门（视觉）
// ---------------------------------------------------------------------------

export interface GateData {
  t: number;
  x: number;
  y: number;
  z: number;
  /** 门的朝向（绕 Y 轴） */
  heading: number;
  halfWidth: number;
  /** 左柱脚 / 右柱脚世界坐标 */
  leftFoot: { x: number; y: number; z: number };
  rightFoot: { x: number; y: number; z: number };
}

/** 生成一个横向跨过赛道的门（拱门/横幅）的位置数据。 */
export function buildGate(
  centerline: Centerline,
  t: number,
  halfWidth: number,
  extraWidth = 1.2,
): GateData {
  const s = centerline.sampleAt(t);
  const w = halfWidth + extraWidth;
  return {
    t,
    x: s.x,
    y: s.y,
    z: s.z,
    heading: Math.atan2(s.tx, s.tz),
    halfWidth,
    leftFoot: {
      x: s.x + s.rx * w,
      y: s.y + s.ry * w,
      z: s.z + s.rz * w,
    },
    rightFoot: {
      x: s.x - s.rx * w,
      y: s.y - s.ry * w,
      z: s.z - s.rz * w,
    },
  };
}
