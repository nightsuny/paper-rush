import RAPIER from '@dimforge/rapier3d-compat';
import { GROUP, groups, type SurfaceType } from './CollisionGroups';

/** 固定物理步长：60 Hz。渲染帧率与它解耦。 */
export const PHYSICS_DT = 1 / 60;

let wasmReady = false;

/** 初始化 Rapier WASM（compat 包需要显式初始化）。幂等。 */
export async function initPhysics(): Promise<void> {
  if (wasmReady) return;
  await RAPIER.init();
  wasmReady = true;
}

export { RAPIER };

/** 刚体快照，用于渲染插值。 */
export interface BodySnapshot {
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export interface TrackedBody {
  readonly body: RAPIER.RigidBody;
  /** 上一步物理的位姿（插值起点）。 */
  readonly prev: BodySnapshot;
  /** 当前物理位姿（插值终点）。 */
  readonly curr: BodySnapshot;
}

interface SurfaceCollider {
  surface: SurfaceType;
}

/**
 * Rapier 世界包装。负责：
 *  - 固定步长推进
 *  - 刚体注册与"步进前/后"位姿记录（供渲染插值）
 *  - collider → 路面类型的映射（轮胎抓地靠它按路面变化）
 */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  /** 已注册用于插值的刚体。 */
  private readonly tracked: TrackedBody[] = [];
  private readonly surfaces = new Map<number, SurfaceCollider>();

  constructor(gravity = -9.81) {
    this.world = new RAPIER.World({ x: 0, y: gravity, z: 0 });
    this.world.timestep = PHYSICS_DT;
    // 默认 4 次求解迭代对这种轻量刚体足够；提高迭代会让悬挂更稳定
    this.world.numSolverIterations = 8;
  }

  /** 注册一个需要渲染插值的刚体。 */
  track(body: RAPIER.RigidBody): TrackedBody {
    const t: TrackedBody = {
      body,
      prev: { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
      curr: { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    };
    this.copyTransform(body, t.prev);
    this.copyTransform(body, t.curr);
    this.tracked.push(t);
    return t;
  }

  private copyTransform(body: RAPIER.RigidBody, out: BodySnapshot): void {
    const t = body.translation();
    const r = body.rotation();
    out.px = t.x;
    out.py = t.y;
    out.pz = t.z;
    out.qx = r.x;
    out.qy = r.y;
    out.qz = r.z;
    out.qw = r.w;
  }

  /** 步进一次：先记录步进前位姿供插值使用。 */
  step(): void {
    for (const t of this.tracked) {
      const tmp = t.prev;
      tmp.px = t.curr.px;
      tmp.py = t.curr.py;
      tmp.pz = t.curr.pz;
      tmp.qx = t.curr.qx;
      tmp.qy = t.curr.qy;
      tmp.qz = t.curr.qz;
      tmp.qw = t.curr.qw;
    }
    this.world.step();
    for (const t of this.tracked) this.copyTransform(t.body, t.curr);
  }

  /** 把一个 collider 标记为某种路面。 */
  registerSurface(collider: RAPIER.Collider, surface: SurfaceType): void {
    this.surfaces.set(collider.handle, { surface });
  }

  surfaceOf(collider: RAPIER.Collider | null): SurfaceType | null {
    if (!collider) return null;
    return this.surfaces.get(collider.handle)?.surface ?? null;
  }

  get trackedBodies(): readonly TrackedBody[] {
    return this.tracked;
  }

  /** 从已存在的静态刚体上创建碰撞体，并登记路面类型。 */
  addStaticCollider(
    body: RAPIER.RigidBody,
    desc: RAPIER.ColliderDesc,
    surface: SurfaceType,
  ): RAPIER.Collider {
    desc.setCollisionGroups(groups(GROUP.TRACK, 0xffff));
    const col = this.world.createCollider(desc, body);
    this.registerSurface(col, surface);
    return col;
  }

  /** 创建一个静态刚体（世界坐标系下，可带位姿）。 */
  createStaticBody(x: number, y: number, z: number, rotY = 0): RAPIER.RigidBody {
    const q = new RAPIER.Quaternion(0, Math.sin(rotY / 2), 0, Math.cos(rotY / 2));
    return this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z).setRotation(q),
    );
  }

  dispose(): void {
    this.world.free();
  }
}
