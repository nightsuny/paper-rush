import type { Car, CarInput } from '../../src/vehicles/Car';
import type { Centerline } from '../../src/tracks/Centerline';
import { PHYSICS_DT, type PhysicsWorld } from '../../src/physics/PhysicsWorld';

/**
 * 测试用参考驾驶员（不在游戏运行时使用）。
 *
 * 用途：
 *  - 验证赛道"真的能开完一圈"（而不是只看几何）
 *  - 用真实物理求解测出单圈时间，作为赛程时长与平衡文档的依据
 *
 * 实现：纯追踪（pure pursuit）转向 + 曲率限速。它是最朴素的开法，
 * 因此测出的圈速是"普通玩家"的上界（真实玩家会更快）。
 */

export interface LapResult {
  /** 完成的圈数 */
  laps: number;
  /** 用时（秒） */
  time: number;
  /** 最高速度 m/s */
  maxSpeed: number;
  /** 平均速度 m/s */
  avgSpeed: number;
  /** 四轮离地（离开赛道/腾空）累计时间 */
  airborneTime: number;
  /** 只在草地/非赛道面上行驶的累计时间 */
  offTrackTime: number;
  /** 是否卡住过 */
  stuck: boolean;
  /** 是否翻车过 */
  flipped: boolean;
  /** 记录的最大横向偏移（米） */
  maxLateral: number;
}

export interface ReferenceDriverOptions {
  /** 前视距离（米） */
  lookahead?: number;
  /** 目标横向加速度（m/s²），应低于附着极限 */
  targetLateralAccel?: number;
  /** 最高目标速度（m/s） */
  maxSpeed?: number;
  /** 转向增益 */
  steerGain?: number;
  /** 是否允许使用刹车 */
  useBrake?: boolean;
}

export function driveReference(
  car: Car,
  world: PhysicsWorld,
  centerline: Centerline,
  targetLaps: number,
  maxSeconds: number,
  opts: ReferenceDriverOptions = {},
): LapResult {
  const lookahead = opts.lookahead ?? 14;
  const targetLat = opts.targetLateralAccel ?? 9.5;
  const maxSpeed = opts.maxSpeed ?? 34;
  const steerGain = opts.steerGain ?? 1.5;
  const useBrake = opts.useBrake ?? true;
  const total = centerline.totalLength;

  let t = 0;
  let time = 0;
  let maxSpeedSeen = 0;
  let distance = 0;
  let airborneTime = 0;
  let offTrackTime = 0;
  let stuck = false;
  let flipped = false;
  let maxLateral = 0;
  let laps = 0;
  let prevT = centerline.project(car.position.x, car.position.z, car.position.y).t;
  let progress = 0;

  const input: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

  while (time < maxSeconds && laps < targetLaps) {
    const p = car.position;
    const proj = centerline.project(p.x, p.z, p.y);
    t = proj.t;
    maxLateral = Math.max(maxLateral, Math.abs(proj.lateral));

    // 进度累加（处理跨圈回绕）
    let d = t - prevT;
    if (d < -0.5) d += 1;
    if (d > 0.5) d -= 1;
    progress += d;
    prevT = t;
    if (progress >= 1) {
      progress -= 1;
      laps++;
      if (laps >= targetLaps) break;
    }

    // 目标点：沿中心线向前看 lookahead 米（车速越高看得越远）
    const speed = car.telemetry.speed;
    const la = lookahead + speed * 0.45;
    const target = centerline.pointAt(t + la / total);
    const forward = car.forward;
    const right = car.right;
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const localForward = dx * forward.x + dz * forward.z;
    const localRight = dx * right.x + dz * right.z;
    const angle = Math.atan2(-localRight, Math.max(localForward, 1));
    let steer = angle * steerGain;
    steer = Math.max(-1, Math.min(1, steer));

    // 限速：扫描前方一段，取曲率允许的最低速度
    let vAllowed = maxSpeed;
    const scanMeters = 40 + speed * 1.6;
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const ahead = (i / steps) * scanMeters;
      const s = centerline.sampleAt(t + ahead / total);
      const k = Math.max(s.curvature, 1e-5);
      const v = Math.sqrt(targetLat / k);
      // 距离越远，允许的速度可以略高（留出制动距离）
      const weighted = v + ahead * 0.10;
      vAllowed = Math.min(vAllowed, weighted);
    }
    vAllowed = Math.max(vAllowed, 7);

    if (speed < vAllowed - 0.8) {
      input.throttle = 1;
      input.brake = 0;
    } else if (speed > vAllowed + 1.2 && useBrake) {
      input.throttle = 0;
      input.brake = Math.min(0.8, (speed - vAllowed) * 0.25);
    } else {
      input.throttle = 0.45;
      input.brake = 0;
    }
    input.steer = steer;
    input.handbrake = false;

    car.step(PHYSICS_DT, input);
    world.step();

    distance += speed * PHYSICS_DT;
    if (car.telemetry.airborne) airborneTime += PHYSICS_DT;
    if (car.telemetry.surface && !car.telemetry.surface.onTrack) offTrackTime += PHYSICS_DT;
    if (speed < 1.5 && time > 3) stuck = true;
    if (car.up.y < 0.3) flipped = true;
    maxSpeedSeen = Math.max(maxSpeedSeen, speed);
    time += PHYSICS_DT;
  }

  return {
    laps,
    time,
    maxSpeed: maxSpeedSeen,
    avgSpeed: time > 0 ? distance / time : 0,
    airborneTime,
    offTrackTime,
    stuck,
    flipped,
    maxLateral,
  };
}
