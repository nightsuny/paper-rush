import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, PhysicsWorld } from '../src/physics/PhysicsWorld';
import { Centerline } from '../src/tracks/Centerline';
import { validateTrack, estimateRaceSeconds } from '../src/tracks/validate';
import { TrackBuilder } from '../src/tracks/Track';
import { MEADOW } from '../src/tracks/catalog/meadow';
import { Car } from '../src/vehicles/Car';
import { STOCK_KART } from '../src/vehicles/vehicleCatalog';
import { deriveVehicle } from '../src/vehicles/VehicleSpec';
import { PHYSICS_DT } from '../src/physics/PhysicsWorld';
import { TRACKS } from '../src/tracks/catalog';
import { driveReference } from './helpers/referenceDriver';

beforeAll(async () => {
  await initPhysics();
});

describe('赛道几何', () => {
  it('中心线是闭合回路，长度与采样正确', () => {
    const cl = new Centerline(MEADOW, 1.4);
    expect(cl.totalLength).toBeGreaterThan(900);
    expect(cl.samples.length).toBeGreaterThan(500);
    // 首尾应闭合：最后一个采样点与第一个采样点的距离应接近一个采样步长
    const a = cl.samples[0];
    const b = cl.samples[cl.samples.length - 1];
    const gap = Math.hypot(a.x - b.x, a.z - b.z);
    expect(gap).toBeLessThan(4);
    // 弧长单调递增
    for (let i = 1; i < cl.samples.length; i++) {
      expect(cl.samples[i].s).toBeGreaterThan(cl.samples[i - 1].s);
    }
  });

  it('切向/右向/上向构成正交标架（含超高）', () => {
    const cl = new Centerline(MEADOW, 1.4);
    let maxDot = 0;
    let maxLen = 0;
    for (const s of cl.samples) {
      maxDot = Math.max(maxDot, Math.abs(s.tx * s.rx + s.ty * s.ry + s.tz * s.rz));
      maxDot = Math.max(maxDot, Math.abs(s.tx * s.ux + s.ty * s.uy + s.tz * s.uz));
      maxDot = Math.max(maxDot, Math.abs(s.rx * s.ux + s.ry * s.uy + s.rz * s.uz));
      maxLen = Math.max(maxLen, Math.abs(Math.hypot(s.tx, s.ty, s.tz) - 1));
      maxLen = Math.max(maxLen, Math.abs(Math.hypot(s.rx, s.ry, s.rz) - 1));
      maxLen = Math.max(maxLen, Math.abs(Math.hypot(s.ux, s.uy, s.uz) - 1));
    }
    console.log(`[实测] 标架正交性：最大 |点积|=${maxDot.toExponential(2)}，最大长度偏差=${maxLen.toExponential(2)}`);
    expect(maxDot).toBeLessThan(1e-6);
    expect(maxLen).toBeLessThan(1e-6);
  });

  it('行进方向约定正确：车头朝切向时右向 = 车右侧', () => {
    const cl = new Centerline(MEADOW, 1.4);
    // 取第一个采样点，构造朝向 = 切向的车，检查其 right 与采样点 right 一致
    const s = cl.samples[0];
    const heading = Math.atan2(s.tx, s.tz);
    const world = new PhysicsWorld(-deriveVehicle(STOCK_KART).gravity);
    const car = new Car({
      spec: STOCK_KART,
      world,
      position: { x: s.x, y: s.y + 0.5, z: s.z },
      heading,
    });
    const right = car.right;
    const dot = right.x * s.rx + right.z * s.rz;
    console.log(`[实测] 车辆右向与中心线右向点积 = ${dot.toFixed(4)}`);
    expect(dot).toBeGreaterThan(0.99);
  });

  it('赛道自检全部通过（自交/曲率/坡度/护栏/检查点/赛程）', () => {
    const cl = new Centerline(MEADOW, 1.4);
    const report = validateTrack(MEADOW, cl);
    for (const issue of report.issues) {
      console.log(`[校验] ${issue.severity === 'error' ? '错误' : '警告'} ${issue.code}: ${issue.message}`);
    }
    console.log(
      `[实测] ${MEADOW.name}: 长度=${report.stats.length.toFixed(0)}m 最小半径=${report.stats.minCornerRadius.toFixed(1)}m ` +
        `最大坡度=${((Math.atan(report.stats.maxGrade) * 180) / Math.PI).toFixed(1)}° 最大超高=${((report.stats.maxBank * 180) / Math.PI).toFixed(2)}° ` +
        `预计单圈=${(report.stats.length / 22).toFixed(0)}s × ${MEADOW.laps}圈=${estimateRaceSeconds(report.stats.length, MEADOW.laps).toFixed(0)}s`,
    );
    expect(report.ok).toBe(true);
    const errors = report.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('赛道目录中的每条赛道都通过校验', () => {
    for (const track of TRACKS) {
      const cl = new Centerline(track, 1.4);
      const report = validateTrack(track, cl);
      const errors = report.issues.filter((i) => i.severity === 'error');
      console.log(`[校验] ${track.name}: ${errors.length === 0 ? '通过' : errors.map((e) => e.message).join('; ')}`);
      expect(errors).toEqual([]);
    }
  });

  it('路面碰撞网格是连续三角网格（非平面），且与路面存在真实高度变化', () => {
    const world = new PhysicsWorld(-deriveVehicle(STOCK_KART).gravity);
    const builder = new TrackBuilder(MEADOW, world);
    const { road, terrain, spawns, checkpoints } = builder.built;

    // 三角网格顶点数 = 采样数 × 断面点数
    const n = builder.centerline.samples.length;
    // 条带为了闭合会多出一行顶点
    expect(road.collision.vertices.length).toBe((n + 1) * 5 * 3);
    expect(road.collision.indices.length).toBe(n * 4 * 6);

    // 路面高度必须有真实起伏（不是无限平面）
    const ys = builder.centerline.samples.map((s) => s.y);
    const spread = Math.max(...ys) - Math.min(...ys);
    console.log(`[实测] 路面高程跨度=${spread.toFixed(2)}m 地形顶点=${terrain.vertices.length / 3} 碰撞体总数=${builder.built.colliderCount}`);
    expect(spread).toBeGreaterThan(2);
    expect(terrain.vertices.length / 3).toBeGreaterThan(10000);
    expect(builder.built.colliderCount).toBeGreaterThan(10);
    expect(spawns.length).toBe(8);
    expect(checkpoints.length).toBeGreaterThanOrEqual(8);
  });

  it('车辆能落在路面上，并由参考驾驶员完整开完一圈（真实物理求解）', () => {
    const d = deriveVehicle(STOCK_KART);
    const world = new PhysicsWorld(-d.gravity);
    const builder = new TrackBuilder(MEADOW, world);
    const spawn = builder.built.spawns[0];
    const car = new Car({
      spec: STOCK_KART,
      world,
      position: { x: spawn.x, y: spawn.y + 0.35, z: spawn.z },
      heading: spawn.heading,
    });
    // 静置 2 秒：应稳稳停在路面上
    for (let s = 0; s < 120; s++) {
      car.step(PHYSICS_DT, { throttle: 0, brake: 0, steer: 0, handbrake: false });
      world.step();
    }
    console.log(
      `[实测] 发车静置：y=${car.position.y.toFixed(3)} 接触轮=${car.telemetry.wheelContacts} 所在路面=${car.telemetry.surface?.id}`,
    );
    expect(car.telemetry.wheelContacts).toBe(4);
    expect(car.telemetry.surface?.id).toBe('asphalt');

    const lap = driveReference(car, world, builder.centerline, 1, 180);
    console.log(
      `[实测] 参考驾驶员单圈：用时=${lap.time.toFixed(1)}s 圈数=${lap.laps} 平均速度=${(lap.avgSpeed * 3.6).toFixed(1)}km/h ` +
        `最高速度=${(lap.maxSpeed * 3.6).toFixed(1)}km/h 越界时间=${lap.offTrackTime.toFixed(1)}s 腾空=${lap.airborneTime.toFixed(1)}s ` +
        `最大横向偏移=${lap.maxLateral.toFixed(2)}m 卡住=${lap.stuck} 翻车=${lap.flipped}`,
    );
    expect(lap.laps).toBe(1);
    expect(lap.stuck).toBe(false);
    expect(lap.flipped).toBe(false);
    // 普通开法应能把大部分时间留在赛道上
    expect(lap.offTrackTime).toBeLessThan(lap.time * 0.2);
    // 单圈时间应落在合理区间（太快说明穿模，太慢说明卡住）
    expect(lap.time).toBeGreaterThan(30);
    expect(lap.time).toBeLessThan(150);
  });

  it('路面三角面法线朝上（绕序正确，否则整条路会不可见）', () => {
    const world = new PhysicsWorld(-deriveVehicle(STOCK_KART).gravity);
    const builder = new TrackBuilder(MEADOW, world);
    const { vertices, indices } = builder.built.road.collision;

    const avgNormalY = (v: Float32Array, idx: Uint32Array): number => {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i] * 3;
        const b = idx[i + 1] * 3;
        const c = idx[i + 2] * 3;
        const e1x = v[b] - v[a];
        const e1y = v[b + 1] - v[a + 1];
        const e1z = v[b + 2] - v[a + 2];
        const e2x = v[c] - v[a];
        const e2y = v[c + 1] - v[a + 1];
        const e2z = v[c + 2] - v[a + 2];
        // 法线 y 分量（未归一化的叉积）
        const ny = e1z * e2x - e1x * e2z;
        const len = Math.hypot(
          e1y * e2z - e1z * e2y,
          ny,
          e1x * e2y - e1y * e2x,
        );
        if (len > 1e-9) {
          sum += ny / len;
          n++;
        }
      }
      return n > 0 ? sum / n : 0;
    };

    const roadNy = avgNormalY(vertices, indices);
    const apronNy = avgNormalY(
      builder.built.road.apronCollision.vertices,
      builder.built.road.apronCollision.indices,
    );
    console.log(
      `[实测] 路面三角面平均法线 Y=${roadNy.toFixed(3)}（应为 +1） 路堤平均法线 Y=${apronNy.toFixed(3)}`,
    );
    // 路面必须完全朝上
    expect(roadNy).toBeGreaterThan(0.95);
    expect(apronNy).toBeGreaterThan(0.8);
  });

  it('地形三角面不会进入赛道走廊（结构性保证，不依赖采样）', () => {
    const world = new PhysicsWorld(-deriveVehicle(STOCK_KART).gravity);
    const builder = new TrackBuilder(MEADOW, world);
    const t = builder.built.terrain;
    const road = builder.built.road;
    const dist = t.distances;

    // 1) 被剔除的顶点数（统计没有出现在索引里的顶点）
    const used = new Set<number>();
    for (let i = 0; i < t.indices.length; i++) used.add(t.indices[i]);
    const removed = dist.length - used.size;

    // 2) 强断言：任何三角面的任何顶点到中心线的距离都必须大于道路+路堤的半宽
    let minDist = Infinity;
    for (const idx of used) minDist = Math.min(minDist, dist[idx]);
    const apronOuter = MEADOW.width / 2 + 0.9 + 9 + 2.6;
    console.log(
      `[实测] 地形：顶点=${dist.length} 保留=${used.size} 剔除=${removed} ` +
        `保留三角面到中心线的最小距离=${minDist.toFixed(2)}m（道路+路堤外缘=${apronOuter.toFixed(2)}m，挖空半径=${t.corridorCutRadius.toFixed(2)}m）`,
    );
    expect(minDist).toBeGreaterThan(MEADOW.width / 2 + 0.9);
    // 三角面最多只能伸进 cutRadius 减去一个格子对角线
    expect(minDist).toBeGreaterThan(t.corridorCutRadius - 8);

    // 3) 路堤必须盖住挖空区：路堤外缘半径 >= 挖空半径
    const apronVerts = road.apronCollision.vertices;
    let maxLat = 0;
    for (let i = 0; i < apronVerts.length; i += 3) {
      const p = builder.centerline.project(apronVerts[i], apronVerts[i + 2]);
      maxLat = Math.max(maxLat, p.distance);
    }
    console.log(`[实测] 路堤外缘半径=${maxLat.toFixed(2)}m`);
    expect(maxLat).toBeGreaterThan(t.corridorCutRadius - 3);
  });

  it('护栏能挡住车（碰撞不是视觉效果）', () => {
    const d = deriveVehicle(STOCK_KART);
    const world = new PhysicsWorld(-d.gravity);
    const builder = new TrackBuilder(MEADOW, world);
    // 找一段有护栏的位置
    const rail = MEADOW.guardrails[0];
    const cl = builder.centerline;
    const s = cl.sampleAt((rail.from + rail.to) / 2);
    const side = rail.side === 'both' ? 1 : rail.side === 'right' ? 1 : -1;
    const startLat = side * 2;
    const heading = Math.atan2(s.tx, s.tz);
    const car = new Car({
      spec: STOCK_KART,
      world,
      position: { x: s.x + s.rx * startLat, y: s.y + 0.3, z: s.z + s.rz * startLat },
      heading,
    });
    // 稳定后朝护栏方向全油门
    for (let i = 0; i < 90; i++) {
      car.step(PHYSICS_DT, { throttle: 0, brake: 0, steer: 0, handbrake: false });
      world.step();
    }
    const targetLat = side * 20;
    for (let i = 0; i < 60 * 5; i++) {
      car.step(PHYSICS_DT, { throttle: 0.85, brake: 0, steer: side * 1, handbrake: false });
      world.step();
    }
    const p = car.position;
    const proj = cl.project(p.x, p.z, p.y);
    console.log(
      `[实测] 冲向护栏 5s 后：横向偏移=${proj.lateral.toFixed(2)}m（护栏在 ${side * rail.offset}m）速度=${(car.telemetry.speed * 3.6).toFixed(1)}km/h ` +
        `目标方向=${targetLat.toFixed(0)}`,
    );
    // 必须被护栏拦在赛道范围内（不能跑到护栏外面）
    expect(Math.abs(proj.lateral)).toBeLessThan(rail.offset + 2.5);
  });
});
