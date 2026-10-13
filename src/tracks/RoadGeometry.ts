import * as THREE from 'three';
import type { Centerline, CenterlineSample } from './Centerline';

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
  /** 路肩外侧过渡到路堤的宽度（米） */
  vergeSlopeWidth: number;
  /** 路堤相对路面的下沉量（米） */
  vergeDrop: number;
  /** 路堤：路缘外侧平铺的纸带宽度（米） */
  apronWidth: number;
  /** 路堤内侧相对路面的下沉量（米） */
  apronDrop: number;
  /** 路堤外侧再向下收边的宽度（米） */
  apronSkirtWidth: number;
  /** 路堤外缘相对路面的下沉量（米） */
  apronSkirtDrop: number;
}

/**
 * 某一行路堤的下压目标。
 * 关键是 `to`：必须在**触到邻路沥青边缘之前**就降到 `dy`，
 * 否则路堤中段会横在邻路沥青的上方（线性插值只在外沿降到邻路，中段仍高）。
 */
export interface ApronDrop {
  /** 目标下沉量（米，相对本路路面，≤ 0） */
  dy: number;
  /** 到达该下沉量的横向距离（米） */
  to: number;
}

/**
 * 地面贴图的世界尺度（米/次重复）。
 * 地形与路堤必须用**同一个**数值，否则接缝处纹理疏密不同，一眼就看得出是两块东西。
 */
export const GROUND_TILE_METERS = 22;

export interface RibbonData {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/**
 * 生成路面几何所需的最小配置。
 * `TrackConfig`（闭合赛道）与 `RoadSegmentConfig`（开放路段）都能折算成它，
 * 因此闭合赛道与路网路段共用同一条几何生成路径。
 */
export interface RoadGeometrySpec {
  /** 路面全宽（不含路肩） */
  width: number;
  paperThickness: number;
  /** 是否闭合曲线 */
  closed: boolean;
  /**
   * 逐采样行的**路堤落点**（米，相对本路路面的下沉量，≤ 0）。
   *
   * 有另一条路在路堤伸展范围内时，把"路面之外"的整个断面按横向比例下压到
   * `drop`：靠路面处仍贴着路面，到路堤外沿正好落到那条邻路的高度。
   * 这样得到的是一个真实的边坡，而不是一块悬在邻路上的平纸板。
   *
   * 实测：不做这件事时，高 1.78 m 的路会把它的草地路堤悬在 17 m 外那条低路的
   * 沥青上方 1.45 m（就是"路边的绿地像另一块模型拼上去"的来源），
   * 车开过去还会被这级草地弹飞（实测 1440 km/h）。
   * 邻路与本路同高时 drop = 0，此时等效于原来的"路口压平"。
   */
  apronDropRows?: readonly (ApronDrop | undefined)[];
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
  /** 路堤纸带：从路缘外侧平铺出去，盖住地形在赛道走廊里被挖掉的洞 */
  apronLeft: RibbonData;
  apronRight: RibbonData;
  /** 路堤的可行驶碰撞面（草地） */
  apronCollision: { vertices: Float32Array; indices: Uint32Array };
  /** 地形被挖空走廊的半径（米）。地形三角面不会出现在这个半径以内。 */
  corridorCutRadius: number;
  totalLength: number;
}

/** 路堤外沿到中心线的横向距离（= 走廊挖空半径）。 */
export function apronInnerLatFor(hw: number, profile: RoadProfile): number {
  return hw + profile.vergeSlopeWidth + profile.apronWidth + profile.apronSkirtWidth;
}

/** 某条路的走廊半径/路堤伸展范围（米）。 */
export function apronReachOf(spec: RoadGeometrySpec): number {
  const p = makeProfile({ width: spec.width, paperThickness: spec.paperThickness });
  return apronInnerLatFor(spec.width / 2, p);
}

function makeProfile(config: { width: number; paperThickness: number }): RoadProfile {
  return {
    halfWidth: config.width / 2,
    kerbWidth: 0.9,
    kerbHeight: 0.055,
    paperThickness: config.paperThickness,
    crown: 0.004,
    vergeSlopeWidth: 1.4,
    vergeDrop: 0.1,
    // 路堤宽度 = 走廊挖空半径 - 路面半宽 - 过渡坡宽。
    // 注意这是个**折中**：路堤越宽，走廊挖空越远、地形越不会贴到路面；
    // 但路堤也会伸得更远，在"高路与低路相邻"处更容易盖到旁边那条路的头上。
    // 实测把它从 9 加到 14 反而让"路堤压到邻路"从 27 处涨到 45 处，因此保持 9。
    // 真正的解法是在重叠区抑制路堤断面（S2 未完成项，见开发进度.md）。
    apronWidth: 9,
    apronDrop: 0.1,
    apronSkirtWidth: 2.6,
    apronSkirtDrop: 0.38,
  };
}

/** 由中心线采样生成一条条带（每个采样点给出若干个断面点）。 */
function buildRibbon(
  samples: CenterlineSample[],
  profile: ReadonlyArray<{ lateral: number; dy: number }>,
  uAcross: number[],
  vRepeatMeters: number,
  closed: boolean,
  /**
   * 超高（bank）的作用范围上限（米）。超过这个横向距离的断面点，
   * 其高度按"路面平面"计算而不跟随超高 —— 否则宽度十几米的路堤外沿
   * 会被超高抬起近 1 米，直接高过路面形成一道墙。
   */
  bankCap = Number.POSITIVE_INFINITY,
  /**
   * 路堤下压：`from` = 路面半宽（边坡起点），`to` = 路堤外沿，`drops` = 逐行落点。
   * 断面点按横向比例从原下沉量插值到 `drops[i]`，形成一条真实边坡。
   */
  ramp?: { from: number; drops: readonly (ApronDrop | undefined)[] },
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
      // 横向位置用完整的 lateral；高度只用夹紧后的 lateral（超高不外溢）
      const latForY = Math.max(-bankCap, Math.min(bankCap, off.lateral));
      // 路面之外按横向比例下压：靠路面处贴住路面，到路堤外沿落到邻路高度
      let dy = off.dy;
      if (ramp) {
        const drop = ramp.drops[i % n];
        const lat = Math.abs(off.lateral);
        if (drop !== undefined && lat > ramp.from) {
          const span = Math.max(drop.to - ramp.from, 0.01);
          const t = Math.min(1, (lat - ramp.from) / span);
          dy = off.dy + (drop.dy - off.dy) * t;
        }
      }
      positions[idx] = s.x + s.rx * off.lateral + s.ux * dy;
      positions[idx + 1] = s.y + s.ry * latForY + s.uy * dy;
      positions[idx + 2] = s.z + s.rz * off.lateral + s.uz * dy;
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
  spec: RoadGeometrySpec,
  centerline: Centerline,
): RoadGeometryResult {
  const profile = makeProfile(spec);
  const hw = profile.halfWidth;
  const kw = profile.kerbWidth;
  const kh = profile.kerbHeight;
  const th = profile.paperThickness;
  const vsw = profile.vergeSlopeWidth;
  const vd = profile.vergeDrop;
  void th;

  // 完整断面（按 lateral 递增排列，保证绕序一致）。
  //
  //  0-----1           1/5: 路肩顶（与路面外沿重合）
  //        |\  2---3---4   2/4: 路肩内沿（落在路面上）
  //        路肩  路面          0/6: 路堤面
  //
  // 关键：路肩外沿到路堤之间用**缓坡**而不是竖直墙。
  // 早期版本在这里放了一堵 0.2m 高的竖直壁，车一旦滑出赛道就再也爬不回来，
  // 也会卡在边缘动不了。现在外侧坡度约 6.8°，进出都顺畅。
  const kwIn = Math.max(kw, 0.2);
  const full = [
    { lateral: -(hw + vsw), dy: -vd },
    { lateral: -hw, dy: kh },
    { lateral: -(hw - kwIn), dy: 0 },
    { lateral: 0, dy: profile.crown },
    { lateral: hw - kwIn, dy: 0 },
    { lateral: hw, dy: kh },
    { lateral: hw + vsw, dy: -vd },
  ];

  const samples = centerline.samples;
  const vRepeat = 12;

  // 路面贴图的 u：横向铺满"两侧路肩内沿之间"的路面
  const roadHalf = hw - kwIn;
  const u = (lat: number) => (lat + roadHalf) / (2 * roadHalf);

  const closed = spec.closed;

  const ramp = spec.apronDropRows
    ? { from: hw, drops: spec.apronDropRows }
    : undefined;
  const road = buildRibbon(
    samples,
    [full[2], full[3], full[4]],
    [u(full[2].lateral), u(full[3].lateral), u(full[4].lateral)],
    vRepeat,
    closed,
    hw,
    ramp,
  );
  const kerbLeft = buildRibbon(samples, [full[1], full[2]], [0, 1], 3, closed, hw, ramp);
  const kerbRight = buildRibbon(samples, [full[4], full[5]], [0, 1], 3, closed, hw, ramp);
  // 路堤过渡坡（草地），把路肩外沿平顺接到路堤面
  const wallLeft = buildRibbon(samples, [full[0], full[1]], [0, 1], 4, closed, hw, ramp);
  const wallRight = buildRibbon(samples, [full[5], full[6]], [0, 1], 4, closed, hw, ramp);

  // 碰撞面：整个断面（含路肩与过渡坡），连续无孔洞、无台坎。
  // 超高只作用到路面半宽，外侧地面保持水平 —— 这是可驾驶性的关键。
  const collision = toTrimesh(
    buildRibbon(samples, full, [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1], vRepeat, closed, hw, ramp),
  );
  // 路堤：过渡坡外沿 → 平铺纸带 → 收边，形成"纸板赛道压在一张桌子上"的边缘
  const apronOuter = profile.apronDrop;
  const apronEnd = profile.apronSkirtDrop;
  const apronFar = profile.apronWidth + profile.apronSkirtWidth;
  // 断面点一律按 lateral 递增排列，保证绕序一致（法线朝上）
  const apronInnerLat = hw + vsw;
  // 路堤从"过渡坡外沿"开始，高度与断面 full[0] 完全一致（无缝、无台坎）
  // 路堤的 UV 用世界米数（横向 / 地面尺度、纵向 弧长 / 地面尺度），
  // 与地形贴图完全同尺度 —— 这样"路边草地"和"远处地面"是同一张皮。
  const apronLeft = buildRibbon(
    samples,
    [
      { lateral: -(apronInnerLat + apronFar), dy: -apronEnd },
      { lateral: -(apronInnerLat + profile.apronWidth), dy: -apronOuter },
      { lateral: -(apronInnerLat + 0.8), dy: -apronOuter },
      { lateral: -apronInnerLat, dy: -vd },
    ],
    [
      -(apronInnerLat + apronFar) / GROUND_TILE_METERS,
      -(apronInnerLat + profile.apronWidth) / GROUND_TILE_METERS,
      -(apronInnerLat + 0.8) / GROUND_TILE_METERS,
      -apronInnerLat / GROUND_TILE_METERS,
    ],
    GROUND_TILE_METERS,
    closed,
    hw,
    ramp,
  );
  const apronRight = buildRibbon(
    samples,
    [
      { lateral: apronInnerLat, dy: -vd },
      { lateral: apronInnerLat + 0.8, dy: -apronOuter },
      { lateral: apronInnerLat + profile.apronWidth, dy: -apronOuter },
      { lateral: apronInnerLat + apronFar, dy: -apronEnd },
    ],
    [
      apronInnerLat / GROUND_TILE_METERS,
      (apronInnerLat + 0.8) / GROUND_TILE_METERS,
      (apronInnerLat + profile.apronWidth) / GROUND_TILE_METERS,
      (apronInnerLat + apronFar) / GROUND_TILE_METERS,
    ],
    GROUND_TILE_METERS,
    closed,
    hw,
    ramp,
  );
  const apronCollisionBand = [
    { lateral: -(apronInnerLat + apronFar), dy: -apronEnd },
    { lateral: -(apronInnerLat + profile.apronWidth), dy: -apronOuter },
    { lateral: -apronInnerLat, dy: -vd },
  ];
  const apronCollisionBandRight = [
    { lateral: apronInnerLat, dy: -vd },
    { lateral: apronInnerLat + profile.apronWidth, dy: -apronOuter },
    { lateral: apronInnerLat + apronFar, dy: -apronEnd },
  ];
  const a1 = toTrimesh(buildRibbon(samples, apronCollisionBand, [0, 0.8, 1], 8, closed, hw, ramp));
  const a2 = toTrimesh(buildRibbon(samples, apronCollisionBandRight, [0, 0.2, 1], 8, closed, hw, ramp));
  const apronVerts = new Float32Array(a1.vertices.length + a2.vertices.length);
  apronVerts.set(a1.vertices, 0);
  apronVerts.set(a2.vertices, a1.vertices.length);
  const apronOffset = a1.vertices.length / 3;
  const apronIdx = new Uint32Array(a1.indices.length + a2.indices.length);
  apronIdx.set(a1.indices, 0);
  for (let i = 0; i < a2.indices.length; i++) {
    apronIdx[a1.indices.length + i] = a2.indices[i] + apronOffset;
  }

  // 合并两侧侧壁
  return {
    road,
    kerbLeft,
    kerbRight,
    wallLeft,
    wallRight,
    collision,
    apronLeft,
    apronRight,
    apronCollision: { vertices: apronVerts, indices: apronIdx },
    // 地形网格在这个半径内不能有三角面，否则插值误差会让地面穿出路面
    corridorCutRadius: apronInnerLat + apronFar,
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
  /**
   * 护栏盒体。`visual*` 用于渲染（栏板），`collider*` 用于物理：
   * 碰撞体比可见栏板更深地埋进地面，避免栏板底下留出缝隙
   * —— 有缝隙时车轮会别进去，表现为"卡在赛道边缘动不了"。
   */
  boxes: Array<{
    x: number;
    y: number;
    z: number;
    heading: number;
    halfLength: number;
    visualHalfHeight: number;
    colliderCenterY: number;
    colliderHalfHeight: number;
    halfThickness: number;
  }>;
}

export interface GuardrailRunSpec {
  from: number;
  to: number;
  side: 'left' | 'right' | 'both';
  offset: number;
}

export interface GuardrailBuildSpec {
  runs: GuardrailRunSpec[];
  /** 曲线是否闭合（开放路段不用回绕逻辑） */
  closed: boolean;
  /**
   * 抑制区间（段内 0..1）。落在其中的立柱与栏板不生成。
   * 用途：路口与路段端头必须没有护栏，否则护栏会横穿另一条路，把路堵死。
   */
  suppress?: Array<{ from: number; to: number }>;
}

/** 判断 t 是否落在任一抑制区间内（不跨越 0/1 边界，供开放路段使用）。 */
function isSuppressed(t: number, ranges: Array<{ from: number; to: number }>): boolean {
  for (const r of ranges) {
    if (t >= r.from && t <= r.to) return true;
  }
  return false;
}

export function buildGuardrails(config: GuardrailBuildSpec, centerline: Centerline): GuardrailData {
  const total = centerline.totalLength;
  const samples = centerline.samples;
  const n = samples.length;
  const postSpacing = 4;
  const railHeight = 0.6;
  /** 碰撞体在可见栏板下方额外延伸的深度（米） */
  const railBuryDepth = 0.45;
  const railThickness = 0.12;
  const posts: number[] = [];
  const rotations: number[] = [];
  const boxes: GuardrailData['boxes'] = [];

  const closed = config.closed;
  const idxForT = (t: number) => {
    const tt = closed ? ((t % 1) + 1) % 1 : Math.min(Math.max(t, 0), 1);
    return Math.min(n - 1, Math.max(0, Math.round(tt * n)));
  };
  const tOfIdx = (i: number) => i / n;

  const sides: Array<'left' | 'right'> = [];
  for (const g of config.runs) {
    const list: Array<'left' | 'right'> = g.side === 'both' ? ['left', 'right'] : [g.side];
    for (const side of list) {
      sides.push(side);
      const i0 = idxForT(g.from);
      const i1 = idxForT(g.to);
      const spanIdx = closed
        ? i1 > i0
          ? i1 - i0
          : n - i0 + i1
        : Math.max(i1 - i0, 0);
      const step = Math.max(1, Math.round(postSpacing / (total / n)));
      const suppress = config.suppress ?? [];
      for (let k = 0; k <= spanIdx; k += step) {
        const i = closed ? (i0 + k) % n : Math.min(i0 + k, n - 1);
        if (suppress.length > 0 && isSuppressed(tOfIdx(i), suppress)) continue;
        const s = samples[i];
        const sign = side === 'right' ? 1 : -1;
        const lateral = sign * g.offset;
        const px = s.x + s.rx * lateral;
        const py = s.y + s.ry * lateral;
        const pz = s.z + s.rz * lateral;
        posts.push(px, py, pz);
        rotations.push(Math.atan2(s.tx, s.tz));
      }
      // 碰撞盒：按 4 米一段铺设
      for (let k = 0; k < spanIdx; k += step) {
        const i = closed ? (i0 + k) % n : Math.min(i0 + k, n - 1);
        const j = closed
          ? (i0 + Math.min(k + step, spanIdx)) % n
          : Math.min(i0 + Math.min(k + step, spanIdx), n - 1);
        if (suppress.length > 0 && isSuppressed(tOfIdx(i), suppress)) continue;
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
        const midY = (ay + by) / 2;
        boxes.push({
          x: (ax + bx) / 2,
          y: midY + railHeight / 2,
          z: (az + bz) / 2,
          heading: Math.atan2(dx, dz),
          halfLength: Math.max(len / 2 - 0.02, 0.1),
          visualHalfHeight: railHeight / 2,
          // 碰撞体中心下移，使其底边埋到路面以下 railBuryDepth
          colliderCenterY: midY + railHeight / 2 - railBuryDepth / 2,
          colliderHalfHeight: railHeight / 2 + railBuryDepth / 2,
          halfThickness: railThickness / 2,
        });
      }
    }
  }

  return {
    postPositions: new Float32Array(posts),
    postRotations: new Float32Array(rotations),
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
