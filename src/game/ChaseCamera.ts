import * as THREE from 'three';
import type { Car } from '../vehicles/Car';

/**
 * 第三人称追车摄像机。
 *
 * 目标位置在车后上方，位置与朝向都做了时间平滑；
 * 速度越高视角越远、FOV 略微张开，高速时有"冲出去"的感觉。
 * 碰撞不做射线避让（纸艺风格下可接受），但会随地形抬高下限高度。
 */

export interface ChaseCameraOptions {
  /** 基础跟随距离（米） */
  distance?: number;
  /** 基础高度（米） */
  height?: number;
  /** 看向车辆前方的前瞻距离（米） */
  lookAhead?: number;
  /** 基础 FOV */
  fov?: number;
  /** 位置平滑时间常数（秒） */
  positionSmooth?: number;
  /** 朝向平滑时间常数（秒） */
  rotationSmooth?: number;
}

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  private readonly distance: number;
  private readonly height: number;
  private readonly lookAhead: number;
  private readonly baseFov: number;
  private readonly posSmooth: number;
  private readonly rotSmooth: number;

  private readonly desired = new THREE.Vector3();
  private readonly smoothedPos = new THREE.Vector3();
  private readonly smoothedTarget = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private mode: 'chase' | 'far' | 'close' = 'chase';
  private initialised = false;

  constructor(aspect: number, opts: ChaseCameraOptions = {}) {
    this.distance = opts.distance ?? 7.4;
    this.height = opts.height ?? 3.0;
    this.lookAhead = opts.lookAhead ?? 9;
    this.baseFov = opts.fov ?? 62;
    this.posSmooth = opts.positionSmooth ?? 0.13;
    this.rotSmooth = opts.rotationSmooth ?? 0.10;
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 0.35, 2200);
  }

  /** 切换镜头模式（C 键）。 */
  cycleMode(): void {
    this.mode = this.mode === 'chase' ? 'close' : this.mode === 'close' ? 'far' : 'chase';
  }

  get modeName(): string {
    return this.mode === 'chase' ? '标准' : this.mode === 'close' ? '贴近' : '远景';
  }

  /** 立即对齐到目标（发车/重置/切换镜头后使用）。 */
  snapTo(car: Car): void {
    const forward = car.forward;
    const p = car.position;
    this.desired.set(
      p.x - forward.x * this.distance,
      p.y + this.height,
      p.z - forward.z * this.distance,
    );
    this.smoothedPos.copy(this.desired);
    this.smoothedTarget.set(p.x + forward.x * this.lookAhead, p.y + 0.8, p.z + forward.z * this.lookAhead);
    this.camera.position.copy(this.smoothedPos);
    this.camera.lookAt(this.smoothedTarget);
    this.initialised = true;
  }

  update(dt: number, car: Car): void {
    const modeScale = this.mode === 'close' ? 0.72 : this.mode === 'far' ? 1.35 : 1;
    const speed = car.telemetry.speed;
    const speedT = Math.min(speed / 34, 1);
    const dist = this.distance * modeScale * (1 + speedT * 0.26);
    const height = this.height * modeScale * (1 + speedT * 0.05);

    const forward = car.forward;
    const p = car.position;

    // 期望位置：车后上方，并稍微朝速度方向偏移，让漂移时能看见车侧
    const vel = car.body.linvel();
    const vh = Math.hypot(vel.x, vel.z);
    let dirX = forward.x;
    let dirZ = forward.z;
    if (vh > 4) {
      // 与速度方向做一点混合（0.25），漂移时镜头更自然
      const blend = 0.25 * Math.min(vh / 20, 1);
      dirX = forward.x * (1 - blend) + (vel.x / vh) * blend;
      dirZ = forward.z * (1 - blend) + (vel.z / vh) * blend;
      const l = Math.hypot(dirX, dirZ) || 1;
      dirX /= l;
      dirZ /= l;
    }

    this.desired.set(p.x - dirX * dist, p.y + height, p.z - dirZ * dist);

    // 位置平滑（与帧率无关的指数逼近）
    const kPos = 1 - Math.exp(-dt / Math.max(this.posSmooth, 1e-4));
    this.smoothedPos.lerp(this.desired, kPos);

    // 目标点：车前上方
    const laDist = this.lookAhead * (1 + speedT * 0.7);
    this.tmp.set(
      p.x + forward.x * laDist,
      p.y + 0.85 + Math.min(speed * 0.012, 0.5),
      p.z + forward.z * laDist,
    );
    const kRot = 1 - Math.exp(-dt / Math.max(this.rotSmooth, 1e-4));
    this.smoothedTarget.lerp(this.tmp, kRot);

    // 不让镜头钻进地面
    const minY = this.smoothedTarget.y - 1.6;
    if (this.smoothedPos.y < minY) this.smoothedPos.y = minY;

    this.camera.position.copy(this.smoothedPos);
    this.camera.lookAt(this.smoothedTarget);
    this.camera.fov = this.baseFov + speedT * 9;
    this.camera.updateProjectionMatrix();
    this.initialised = true;
  }

  get ready(): boolean {
    return this.initialised;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
