import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, PhysicsWorld, PHYSICS_DT, RAPIER as R } from '../src/physics/PhysicsWorld';
import { RegionBuilder, type BuiltRegion } from '../src/world/Region';
import { REGION_QINGYE } from '../src/world/catalog/region1';
import { validateNetwork } from '../src/world/validateNetwork';
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
  const region = new RegionBuilder(REGION_QINGYE, world).built;
  return { world, region };
}

/** 沿一串世界坐标航点做纯追踪驾驶。 */
function driveWaypoints(
  car: Car,
  world: PhysicsWorld,
  waypoints: Array<{ x: number; z: number }>,
  opts: { maxSeconds?: number; throttle?: number; targetSpeed?: number } = {},
): {
  reached: number;
  stuck: boolean;
  offRoadFrames: number;
  frames: number;
  maxLateral: number;
  recoveries: number;
} {
  const maxSeconds = opts.maxSeconds ?? 120;
  const targetSpeed = opts.targetSpeed ?? 16;
  const input: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  let reached = 0;
  let stuckFrames = 0;
  let offRoadFrames = 0;
  let frames = 0;
  let maxLateral = 0;
  let recovery = 0;
  let recoveries = 0;
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
    const rawSteer = Math.max(-1, Math.min(1, Math.atan2(-lr, Math.max(lf, 1)) * 1.8));
    const speed = car.telemetry.speed;
    // 会开车的驾驶员：方向打得越满，进弯速度越低（否则会推头冲出弯道）
    let desired = targetSpeed;
    if (Math.abs(rawSteer) > 0.45) desired = Math.max(3.5, targetSpeed * 0.5);

    if (recovery > 0) {
      // 脱困：松油门、倒车、反打方向把车头掰回目标
      recovery--;
      input.throttle = 0;
      input.brake = 1;
      input.steer = -rawSteer;
    } else {
      input.throttle = speed < desired ? Math.min(1, (desired - speed) * 0.5) : 0.25;
      input.brake = speed > desired * 1.5 ? 0.5 : 0;
      input.steer = rawSteer;
    }
    car.step(PHYSICS_DT, input);
    world.step();
    frames++;
    // 顶着障碍物不动 → 倒车脱困（真实玩家都会这么做，驾驶员也该会）
    if (speed < 1.2) stuckFrames++;
    else stuckFrames = Math.max(0, stuckFrames - 1);
    if (recovery === 0 && stuckFrames > 60) {
      recovery = 90;
      recoveries++;
      stuckFrames = 0;
    }
  }
  void maxLateral;
  return { reached, stuck: stuckFrames > 120, offRoadFrames, frames, maxLateral, recoveries };
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
    const rb = REGION_QINGYE.bounds;
    const km = region.stats.totalRoadLength / 1000;
    console.log(
      `[实测] 区域「${region.config.name}」：路段 ${region.stats.segmentCount} 条，` +
        `总长 ${km.toFixed(2)} km，碰撞体 ${region.stats.colliderCount} 个，` +
        `中央岛 ${region.islands.length} 个，边界墙段 ${region.walls.length} 段，` +
        `护栏抑制区间 ${region.stats.suppressedGuardrailRanges} 处`,
    );
    expect(region.stats.segmentCount).toBe(REGION_QINGYE.roads.length);
    // 不再拿"总长度"当目标：这一版是约 1 km² 的设计街区。
    // 守住"范围没被撑大"和"路网不是空的"这两条，才是有意义的约束。
    expect(km).toBeGreaterThan(1.5);
    expect(km).toBeLessThan(6);
    expect(rb.maxX - rb.minX).toBeLessThanOrEqual(1100);
    expect(rb.maxZ - rb.minZ).toBeLessThanOrEqual(1050);
    // 这一版没有环岛。中央岛的数量应当**正好等于**配了 islandHeight 的路口数（现在 0），
    // 断言这个不变量，而不是硬编码一个数字。
    const islandJunctions = REGION_QINGYE.junctions.filter((j) => (j.islandHeight ?? 0) > 0);
    expect(region.islands.length).toBe(islandJunctions.length);
    expect(region.walls.length).toBeGreaterThan(50);
    // 护栏抑制必须生效（否则护栏会横在路口把路堵死）
    expect(region.stats.suppressedGuardrailRanges).toBeGreaterThan(0);
  });

  it('路网自检通过：连通、无悬空端、无非法重叠、路口有效', () => {
    const d = deriveVehicle(STOCK_KART);
    const world = new PhysicsWorld(-d.gravity);
    const region = new RegionBuilder(REGION_QINGYE, world).built;
    const report = validateNetwork(REGION_QINGYE, region.network);
    for (const issue of report.issues) {
      console.log(`[路网校验] ${issue.severity === 'error' ? '错误' : '警告'} ${issue.code}: ${issue.message}`);
    }
    const st = report.stats;
    console.log(
      `[实测] ${REGION_QINGYE.name} 路网：${st.segmentCount} 条路段 / ${(st.totalLength / 1000).toFixed(2)} km / ` +
        `连通分量 ${st.components} / 路口 ${st.junctionCount} / 闸口 ${st.gateCount} / 断头路端头 ${st.deadEndCount} / ` +
        `最大连通块 ${st.largestComponent} 条`,
    );
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(st.components).toBe(1);
    expect(st.totalLength / 1000).toBeGreaterThan(1.5);
    expect(st.totalLength / 1000).toBeLessThan(6);
  });

  it('地形不会从路面里穿出来（沿全程射线实测）', () => {
    const d = deriveVehicle(STOCK_KART);
    const world = new PhysicsWorld(-d.gravity);
    const region = new RegionBuilder(REGION_QINGYE, world).built;
    world.step();

    // 直接沿每条路的中心线与两侧打竖直射线：第一命中必须是路面本身，不是草地/地形。
    // 这比"采样顶点到中心线的距离"更贴近真实问题（之前环岛出现过一道横在路中的草墙）。
    let bad = 0;
    let checked = 0;
    let noHit = 0;
    const badSpots: string[] = [];
    for (const seg of region.segments) {
      const hw = seg.curve.config.width / 2;
      const n = seg.curve.samples.length;
      const step = Math.max(1, Math.floor(n / 40));
      // 跳过路段两端 4%：路端之外本来就没有路面覆盖（那里是地形），
      // 端头处的表现单独由"闸口可通过/断头路"用例覆盖。
      const margin = Math.max(2, Math.floor(n * 0.04));
      for (let i = margin; i < n - margin; i += step) {
        const smp = seg.curve.samples[i];
        // 轻微错位：采样点与断面点都正好落在网格顶点/边线上，射线正好打中顶点会退化漏检
        // （实测环岛西侧就因此报了 3 处"路面缺失"，其实网格顶点就在那里）。错开一点点即可。
        for (const lat of [-hw * 0.75 + 0.137, 0.211, hw * 0.75 - 0.091]) {
          const x = smp.x + smp.rx * lat + 0.083;
          const z = smp.z + smp.rz * lat - 0.061;
          const y = smp.y + smp.ry * lat;
          const hit = world.world.castRay(
            new R.Ray({ x, y: y + 8, z }, { x: 0, y: -1, z: 0 }),
            20,
            true,
          );
          checked++;
          if (!hit) {
            noHit++;
            if (badSpots.length < 4) badSpots.push(`${seg.config.id} (${x.toFixed(0)},${z.toFixed(0)}) 路面缺失：射线未命中任何东西`);
            continue;
          }
          const surf = world.surfaceOf(hit.collider)?.id ?? '?';
          if (surf === 'grass') {
            const hitY = y + 8 - hit.timeOfImpact;
            // 5 cm 是这个用例的**可驾驶性**阈值：两条土路交叉处各自的坑洼噪声不同源，
            // 局部差几厘米是物理上无影响的（车不会因此弹起）。真正要抓的是米级穿模。
            if (hitY > y + 0.05) {
              bad++;
              if (badSpots.length < 4) {
                badSpots.push(`${seg.config.id} (${x.toFixed(0)},${z.toFixed(0)}) 草地高出路面 ${(hitY - y).toFixed(2)}m`);
              }
            }
          }
        }
      }
    }
    const detail = badSpots.length > 0 ? ' | ' + badSpots.join(' | ') : '';
    console.log(
      `[实测] 沿路段内部 ${checked} 次竖直射线：地形穿出路面 ${bad} 处、路面缺失 ${noHit} 处${detail}`,
    );
    expect(bad).toBe(0);
    expect(noHit).toBe(0);
    // 采样量护栏：按 1 km² 街区的路网规模设下限，防止"用例其实没跑几条射线"。
    expect(checked).toBeGreaterThan(600);
  });

  it('边界墙在闸口处必须留出开口', () => {
    const { region } = buildRegion();
    const gate = REGION_QINGYE.gates[0];
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

  it('过境公路本身可长距离开（骨架路可驾驶）', () => {
    const { world, region } = buildRegion();
    const net = region.network;
    const car = new Car({
      spec: STOCK_KART,
      world,
      position: { x: region.spawn.x, y: region.spawn.y, z: region.spawn.z },
      heading: region.spawn.heading,
    });
    const trunk = net.curves[net.segmentIndexById('trunk')];
    const s0 = trunk.sampleAt(0.12);
    car.teleportTo({ x: s0.x, y: s0.y + 0.4, z: s0.z }, Math.atan2(s0.tx, s0.tz));
    for (let i = 0; i < 120; i++) {
      car.step(PHYSICS_DT, { throttle: 0, brake: 0, steer: 0, handbrake: false });
      world.step();
    }
    const route = waypointsFrom(net, 'trunk', 0.12, 0.46, 16, 0);
    const res = driveWaypoints(car, world, route, { maxSeconds: 200, targetSpeed: 14 });
    const proj = net.project(car.position.x, car.position.z, car.position.y);
    console.log(
      `[实测] 沿过境公路开：到达航点 ${res.reached}/${route.length}，最终路段 ${proj.segmentId}@t=${proj.t.toFixed(2)}，` +
        `速度 ${(car.telemetry.speed * 3.6).toFixed(1)} km/h，卡住=${res.stuck}，脱困=${res.recoveries}`,
    );
    expect(res.reached).toBeGreaterThan(route.length - 3);
    expect(res.stuck).toBe(false);
  });

  it('从进村路拐进村中主街（村口丁字口连通）', () => {
    const { world, region } = buildRegion();
    const net = region.network;
    const car = new Car({
      spec: STOCK_KART,
      world,
      position: { x: region.spawn.x, y: region.spawn.y, z: region.spawn.z },
      heading: region.spawn.heading,
    });
    const conn = net.curves[net.segmentIndexById('vil-conn')];
    const s0 = conn.sampleAt(0.1);
    car.teleportTo({ x: s0.x, y: s0.y + 0.4, z: s0.z }, Math.atan2(s0.tx, s0.tz));
    for (let i = 0; i < 120; i++) {
      car.step(PHYSICS_DT, { throttle: 0, brake: 0, steer: 0, handbrake: false });
      world.step();
    }
    const route = [
      ...waypointsFrom(net, 'vil-conn', 0.1, 0.97, 10, 0),
      ...waypointsFrom(net, 'vil-main', 0.04, 0.5, 14, 0),
    ];
    const res = driveWaypoints(car, world, route, { maxSeconds: 200, targetSpeed: 9 });
    const proj = net.project(car.position.x, car.position.z, car.position.y);
    console.log(
      `[实测] 进村路→主街：到达航点 ${res.reached}/${route.length}，最终路段 ${proj.segmentId}@t=${proj.t.toFixed(2)}，` +
        `速度 ${(car.telemetry.speed * 3.6).toFixed(1)} km/h，卡住=${res.stuck}，脱困=${res.recoveries}`,
    );
    expect(res.reached).toBeGreaterThan(route.length - 4);
    expect(res.stuck).toBe(false);
    expect(car.up.y).toBeGreaterThan(0.7);
  });

  it('能从西巷开进村内环线并绕行一段（村庄环路连通）', () => {
    const { world, region } = buildRegion();
    const net = region.network;
    const car = new Car({
      spec: STOCK_KART,
      world,
      position: { x: region.spawn.x, y: region.spawn.y, z: region.spawn.z },
      heading: region.spawn.heading,
    });
    // 西巷的 t=0 在环线西顶点、t=1 在过境公路。所以"从公路开进环线"要**反向**开。
    const lane = net.curves[net.segmentIndexById('vil-lane-west')];
    const s0 = lane.sampleAt(0.94);
    car.teleportTo({ x: s0.x, y: s0.y + 0.4, z: s0.z }, Math.atan2(-s0.tx, -s0.tz));
    for (let i = 0; i < 120; i++) {
      car.step(PHYSICS_DT, { throttle: 0, brake: 0, steer: 0, handbrake: false });
      world.step();
    }
    const ring = net.curves[net.segmentIndexById('village-ring')];
    const west = lane.sampleAt(0);
    const entryT = ring.project(west.x, west.z).t;
    const route = [
      ...waypointsFrom(net, 'vil-lane-west', 0.94, 0.04, 6, 0),
      ...waypointsFrom(net, 'village-ring', entryT, Math.min(1, entryT + 0.28), 20, 0),
    ];
    const res = driveWaypoints(car, world, route, { maxSeconds: 200, targetSpeed: 10 });
    const proj = net.project(car.position.x, car.position.z, car.position.y);
    console.log(
      `[实测] 西巷→村内环线：到达航点 ${res.reached}/${route.length}，最终路段 ${proj.segmentId}@t=${proj.t.toFixed(2)}，` +
        `速度 ${(car.telemetry.speed * 3.6).toFixed(1)} km/h，卡住=${res.stuck}，脱困=${res.recoveries}`,
    );
    expect(res.reached).toBeGreaterThan(route.length - 4);
    expect(res.stuck).toBe(false);
  });

  it('撞到区域边界会被挡住（空气墙有效）', () => {
    const { world, region } = buildRegion();
    const b = REGION_QINGYE.bounds;
    // 选东边界中段（远离闸口），朝东全油门。z 必须落在区域之内。
    const x0 = b.maxX - 90;
    const z0 = 1000;
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
    // 必须被挡在边界内侧（允许一点车身长度），而且**确实是被挡住**：
    // 只看 x 的话，"车掉进虚空"也会满足 x < maxX+4，所以必须同时断言速度很低、没有在坠落。
    expect(p.x).toBeLessThan(b.maxX + 4);
    expect(Math.abs(car.telemetry.speed)).toBeLessThan(10);
    expect(car.body.linvel().y).toBeGreaterThan(-3);
  });

  it('闸口是可以通过的（开口不是装饰）', () => {
    const { world, region } = buildRegion();
    const gate = REGION_QINGYE.gates[0];
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
      `[实测] 从闸口驶出：闸口 z=${gate.z}，终点 z = ${p.z.toFixed(1)}（边界 minZ = ${REGION_QINGYE.bounds.minZ}），` +
        `速度 ${(car.telemetry.speed * 3.6).toFixed(1)} km/h，垂直速度 ${car.body.linvel().y.toFixed(1)} m/s`,
    );
    // 闸口必须真的能出去，而且要仍然在路上（不能是掉进虚空掉出去）
    expect(p.z).toBeLessThan(gate.z - 30);
    expect(car.body.linvel().y).toBeGreaterThan(-2);
  });

  it('路网投影在路口附近稳定（不会在两条路之间跳变）', () => {
    const { region } = buildRegion();
    const net = region.network;
    // 沿过境公路中心线走一遍，检查 segmentId 只在靠近丁字口时才切换
    let switches = 0;
    let prev = '';
    const cl = net.curves[net.segmentIndexById('trunk')];
    for (let i = 0; i < cl.samples.length; i++) {
      const s = cl.samples[i];
      const proj = net.project(s.x, s.z, s.y);
      if (proj.segmentId !== prev) {
        switches++;
        prev = proj.segmentId;
      }
    }
    // 过境公路上有 3 个丁字口（林道 / 进村路 / 西巷），每个口子附近会出现一次归属切换，
    // 因此 6~10 次是正常的；关键是不要在两条路之间来回跳。
    console.log(`[实测] 沿过境公路走一遍，路段归属切换 ${switches} 次（3 个丁字口）`);
    expect(switches).toBeLessThan(12);
  });
});
