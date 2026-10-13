import { RAPIER as R, type PhysicsWorld } from '../physics/PhysicsWorld';
import { GROUP, groups, surfaceById, type SurfaceType } from '../physics/CollisionGroups';
import { Centerline } from '../tracks/Centerline';
import {
  buildGuardrails,
  buildRoadGeometry,
  type GuardrailData,
  type RoadGeometryResult,
} from '../tracks/RoadGeometry';
import { buildTerrainFromProjector, type TerrainData, type TerrainProjector } from '../tracks/Terrain';
import { apronReachOf, roadRoughness } from '../tracks/RoadGeometry';
import type { GuardrailConfig } from '../tracks/types';
import { RoadNetwork, type RoadSegmentCurve } from './RoadNetwork';
import {
  GATE_OPENING_WIDTH,
  REGION_WALL_HEIGHT,
  REGION_WALL_THICKNESS,
  ROAD_KINDS,
  type RegionConfig,
  type RoadSegmentConfig,
} from './types';

/** 一条路段构建后的全部产物。 */
export interface BuiltSegment {
  config: RoadSegmentConfig;
  curve: Centerline<RoadSegmentCurve>;
  road: RoadGeometryResult;
  guardrails: GuardrailData;
  surface: SurfaceType;
  /** 被抑制的护栏区间（段内 0..1） */
  suppressed: Array<{ from: number; to: number }>;
}

/** 不可见边界墙的一段。 */
export interface BoundaryWall {
  x: number;
  y: number;
  z: number;
  heading: number;
  halfLength: number;
  halfHeight: number;
  halfThickness: number;
}

export interface BuiltRegion {
  config: RegionConfig;
  network: RoadNetwork;
  segments: BuiltSegment[];
  terrain: TerrainData;
  /** 路口中央岛（抬高、不可行驶） */
  islands: Array<{ x: number; y: number; z: number; radius: number; height: number }>;
  walls: BoundaryWall[];
  minimap: {
    polylines: Array<{ points: Array<{ x: number; z: number }>; closed: boolean }>;
    bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  };
  spawn: { x: number; y: number; z: number; heading: number };
  stats: {
    totalRoadLength: number;
    segmentCount: number;
    colliderCount: number;
    suppressedGuardrailRanges: number;
  };
}

export interface RegionBuildOptions {
  /** 路段采样分辨率（米） */
  resolution?: number;
  /** 地形网格分辨率（每边格子数） */
  terrainResolution?: number;
  /** 地形相对道路之外的外扩（米） */
  terrainMargin?: number;
}

/**
 * 把一个 RegionConfig 组装成可驾驶的物理世界。
 *
 * 与 TrackBuilder 的关键区别：
 *  - 多条路段（开放或闭合）而不是一条闭合赛道
 *  - 地形走廊按"到**最近任意路段**的距离"压平与挖空
 *  - 沿区域边界布置不可见墙，并在闸口处留出开口
 *  - 路口与端头附近的护栏自动抑制（否则护栏会横穿另一条路把路堵死）
 *
 * 不含任何渲染素材，便于在 Node 里做自动化校验。
 */
export class RegionBuilder {
  readonly built: BuiltRegion;

  constructor(config: RegionConfig, world: PhysicsWorld, opts: RegionBuildOptions = {}) {
    const network = new RoadNetwork(config.roads, { resolution: opts.resolution ?? 1.4 });

    // ---- 1) 逐路段：路面几何 + 碰撞 + 护栏 ----
    const segments: BuiltSegment[] = [];
    let colliderCount = 0;
    for (let i = 0; i < network.curves.length; i++) {
      const curve = network.curves[i];
      const cfg = config.roads[i];
      const kind = ROAD_KINDS[cfg.kind];
      const width = cfg.width ?? kind.width;
      const surface = surfaceById(cfg.surface ?? kind.surface);

      // 逐行算"路堤落点"：如果别的路在本路路堤伸展范围内，就把路面之外的断面
      // 按横向比例下压到那条邻路的高度（真实边坡），否则路堤会悬在邻路沥青上方。
      // 邻路与本路同高时 drop = 0 → 等价于路口压平，顺带消掉接缝台阶。
      const ownReach = apronReachOf({
        width,
        paperThickness: config.paperThickness,
        closed: curve.closed,
      });
      const apronDropRows = curve.samples.map((s) => {
        const low = network.lowestRoadSampleWithin(s.x, s.z, ownReach, i);
        if (!low) return undefined;
        const dy = low.y - s.y;
        // 邻路不比本路低：压平到本路高度即可（路口情形，不留沟）
        if (dy > -0.05) return { dy: 0, to: ownReach };
        // 邻路更低：必须在**触到邻路沥青边缘之前**就降到它下面 0.35 m。
        // 只在外沿降是不够的：线性插值的中段仍会横在邻路沥青上方
        // （实测残余草地高出路面 0.93 m 就是这么来的）。
        const otherHalf = network.curves[low.segmentIndex].config.width / 2;
        const to = Math.max(low.distance - otherHalf, width / 2 + 0.6);
        return { dy: dy - 0.35, to: Math.min(to, ownReach) };
      });

      const road = buildRoadGeometry(
        {
          width,
          paperThickness: config.paperThickness,
          closed: curve.closed,
          apronDropRows,
          // 路面观感与体感按**等级**决定：土路无路缘、明显坑洼；沥青有路缘、接近平整
          kerbHeight: kind.kerbHeight,
          roughness: kind.roughness,
          roughnessSeed: i + 1,
        },
        curve,
      );

      // 路口处两条路的路面会互相重叠并且几乎共面 —— 完全共面会 z-fighting。
      // 给每条路段一个亚毫米级的 Y 偏移（0.4 mm 起），深度测试就有确定赢家，
      // 视觉与物理上完全看不出来，但不会闪。
      const yOffset = -i * 0.0004;
      if (yOffset !== 0) {
        const bufs = [
          road.road.positions,
          road.kerbLeft.positions,
          road.kerbRight.positions,
          road.wallLeft.positions,
          road.wallRight.positions,
          road.apronLeft.positions,
          road.apronRight.positions,
          road.collision.vertices,
          road.apronCollision.vertices,
        ];
        for (const b of bufs) {
          for (let k = 1; k < b.length; k += 3) b[k] += yOffset;
        }
      }

      // 护栏抑制区间：路口附近 + 闸口附近 + 显式声明的端头
      const suppressed = computeSuppressedRanges(curve, [
        ...config.junctions.map((j) => ({ x: j.x, z: j.z, radius: j.radius })),
        ...config.gates.map((g) => ({ x: g.x, z: g.z, radius: GATE_OPENING_WIDTH / 2 + 6 })),
      ]);

      const runs: GuardrailConfig[] = cfg.guardrails ?? [];
      const guardrails = buildGuardrails(
        { runs, closed: curve.closed, suppress: suppressed },
        curve,
      );

      // ---- 碰撞体 ----
      const roadBody = world.createStaticBody(0, 0, 0);
      world.addStaticCollider(
        roadBody,
        R.ColliderDesc.trimesh(road.collision.vertices, road.collision.indices)
          .setFriction(1.0)
          .setRestitution(0.02),
        surface,
      );
      colliderCount++;
      // 路堤（草地）：把走廊挖空区盖上，也是可以开上去的地面
      world.addStaticCollider(
        roadBody,
        R.ColliderDesc.trimesh(road.apronCollision.vertices, road.apronCollision.indices)
          .setFriction(0.85)
          .setRestitution(0.02),
        surfaceById('grass'),
      );
      colliderCount++;
      // 路肩单独登记一份，让轮胎射线拿到"抓地略低"的路面类型
      const kerbSurface = surfaceById('kerb');
      for (const ribbon of [road.kerbLeft, road.kerbRight]) {
        const kerbBody = world.createStaticBody(0, 0, 0);
        world.addStaticCollider(
          kerbBody,
          R.ColliderDesc.trimesh(
            new Float32Array([...ribbon.positions]),
            new Uint32Array([...ribbon.indices]),
          ).setFriction(0.95),
          kerbSurface,
        );
        colliderCount++;
      }
      // 护栏
      if (guardrails.boxes.length > 0) {
        const railBody = world.createStaticBody(0, 0, 0);
        for (const b of guardrails.boxes) {
          const q = new R.Quaternion(0, Math.sin(b.heading / 2), 0, Math.cos(b.heading / 2));
          world.addStaticCollider(
            railBody,
            R.ColliderDesc.cuboid(b.halfThickness, b.colliderHalfHeight, b.halfLength)
              .setTranslation(b.x, b.colliderCenterY, b.z)
              .setRotation(q)
              .setFriction(0.5)
              .setRestitution(0.1)
              .setCollisionGroups(groups(GROUP.TRACK, 0xffff)),
            surfaceById('wall'),
          );
          colliderCount++;
        }
      }

      segments.push({ config: cfg, curve, road, guardrails, surface, suppressed });
    }

    // ---- 2) 地形：走廊按"到最近任意路段"压平与挖空 ----
    const maxCut = Math.max(...segments.map((s) => s.road.corridorCutRadius));
    const maxHalf = Math.max(...segments.map((s) => s.curve.config.width / 2));
    // 地形的范围必须覆盖**区域边界**，而不只是路网的包围盒。
    // 之前地形只按"路网 bbox + margin(170)"生成，而边界可能离最外侧的路更远
    // （这一版东墙离最东的路有 190 m），于是墙立在地形之外的空处：
    // 车一路向东会先掉出地形、从墙底下飞过去（实测冲到 227 km/h 越过边界）。
    const baseProjector = networkProjector(network);
    const terrainProjector = {
      sample: (x: number, z: number) => baseProjector.sample(x, z),
      bounds: {
        minX: Math.min(baseProjector.bounds.minX, config.bounds.minX),
        minZ: Math.min(baseProjector.bounds.minZ, config.bounds.minZ),
        maxX: Math.max(baseProjector.bounds.maxX, config.bounds.maxX),
        maxZ: Math.max(baseProjector.bounds.maxZ, config.bounds.maxZ),
      },
    };
    const terrain = buildTerrainFromProjector(
      terrainProjector,
      {
        terrainAmplitude: config.terrainAmplitude,
        terrainScale: config.terrainScale,
        seed: config.seed,
        paperThickness: config.paperThickness,
        // 走廊宽度取最宽的路段，保证窄路两侧也被压平（宁可多压一点）
        width: maxHalf * 2,
      },
      {
        corridorCutRadius: maxCut,
        resolution: opts.terrainResolution ?? 340,
        margin: opts.terrainMargin ?? 170,
        // 地面顶点色：紧贴路面用 theme.grass（与路堤材质同色），
        // 向外 16→64 m 过渡到 theme.paperGround（野地）。地面因此是一张连续的东西。
        groundNearColor: config.theme.grass,
        groundFarColor: config.theme.paperGround,
        groundColorFade: [16, 64],
      },
    );
    const terrainBody = world.createStaticBody(0, 0, 0);
    world.addStaticCollider(
      terrainBody,
      R.ColliderDesc.trimesh(terrain.vertices, terrain.indices)
        .setFriction(0.85)
        .setRestitution(0.02),
      surfaceById('grass'),
    );
    colliderCount++;

    // ---- 3) 路口中央岛（环岛） ----
    const islands: BuiltRegion['islands'] = [];
    for (const j of config.junctions) {
      const r = j.islandHeight ?? 0;
      if (r <= 0) continue;
      const radius = j.islandRadius ?? j.radius * 0.55;
      const islandHeight = r;
      const body = world.createStaticBody(j.x, j.y + islandHeight / 2, j.z);
      // 圆柱做中央岛：抬高的实体，不可行驶
      world.addStaticCollider(
        body,
        R.ColliderDesc.cylinder(islandHeight / 2, radius).setFriction(0.9),
        surfaceById('grass'),
      );
      colliderCount++;
      islands.push({ x: j.x, y: j.y, z: j.z, radius, height: islandHeight });
    }

    // ---- 4) 区域边界空气墙（在闸口处留开口） ----
    const walls = buildBoundaryWalls(config, terrain);
    if (walls.length > 0) {
      const wallBody = world.createStaticBody(0, 0, 0);
      for (const w of walls) {
        const q = new R.Quaternion(0, Math.sin(w.heading / 2), 0, Math.cos(w.heading / 2));
        world.addStaticCollider(
          wallBody,
          R.ColliderDesc.cuboid(w.halfThickness, w.halfHeight, w.halfLength)
            .setTranslation(w.x, w.y, w.z)
            .setRotation(q)
            .setFriction(0.4)
            .setRestitution(0.05)
            .setCollisionGroups(groups(GROUP.TRACK, 0xffff)),
          surfaceById('wall'),
        );
        colliderCount++;
      }
    }

    // ---- 5) 小地图折线 ----
    const polylines: BuiltRegion['minimap']['polylines'] = [];
    let mnX = Infinity;
    let mnZ = Infinity;
    let mxX = -Infinity;
    let mxZ = -Infinity;
    for (const seg of segments) {
      const step = Math.max(1, Math.floor(seg.curve.samples.length / 160));
      const pts: Array<{ x: number; z: number }> = [];
      for (let i = 0; i < seg.curve.samples.length; i += step) {
        const s = seg.curve.samples[i];
        pts.push({ x: s.x, z: s.z });
        mnX = Math.min(mnX, s.x);
        mnZ = Math.min(mnZ, s.z);
        mxX = Math.max(mxX, s.x);
        mxZ = Math.max(mxZ, s.z);
      }
      polylines.push({ points: pts, closed: seg.curve.closed });
    }
    if (!Number.isFinite(mnX)) {
      mnX = mnZ = 0;
      mxX = mxZ = 1;
    }

    // ---- 6) 出生点 ----
    const spawnSegIdx = Math.max(0, network.segmentIndexById(config.spawn.segment));
    const spawnCurve = network.curves[spawnSegIdx];
    const spawnSample = spawnCurve.sampleAt(config.spawn.t);
    const spawnLat = config.spawn.lateral ?? 0;
    const spawn = {
      x: spawnSample.x + spawnSample.rx * spawnLat,
      y: spawnSample.y + spawnSample.ry * spawnLat + 0.4,
      z: spawnSample.z + spawnSample.rz * spawnLat,
      heading: Math.atan2(spawnSample.tx, spawnSample.tz),
    };

    this.built = {
      config,
      network,
      segments,
      terrain,
      islands,
      walls,
      minimap: {
        polylines,
        bounds: { minX: mnX, minZ: mnZ, maxX: mxX, maxZ: mxZ },
      },
      spawn,
      stats: {
        totalRoadLength: network.totalLength,
        segmentCount: segments.length,
        colliderCount,
        suppressedGuardrailRanges: segments.reduce((a, s) => a + s.suppressed.length, 0),
      },
    };
  }

  get builtRegion(): BuiltRegion {
    return this.built;
  }
}

/** 把路网包装成地形用的"最近道路"查询。 */
export function networkProjector(net: RoadNetwork): TerrainProjector {
  // 预计算：每个采样点周围 R 米内的最低路面高度（含自身）。
  // 一次性算好，之后每个地形格点只是 O(1) 查表 —— 逐格调用空间索引会慢一个量级。
  const NEIGHBOUR_R = 22;
  const floorCache = net.curves.map((c) => {
    const out = new Float32Array(c.samples.length);
    for (let i = 0; i < c.samples.length; i++) {
      const s = c.samples[i];
      const low = net.lowestRoadSampleWithin(s.x, s.z, NEIGHBOUR_R);
      out[i] = low ? Math.min(low.y, s.y) : s.y;
    }
    return out;
  });

  return {
    bounds: net.bounds,
    sample(x, z) {
      const p = net.project(x, z);
      const s = net.curves[p.segmentIndex].samples[p.sampleIndex];
      const curve = net.curves[p.segmentIndex];
      const closed = curve.closed;
      const last = curve.samples.length - 1;
      let cutDistance = p.distance;
      // 开放路段的端头之外不挖空，否则路的尽头会出现天坑
      if (!closed && (p.sampleIndex === 0 || p.sampleIndex === last)) {
        const along = (x - s.x) * s.tx + (z - s.z) * s.tz;
        if ((p.sampleIndex === 0 && along < 0) || (p.sampleIndex === last && along > 0)) {
          cutDistance = Number.POSITIVE_INFINITY;
        }
      }
      // 走廊压平取"附近最低的那条路"：否则较高那条的平面会把较低那条埋掉。
      // 压到较低那条时不再施加它的横向超高（此时这里是两路之间的平地，平的就对）。
      // 地形走廊必须与路面加同一个起伏量，否则土路下颠处地形会从路面穿出
      const si = p.segmentIndex;
      const segRough = net.roughnessOf(si);
      const roadBump =
        segRough > 0
          ? roadRoughness(s.s, p.lateral, net.roughnessSeedOf(si)) * segRough
          : 0;
      const floorY = floorCache[p.segmentIndex][p.sampleIndex];
      const buried = floorY < s.y - 0.05;
      return {
        distance: p.distance,
        lateral: p.lateral,
        bankLateral: buried
          ? 0
          : Math.max(-s.halfWidth, Math.min(s.halfWidth, p.lateral)),
        roadY: buried ? floorY : s.y,
        roadRy: s.ry,
        cutDistance,
        roadBump,
      };
    },
  };
}

/**
 * 计算某条路段上需要抑制护栏的段内区间。
 * 做法：逐采样点判断是否落在任一"抑制源"（路口/闸口）半径内，再把连续区间合并。
 */
function computeSuppressedRanges(
  curve: Centerline<RoadSegmentCurve>,
  spots: Array<{ x: number; z: number; radius: number }>,
): Array<{ from: number; to: number }> {
  if (spots.length === 0) return [];
  const n = curve.samples.length;
  const flags = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const s = curve.samples[i];
    for (const spot of spots) {
      const dx = s.x - spot.x;
      const dz = s.z - spot.z;
      if (dx * dx + dz * dz < spot.radius * spot.radius) {
        flags[i] = true;
        break;
      }
    }
  }
  const ranges: Array<{ from: number; to: number }> = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (flags[i] && start < 0) start = i;
    if ((!flags[i] || i === n - 1) && start >= 0) {
      const end = flags[i] ? i : i - 1;
      ranges.push({ from: start / n, to: (end + 1) / n });
      start = -1;
    }
  }
  return ranges;
}

/**
 * 沿区域矩形边界布置不可见墙，并在闸口处留出开口。
 * 做法是沿周长按固定步长放置墙段，位于闸口开口宽度内的墙段直接跳过 —— 简单且不会算错区间。
 */
function buildBoundaryWalls(
  config: RegionConfig,
  terrain: TerrainData,
): BoundaryWall[] {
  const { minX, minZ, maxX, maxZ } = config.bounds;
  const step = 20;
  const segLen = step / 2;
  const walls: BoundaryWall[] = [];
  const opening = GATE_OPENING_WIDTH / 2;
  /** 闸口"贴近某条边"的判定距离：闸口不需要严格落在边界线上 */
  const gateSnapDistance = 90;

  // 把每个闸口投影到它最贴近的那条边上，得到该边上需要开口的位置。
  // 早期版本直接比较闸口与墙段的直线距离：闸口只要不在边界线上（通常离几十米），
  // 就永远不会在墙上开洞，于是"通往下一区的开口"是假的。
  const gapS: number[] = [];
  const gapN: number[] = [];
  const gapW: number[] = [];
  const gapE: number[] = [];
  for (const g of config.gates) {
    const inX = g.x >= minX - 60 && g.x <= maxX + 60;
    const inZ = g.z >= minZ - 60 && g.z <= maxZ + 60;
    if (inX && Math.abs(g.z - minZ) < gateSnapDistance) gapS.push(Math.min(Math.max(g.x, minX), maxX));
    if (inX && Math.abs(g.z - maxZ) < gateSnapDistance) gapN.push(Math.min(Math.max(g.x, minX), maxX));
    if (inZ && Math.abs(g.x - minX) < gateSnapDistance) gapW.push(Math.min(Math.max(g.z, minZ), maxZ));
    if (inZ && Math.abs(g.x - maxX) < gateSnapDistance) gapE.push(Math.min(Math.max(g.z, minZ), maxZ));
  }

  const inGap = (v: number, gaps: number[]): boolean => gaps.some((g) => Math.abs(v - g) < opening);

  const push = (x: number, z: number, heading: number): void => {
    const gy = terrain.heightAt(x, z);
    walls.push({
      x,
      y: gy + REGION_WALL_HEIGHT / 2 - 4,
      z,
      heading,
      halfLength: segLen,
      halfHeight: REGION_WALL_HEIGHT / 2,
      halfThickness: REGION_WALL_THICKNESS / 2,
    });
  };

  // 墙段的长轴是盒体的**局部 Z**，绕 Y 旋转 heading 后：
  //   heading = π/2 → 长轴沿世界 X（用于南/北边）
  //   heading = 0   → 长轴沿世界 Z（用于东/西边）
  for (let x = minX; x <= maxX; x += step) {
    if (!inGap(x, gapS)) push(x, minZ, Math.PI / 2);
    if (!inGap(x, gapN)) push(x, maxZ, Math.PI / 2);
  }
  for (let z = minZ; z <= maxZ; z += step) {
    if (!inGap(z, gapW)) push(minX, z, 0);
    if (!inGap(z, gapE)) push(maxX, z, 0);
  }
  return walls;
}
