import type { VehicleSpec } from './VehicleSpec';

/**
 * 初始可用赛车：小纸盒（纸板玩具车）。
 *
 * 数值为阶段一调校起点，全部由 tests/vehicle-physics.test.ts 实测校验：
 *  - 静止时刚体原点离地 ≈ 0.365 m（由悬挂目标压缩量决定，与质量无关）
 *  - 满油门 0→100 km/h 约 6–8 s，理论极速 ≈ 135–142 km/h
 *  - 干燥路面制动减速度不超过轮胎附着极限
 */
export const STOCK_KART: VehicleSpec = {
  id: 'stock-cardboard',
  name: '小纸盒',

  mass: 380,
  wheelbase: 1.55,
  trackWidth: 1.10,
  comHeight: 0.345,
  comLongitudinal: 0.46, // 重心略偏后 → 前轴静态载荷 54%
  wheelRadius: 0.23,
  wheelWidth: 0.16,
  bodyHalfLength: 0.82,
  bodyHalfWidth: 0.53,
  bodyHalfHeight: 0.20,
  colliders: [
    // 底盘纸盒：离地约 0.12 m
    { half: [0.52, 0.165, 0.80], offset: [0, -0.075, 0.02] },
    // 车手与防滚架：碰撞时提供更真实的上部外形
    { half: [0.30, 0.20, 0.34], offset: [0, 0.20, -0.10] },
  ],

  suspensionRestLength: 0.20,
  targetStaticCompression: 0.065,
  suspensionTravel: 0.13,
  suspensionDamping: 0.85,
  suspensionMaxForce: 42000,

  engineMaxPower: 40000, // 40 kW ≈ 54 hp
  enginePeakPowerRpm: 6600,
  engineMaxTorque: 54,
  enginePeakTorqueRpm: 4300,
  engineIdleRpm: 1200,
  engineRedlineRpm: 8200,
  engineBrakingTorque: 16,
  throttleResponseTime: 0.09,
  engineInertia: 0.16,

  gearRatios: [3.3, 2.05, 1.42],
  finalDrive: 3.55,
  drivetrainEfficiency: 0.92,
  shiftTime: 0.24,
  shiftRpmDrop: 0.06,
  driveLayout: 'rwd',
  reverseRatio: -3.2,

  tyreFrictionFront: 1.38,
  tyreFrictionRear: 1.32,
  tyreSideStiffness: 1.35,
  rollingResistance: 0.015,
  frictionCircle: true,

  brakeForceFront: 2900,
  brakeForceRear: 1600,
  handbrakeForceRear: 3400,
  handbrakeGripScale: 0.5,

  dragArea: 0.62,
  downforceAreaFront: 0.22,
  downforceAreaRear: 0.30,

  maxSteerAngle: 0.42,
  steerFalloffSpeed: 13,
  steerFalloffRatio: 0.3,
  steerRate: 3.6,
  steerReturnRate: 7.0,

  gravityScale: 1.35,
  handbrakeDrag: 0.30,
  holdCreepSpeed: 0.35,
  reverseForceLimit: 1500,
};

/** 阶段一可用赛车列表。 */
export const VEHICLES: readonly VehicleSpec[] = [STOCK_KART];

export function findVehicle(id: string): VehicleSpec | undefined {
  return VEHICLES.find((v) => v.id === id);
}
