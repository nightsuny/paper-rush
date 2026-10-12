import { RAPIER as R, type PhysicsWorld, type TrackedBody } from '../physics/PhysicsWorld';
import { GROUP, groups, surfaceById, type SurfaceType } from '../physics/CollisionGroups';
import {
  deriveVehicle,
  WHEEL_COUNT,
  WHEEL_IS_FRONT,
  type DerivedVehicle,
  type VehicleSpec,
} from './VehicleSpec';
import { Drivetrain, type DrivetrainInput, type DrivetrainState } from './Drivetrain';

const AIR_DENSITY = 1.225;

export interface CarInput {
  /** 0..1 油门 */
  throttle: number;
  /** 0..1 刹车 */
  brake: number;
  /** -1..1 转向，正为左转 */
  steer: number;
  handbrake: boolean;
}

export const EMPTY_INPUT: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

export interface WheelTelemetry {
  contact: boolean;
  /** 悬挂长度 m */
  suspensionLength: number;
  /** 载荷占整车重的比例 0..1 */
  loadRatio: number;
  /** 法向载荷 N */
  normalLoad: number;
  /** 当前有效摩擦系数（含路面/手刹/打滑修正） */
  friction: number;
  /** 纵向力 N（驱动为正、制动为负） */
  longitudinalForce: number;
  /** 侧向力 N（Rapier 侧向冲量换算） */
  lateralForce: number;
  /** 所在路面 */
  surface: SurfaceType | null;
  /** 是否因动力请求超过附着力而打滑 */
  wheelspin: boolean;
}

export interface CarTelemetry {
  /** 速度 m/s */
  speed: number;
  /** 沿车身前向的速度 m/s */
  forwardSpeed: number;
  /** 沿车身侧向的速度 m/s */
  lateralSpeed: number;
  rpm: number;
  gear: number;
  shifting: boolean;
  throttle: number;
  wheelContacts: number;
  wheels: WheelTelemetry[];
  dragForce: number;
  downforce: number;
  rollingForce: number;
  /** 侧向加速度 m/s²（平滑后，用于 HUD 与平衡测试） */
  lateralAccel: number;
  /** 侧向加速度瞬时值 m/s²（含碰撞冲量） */
  lateralAccelRaw: number;
  /** 纵向加速度 m/s² */
  longitudinalAccel: number;
  /** 车底离地高度 m */
  groundHeight: number;
  airborne: boolean;
  upsideDown: boolean;
  /** 侧滑角 rad，漂移指标 */
  slipAngle: number;
  /** 0..1 综合打滑程度 */
  slipAmount: number;
  surface: SurfaceType | null;
  /** 本步实际施加的总纵向力 N */
  appliedLongitudinalForce: number;
}

export interface CarOptions {
  spec: VehicleSpec;
  world: PhysicsWorld;
  position: { x: number; y: number; z: number };
  /** 车头朝向（绕 Y 轴，弧度） */
  heading: number;
}

/**
 * 车辆：物理完全由 Rapier 动态射线车辆控制器驱动。
 *
 * 分工（避免出现两套冲突的抓地/悬挂模型）：
 *  - Rapier 负责：车轮射线、悬挂弹簧与阻尼、转向几何、侧向轮胎力、刚体积分与碰撞
 *  - 本类负责：发动机扭矩曲线 → 轮端牵引力；制动分配；轮胎摩擦圆裁剪；
 *    空气阻力/下压力/滚动阻力；按路面切换摩擦系数
 * 所有纵向力都通过 Rapier 的 engineForce / brake 参数施加到刚体上，
 * 不使用任何直接改写刚体位置或速度的做法。
 */
export class Car {
  readonly spec: VehicleSpec;
  readonly derived: DerivedVehicle;
  readonly body: R.RigidBody;
  readonly vehicle: R.DynamicRayCastVehicleController;
  readonly tracked: TrackedBody;
  readonly drivetrain: Drivetrain;
  readonly world: PhysicsWorld;

  private readonly ownColliders = new Set<number>();
  private readonly wheelState: WheelTelemetry[] = [];
  private readonly smoothedContact = [1, 1, 1, 1];
  private readonly driven: boolean[];
  private steerAngle = 0;
  private lastSteerInput = 0;
  private prevForwardSpeed = 0;
  private prevLateralSpeed = 0;
  private lateralAccelSmoothed = 0;
  private upsideDownTimer = 0;
  private idleTimer = 0;
  private readonly spawnPosition: { x: number; y: number; z: number };
  private readonly spawnHeading: number;
  private tel: CarTelemetry;

  constructor(opts: CarOptions) {
    this.spec = opts.spec;
    this.derived = deriveVehicle(opts.spec);
    this.drivetrain = new Drivetrain(this.derived);
    this.world = opts.world;
    this.spawnPosition = { ...opts.position };
    this.spawnHeading = opts.heading;
    this.driven = [0, 1, 2, 3].map((i) => this.derived.drivenWheels.includes(i));

    const d = this.derived;
    const yaw = opts.heading;
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(opts.position.x, opts.position.y, opts.position.z)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setLinearDamping(0)
      .setAngularDamping(0.12)
      .setCanSleep(false)
      .setCcdEnabled(true);

    this.body = opts.world.world.createRigidBody(desc);

    // 质量与转动惯量显式指定：碰撞体密度设为 0，避免体积与质量耦合
    for (const c of this.spec.colliders) {
      const cd = R.ColliderDesc.cuboid(c.half[0], c.half[1], c.half[2])
        .setTranslation(c.offset[0], c.offset[1], c.offset[2])
        .setDensity(0)
        .setFriction(0.55)
        .setRestitution(0.15)
        .setCollisionGroups(groups(GROUP.VEHICLE, GROUP.TRACK | GROUP.PROP | GROUP.VEHICLE));
      const col = opts.world.world.createCollider(cd, this.body);
      this.ownColliders.add(col.handle);
    }

    this.body.setAdditionalMassProperties(
      this.spec.mass,
      { x: 0, y: 0, z: 0 },
      d.inertia,
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

    this.vehicle = opts.world.world.createVehicleController(this.body);
    this.vehicle.indexUpAxis = 1;
    // 注意：本版本 Rapier 的 forward axis 只有 setter，没有 getter
    this.vehicle.setIndexForwardAxis = 2;

    // 车轮轴指向 -X：正牵引力沿 +Z（车头方向）推动车辆。
    const axle = { x: -1, y: 0, z: 0 };
    for (let i = 0; i < WHEEL_COUNT; i++) {
      const w = d.wheelOffsets[i];
      this.vehicle.addWheel(
        { x: w.x, y: 0, z: w.z },
        { x: 0, y: -1, z: 0 },
        axle,
        this.spec.suspensionRestLength,
        this.spec.wheelRadius,
      );
      this.vehicle.setWheelSuspensionStiffness(i, d.suspensionStiffness);
      this.vehicle.setWheelMaxSuspensionTravel(i, this.spec.suspensionTravel);
      this.vehicle.setWheelSuspensionCompression(i, d.dampingCompression);
      this.vehicle.setWheelSuspensionRelaxation(i, d.dampingRelaxation);
      this.vehicle.setWheelMaxSuspensionForce(i, this.spec.suspensionMaxForce);
      this.vehicle.setWheelFrictionSlip(i, d.wheelFriction[i]);
      this.vehicle.setWheelSideFrictionStiffness(i, this.spec.tyreSideStiffness);
      this.wheelState.push({
        contact: false,
        suspensionLength: this.spec.suspensionRestLength,
        loadRatio: 0.25,
        normalLoad: 0,
        friction: d.wheelFriction[i],
        longitudinalForce: 0,
        lateralForce: 0,
        surface: null,
        wheelspin: false,
      });
    }

    this.tracked = opts.world.track(this.body);
    this.tel = this.emptyTelemetry();
  }

  get telemetry(): CarTelemetry {
    return this.tel;
  }

  get position(): { x: number; y: number; z: number } {
    return this.body.translation();
  }

  /** 车头方向（刚体 +Z 轴）在世界坐标下的单位向量。 */
  get forward(): Vec3 {
    return rotateByQuat({ x: 0, y: 0, z: 1 }, this.body.rotation());
  }

  /** 车的右侧方向（本工程约定为 -X 轴）。 */
  get right(): Vec3 {
    return rotateByQuat({ x: -1, y: 0, z: 0 }, this.body.rotation());
  }

  /** 车身向上方向。 */
  get up(): Vec3 {
    return rotateByQuat({ x: 0, y: 1, z: 0 }, this.body.rotation());
  }

  /** 翻车持续时间（秒）。 */
  get upsideDownFor(): number {
    return this.upsideDownTimer;
  }

  /** 低速滞留持续时间（秒）。 */
  get idleFor(): number {
    return this.idleTimer;
  }

  private emptyTelemetry(): CarTelemetry {
    return {
      speed: 0,
      forwardSpeed: 0,
      lateralSpeed: 0,
      rpm: this.spec.engineIdleRpm,
      gear: 1,
      shifting: false,
      throttle: 0,
      wheelContacts: WHEEL_COUNT,
      wheels: [],
      dragForce: 0,
      downforce: 0,
      rollingForce: 0,
      lateralAccel: 0,
      lateralAccelRaw: 0,
      longitudinalAccel: 0,
      groundHeight: this.derived.rideHeight,
      airborne: false,
      upsideDown: false,
      slipAngle: 0,
      slipAmount: 0,
      surface: null,
      appliedLongitudinalForce: 0,
    };
  }

  /** 一个固定物理步。必须在 PhysicsWorld.step() 之前调用。 */
  step(dt: number, input: CarInput): void {
    const spec = this.spec;
    const d = this.derived;

    // Rapier 的 addForce/addTorque 是"持续力"，不会在步进后自动清零，
    // 必须在每步开头显式复位，否则空气阻力与下压力会逐帧累加。
    this.body.resetForces(false);
    this.body.resetTorques(false);

    const q = this.body.rotation();
    const forward = this.forward;
    const right = this.right;
    const vel = this.body.linvel();

    const forwardSpeed = vel.x * forward.x + vel.y * forward.y + vel.z * forward.z;
    const lateralSpeed = vel.x * right.x + vel.y * right.y + vel.z * right.z;
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    const yawRate = this.body.angvel().y;

    // ---- 1. 动力总成 ----
    const dtIn: DrivetrainInput = {
      throttle: input.throttle,
      brake: input.brake,
      handbrake: input.handbrake,
    };
    const power: DrivetrainState = this.drivetrain.update(dt, dtIn, forwardSpeed);

    // ---- 2. 车轮接触与法向载荷 ----
    // Rapier 报告的悬挂力与底盘质量成正比；用总和归一化得到真实载荷分配，
    // 自动包含加速/制动/过弯带来的轴荷转移。
    const rawSusp: number[] = [0, 0, 0, 0];
    let loadSum = 0;
    for (let i = 0; i < WHEEL_COUNT; i++) {
      const inContact = this.vehicle.wheelIsInContact(i);
      const f = inContact ? Math.max(this.vehicle.wheelSuspensionForce(i) ?? 0, 0) : 0;
      rawSusp[i] = f;
      loadSum += f;
      const target = inContact ? 1 : 0;
      this.smoothedContact[i] += (target - this.smoothedContact[i]) * Math.min(1, dt * 18);
    }
    const weight = spec.mass * d.gravity;
    const staticRatio = [0, 1, 2, 3].map((i) => {
      const front = WHEEL_IS_FRONT[i];
      const axle = front ? d.staticFrontLoadRatio : 1 - d.staticFrontLoadRatio;
      return axle / 2;
    });

    // ---- 3. 侧向力需求（摩擦圆用） ----
    // 侧向加速度含向心分量与侧滑变化。碰撞瞬间的冲量会让瞬时值极大，
    // 因此额外保留一个平滑值给 HUD 与测试用，原始值用于摩擦圆判断。
    const lateralAccelRaw = (lateralSpeed - this.prevLateralSpeed) / dt + yawRate * forwardSpeed;
    const smoothK = Math.min(1, dt / 0.12);
    this.lateralAccelSmoothed += (lateralAccelRaw - this.lateralAccelSmoothed) * smoothK;
    const totalLateralForce = Math.abs(spec.mass * lateralAccelRaw);
    this.prevLateralSpeed = lateralSpeed;
    const longitudinalAccel = (forwardSpeed - this.prevForwardSpeed) / dt;
    this.prevForwardSpeed = forwardSpeed;

    // ---- 4. 逐轮纵向力 ----
    let contactCount = 0;
    let appliedTotal = 0;
    let rollingTotal = 0;

    for (let i = 0; i < WHEEL_COUNT; i++) {
      const ws = this.wheelState[i];
      const isFront = WHEEL_IS_FRONT[i];
      const ground = this.vehicle.wheelGroundObject(i);
      const surface = ground ? this.world.surfaceOf(ground) ?? surfaceById('asphalt') : null;
      ws.surface = surface;
      const surf = surface ?? surfaceById('asphalt');

      const contactNow = this.smoothedContact[i] > 0.35;
      ws.contact = contactNow;
      const suspLen = this.vehicle.wheelSuspensionLength(i);
      if (suspLen !== null) ws.suspensionLength = suspLen;

      const loadRatio = loadSum > 1e-3 ? rawSusp[i] / loadSum : staticRatio[i];
      ws.loadRatio = loadRatio;
      ws.normalLoad = weight * (loadSum > 1e-3 ? loadRatio : staticRatio[i]) * this.smoothedContact[i];

      if (!contactNow) {
        ws.friction = 0;
        ws.longitudinalForce = 0;
        ws.lateralForce = 0;
        ws.wheelspin = false;
        this.vehicle.setWheelEngineForce(i, 0);
        this.vehicle.setWheelBrake(i, 0);
        this.vehicle.setWheelFrictionSlip(i, d.wheelFriction[i]);
        continue;
      }
      contactCount++;

      // ---- 纵向请求：驱动 / 倒挡 / 制动 / 滚阻 / 驻车 ----
      //
      // 统一用一个"有符号的纵向力"来表达，并且**全部通过 engineForce 施加**：
      // Rapier 的 engineForce 支持负值（反向推力），而 brake 参数只会在前进方向
      // 上抵抗。早期版本把负的 request 交给 brake 参数，结果倒挡变成了刹车，
      // 从静止永远退不了车。
      const drivenCount = Math.max(this.derived.drivenWheels.length, 1);
      let request = this.driven[i] ? power.driveForce : 0;
      if (request < 0 && power.gear === -1) {
        // 倒挡单独限幅，避免倒挡比前进挡更有劲
        request = Math.max(request, -spec.reverseForceLimit / drivenCount);
      }

      let brakeForce = 0;
      // 倒挡时刹车键是"后退踏板"，不能再当制动用，否则两个力互相抵消
      if (input.brake > 0 && power.gear > 0) {
        const axleForce = isFront ? spec.brakeForceFront : spec.brakeForceRear;
        brakeForce = (axleForce / 2) * input.brake;
      }
      if (input.handbrake && !isFront) {
        brakeForce = Math.max(brakeForce, spec.handbrakeForceRear / 2);
      }
      let resist = brakeForce;
      if (input.handbrake && !isFront) {
        resist += ws.normalLoad * spec.handbrakeDrag;
      }

      const rollingCoef = spec.rollingResistance * surf.rollingScale;
      const rolling = rollingCoef * ws.normalLoad;
      rollingTotal += rolling;
      resist += rolling;

      const moving = Math.abs(forwardSpeed) > 0.15;
      const wantsDrive = Math.abs(power.driveForce) > 1;
      if (moving) {
        // 阻力抵抗运动方向，但不能在一帧内把车推向反向（否则松手即倒退/点头）
        const maxStop = (spec.mass * Math.abs(forwardSpeed)) / (dt * WHEEL_COUNT);
        request -= Math.sign(forwardSpeed) * Math.min(resist, maxStop);
      } else if ((brakeForce > 0 || input.handbrake) && !wantsDrive) {
        // 静止/极低速且没有驱动请求时，做**真正的驻车**：
        // 施加"一步内彻底停住"所需的力（带一个速度下限作为静摩擦近似），
        // 而不是粘滞阻尼 —— 粘滞阻尼只能把车拖成缓慢溜坡，
        // 溜起来之后反而会触发倒挡判定，表现为"踩住刹车车自己往后退"。
        // 这个力稍后会被摩擦圆裁剪，所以不会超过附着力上限。
        const vEff = Math.max(Math.abs(forwardSpeed), spec.holdCreepSpeed);
        const stopForce = (spec.mass * vEff) / (dt * WHEEL_COUNT);
        request -= Math.sign(forwardSpeed || 1) * Math.min(stopForce, ws.normalLoad * 2.2);
      }

      // ---- 摩擦圆：横向已占用的附着不能再用于纵向 ----
      const latShare = (totalLateralForce *
        (isFront ? d.staticFrontLoadRatio : 1 - d.staticFrontLoadRatio)) / 2;
      let mu = d.wheelFriction[i] * surf.gripScale;
      if (input.handbrake && !isFront) mu *= spec.handbrakeGripScale;
      const gripLimit = mu * ws.normalLoad;
      let available = gripLimit;
      if (spec.frictionCircle) {
        const used = Math.min(Math.abs(latShare), gripLimit);
        available = Math.sqrt(Math.max(gripLimit * gripLimit - used * used, 0));
      }

      // 请求超过附着极限时按极限施加，并让轮胎进入滑动状态（摩擦系数下降）
      let applied = request;
      ws.wheelspin = false;
      if (Math.abs(request) > available) {
        applied = Math.sign(request) * available;
        if (this.driven[i] && request > 0) ws.wheelspin = true;
      }

      // 打滑时（动力过剩）有效摩擦下降：摩擦系数从静摩擦掉到动摩擦，
      // 这是"给油过度导致后轮失去抓地"的物理来源。
      if (ws.wheelspin) mu *= 0.9;
      this.vehicle.setWheelFrictionSlip(i, mu);
      ws.friction = mu;

      ws.longitudinalForce = applied;
      appliedTotal += applied;

      // 全部走 engineForce（负值 = 倒挡推力），不再使用 brake 参数，
      // 这样"制动"与"倒车"就不会互相抵消。
      this.vehicle.setWheelEngineForce(i, applied);
      this.vehicle.setWheelBrake(i, 0);
    }

    // ---- 5. 侧向力遥测 ----
    for (let i = 0; i < WHEEL_COUNT; i++) {
      const si = this.vehicle.wheelSideImpulse(i);
      this.wheelState[i].lateralForce = si === null ? 0 : si / dt;
    }

    // ---- 6. 转向 ----
    const steer = this.updateSteering(dt, input.steer, forwardSpeed);
    for (let i = 0; i < WHEEL_COUNT; i++) {
      this.vehicle.setWheelSteering(i, WHEEL_IS_FRONT[i] ? steer : 0);
    }

    // ---- 7. 空气动力学（真实外力加载到刚体） ----
    const vh = Math.hypot(vel.x, vel.z);
    const dragForce = 0.5 * AIR_DENSITY * spec.dragArea * vh * vh;
    if (vh > 0.01) {
      this.body.addForce(
        { x: (-vel.x / vh) * dragForce, y: 0, z: (-vel.z / vh) * dragForce },
        true,
      );
    }
    const clTotal = spec.downforceAreaFront + spec.downforceAreaRear;
    const downforce = 0.5 * AIR_DENSITY * clTotal * vh * vh;
    if (downforce > 0.1 && clTotal > 1e-6) {
      const frontShare = downforce * (spec.downforceAreaFront / clTotal);
      const rearShare = downforce - frontShare;
      // 注意：applyForceAtPoint 的 point 是世界坐标的绝对点，必须加上车身位置
      const t = this.body.translation();
      const frontOffset = rotateByQuat({ x: 0, y: 0, z: d.frontAxleZ }, q);
      const rearOffset = rotateByQuat({ x: 0, y: 0, z: d.rearAxleZ }, q);
      this.body.addForceAtPoint(
        { x: 0, y: -frontShare, z: 0 },
        { x: t.x + frontOffset.x, y: t.y + frontOffset.y, z: t.z + frontOffset.z },
        true,
      );
      this.body.addForceAtPoint(
        { x: 0, y: -rearShare, z: 0 },
        { x: t.x + rearOffset.x, y: t.y + rearOffset.y, z: t.z + rearOffset.z },
        true,
      );
    }

    // ---- 8. 推进车辆控制器：由 Rapier 计算悬挂、侧向力并更新刚体速度 ----
    this.vehicle.updateVehicle(
      dt,
      undefined,
      groups(GROUP.VEHICLE, GROUP.TRACK | GROUP.PROP | GROUP.VEHICLE),
      (collider: R.Collider) => !this.ownColliders.has(collider.handle),
    );

    // ---- 9. 遥测与状态 ----
    const up = this.up;
    const upsideDown = up.y < 0.25;
    this.upsideDownTimer = upsideDown ? this.upsideDownTimer + dt : 0;
    this.idleTimer = speed < 1.0 ? this.idleTimer + dt : 0;

    const slipAngle = Math.atan2(lateralSpeed, Math.max(Math.abs(forwardSpeed), 1));

    let lowestLen = Infinity;
    for (let i = 0; i < WHEEL_COUNT; i++) {
      const len = this.vehicle.wheelSuspensionLength(i);
      if (len !== null) lowestLen = Math.min(lowestLen, len);
    }

    let slipAccum = 0;
    for (const ws of this.wheelState) {
      const longPart = ws.wheelspin ? 1 : 0;
      const angPart = Math.min(Math.abs(slipAngle) / 0.45, 1);
      slipAccum += Math.min(1, longPart * 0.7 + angPart * 0.7);
    }

    this.tel = {
      speed,
      forwardSpeed,
      lateralSpeed,
      rpm: power.rpm,
      gear: power.gear,
      shifting: power.shifting,
      throttle: power.effectiveThrottle,
      wheelContacts: contactCount,
      wheels: this.wheelState.map((w) => ({ ...w })),
      dragForce,
      downforce,
      rollingForce: rollingTotal,
      lateralAccel: this.lateralAccelSmoothed,
      lateralAccelRaw,
      longitudinalAccel,
      groundHeight: Number.isFinite(lowestLen) ? lowestLen + spec.wheelRadius : d.rideHeight,
      airborne: contactCount === 0,
      upsideDown,
      slipAngle,
      slipAmount: slipAccum / WHEEL_COUNT,
      surface: this.dominantSurface(),
      appliedLongitudinalForce: appliedTotal,
    };
  }

  private dominantSurface(): SurfaceType | null {
    const tally = new Map<string, { s: SurfaceType; n: number }>();
    let best: SurfaceType | null = null;
    let bestN = 0;
    for (const w of this.wheelState) {
      if (!w.surface) continue;
      const e = tally.get(w.surface.id) ?? { s: w.surface, n: 0 };
      e.n++;
      tally.set(w.surface.id, e);
      if (e.n > bestN) {
        bestN = e.n;
        best = w.surface;
      }
    }
    return best;
  }

  /**
   * 转向：速度越高最大转角越小，且方向盘有转动速率上限。
   * 避免"高速下转向没有限制"。
   */
  private updateSteering(dt: number, steerInput: number, forwardSpeed: number): number {
    const spec = this.spec;
    const speedAbs = Math.abs(forwardSpeed);
    const falloff =
      speedAbs <= spec.steerFalloffSpeed
        ? 1
        : Math.max(
            spec.steerFalloffRatio,
            1 -
              ((speedAbs - spec.steerFalloffSpeed) / spec.steerFalloffSpeed) *
                (1 - spec.steerFalloffRatio),
          );
    const target = clamp(steerInput, -1, 1) * spec.maxSteerAngle * falloff;

    const reversing = Math.sign(steerInput) !== Math.sign(this.lastSteerInput) && steerInput !== 0;
    const rate =
      steerInput === 0 || reversing
        ? spec.steerReturnRate * (1 + speedAbs / 45)
        : spec.steerRate * (1 + speedAbs / 70);
    const delta = target - this.steerAngle;
    const maxDelta = rate * dt;
    this.steerAngle += clamp(delta, -maxDelta, maxDelta);
    this.lastSteerInput = steerInput;
    return this.steerAngle;
  }

  /** 回到出生点（清空速度，不做任何位移推进）。 */
  reset(): void {
    this.teleportTo(this.spawnPosition, this.spawnHeading);
  }

  /** 传送到指定位置与朝向。仅用于重置/发车，不用于行驶。 */
  teleportTo(position: { x: number; y: number; z: number }, heading: number): void {
    const q = { x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) };
    this.body.setTranslation(position, true);
    this.body.setRotation(q, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.drivetrain.reset();
    this.steerAngle = 0;
    this.prevForwardSpeed = 0;
    this.prevLateralSpeed = 0;
    this.lateralAccelSmoothed = 0;
    this.upsideDownTimer = 0;
    this.idleTimer = 0;
    for (let i = 0; i < WHEEL_COUNT; i++) {
      this.vehicle.setWheelEngineForce(i, 0);
      this.vehicle.setWheelBrake(i, 0);
      this.vehicle.setWheelSteering(i, 0);
      this.smoothedContact[i] = 1;
    }
    for (const snap of [this.tracked.prev, this.tracked.curr]) {
      snap.px = position.x;
      snap.py = position.y;
      snap.pz = position.z;
      snap.qx = q.x;
      snap.qy = q.y;
      snap.qz = q.z;
      snap.qw = q.w;
    }
  }
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 用四元数旋转向量（v' = v + 2w(q×v) + 2q×(q×v)）。 */
export function rotateByQuat(v: Vec3, q: Quat): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}
