import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, PhysicsWorld, PHYSICS_DT } from '../src/physics/PhysicsWorld';
import { TrackBuilder, type TrackCheckpoint } from '../src/tracks/Track';
import { MEADOW } from '../src/tracks/catalog/meadow';
import { Car } from '../src/vehicles/Car';
import { STOCK_KART } from '../src/vehicles/vehicleCatalog';
import { deriveVehicle } from '../src/vehicles/VehicleSpec';
import { RaceSession, formatTime, formatTimeShort } from '../src/race/RaceSession';

beforeAll(async () => {
  await initPhysics();
});

interface Rig {
  world: PhysicsWorld;
  car: Car;
  session: RaceSession;
  checkpoints: TrackCheckpoint[];
  /** 把车放到指定归一化位置（直接摆放，用于构造场景，不模拟行驶） */
  placeAt: (t: number, lateral?: number) => void;
  /** 沿中心线平滑推进到目标位置（模拟真实行驶，会产生合法的进度变化） */
  driveTo: (t: number, steps?: number) => void;
  tick: (steps?: number) => void;
}

function rig(laps = 3): Rig {
  const d = deriveVehicle(STOCK_KART);
  const world = new PhysicsWorld(-d.gravity);
  const track = new TrackBuilder(MEADOW, world).built;
  const spawn = track.spawns[0];
  const car = new Car({
    spec: STOCK_KART,
    world,
    position: { x: spawn.x, y: spawn.y + 0.3, z: spawn.z },
    heading: spawn.heading,
  });
  const session = new RaceSession({
    centerline: track.centerline,
    checkpoints: track.checkpoints,
    laps,
    countdown: 0,
  });
  session.addRacer('player', car);

  const placeAt = (t: number, lateral = 0): void => {
    const p = track.centerline.pointAt(t, lateral);
    const sample = track.centerline.sampleAt(t);
    car.teleportTo({ x: p.x, y: p.y + 0.05, z: p.z }, Math.atan2(sample.tx, sample.tz));
  };

  const driveTo = (target: number, steps = 40): void => {
    // 从当前位置沿中心线逐步推进（每步位移很小，不会被判为进度跳跃）
    const cur = track.centerline.project(car.position.x, car.position.z, car.position.y).t;
    let delta = target - cur;
    if (delta < -0.5) delta += 1;
    // 逐步传送模拟行驶；每步都推进 session 以保证检查点/计圈按顺序触发
    for (let i = 1; i <= steps; i++) {
      const t = (cur + (delta * i) / steps + 1) % 1;
      placeAt(t);
      session.update(PHYSICS_DT);
    }
  };

  const tick = (steps = 1): void => {
    for (let i = 0; i < steps; i++) {
      car.step(PHYSICS_DT, { throttle: 0, brake: 0, steer: 0, handbrake: false });
      world.step();
      session.update(PHYSICS_DT);
    }
  };

  return { world, car, session, checkpoints: track.checkpoints, placeAt, driveTo, tick };
}

describe('比赛流程：计圈 / 检查点 / 重置', () => {
  it('完整跑完一圈会正确计圈并记录单圈时间', () => {
    const r = rig(3);
    r.session.beginRace();
    // 真实路线：从发车点（起点线后方）依次通过全部检查点，再穿过起点线
    const cps = r.checkpoints.map((c) => c.t);
    for (const t of cps) {
      r.driveTo(t, 6);
      r.session.update(PHYSICS_DT);
    }
    const racer = r.session.racers[0];
    const cpBefore = racer.nextCheckpoint;
    r.driveTo(0.005, 6);
    r.session.update(PHYSICS_DT);
    console.log(
      `[实测] 计圈：通过检查点=${cpBefore}/${cps.length} lap=${racer.lap} 已完成=${racer.lapTimes.length} 单圈=${racer.lapTimes.map((t) => t.toFixed(2)).join(',')} 无效圈=${r.session.invalidLapCount}`,
    );
    expect(cpBefore).toBe(cps.length);
    expect(racer.lapTimes.length).toBe(1);
    expect(racer.lap).toBe(2);
    expect(r.session.invalidLapCount).toBe(0);
  });

  it('发车时压过起点线不会被误判为漏检查点', () => {
    const r = rig(3);
    r.session.beginRace();
    // 车辆本来就在起点线后方，起跑后立刻压线
    r.driveTo(0.01, 6);
    r.session.update(PHYSICS_DT);
    const racer = r.session.racers[0];
    console.log(
      `[实测] 发车压线：lap=${racer.lap} 无效圈=${r.session.invalidLapCount} lapInvalid=${racer.lapInvalid} 事件=${r.session.events.map((e) => e.type).join(',')}`,
    );
    expect(r.session.invalidLapCount).toBe(0);
    expect(racer.lapInvalid).toBe(false);
    expect(racer.lap).toBe(1);
  });

  it('从门外绕过检查点：本圈无效但不会卡死，仍能完赛', () => {
    const r = rig(3);
    r.session.beginRace();
    const cps = r.checkpoints.map((c) => c.t);
    // 第一个检查点从赛道外侧（草地）横向绕过去
    r.driveTo(cps[0] - 0.004, 6);
    r.placeAt(cps[0] - 0.002, 22); // 远离门口
    r.session.update(PHYSICS_DT);
    r.placeAt(cps[0] + 0.004, 22);
    r.session.update(PHYSICS_DT);
    r.placeAt(cps[0] + 0.02, 0);
    r.session.update(PHYSICS_DT);
    const racer = r.session.racers[0];
    console.log(
      `[实测] 绕过检查点：nextCheckpoint=${racer.nextCheckpoint} lapInvalid=${racer.lapInvalid} 事件=${r.session.events.map((e) => e.type).join(',')}`,
    );
    expect(racer.lapInvalid).toBe(true);
    // 指针必须已经越过被漏掉的检查点，否则玩家会永远卡住
    expect(racer.nextCheckpoint).toBeGreaterThanOrEqual(1);

    // 继续跑完剩下的检查点并回到起点线
    for (let i = 1; i < cps.length; i++) {
      r.driveTo(cps[i], 6);
      r.session.update(PHYSICS_DT);
    }
    r.driveTo(0.005, 6);
    r.session.update(PHYSICS_DT);
    console.log(
      `[实测] 漏检查点后完赛：lap=${racer.lap} 已完成圈=${racer.lapTimes.length} 无效圈数=${r.session.invalidLapCount}`,
    );
    expect(racer.lapTimes.length).toBe(1);
    expect(r.session.invalidLapCount).toBe(1);
  });

  it('重置回到最近检查点，且不改变计圈状态（不会刷圈）', () => {
    const r = rig(3);
    r.session.beginRace();
    const cps = r.checkpoints.map((c) => c.t);
    for (let i = 0; i < 3; i++) {
      r.driveTo(cps[i], 6);
      r.session.update(PHYSICS_DT);
    }
    const before = {
      lap: r.session.racers[0].lap,
      cp: r.session.racers[0].nextCheckpoint,
      laps: r.session.racers[0].lapTimes.length,
      invalid: r.session.invalidLapCount,
      illegal: r.session.racers[0].illegalProgressCount,
    };
    r.session.resetRacer('player');
    r.session.update(PHYSICS_DT);
    r.tick(30);
    const after = {
      lap: r.session.racers[0].lap,
      cp: r.session.racers[0].nextCheckpoint,
      laps: r.session.racers[0].lapTimes.length,
      invalid: r.session.invalidLapCount,
      illegal: r.session.racers[0].illegalProgressCount,
    };
    const t = r.session.centerline.project(r.car.position.x, r.car.position.z, r.car.position.y).t;
    const expectedT = r.checkpoints[before.cp - 1]?.t ?? MEADOW.startT;
    console.log(
      `[实测] 重置：前=${JSON.stringify(before)} 后=${JSON.stringify(after)} 重置位置 t=${t.toFixed(4)}（应为 ${expectedT.toFixed(4)}）`,
    );
    expect(after).toEqual(before);
    expect(Math.abs(t - expectedT)).toBeLessThan(0.02);
  });

  it('连续重置不会累积奖励/圈数', () => {
    const r = rig(3);
    r.session.beginRace();
    const cps = r.checkpoints.map((c) => c.t);
    for (let i = 0; i < 5; i++) {
      r.driveTo(cps[i], 6);
      r.session.update(PHYSICS_DT);
    }
    const lapsBefore = r.session.racers[0].lapTimes.length;
    const cpBefore = r.session.racers[0].nextCheckpoint;
    for (let i = 0; i < 12; i++) {
      r.session.resetRacer('player');
      r.session.update(PHYSICS_DT);
      r.tick(10);
    }
    console.log(
      `[实测] 连续重置 12 次：圈数增量=${r.session.racers[0].lapTimes.length - lapsBefore} lap=${r.session.racers[0].lap} 检查点=${cpBefore}→${r.session.racers[0].nextCheckpoint} 无效圈=${r.session.invalidLapCount}`,
    );
    expect(r.session.racers[0].lapTimes.length).toBe(lapsBefore);
    expect(r.session.racers[0].nextCheckpoint).toBe(cpBefore);
    expect(r.session.invalidLapCount).toBe(0);
  });

  it('跑满总圈数后进入 finished 并给出成绩', () => {
    const r = rig(2);
    r.session.beginRace();
    const cps = r.checkpoints.map((c) => c.t);
    for (let lap = 0; lap < 2; lap++) {
      for (const t of cps) {
        r.driveTo(t, 6);
        r.session.update(PHYSICS_DT);
      }
      r.driveTo(0.005, 6);
      r.session.update(PHYSICS_DT);
    }
    const result = r.session.resultOf('player');
    console.log(
      `[实测] 完赛：phase=${r.session.phase} 圈数=${result.lapsCompleted}/${r.session.totalLaps} 总时间=${formatTime(result.totalTime)} 最快圈=${formatTimeShort(result.bestLap)} 名次=${result.position}/${result.totalRacers} 无效圈=${r.session.invalidLapCount}`,
    );
    expect(r.session.phase).toBe('finished');
    expect(result.lapsCompleted).toBe(2);
    expect(r.session.racers[0].finished).toBe(true);
    expect(result.bestLap).toBeGreaterThan(0);
    expect(r.session.invalidLapCount).toBe(0);
  });

  it('横向瞬移（抄近道穿过场地）不会增加进度', () => {
    const r = rig(3);
    r.session.beginRace();
    r.placeAt(0.05);
    r.session.update(PHYSICS_DT);
    r.tick(30);
    const distBefore = r.session.racers[0].distance;
    // 直接跳到赛道另一侧很远处（模拟穿模/瞬移）
    r.placeAt(0.55);
    r.session.update(PHYSICS_DT);
    const distAfter = r.session.racers[0].distance;
    console.log(
      `[实测] 瞬移：进度 ${distBefore.toFixed(0)} → ${distAfter.toFixed(0)}（差 ${(distAfter - distBefore).toFixed(0)}m）非法计数=${r.session.racers[0].illegalProgressCount}`,
    );
    expect(r.session.racers[0].illegalProgressCount).toBeGreaterThan(0);
    expect(distAfter - distBefore).toBeLessThan(1);
  });

  it('时间格式化输出稳定', () => {
    expect(formatTime(0)).toBe('--:--.---');
    expect(formatTime(9.5)).toBe('0:09.500');
    expect(formatTime(65.25)).toBe('1:05.250');
    expect(formatTimeShort(65.25)).toBe('1:05.25');
  });
});
