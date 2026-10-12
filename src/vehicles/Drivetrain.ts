import type { DerivedVehicle } from './VehicleSpec';

/**
 * 动力总成：发动机扭矩曲线 + 自动变速箱 + 倒挡。
 *
 * 所有输出都是真实物理量：driveForce 是轮端牵引力（N），由
 *   轮端力 = 扭矩 × 传动比 × 主减 × 效率 / 车轮半径
 * 得到，最终再由 Car 按轮胎附着极限裁剪。
 */

export interface DrivetrainInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  handbrake: boolean;
}

export interface DrivetrainState {
  /** -1 为倒挡，1..n 为前进挡。 */
  gear: number;
  /** 发动机转速 rpm。 */
  rpm: number;
  /** 当前输出扭矩 N·m（负值为倒挡/发动机制动）。 */
  engineTorque: number;
  /** 轮端牵引力 N（正为前进方向）。 */
  driveForce: number;
  /** 是否正在换挡（换挡期间无牵引力）。 */
  shifting: boolean;
  /** 归一化油门（含响应延迟）。 */
  effectiveThrottle: number;
}

const RPM_TO_RAD = (Math.PI * 2) / 60;

export class Drivetrain {
  private readonly d: DerivedVehicle;
  private rpm: number;
  private gear = 1;
  private shiftTimer = 0;
  private throttleLagged = 0;
  private pendingGear = 0;
  /** 静止计时：必须真正停稳一小段时间才挂倒挡 */
  private stationaryFor = 0;

  constructor(derived: DerivedVehicle) {
    this.d = derived;
    this.rpm = derived.spec.engineIdleRpm;
  }

  reset(): void {
    this.rpm = this.d.spec.engineIdleRpm;
    this.gear = 1;
    this.shiftTimer = 0;
    this.throttleLagged = 0;
    this.pendingGear = 0;
    this.stationaryFor = 0;
  }

  /**
   * 发动机扭矩曲线。
   *
   * 形状：从怠速到峰值扭矩转速线性上升，之后到断油转速线性下降；
   * 同时以最大功率为上限（T ≤ P/ω），保证"功率限制"永远成立。
   */
  torqueAt(rpm: number): number {
    const s = this.d.spec;
    if (rpm <= 0) return 0;
    if (rpm > s.engineRedlineRpm) return 0; // 断油

    const lo = Math.max(s.engineIdleRpm * 0.6, 1);
    const peakT = s.enginePeakTorqueRpm;
    const peakP = s.enginePeakPowerRpm;
    const red = s.engineRedlineRpm;

    let t: number;
    if (rpm <= peakT) {
      // 怠速时保留 82% 扭矩：低转扭矩决定起步加速能力
      const k = (rpm - lo) / Math.max(peakT - lo, 1);
      t = s.engineMaxTorque * (0.82 + 0.18 * Math.min(Math.max(k, 0), 1));
    } else {
      const k = (rpm - peakT) / Math.max(red * 1.02 - peakT, 1);
      t = s.engineMaxTorque * (1 - 0.40 * Math.min(Math.max(k, 0), 1));
    }

    // 功率上限
    const omega = Math.max(rpm * RPM_TO_RAD, 1);
    const powerLimit = s.engineMaxPower / omega;
    const powerRpmScale = rpm > peakP ? 1.0 : 1.25; // 低转时功率限制不构成约束
    t = Math.min(t, powerLimit * powerRpmScale);

    return Math.max(t, 0);
  }

  /** 当前理论极速（m/s），用于自动换挡判断。 */
  private wheelAngularSpeed(speed: number): number {
    return speed / this.d.spec.wheelRadius;
  }

  private ratioFor(gear: number): number {
    const s = this.d.spec;
    if (gear === -1) return Math.abs(s.reverseRatio);
    const idx = Math.min(Math.max(gear, 1), s.gearRatios.length) - 1;
    return s.gearRatios[idx];
  }

  /**
   * 推进一步。
   * @param speed 车辆沿车身前进方向的速度（m/s，可为负）。
   */
  update(dt: number, input: DrivetrainInput, speed: number): DrivetrainState {
    const s = this.d.spec;
    const driven = this.d.drivenWheels.length || 2;

    // 油门响应（一阶延迟）
    const tau = Math.max(s.throttleResponseTime, 0.001);
    this.throttleLagged += (input.throttle - this.throttleLagged) * Math.min(1, dt / tau);

    // 换挡计时
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      if (this.shiftTimer <= 0) {
        this.gear = this.pendingGear || this.gear;
        this.pendingGear = 0;
      }
    }
    const shifting = this.shiftTimer > 0;

    // 倒挡判定：按住刹车键 + 真正停稳一小段时间才挂入。
    // 只判断瞬时速度会导致：高速刹到 0.5 m/s 时突然挂上倒挡并输出全倒挡推力，
    // 以及在坡上"踩住刹车却开始倒退"。
    this.stationaryFor = Math.abs(speed) < 0.35 ? this.stationaryFor + dt : 0;
    if (this.gear > 0 && input.brake > 0.5 && this.stationaryFor >= 0.25) {
      this.gear = -1;
    } else if (this.gear === -1) {
      // 退出倒挡：松开刹车并给油，或已经明显向前
      if (speed > 0.5 || (input.brake < 0.1 && this.throttleLagged > 0.05)) this.gear = 1;
    }

    // 由车轮转速反推发动机转速
    const ratio = this.ratioFor(this.gear);
    const wheelOmega = Math.abs(this.wheelAngularSpeed(speed));
    const gearedRpm = wheelOmega * ratio * s.finalDrive / RPM_TO_RAD;
    const targetRpm = Math.max(s.engineIdleRpm, gearedRpm);
    // 转速跟随有一点点惯性，避免换挡瞬间跳变
    this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * 14);
    this.rpm = Math.min(this.rpm, s.engineRedlineRpm * 1.02);

    if (this.gear === -1) {
      // 倒挡：踏板映射与前进挡不同 —— 玩家按的是"刹车/后退"键，
      // 所以用 max(油门, 刹车) 作为动力输入，否则挂上倒挡也不会有推力。
      const pedal = Math.max(this.throttleLagged, input.brake);
      const torque = this.torqueAt(this.rpm) * pedal;
      const total = -(torque * ratio * s.finalDrive * s.drivetrainEfficiency) / s.wheelRadius;
      return this.finish(total / driven, torque, false);
    }
    if (shifting) {
      // 换挡期间无牵引力
      return this.finish(0, 0, true);
    }

    // 自动换挡
    const gearCount = s.gearRatios.length;
    const upRpm = s.engineRedlineRpm * 0.93;
    const downRpm = s.engineRedlineRpm * 0.36;
    if (!shifting) {
      if (this.rpm > upRpm && this.gear < gearCount) {
        this.pendingGear = this.gear + 1;
        this.shiftTimer = s.shiftTime;
        this.rpm *= 1 - s.shiftRpmDrop;
      } else if (this.rpm < downRpm && this.gear > 1) {
        this.pendingGear = this.gear - 1;
        this.shiftTimer = s.shiftTime * 0.7;
      }
    }

    const torque = this.torqueAt(this.rpm);
    let driveTorque = torque * this.throttleLagged;

    // 发动机制动 / 滑行阻力
    if (this.throttleLagged < 0.05) {
      const revScale = Math.min(this.rpm / s.enginePeakTorqueRpm, 1.4);
      const brakeTorque = s.engineBrakingTorque * revScale;
      // 只在前进时向后拖拽，避免把车拖成倒退
      const canDrag = speed > 0.4;
      driveTorque = canDrag ? -brakeTorque : 0;
    }

    const force = (driveTorque * ratio * s.finalDrive * s.drivetrainEfficiency) / s.wheelRadius;
    // 单轮分配在 Car 中完成；这里给出总轮端力
    const perWheelForce = force / driven;
    return this.finish(perWheelForce, driveTorque, false);
  }

  private finish(perWheelForce: number, torque: number, shifting: boolean): DrivetrainState {
    return {
      gear: this.gear,
      rpm: this.rpm,
      engineTorque: torque,
      driveForce: perWheelForce,
      shifting,
      effectiveThrottle: this.throttleLagged,
    };
  }
}
