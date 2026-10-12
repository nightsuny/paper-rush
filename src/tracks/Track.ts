import { RAPIER as R, type PhysicsWorld } from '../physics/PhysicsWorld';
import { GROUP, groups, surfaceById } from '../physics/CollisionGroups';
import { Centerline } from './Centerline';
import {
  buildGate,
  buildGuardrails,
  buildRoadGeometry,
  type GateData,
  type GuardrailData,
  type RoadGeometryResult,
} from './RoadGeometry';
import { buildTerrain, type TerrainData } from './Terrain';
import type { TrackConfig } from './types';

export interface TrackCheckpoint {
  /** 归一化位置 */
  t: number;
  /** 采样点索引 */
  index: number;
  x: number;
  y: number;
  z: number;
  /** 门的横向单位向量（右向） */
  rx: number;
  rz: number;
  /** 门的前向单位向量（用于判断是否穿过门平面） */
  tx: number;
  tz: number;
  halfWidth: number;
}

export interface TrackSpawn {
  x: number;
  y: number;
  z: number;
  heading: number;
}

export interface BuiltTrack {
  config: TrackConfig;
  centerline: Centerline;
  road: RoadGeometryResult;
  terrain: TerrainData;
  guardrails: GuardrailData;
  checkpoints: TrackCheckpoint[];
  startGate: GateData;
  /** 发车位（含小型交错排列），index 0 为杆位 */
  spawns: TrackSpawn[];
  /** 小地图折线（已归一化到 0..1 的包围盒） */
  minimap: { points: Array<{ x: number; z: number }>; bounds: { minX: number; minZ: number; maxX: number; maxZ: number } };
  colliderCount: number;
}

/**
 * 把赛道配置变成可驾驶的物理对象：路面三角网格、路缘侧壁、护栏盒体、地形。
 * 不包含任何渲染素材，方便在 Node 里做自动化校验。
 */
export class TrackBuilder {
  readonly built: BuiltTrack;

  constructor(config: TrackConfig, world: PhysicsWorld, resolution = 1.4) {
    const centerline = new Centerline(config, resolution);
    const road = buildRoadGeometry(
      { width: config.width, paperThickness: config.paperThickness, closed: true },
      centerline,
    );
    const terrain = buildTerrain(config, centerline, {
      corridorCutRadius: road.corridorCutRadius,
    });
    const guardrails = buildGuardrails(
      { runs: config.guardrails, closed: true },
      centerline,
    );

    let colliderCount = 0;
    const asphalt = surfaceById('asphalt');
    const kerbSurface = surfaceById('kerb');
    const grass = surfaceById('grass');
    const wallSurface = surfaceById('wall');

    // ---- 路面：真实连续三角网格，支持高程与高架 ----
    const roadBody = world.createStaticBody(0, 0, 0);
    world.addStaticCollider(
      roadBody,
      R.ColliderDesc.trimesh(road.collision.vertices, road.collision.indices).setFriction(1.0).setRestitution(0.02),
      asphalt,
    );
    colliderCount++;

    // 路肩（kerb）：单独登记一份碰撞面，让轮胎射线在路肩上拿到"抓地略低"的路面类型。
    // 它与主路面网格在几何上重合，但材质不同 —— 车轮取到的会是这里登记的类型。
    const kerbLeft = world.createStaticBody(0, 0, 0);
    world.addStaticCollider(
      kerbLeft,
      R.ColliderDesc.trimesh(
        new Float32Array([...road.kerbLeft.positions]),
        new Uint32Array([...road.kerbLeft.indices]),
      ).setFriction(0.95),
      kerbSurface,
    );
    colliderCount++;
    const kerbRight = world.createStaticBody(0, 0, 0);
    world.addStaticCollider(
      kerbRight,
      R.ColliderDesc.trimesh(
        new Float32Array([...road.kerbRight.positions]),
        new Uint32Array([...road.kerbRight.indices]),
      ).setFriction(0.95),
      kerbSurface,
    );
    colliderCount++;

    // ---- 路堤：路缘外侧的纸带，覆盖走廊挖空区，也是可以开上去的草地 ----
    world.addStaticCollider(
      roadBody,
      R.ColliderDesc.trimesh(road.apronCollision.vertices, road.apronCollision.indices)
        .setFriction(0.85)
        .setRestitution(0.02),
      grass,
    );
    colliderCount++;

    // ---- 地形：草地，同一份顶点数据也用于渲染 ----
    const terrainBody = world.createStaticBody(0, 0, 0);
    world.addStaticCollider(
      terrainBody,
      R.ColliderDesc.trimesh(terrain.vertices, terrain.indices).setFriction(0.85).setRestitution(0.02),
      grass,
    );
    colliderCount++;

    // ---- 护栏：按段铺设盒体，保证无缺口 ----
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
        wallSurface,
      );
      colliderCount++;
    }

    // ---- 检查点 ----
    const checkpoints: TrackCheckpoint[] = config.checkpoints.map((cp) => {
      const s = centerline.sampleAt(cp.t);
      const index = Math.round(cp.t * centerline.samples.length) % centerline.samples.length;
      return {
        t: cp.t,
        index,
        x: s.x,
        y: s.y,
        z: s.z,
        rx: s.rx,
        rz: s.rz,
        tx: s.tx,
        tz: s.tz,
        halfWidth: cp.halfWidth,
      };
    });

    const startGate = buildGate(centerline, config.startT, config.width / 2);

    // ---- 发车位：起跑线后方的交错排列 ----
    const spawns: TrackSpawn[] = [];
    const gridGap = 7.5;
    const lateral = 2.4;
    for (let i = 0; i < 8; i++) {
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? -1 : 1;
      const t = config.startT - (row + 1) * (gridGap / centerline.totalLength);
      const p = centerline.pointAt(t, side * lateral);
      spawns.push({
        x: p.x,
        y: p.y + 0.02,
        z: p.z,
        heading: Math.atan2(centerline.sampleAt(t).tx, centerline.sampleAt(t).tz),
      });
    }

    // ---- 小地图折线 ----
    const step = Math.max(1, Math.floor(centerline.samples.length / 220));
    const raw: Array<{ x: number; z: number }> = [];
    for (let i = 0; i < centerline.samples.length; i += step) {
      raw.push({ x: centerline.samples[i].x, z: centerline.samples[i].z });
    }
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const p of raw) {
      minX = Math.min(minX, p.x);
      minZ = Math.min(minZ, p.z);
      maxX = Math.max(maxX, p.x);
      maxZ = Math.max(maxZ, p.z);
    }
    const spanX = Math.max(maxX - minX, 1);
    const spanZ = Math.max(maxZ - minZ, 1);
    const span = Math.max(spanX, spanZ);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const points = raw.map((p) => ({
      x: (p.x - cx) / span + 0.5,
      z: (p.z - cz) / span + 0.5,
    }));

    this.built = {
      config,
      centerline,
      road,
      terrain,
      guardrails,
      checkpoints,
      startGate,
      spawns,
      minimap: { points, bounds: { minX, minZ, maxX, maxZ } },
      colliderCount,
    };
  }

  get config(): TrackConfig {
    return this.built.config;
  }

  get centerline(): Centerline {
    return this.built.centerline;
  }
}
