import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, PhysicsWorld, PHYSICS_DT } from '../src/physics/PhysicsWorld';
import { RegionBuilder, type BuiltRegion } from '../src/world/Region';
import { REGION_SKELETON } from '../src/world/catalog/region1';
import { GATE_OPENING_WIDTH } from '../src/world/types';
import { Car, type CarInput } from '../src/vehicles/Car';
import { STOCK_KART } from '../src/vehicles/vehicleCatalog';
import { deriveVehicle } from '../src/vehicles/VehicleSpec';
import { RoadNetwork } from '../src/world/RoadNetwork';

beforeAll(async () => {
  await initPhysics();
});

function buildRegion(): { world: PhysicsWorld; region: BuiltRegion } {
  const d = deriveVehicle(STOCK_KART);
  const world = new PhysicsWorld(-d.gravity);
  const region = new RegionBuilder(REGION_SKELETON, world).built;
  return { world, region };
}

/** 沿一串世界坐标航点做纯追踪驾驶。 */
function driveWaypoints(
  car: Car,
  world: PhysicsWorld,
  waypoints: Array<{ x: number; z: number }>,
  opts: { maxSeconds?: number; throttle?: number; targetSpeed?: number } = {},
): { reached: number; stuck: boolean; offRoadFrames: number; frames: number; maxLateral: number } {
  const maxSeconds = opts.maxSeconds ?? 120;
  const targetSpeed = opts.targetSpeed ?? 16;
  const input: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  let reached = 0;
  let stuckFrames = 0;
  let offRoadFrames = 0;
  let frames = 0;
  let maxLateral = 0;
  const steps = Math.round(maxSeconds / PHYSICS_DT);

  for (let s = 0; s < steps && reached < waypoints.length; s++) {
    const p = car.position;
    // 找当前目标航点：跳过已经通过的
    while (reached < waypoints.length) {
      const wp = waypoints[reached];
      const dx = wp.x - p.x;
      const dz = wp.z - p.z;
      if (dx * dx + dz * dz < 15 * 15) reached++;
      else break;
    }
    if (reached >= waypoints.length) break;

    const wp = waypoints[Math.min(reached + 1, waypoints.length - 1)];
    const fwd = car.forward;
    const rgt = car.right;
    const dx = wp.x - p.x;
    const dz = wp.z - p.z;
    const lf = dx * fwd.x + dz * fwd.z;
    const lr = dx * rgt.x + dz * rgt.z;
    const steer = Math.max(-1, Math.min(1, Math.atan2(-lr, Math.max(lf, 1)) * 1.8));
    const speed = car.telemetry.speed;
    input.throttle = speed < targetSpeed ? Math.min(1, (targetSpeed - speed) * 0.5) : 0.25;
    input.brake = speed > targetSpeed * 1.5 ? 0.5 : 0;
    input.steer = steer;
    car.step(PHYSICS_DT, input);
    world.step();
    frames++;
    if (speed < 1.2) stuckFrames++;
  }
  void maxLateral;
  return { reached, stuck: stuckFrames > 240, offRoadFrames, frames, maxLateral };
}

/** 从一条路段上取一串中心线航点。 */
function waypointsFrom(
  net: RoadNetwork,
  segmentId: string,
  fromT: number,
  toT: number,
  count = 10,
  lateral = 0,
): Array<{ x: number; z: number }> {
  const idx = net.segmentIndexById(segmentId);
  const cl = net.curves[idx];
  const out: Array<{ x: number; z: number }> = [];
  for (let i = 0; i <= count; i++) {
    const t = fromT + ((toT - fromT) * i) / count;
    const p = cl.pointAt(t, lateral);
    out.push({ x: p.x, z: p.z });
  }
  return out;
}

describe('开放世界：区域路网（S1）', () => {
  it('区域可以构建：多路段 + 环岛 + 边界墙', () => {
    const { region } = buildRegion();
    const km = region.stats.totalRoadLength / 1000;
    console.log(
      `[实测] 区域「${region.config.name}」：路段 ${region.stats.segmentCount} 条，` +
        `总长 ${km.toFixed(2)} km，碰撞体 ${region.stats.colliderCount} 个，` +
        `中央岛 ${region.islands.length} 个，边界墙段 ${region.walls.length} 段，` +
        `护栏抑制区间 ${region.stats.suppressedGuardrailRanges} 处`,
    );
    expect(region.stats.segmentCount).toBe(REGION_SKELETON.roads.length);
    expect(km).toBeGreaterThan(2.2);
    expect(km).toBeLessThan(4.5);
    expect(region.islands.length).toBe(1);
    expect(region.walls.length).toBeGreaterThan(50);
    // 护栏抑制必须生效（否则护栏会横在路口把路堵死）
    expect(region.stats.suppressedGuardrailRanges).toBeGreaterThan(0);
  });

  it('地形不会侵入任何路段的路面范围（全网走廊都挖空）', () => {
    const { region } = buildRegion();
    const t = region.terrain;
    const used = new Set<number>();
    for (let i = 0; i < t.indices.length; i++) used.add(t.indices[i]);
    let worst = Infinity;
    let worstAt = { x: 0, z: 0 };
    for (const idx of used) {
      const x = t.vertices[idx * 3];
      const z = t.vertices[idx * 3 + 2];
      const d = region.network.distanceToRoad(x, z);
      if (d < worst) {
        worst = d;
        worstAt = { x, z };
      }
    }
    const widest = Math.max(...region.segments.map((s) => s.curve.config.width / 2));
    console.log(
      `[实测] 地形保留顶点到最近路面的最小距离 = ${worst.toFixed(2)} m ` +
        `（最宽路面半宽 ${widest} m，位于 ${worstAt.x.toFixed(0)},${worstAt.z.toFixed(0)}）`,
    );
    expect(worst).toBeGreaterThan(widest + 1.5);
  });

  it('边界墙在闸口处必须留出开口', () => {
    const { region } = buildRegion();
    const gate = REGION_SKELETON.gates[0];
    let minDist = Infinity;
    for (const w of region.walls) {
      const d = Math.hypot(w.x - gate.x, w.z - gate.z);
      minDist = Math.min(minDist, d);
    }
    console.log(
      `[实测] 最近的边界墙段距闸口 ${minDist.toFixed(1)} m（开口半宽 ${GATE_OPENING_WIDTH / 2} m）`,
    );
    // 闸口附近不能有墙，否则"通往下一区"的开口是假的
    expect(minDist).toBeGreaterThan(GATE_OPENING_WIDTH / 2 - 1);
    // 但边界其余地方必须有墙
    expect(region.walls.length).toBeGreaterThan(50);
  });

  it('出生点在路面上，车辆能稳定停住', () => {
    const { world, region } = buildRegion();
    const car = new Car({
      spec: STOCK_KART,
      world,
      position: { x: region.spawn.x, y: region.spawn.y, z: region.spawn.z },
      heading: region.spawn.heading,
    });
    for (let i = 0; i < 240; i++) {
      car.step(PHYSICS_DT, { throttle: 0, brake: 0, steer: 0, handbrake: true });
      world.step();
    }
    const proj = region.network.project(car.position.x, car.position.z, car.position.y);
    console.log(
      `[实测] 出生点静置：接触轮 ${car.telemetry.wheelContacts}/4，所在路段 ${proj.segmentId}，` +
        `横向偏移 ${proj.lateral.toFixed(2)} m，路面 ${car.telemetry.surface?.id}`,
    );
    expect(car.telemetry.wheelContacts).toBe(4);
    expect(Math.abs(proj.lateral)).toBeLessThan(proj.halfWidth);
    expect(car.telemetry.speed).toBeLessThan(1.5);
  });

  it('能沿主干道驶入环岛并绕行（路口连通）', () => {
    const { world, region } = buildRegion();
    const net = region.network;
    const car = new Car({
      spec: STOCK_KART,
      world,
      position: { x: region.spawn.x, y: region.spawn.y, z: region.spawn.z },
      heading: region.spawn.heading,
    });
    for (let i = 0; i < 120; i++) {
      car.step(PHYSICS_DT, { throttle: 0, brake: 0, steer: 0, handbrake: false });
      world.step();
    }

    // 路线：南主干道 → 环岛绕半圈 → 北主干道
    // 注意方向：main-south 的 t=0 在远端，t=1 才接到环岛
    const route = [
      ...waypointsFrom(net, 'main-south', 0.88, 0.99, 6, 2.5),
      ...waypointsFrom(net, 'roundabout-ring', 0.3, 0.72, 16, 0),
      ...waypointsFrom(net, 'main-north', 0.02, 0.45, 8, 0),
    ];
    const res = driveWaypoints(car, world, route, { maxSeconds: 150, targetSpeed: 15 });
    const proj = net.project(car.position.x, car.position.z, car.position.y);
    console.log(
      `[实测] 环岛连通性：到达航点 ${res.reached}/${route.length}，` +
        `最终所在路段 ${proj.segmentId}（t=${proj.t.toFixed(2)}），速度 ${(car.telemetry.speed * 3.6).toFixed(1)} km/h，` +
        `卡住=${res.stuck}，翻车=${car.up.y < 0.5}`,
    );
    expect(res.reached).toBeGreaterThan(route.length - 3);
    expect(res.stuck).toBe(false);
    expect(car.up.y).toBeGreaterThan(0.7);
  });

  it('能驶入东侧次干道与西侧林道（路口连通）', () => {
    const { world, region } = buildRegion();
    const net = region.network;
    for (const [segId, targetT] of [
      ['east-secondary', 0.9],
      ['west-dirt', 0.9],
    ] as const) {
      const car = new Car({
        spec: STOCK_KART,
        world,
        position: { x: region.spawn.x, y: region.spawn.y, z: region.spawn.z },
        heading: region.spawn.heading,
      });
      for (let i = 0; i < 120; i++) {
        car.step(PHYSICS_DT, { throttle: 0, brake: 0, steer: 0, handbrake: false });
        world.step();
      }
      // 环岛上的进入点与离开点：东侧 = 环线 t≈0，西侧 = 环线 t≈0.5
      const ringTo = segId === 'east-secondary' ? 0.02 : 0.5;
      const route = [
        ...waypointsFrom(net, 'main-south', 0.88, 0.99, 6, 2.5),
        ...waypointsFrom(net, 'roundabout-ring', 0.28, ringTo, 12, 0),
        ...waypointsFrom(net, segId, 0.02, targetT, 8, 0),
      ];
      // 林道更窄、抓地更低，参考速度也要降下来
      const isDirt = segId === 'west-dirt';
      const res = driveWaypoints(car, world, route, {
        maxSeconds: 180,
        targetSpeed: isDirt ? 9 : 13,
      });
      const proj = net.project(car.position.x, car.position.z, car.position.y);
      console.log(
        `[实测] 进入 ${segId}：到达航点 ${res.reached}/${route.length}，最终路段 ${proj.segmentId}，` +
          `路面 ${car.telemetry.surface?.id}，卡住=${res.stuck}，横向偏移 ${proj.lateral.toFixed(2)}m`,
      );
      expect(res.reached).toBeGreaterThan(route.length - 5);
      expect(res.stuck).toBe(false);
    }
  });

  it('撞到区域边界会被挡住（空气墙有效）', () => {
    const { world, region } = buildRegion();
    const b = REGION_SKELETON.bounds;
    // 选东边界中段（远离闸口），朝东全油门
    const x0 = b.maxX - 90;
    const z0 = 160;
    const car = new Car({
      spec: STOCK_KART,
      world,
      position: { x: x0, y: region.terrain.heightAt(x0, z0) + 0.6, z: z0 },
      heading: Math.PI / 2, // 车头朝 +X
    });
    for (let i = 0; i < 200; i++) {
      car.step(PHYSICS_DT, { throttle: 0, brake: 0, steer: 0, handbrake: false });
      world.step();
    }
    for (let i = 0; i < 60 * 12; i++) {
      car.step(PHYSICS_DT, { throttle: 1, brake: 0, steer: 0, handbrake: false });
      world.step();
    }
    const p = car.position;
    console.log(
      `[实测] 朝边界全油门 12s：x = ${p.x.toFixed(1)}（边界 maxX = ${b.maxX}），速度 ${(car.telemetry.speed * 3.6).toFixed(1)} km/h`,
    );
    // 必须被挡在边界内侧（允许一点车身长度）
    expect(p.x).toBeLessThan(b.maxX + 4);
  });

  it('闸口是可以通过的（开口不是装饰）', () => {
    const { world, region } = buildRegion();
    const gate = REGION_SKELETON.gates[0];
    // 从闸口内侧朝闸口方向开
    const car = new Car({
      spec: STOCK_KART,
      world,
      position: { x: gate.x, y: region.terrain.heightAt(gate.x, gate.z + 60) + 0.6, z: gate.z + 60 },
      heading: Math.PI, // 车头朝 -Z（闸口方向）
    });
    for (let i = 0; i < 200; i++) {
      car.step(PHYSICS_DT, { throttle: 0, brake: 0, steer: 0, handbrake: false });
      world.step();
    }
    for (let i = 0; i < 60 * 10; i++) {
      car.step(PHYSICS_DT, { throttle: 1, brake: 0, steer: 0, handbrake: false });
      world.step();
    }
    const p = car.position;
    console.log(
      `[实测] 从闸口驶出：闸口 z=${gate.z}，终点 z = ${p.z.toFixed(1)}（边界 minZ = ${REGION_SKELETON.bounds.minZ}），` +
        `速度 ${(car.telemetry.speed * 3.6).toFixed(1)} km/h，垂直速度 ${car.body.linvel().y.toFixed(1)} m/s`,
    );
    // 闸口必须真的能出去，而且要仍然在路上（不能是掉进虚空掉出去）
    expect(p.z).toBeLessThan(gate.z - 30);
    expect(car.body.linvel().y).toBeGreaterThan(-2);
  });

  it('路网投影在路口附近稳定（不会在两条路之间跳变）', () => {
    const { region } = buildRegion();
    const net = region.network;
    // 沿南主干道中心线走一遍，检查 segmentId 只在进入环岛范围时才切换
    let switches = 0;
    let prev = '';
    const cl = net.curves[net.segmentIndexById('main-south')];
    for (let i = 0; i < cl.samples.length; i++) {
      const s = cl.samples[i];
      const proj = net.project(s.x, s.z, s.y);
      if (proj.segmentId !== prev) {
        switches++;
        prev = proj.segmentId;
      }
    }
    console.log(`[实测] 沿南主干道走一遍，路段归属切换 ${switches} 次（应主要发生在环岛附近）`);
    expect(switches).toBeLessThan(6);
  });
});
