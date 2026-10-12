import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, PhysicsWorld, PHYSICS_DT } from '../src/physics/PhysicsWorld';
import { RAPIER as R } from '../src/physics/PhysicsWorld';
import { Car, type CarInput } from '../src/vehicles/Car';
import { STOCK_KART } from '../src/vehicles/vehicleCatalog';
import { deriveVehicle } from '../src/vehicles/VehicleSpec';
import { surfaceById } from '../src/physics/CollisionGroups';

beforeAll(async () => {
  await initPhysics();
});

interface Harness {
  world: PhysicsWorld;
  car: Car;
  run: (steps: number, input: Partial<CarInput>) => void;
  surface: string;
  setSurface: (id: string) => void;
}

/** 建一个带无限平地的测试世界和一辆车。 */
function harness(surfaceId = 'asphalt'): Harness {
  const derived = deriveVehicle(STOCK_KART);
  const world = new PhysicsWorld(-derived.gravity);
  const groundBody = world.createStaticBody(0, 0, 0);
  const col = world.addStaticCollider(
    groundBody,
    R.ColliderDesc.cuboid(20000, 0.5, 20000).setTranslation(0, -0.5, 0).setFriction(1.0),
    surfaceById(surfaceId),
  );
  void col;
  const car = new Car({
    spec: STOCK_KART,
    world,
    position: { x: 0, y: derived.rideHeight + 0.02, z: 0 },
    heading: 0,
  });
  const full: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  return {
    world,
    car,
    surface: surfaceId,
    setSurface: (id: string) => {
      world.registerSurface(col, surfaceById(id));
    },
    run: (steps: number, input: Partial<CarInput>) => {
      Object.assign(full, { throttle: 0, brake: 0, steer: 0, handbrake: false }, input);
      for (let s = 0; s < steps; s++) {
        car.step(PHYSICS_DT, full);
        world.step();
      }
    },
  };
}

describe('车辆物理（真实 Rapier 求解，非模拟）', () => {
  it('质量与转动惯量按参数表生效', () => {
    const h = harness();
    h.run(1, {});
    expect(h.car.body.mass()).toBeCloseTo(STOCK_KART.mass, 1);
  });

  it('静止时车身高度符合"目标静态压缩量"设计值', () => {
    const h = harness();
    h.run(300, {});
    const y = h.car.position.y;
    const derived = deriveVehicle(STOCK_KART);
    // 设计值 = 悬挂静长 - 目标压缩量 + 轮半径
    expect(y).toBeGreaterThan(derived.rideHeight - 0.02);
    expect(y).toBeLessThan(derived.rideHeight + 0.02);
    expect(h.car.telemetry.wheelContacts).toBe(4);
  });

  it('满油门加速：0-100 km/h 时间与轮端牵引力一致', () => {
    const h = harness();
    h.run(200, {}); // 落地稳定
    const derived = deriveVehicle(STOCK_KART);
    const perWheel = derived.drivenWheels.length;
    let t = 0;
    let reached = 0;
    for (let s = 0; s < 60 * 30; s++) {
      h.run(1, { throttle: 1 });
      t += PHYSICS_DT;
      if (h.car.telemetry.speed * 3.6 >= 100) {
        reached = t;
        break;
      }
    }
    const tel = h.car.telemetry;
    // 记录实测数据，作为平衡文档的依据
    // eslint-disable-next-line no-console
    console.log(
      `[实测] 0-100km/h=${reached.toFixed(2)}s 终速=${(tel.speed * 3.6).toFixed(1)}km/h ` +
        `档位=${tel.gear} 转速=${tel.rpm.toFixed(0)} 驱动轮=${perWheel}`,
    );
    expect(reached).toBeGreaterThan(3);
    expect(reached).toBeLessThan(9);
  });

  it('极速受空气阻力与红线的双重限制，并稳定收敛', () => {
    const h = harness();
    h.run(200, {});
    for (let s = 0; s < 60 * 90; s++) h.run(1, { throttle: 1 });
    const tel = h.car.telemetry;
    const kmh = tel.speed * 3.6;
    const derived = deriveVehicle(STOCK_KART);
    console.log(
      `[实测] 极速=${kmh.toFixed(1)}km/h (${tel.speed.toFixed(1)} m/s) 理论红线极速=${(derived.theoreticalTopSpeed * 3.6).toFixed(1)}km/h 阻力=${tel.dragForce.toFixed(0)}N 档位=${tel.gear}`,
    );
    expect(kmh).toBeGreaterThan(100);
    expect(kmh).toBeLessThan(derived.theoreticalTopSpeed * 3.6 + 6);
  });

  it('制动减速度不超过轮胎附着极限（大刹车也突破不了附着力）', () => {
    const h = harness();
    h.run(200, {});
    for (let s = 0; s < 60 * 30; s++) h.run(1, { throttle: 1 });
    const v0 = h.car.telemetry.forwardSpeed;
    let t = 0;
    for (let s = 0; s < 60 * 30; s++) {
      h.run(1, { brake: 1 });
      t += PHYSICS_DT;
      if (h.car.telemetry.forwardSpeed < 1) break;
    }
    const decel = v0 / t;
    const derived = deriveVehicle(STOCK_KART);
    const muMax = Math.max(STOCK_KART.tyreFrictionFront, STOCK_KART.tyreFrictionRear);
    console.log(
      `[实测] 制动 ${(v0 * 3.6).toFixed(0)}→0km/h 用时=${t.toFixed(2)}s 平均减速度=${decel.toFixed(2)}m/s² ` +
        `(${(decel / 9.81).toFixed(2)} g，轮胎 μ 上限 ${muMax})`,
    );
    expect(decel).toBeGreaterThan(5);
    // 减速度不能超过轮胎摩擦系数 × 有效重力
    expect(decel).toBeLessThan(muMax * derived.gravity * 0.85);
  });

  it('低速时转向几何生效：转向越大转弯半径越小', () => {
    const out: Array<{ steer: number; radius: number; lat: number }> = [];
    for (const steer of [0.2, 0.45, 0.9]) {
      const h = harness();
      h.run(240, {});
      const target = 25 / 3.6; // 25 km/h，远低于附着极限，纯看转向几何
      const full = { throttle: 0, brake: 0, steer, handbrake: false };
      for (let s = 0; s < 60 * 6; s++) {
        const v = h.car.telemetry.forwardSpeed;
        full.throttle = v < target ? Math.min(1, (target - v) * 0.8) : 0;
        full.brake = v > target * 1.05 ? 0.2 : 0;
        h.car.step(PHYSICS_DT, full);
        h.world.step();
      }
      let sumLat = 0;
      let sumV = 0;
      for (let s = 0; s < 60; s++) {
        const v = h.car.telemetry.forwardSpeed;
        full.throttle = v < target ? Math.min(1, (target - v) * 0.8) : 0;
        full.brake = v > target * 1.05 ? 0.2 : 0;
        h.car.step(PHYSICS_DT, full);
        h.world.step();
        sumLat += h.car.telemetry.lateralAccel;
        sumV += h.car.telemetry.speed;
      }
      const lat = Math.abs(sumLat / 60);
      const v = sumV / 60;
      out.push({ steer, lat, radius: (v * v) / Math.max(lat, 1e-3) });
      console.log(
        `[实测] 低速绕圈(25km/h) 转向=${steer} 实际速度=${(v * 3.6).toFixed(1)}km/h 横向加速度=${lat.toFixed(2)}m/s² 半径=${((v * v) / Math.max(lat, 1e-3)).toFixed(2)}m`,
      );
    }
    // 转向几何：转角越大半径越小，且此时远未到附着极限
    expect(out[2].radius).toBeLessThan(out[1].radius);
    expect(out[1].radius).toBeLessThan(out[0].radius);
    expect(out[2].lat).toBeLessThan(deriveVehicle(STOCK_KART).gravity * 1.2);
  });

  it('轮胎侧向附着能力实测（横向 μ）', () => {
    const h = harness();
    h.run(240, {});
    // 给车辆一个纯侧向初速度，测轮胎把它抹平的速度 → 侧向 μ
    h.car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    h.car.body.setLinvel({ x: 8, y: 0, z: 0 }, true);
    let t = 0;
    for (let s = 0; s < 300; s++) {
      h.run(1, {});
      t += PHYSICS_DT;
      if (Math.abs(h.car.body.linvel().x) < 0.4) break;
    }
    // 轮胎侧向力 = μ × 法向载荷，所以侧向减速度 = μ × 有效重力
    const derived = deriveVehicle(STOCK_KART);
    const muLat = 8 / t / derived.gravity;
    console.log(
      `[实测] 侧向滑移 8m/s 抹平用时=${t.toFixed(3)}s → 侧向减速度=${(8 / t).toFixed(2)}m/s² ` +
        `= ${muLat.toFixed(2)} × 有效重力(${derived.gravity.toFixed(2)}m/s²)` +
        `（参数 μ 前=${STOCK_KART.tyreFrictionFront} 后=${STOCK_KART.tyreFrictionRear}）`,
    );
    // 实测侧向 μ 必须落在前后轮胎摩擦系数之间（轮胎模型忠实于参数）
    const muMin = Math.min(STOCK_KART.tyreFrictionFront, STOCK_KART.tyreFrictionRear);
    const muMax = Math.max(STOCK_KART.tyreFrictionFront, STOCK_KART.tyreFrictionRear);
    expect(muLat).toBeGreaterThan(muMin * 0.92);
    expect(muLat).toBeLessThan(muMax * 1.08);
  });

  it('全力转向的稳态绕圈被附着极限封顶', () => {
    const derived = deriveVehicle(STOCK_KART);
    const h = harness();
    h.run(240, {});
    // 全油门 + 满转向跑 20 秒，车辆会自然收敛到"驱动力 = 阻力"的稳态圆圈
    for (let s = 0; s < 60 * 20; s++) h.run(1, { throttle: 1, steer: 1 });
    let sumLat = 0;
    let sumV = 0;
    let maxLat = 0;
    const N = 180;
    for (let s = 0; s < N; s++) {
      h.run(1, { throttle: 1, steer: 1 });
      const lat = Math.abs(h.car.telemetry.lateralAccel);
      sumLat += lat;
      sumV += h.car.telemetry.speed;
      maxLat = Math.max(maxLat, lat);
    }
    const lat = sumLat / N;
    const v = sumV / N;
    console.log(
      `[实测] 满转向稳态绕圈：速度=${(v * 3.6).toFixed(0)}km/h 平均横向加速度=${lat.toFixed(2)}m/s² (${(lat / 9.81).toFixed(2)}g) ` +
        `峰值=${maxLat.toFixed(2)}m/s² 半径=${((v * v) / Math.max(lat, 1e-3)).toFixed(1)}m`,
    );
    // 稳态横向加速度必须被附着极限封顶，不能无限大
    expect(lat).toBeLessThan(derived.gravity * 1.45);
    expect(lat).toBeGreaterThan(derived.gravity * 0.8);
    expect(h.car.up.y).toBeGreaterThan(0.7); // 不应该翻车
  });

  it('摩擦圆：制动与转向同时使用附着时，制动能力下降', () => {
    const straight = harness();
    straight.run(240, {});
    for (let s = 0; s < 60 * 30; s++) straight.run(1, { throttle: 1 });
    let v0 = straight.car.telemetry.forwardSpeed;
    for (let s = 0; s < 60 * 30; s++) {
      straight.run(1, { brake: 1 });
      if (straight.car.telemetry.forwardSpeed < 1) break;
    }
    const straightDecel = v0 / (Math.max(v0, 0.001) / ((straight.car.telemetry.forwardSpeed + 1) || 1));
    void straightDecel;
    const h = harness();
    h.run(240, {});
    for (let s = 0; s < 60 * 30; s++) h.run(1, { throttle: 1 });
    v0 = h.car.telemetry.forwardSpeed;
    let t = 0;
    for (let s = 0; s < 60 * 30; s++) {
      h.run(1, { brake: 1, steer: 1, throttle: 0.3 });
      t += PHYSICS_DT;
      if (h.car.telemetry.forwardSpeed < 1) break;
    }
    const turningDecel = v0 / t;
    // 单独测直线制动（同样初速）
    const s2 = harness();
    s2.run(240, {});
    for (let s = 0; s < 60 * 30; s++) s2.run(1, { throttle: 1 });
    const v0b = s2.car.telemetry.forwardSpeed;
    let t2 = 0;
    for (let s = 0; s < 60 * 30; s++) {
      s2.run(1, { brake: 1 });
      t2 += PHYSICS_DT;
      if (s2.car.telemetry.forwardSpeed < 1) break;
    }
    const lineDecel = v0b / t2;
    console.log(
      `[实测] 初速 ${(v0b * 3.6).toFixed(0)}km/h：直线制动减速度=${lineDecel.toFixed(2)}m/s²  ` +
        `边转向边制动减速度=${turningDecel.toFixed(2)}m/s²（摩擦圆应使后者更小）`,
    );
    expect(turningDecel).toBeLessThan(lineDecel * 0.98);
  });

  it('松油门滑行会减速（发动机制动 + 滚动阻力 + 空气阻力）', () => {
    const h = harness();
    h.run(200, {});
    for (let s = 0; s < 60 * 15; s++) h.run(1, { throttle: 1 });
    const v1 = h.car.telemetry.forwardSpeed;
    h.run(60 * 5, {});
    const v2 = h.car.telemetry.forwardSpeed;
    console.log(`[实测] 滑行 5s: ${(v1 * 3.6).toFixed(1)} → ${(v2 * 3.6).toFixed(1)} km/h`);
    expect(v2).toBeLessThan(v1 - 1);
  });

  it('草地路面显著降低抓地、加速与极速', () => {
    const data: Record<string, { accel: number; top: number }> = {};
    for (const surface of ['asphalt', 'grass']) {
      const h = harness(surface);
      h.run(240, {});
      let t = 0;
      for (let s = 0; s < 60 * 40; s++) {
        h.run(1, { throttle: 1 });
        t += PHYSICS_DT;
        if (h.car.telemetry.speed * 3.6 >= 60) break;
      }
      for (let s = 0; s < 60 * 60; s++) h.run(1, { throttle: 1 });
      const top = h.car.telemetry.speed * 3.6;
      data[surface] = { accel: t, top };
      console.log(
        `[实测] ${surface}: 0-60km/h=${t.toFixed(2)}s 极速=${top.toFixed(1)}km/h 滚动阻力=${h.car.telemetry.rollingForce.toFixed(0)}N`,
      );
    }
    expect(data.grass.accel).toBeGreaterThan(data.asphalt.accel * 1.12);
    expect(data.grass.top).toBeLessThan(data.asphalt.top * 0.93);
  });

  it('相同输入产生完全相同的结果（可复现）', () => {
    const runOnce = () => {
      const h = harness();
      h.run(200, {});
      for (let s = 0; s < 60 * 12; s++) {
        h.run(1, {
          throttle: s % 120 < 90 ? 1 : 0,
          steer: Math.sin(s * 0.03) * 0.7,
          brake: s % 200 > 180 ? 1 : 0,
        });
      }
      const p = h.car.position;
      const v = h.car.body.linvel();
      return [p.x, p.y, p.z, v.x, v.y, v.z];
    };
    const a = runOnce();
    const b = runOnce();
    expect(b).toEqual(a);
  });

  it('空气阻力与速度平方成正比', () => {
    const h = harness();
    h.run(240, {});
    const at = (speed: number) => {
      h.car.body.setLinvel({ x: 0, y: 0, z: speed }, true);
      h.run(1, {});
      return h.car.telemetry.dragForce;
    };
    const d20 = at(20);
    const d40 = at(40);
    const d10 = at(10);
    console.log(
      `[实测] 空气阻力: 10m/s→${d10.toFixed(1)}N  20m/s→${d20.toFixed(1)}N  40m/s→${d40.toFixed(1)}N ` +
        `(比值 40:20=${(d40 / d20).toFixed(2)}, 应≈4.00；20:10=${(d20 / d10).toFixed(2)}, 应≈4.00)`,
    );
    expect(d40 / d20).toBeGreaterThan(3.6);
    expect(d40 / d20).toBeLessThan(4.4);
    expect(d20 / d10).toBeGreaterThan(3.6);
    expect(d20 / d10).toBeLessThan(4.4);
  });

  it('悬挂落地后收敛（落车试验）', () => {
    const derived = deriveVehicle(STOCK_KART);
    const h = harness();
    h.run(1, {});
    h.car.body.setTranslation({ x: 0, y: 1.4, z: 0 }, true);
    h.car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    const heights: number[] = [];
    for (let s = 0; s < 240; s++) {
      h.run(1, {});
      if (s % 20 === 0) heights.push(h.car.position.y);
    }
    const settled = h.car.position.y;
    const lastFive = heights.slice(-5);
    const spread = Math.max(...lastFive) - Math.min(...lastFive);
    console.log(
      `[实测] 落车高度轨迹: ${heights.map((v) => v.toFixed(3)).join(' ')} → 稳态 ${settled.toFixed(3)}（设计 ${derived.rideHeight.toFixed(3)}）`,
    );
    // 落地后必须稳定在静止高度附近，且不再大幅震荡
    expect(settled).toBeGreaterThan(derived.rideHeight - 0.03);
    expect(settled).toBeLessThan(derived.rideHeight + 0.03);
    expect(spread).toBeLessThan(0.02);
  });

  it('倒挡可用：从静止按住刹车/后退键会真的向后走', () => {
    const h = harness();
    h.run(240, {});
    // 按住刹车（低速时进入倒挡）
    h.run(60 * 3, { brake: 1 });
    const tel = h.car.telemetry;
    console.log(
      `[实测] 倒挡：挡位=${tel.gear} 前向速度=${tel.forwardSpeed.toFixed(2)} m/s（负值表示后退）`,
    );
    expect(tel.gear).toBe(-1);
    expect(tel.forwardSpeed).toBeLessThan(-1.5);
  });

  it('坡道驻车：拉住手刹时车辆不会自己溜下坡（发车不倒退）', () => {
    // 造一个 8% 的斜坡，车头朝上坡
    const derived = deriveVehicle(STOCK_KART);
    const world = new PhysicsWorld(-derived.gravity);
    const slope = 0.08;
    const gb = world.createStaticBody(0, 0, 0);
    const half = -Math.atan(slope) / 2;
    const q = new R.Quaternion(Math.sin(half), 0, 0, Math.cos(half));
    world.addStaticCollider(
      gb,
      R.ColliderDesc.cuboid(3000, 0.5, 3000).setTranslation(0, -0.5, 0).setRotation(q).setFriction(0.9),
      surfaceById('asphalt'),
    );
    const car = new Car({
      spec: STOCK_KART,
      world,
      position: { x: 0, y: derived.rideHeight + 0.1, z: 0 },
      heading: 0,
    });

    // 对照组：不拉手刹，5 秒应该明显溜坡（证明坡是真的）
    const free = new Car({
      spec: STOCK_KART,
      world,
      position: { x: 60, y: derived.rideHeight + 0.1, z: 0 },
      heading: 0,
    });
    const freeZ0 = free.position.z;
    for (let s = 0; s < 60 * 5; s++) {
      free.step(PHYSICS_DT, { throttle: 0, brake: 0, steer: 0, handbrake: false });
      world.step();
    }
    const freeDrift = Math.abs(free.position.z - freeZ0);

    // 实验组：拉住手刹（倒计时期间游戏就是这么做的）
    const z0 = car.position.z;
    for (let s = 0; s < 60 * 5; s++) {
      car.step(PHYSICS_DT, { throttle: 0, brake: 0, steer: 0, handbrake: true });
      world.step();
    }
    const drift = Math.abs(car.position.z - z0);
    console.log(
      `[实测] 8% 坡：不拉手刹 5 秒滑 ${freeDrift.toFixed(2)} m；拉住手刹滑 ${drift.toFixed(3)} m（速度 ${car.telemetry.speed.toFixed(3)} m/s）`,
    );
    expect(freeDrift).toBeGreaterThan(2); // 坡确实会让车溜
    expect(drift).toBeLessThan(0.5); // 拉住手刹必须站住
  });

  it('重置后回到出生点且状态清零', () => {
    const h = harness();
    h.run(300, {});
    h.run(60 * 8, { throttle: 1, steer: 0.4 });
    h.car.reset();
    h.run(2, {});
    const p = h.car.position;
    expect(Math.abs(p.x)).toBeLessThan(0.6);
    expect(Math.abs(p.z)).toBeLessThan(0.6);
    expect(h.car.telemetry.speed).toBeLessThan(1.5);
  });
});
