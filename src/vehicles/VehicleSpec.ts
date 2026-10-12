/**
 * 车辆参数表 —— 全项目唯一的车辆物理参数来源。
 *
 * 单位约定（全部为 SI，UI 不得直接把下面的数值当作"属性条格数"）：
 *   质量 kg    长度 m    力 N    扭矩 N·m    功率 W    角度 rad    转速 rpm
 *   摩擦系数无量纲    阻力面积 m²（Cd·A）    升力面积 m²（Cl·A）
 *
 * 配件（阶段三）只允许通过 `applyPartModifiers` 修改本表，再由 `deriveVehicle`
 * 统一换算成 Rapier 参数，禁止在控制器里散落硬编码。
 */

/** 世界重力加速度基准值。 */
export const EARTH_GRAVITY = 9.81;

/** 车辆驱动形式。 */
export type DriveLayout = 'rwd' | 'fwd' | 'awd';

export interface VehicleSpec {
  readonly id: string;
  readonly name: string;

  // ---- 质量与几何 ----
  /** 整车质量 kg（含车手）。 */
  mass: number;
  /** 轴距 m（前后轴中心距离）。 */
  wheelbase: number;
  /** 轮距 m（左右轮中心距离）。 */
  trackWidth: number;
  /** 重心离地高度 m。 */
  comHeight: number;
  /** 重心纵向位置：0 = 前轴，1 = 后轴。 */
  comLongitudinal: number;
  /** 车轮半径 m。 */
  wheelRadius: number;
  /** 车轮宽度 m。 */
  wheelWidth: number;
  /** 主车体尺寸 m（纵向为 Z），用于转动惯量估算与视觉生成。 */
  bodyHalfLength: number;
  bodyHalfWidth: number;
  bodyHalfHeight: number;
  /**
   * 碰撞盒列表，坐标相对刚体原点。原点位于重心高度（见 DerivedVehicle.rideHeight），
   * 因此车体碰撞盒需要向下偏移，让底盘离地间隙正确。
   */
  colliders: ReadonlyArray<{
    readonly half: readonly [number, number, number];
    readonly offset: readonly [number, number, number];
  }>;

  // ---- 悬挂 ----
  /** 悬挂不受载时的弹簧长度 m。 */
  suspensionRestLength: number;
  /** 目标静态压缩量 m，决定弹簧硬度与静态车身高度。 */
  targetStaticCompression: number;
  /** 悬挂允许行程 m（压缩/回弹各一侧）。 */
  suspensionTravel: number;
  /**
   * 悬挂阻尼系数。该值直接作为 Rapier 的 compression/relaxation 阻尼使用，
   * 由落车试验标定：0.55 偏软（吸收颠簸好、响应慢）、0.85 标准、1.35 偏硬
   * （响应快、不平路面接地稳定性下降）。静态压缩量会随阻尼略变，属实测特性。
   */
  suspensionDamping: number;
  /** 悬挂最大作用力 N。 */
  suspensionMaxForce: number;

  // ---- 发动机 ----
  /** 最大功率 W。 */
  engineMaxPower: number;
  /** 最大功率对应转速 rpm。 */
  enginePeakPowerRpm: number;
  /** 最大扭矩 N·m。 */
  engineMaxTorque: number;
  /** 最大扭矩对应转速 rpm。 */
  enginePeakTorqueRpm: number;
  /** 怠速 rpm。 */
  engineIdleRpm: number;
  /** 断油转速 rpm。 */
  engineRedlineRpm: number;
  /** 松油门时的发动机制动扭矩 N·m。 */
  engineBrakingTorque: number;
  /** 油门响应时间常数 s（越大越迟缓）。 */
  throttleResponseTime: number;
  /** 转速上升惯性：等效转动惯量 kg·m²。 */
  engineInertia: number;

  // ---- 传动 ----
  /** 各前进挡传动比（1 挡在前）。 */
  gearRatios: number[];
  /** 主减速比。 */
  finalDrive: number;
  /** 传动效率 0..1。 */
  drivetrainEfficiency: number;
  /** 换挡耗时 s。 */
  shiftTime: number;
  /** 换挡后转速损失比例 0..1。 */
  shiftRpmDrop: number;
  /** 驱动形式。 */
  driveLayout: DriveLayout;
  /** 倒车传动比。 */
  reverseRatio: number;

  // ---- 轮胎 ----
  /** 前轮胎摩擦系数（同时用于横向抓地与附着极限）。 */
  tyreFrictionFront: number;
  /** 后轮胎摩擦系数。 */
  tyreFrictionRear: number;
  /** 侧向摩擦刚度倍率（越小越容易渐进侧滑）。 */
  tyreSideStiffness: number;
  /** 滚动阻力系数（力 = 系数 × 轮载荷）。 */
  rollingResistance: number;
  /** 是否启用摩擦圆：纵向力受横向已用附着限制。 */
  frictionCircle: boolean;

  // ---- 制动 ----
  /** 前轴总制动力 N。 */
  brakeForceFront: number;
  /** 后轴总制动力 N。 */
  brakeForceRear: number;
  /** 手刹额外作用于后轴的最大制动力 N。 */
  handbrakeForceRear: number;
  /** 手刹期间后轮摩擦系数倍率。 */
  handbrakeGripScale: number;

  // ---- 空气动力学 ----
  /** 阻力面积 Cd·A m²。 */
  dragArea: number;
  /** 前部下压力面积 Cl·A m²。 */
  downforceAreaFront: number;
  /** 后部下压力面积 Cl·A m²。 */
  downforceAreaRear: number;

  // ---- 转向 ----
  /** 低速最大转向角 rad。 */
  maxSteerAngle: number;
  /** 达到最大衰减时的参考速度 m/s。 */
  steerFalloffSpeed: number;
  /** 高速转向保留比例 0..1。 */
  steerFalloffRatio: number;
  /** 方向盘转动速率 rad/s。 */
  steerRate: number;
  /** 方向盘回正速率 rad/s。 */
  steerReturnRate: number;

  // ---- 其他 ----
  /** 重力倍率（街机手感用，只放大重力，不改变其它力学关系）。 */
  gravityScale: number;
  /** 手刹时后轮额外的纵向阻力系数。 */
  handbrakeDrag: number;
}

/** 由主参数表换算出的、直接喂给 Rapier 的量。 */
export interface DerivedVehicle {
  readonly spec: VehicleSpec;
  /** 有效重力加速度 m/s²。 */
  readonly gravity: number;
  readonly halfTrack: number;
  readonly frontAxleZ: number;
  readonly rearAxleZ: number;
  /** 静态前轴载荷比例。 */
  readonly staticFrontLoadRatio: number;
  /** Rapier 悬挂刚度参数（该模型下弹簧力 = 刚度 × 压缩量 × 底盘质量）。 */
  readonly suspensionStiffness: number;
  /** 每轮等效弹簧刚度 N/m，仅用于显示与校验。 */
  readonly springRatePerWheel: number;
  /** 悬挂压缩/回弹阻尼系数（Rapier 参数）。 */
  readonly dampingCompression: number;
  readonly dampingRelaxation: number;
  /** 刚体原点静止时离地高度 m。 */
  readonly rideHeight: number;
  /** 车轮挂点相对刚体原点的纵向/横向坐标。 */
  readonly wheelOffsets: ReadonlyArray<{ x: number; z: number; front: boolean }>;
  /** 驱动轮索引（0=前左 1=前右 2=后左 3=后右）。 */
  readonly drivenWheels: readonly number[];
  /** 各轮摩擦系数。 */
  readonly wheelFriction: readonly number[];
  /** 三挡时的理论极速 m/s（按断油转速估算）。 */
  readonly theoreticalTopSpeed: number;
  /** 整车转动惯量（用于 setAdditionalMassProperties）。 */
  readonly inertia: { x: number; y: number; z: number };
}

/** 车轮编号约定：0 前左、1 前右、2 后左、3 后右。 */
export const WHEEL_FRONT_LEFT = 0;
export const WHEEL_FRONT_RIGHT = 1;
export const WHEEL_REAR_LEFT = 2;
export const WHEEL_REAR_RIGHT = 3;
export const WHEEL_COUNT = 4;

/** 各轮是否为前轮。 */
export const WHEEL_IS_FRONT = [true, true, false, false] as const;
/** 各轮左右符号（+1 左，-1 右）。注意：本工程中车的右侧为 -X。 */
export const WHEEL_SIDE = [1, -1, 1, -1] as const;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 把参数表限制到物理上可用的范围，返回被修正的字段说明。
 * 运行时与测试都调用它，保证"参数→行为"始终自洽。
 */
export function validateVehicleSpec(spec: VehicleSpec): string[] {
  const notes: string[] = [];
  const fix = (label: string, ok: boolean, apply: () => void) => {
    if (!ok) {
      apply();
      notes.push(label);
    }
  };

  fix('质量必须在 120–900 kg', spec.mass >= 120 && spec.mass <= 900, () => (spec.mass = clamp(spec.mass, 120, 900)));
  fix('轴距必须在 1.0–3.2 m', spec.wheelbase >= 1.0 && spec.wheelbase <= 3.2, () => (spec.wheelbase = clamp(spec.wheelbase, 1.0, 3.2)));
  fix('轮距必须在 0.7–2.2 m', spec.trackWidth >= 0.7 && spec.trackWidth <= 2.2, () => (spec.trackWidth = clamp(spec.trackWidth, 0.7, 2.2)));
  fix('重心高度必须在 0.15–1.0 m', spec.comHeight >= 0.15 && spec.comHeight <= 1.0, () => (spec.comHeight = clamp(spec.comHeight, 0.15, 1.0)));
  fix('重心纵向位置必须在 0.2–0.8', spec.comLongitudinal >= 0.2 && spec.comLongitudinal <= 0.8, () => (spec.comLongitudinal = clamp(spec.comLongitudinal, 0.2, 0.8)));
  fix('重心不能高于轮距一半的 2.2 倍（否则极易翻车）', spec.comHeight <= spec.trackWidth * 2.2, () => (spec.comHeight = spec.trackWidth * 2.2));
  fix('重力倍率必须在 0.5–2.5', spec.gravityScale >= 0.5 && spec.gravityScale <= 2.5, () => (spec.gravityScale = clamp(spec.gravityScale, 0.5, 2.5)));
  fix('目标静态压缩量必须小于悬挂可用行程的 60%', spec.targetStaticCompression > 0 && spec.targetStaticCompression < spec.suspensionTravel * 0.6,
    () => (spec.targetStaticCompression = clamp(spec.targetStaticCompression, 0.01, spec.suspensionTravel * 0.6)));
  fix('悬挂阻尼系数必须在 0.05–3.0', spec.suspensionDamping > 0.05 && spec.suspensionDamping <= 3.0, () => (spec.suspensionDamping = clamp(spec.suspensionDamping, 0.05, 3.0)));
  fix('轮胎摩擦系数必须在 0.3–1.8', spec.tyreFrictionFront >= 0.3 && spec.tyreFrictionFront <= 1.8, () => (spec.tyreFrictionFront = clamp(spec.tyreFrictionFront, 0.3, 1.8)));
  fix('后轮胎摩擦系数必须在 0.3–1.8', spec.tyreFrictionRear >= 0.3 && spec.tyreFrictionRear <= 1.8, () => (spec.tyreFrictionRear = clamp(spec.tyreFrictionRear, 0.3, 1.8)));
  fix('阻力面积必须在 0.05–2.0 m²', spec.dragArea >= 0.05 && spec.dragArea <= 2.0, () => (spec.dragArea = clamp(spec.dragArea, 0.05, 2.0)));
  fix('下压力面积不能超过 3.0 m²', spec.downforceAreaFront <= 3.0 && spec.downforceAreaRear <= 3.0,
    () => { spec.downforceAreaFront = clamp(spec.downforceAreaFront, 0, 3.0); spec.downforceAreaRear = clamp(spec.downforceAreaRear, 0, 3.0); });
  fix('挡位数必须为 1–8', spec.gearRatios.length >= 1 && spec.gearRatios.length <= 8,
    () => (spec.gearRatios = spec.gearRatios.slice(0, Math.max(1, Math.min(8, spec.gearRatios.length)))));
  fix('断油转速必须高于峰值功率转速', spec.engineRedlineRpm > spec.enginePeakPowerRpm,
    () => (spec.engineRedlineRpm = spec.enginePeakPowerRpm * 1.08));
  fix('怠速转速必须低于峰值扭矩转速', spec.engineIdleRpm < spec.enginePeakTorqueRpm,
    () => (spec.engineIdleRpm = spec.enginePeakTorqueRpm * 0.25));
  fix('最大转向角必须在 0.15–0.9 rad', spec.maxSteerAngle >= 0.15 && spec.maxSteerAngle <= 0.9, () => (spec.maxSteerAngle = clamp(spec.maxSteerAngle, 0.15, 0.9)));
  fix('手刹抓地倍率必须在 0.15–1.0', spec.handbrakeGripScale >= 0.15 && spec.handbrakeGripScale <= 1.0, () => (spec.handbrakeGripScale = clamp(spec.handbrakeGripScale, 0.15, 1.0)));
  fix('传动效率必须在 0.5–1.0', spec.drivetrainEfficiency >= 0.5 && spec.drivetrainEfficiency <= 1.0, () => (spec.drivetrainEfficiency = clamp(spec.drivetrainEfficiency, 0.5, 1.0)));
  fix('主减速比必须为正', spec.finalDrive > 0, () => (spec.finalDrive = Math.abs(spec.finalDrive) || 1));
  return notes;
}

/** 由参数表换算 Rapier 参数与派生量。 */
export function deriveVehicle(spec: VehicleSpec): DerivedVehicle {
  const gravity = EARTH_GRAVITY * spec.gravityScale;

  const halfTrack = spec.trackWidth / 2;
  const frontAxleZ = spec.wheelbase / 2;
  const rearAxleZ = -spec.wheelbase / 2;
  const staticFrontLoadRatio = 1 - spec.comLongitudinal;

  // Rapier 射线车辆模型的悬挂力 = 刚度 × 压缩量 × 底盘质量。
  // 静态平衡时 4 × 刚度 × 压缩量 = g，因此刚度只与目标压缩量和重力有关，
  // 与质量无关 —— 实测（tests/vehicle-physics）确认压缩量在 200/380/700 kg 下一致。
  const suspensionStiffness = gravity / (WHEEL_COUNT * spec.targetStaticCompression);
  // 报告用真实弹簧刚度：k = m·g / (4·压缩量)
  const springRatePerWheel = (spec.mass * gravity) / (WHEEL_COUNT * spec.targetStaticCompression);

  // 阻尼系数直接使用参数值。落车试验（tests/vehicle-physics）显示该模型下
  // compression≈0.85 时静态压缩量与理论值 g/(4k) 相差 < 3%，且落地后约 1.5 s 收敛。
  const dampingCompression = clamp(spec.suspensionDamping, 0.02, 4);
  const dampingRelaxation = clamp(spec.suspensionDamping * 1.06, 0.02, 4.2);

  const rideHeight = spec.suspensionRestLength - spec.targetStaticCompression + spec.wheelRadius;

  const wheelOffsets = [
    { x: halfTrack, z: frontAxleZ, front: true },
    { x: -halfTrack, z: frontAxleZ, front: true },
    { x: halfTrack, z: rearAxleZ, front: false },
    { x: -halfTrack, z: rearAxleZ, front: false },
  ];

  const drivenWheels =
    spec.driveLayout === 'fwd' ? [0, 1] : spec.driveLayout === 'awd' ? [0, 1, 2, 3] : [2, 3];

  const wheelFriction = [
    spec.tyreFrictionFront,
    spec.tyreFrictionFront,
    spec.tyreFrictionRear,
    spec.tyreFrictionRear,
  ];

  const topGear = spec.gearRatios[spec.gearRatios.length - 1];
  const wheelAngularAtRedline = (spec.engineRedlineRpm * Math.PI * 2) / 60 / (topGear * spec.finalDrive);
  const theoreticalTopSpeed = wheelAngularAtRedline * spec.wheelRadius;

  // 长方体近似转动惯量（刚体原点为重心）。
  const w = spec.bodyHalfWidth * 2;
  const h = spec.bodyHalfHeight * 2;
  const l = spec.bodyHalfLength * 2;
  const m = spec.mass;
  const inertia = {
    x: (m * (h * h + l * l)) / 12,
    y: (m * (w * w + l * l)) / 12,
    z: (m * (w * w + h * h)) / 12,
  };

  return {
    spec,
    gravity,
    halfTrack,
    frontAxleZ,
    rearAxleZ,
    staticFrontLoadRatio,
    suspensionStiffness,
    springRatePerWheel,
    dampingCompression,
    dampingRelaxation,
    rideHeight,
    wheelOffsets,
    drivenWheels,
    wheelFriction,
    theoreticalTopSpeed,
    inertia,
  };
}

/** 深拷贝一份参数表，便于配件系统在不污染原厂数据的前提下修改。 */
export function cloneVehicleSpec(spec: VehicleSpec): VehicleSpec {
  return { ...spec, gearRatios: [...spec.gearRatios] };
}
