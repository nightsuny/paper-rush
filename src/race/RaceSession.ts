import type { Centerline } from '../tracks/Centerline';
import type { TrackCheckpoint } from '../tracks/Track';
import type { Car } from '../vehicles/Car';

/**
 * 单场比赛的流程与计时。
 *
 * 设计要点：
 *  - 计圈基于"中心线进度 + 顺序检查点"，不依赖触发盒，因此高速穿门也不会漏判。
 *  - 检查点必须按顺序通过；漏过检查点的那一圈不计入成绩，避免抄近道。
 *  - 进度跳变（瞬移 / 横穿草地抄近路）会被识别为非法进度，不计圈。
 *  - 重置（R）把车送回最近一个已通过的检查点，并且**不改变计圈状态**，
 *    因此不会出现"重置刷圈"或"重置后卡死"。
 */

export type RacePhase = 'countdown' | 'racing' | 'finished';

export interface RacerProgress {
  readonly id: string;
  readonly car: Car;
  /** 当前圈数（从 1 开始；已完成的圈数 = lap - 1） */
  lap: number;
  /** 已按顺序通过的检查点数量 */
  nextCheckpoint: number;
  /** 总进度（米，用于排名） */
  distance: number;
  /** 本圈已行驶的进度（米），用于区分"发车压过起点线"和"真的跑完一圈" */
  lapDistance: number;
  /** 上一帧沿赛道的归一化位置，用于检测穿越 */
  lastT: number;
  finished: boolean;
  finishTime: number;
  bestLap: number;
  lapTimes: number[];
  lapStartTime: number;
  /** 是否本圈漏过检查点 */
  lapInvalid: boolean;
  /** 因为进度跳变被判为非法移动的次数 */
  illegalProgressCount: number;
  /** 连续静止时长 */
  stalledFor: number;
  /** 是否需要提示玩家重置 */
  needsReset: boolean;
}

export interface RaceEvent {
  type:
    | 'countdown'
    | 'go'
    | 'lap'
    | 'invalid-lap'
    | 'checkpoint'
    | 'finish'
    | 'reset'
    | 'wrong-way'
    | 'illegal-progress';
  /** 附加信息（圈数、时间等） */
  value?: number;
  message?: string;
}

export interface RaceResult {
  totalTime: number;
  lapTimes: number[];
  bestLap: number;
  avgSpeed: number;
  topSpeed: number;
  invalidLaps: number;
  lapsCompleted: number;
  position: number;
  totalRacers: number;
}

export interface RaceSessionOptions {
  centerline: Centerline;
  checkpoints: TrackCheckpoint[];
  laps: number;
  /** 倒计时秒数 */
  countdown?: number;
  /** 判定"进度跳变"的最大每帧位移（米）。超过则视为非法（瞬移/穿模）。 */
  maxProgressJumpMeters?: number;
}

const WRONG_WAY_TIME = 1.6;

export class RaceSession {
  readonly centerline: Centerline;
  readonly checkpoints: TrackCheckpoint[];
  readonly totalLaps: number;
  readonly countdownDuration: number;
  readonly maxProgressJump: number;

  phase: RacePhase = 'countdown';
  /** 倒计时剩余（秒） */
  countdownRemaining: number;
  elapsed = 0;
  topSpeed = 0;
  racers: RacerProgress[] = [];
  events: RaceEvent[] = [];
  /** 排名（racer id 从第 1 名开始） */
  positions = new Map<string, number>();
  /** 反向行驶提示 */
  wrongWay = false;
  private wrongWayTimer = 0;
  private invalidLapTotal = 0;

  constructor(opts: RaceSessionOptions) {
    this.centerline = opts.centerline;
    this.checkpoints = opts.checkpoints;
    this.totalLaps = opts.laps;
    this.countdownDuration = opts.countdown ?? 3.4;
    this.maxProgressJump = opts.maxProgressJumpMeters ?? 45;
    this.countdownRemaining = this.countdownDuration;
  }

  /** 注册一名参赛者（阶段一只有玩家一辆，阶段三加入 AI）。 */
  addRacer(id: string, car: Car): RacerProgress {
    const t = this.centerline.project(car.position.x, car.position.z, car.position.y).t;
    const progress: RacerProgress = {
      id,
      car,
      lap: 1,
      nextCheckpoint: 0,
      distance: 0,
      lapDistance: 0,
      lastT: t,
      finished: false,
      finishTime: 0,
      bestLap: Infinity,
      lapTimes: [],
      lapStartTime: 0,
      lapInvalid: false,
      illegalProgressCount: 0,
      stalledFor: 0,
      needsReset: false,
    };
    this.racers.push(progress);
    this.positions.set(id, this.racers.length);
    return progress;
  }

  /** 开始比赛（从倒计时进入行驶）。 */
  beginRace(): void {
    this.phase = 'racing';
    this.elapsed = 0;
    for (const r of this.racers) {
      r.lapStartTime = 0;
    }
    this.events.push({ type: 'go' });
  }

  /** 完全重新开始（清空所有成绩，用于"重新比赛"）。 */
  restart(): void {
    this.phase = 'countdown';
    this.countdownRemaining = this.countdownDuration;
    this.elapsed = 0;
    this.topSpeed = 0;
    this.invalidLapTotal = 0;
    this.wrongWayTimer = 0;
    this.wrongWay = false;
    this.events.length = 0;
    for (const r of this.racers) {
      r.lap = 1;
      r.nextCheckpoint = 0;
      r.distance = 0;
      r.lapDistance = 0;
      r.finished = false;
      r.finishTime = 0;
      r.bestLap = Infinity;
      r.lapTimes = [];
      r.lapStartTime = 0;
      r.lapInvalid = false;
      r.illegalProgressCount = 0;
      r.stalledFor = 0;
      r.needsReset = false;
      r.lastT = this.centerline.project(r.car.position.x, r.car.position.z, r.car.position.y).t;
    }
  }

  goToCountdown(): void {
    this.phase = 'countdown';
    this.countdownRemaining = this.countdownDuration;
    this.elapsed = 0;
    this.events.length = 0;
  }

  /** 倒计时显示文本：3 / 2 / 1 / GO! */
  get countdownLabel(): string {
    const r = this.countdownRemaining;
    if (r <= 0) return 'GO!';
    const n = Math.ceil(r);
    return n > 3 ? '' : String(n);
  }

  /**
   * 推进一个物理步。
   * @param dt 固定步长
   */
  update(dt: number): void {
    if (this.phase === 'countdown') {
      this.countdownRemaining -= dt;
      if (this.countdownRemaining <= 0) this.beginRace();
      // 倒计时期间仍然统计进度基线，但不计时
      this.updateProgress(dt, false);
      return;
    }
    if (this.phase === 'racing') {
      this.elapsed += dt;
      this.updateProgress(dt, true);
      return;
    }
    // finished：仍更新排名，但不计时
    this.updateProgress(dt, false);
  }

  private updateProgress(dt: number, timing: boolean): void {
    for (const r of this.racers) {
      if (r.finished) continue;
      const p = r.car.position;
      const proj = this.centerline.project(p.x, p.z, p.y);
      let t = proj.t;

      // 沿赛道的位移（处理回绕）
      let dT = t - r.lastT;
      if (dT < -0.5) dT += 1;
      if (dT > 0.5) dT -= 1;
      const advanceMeters = dT * this.centerline.totalLength;

      // 非法进度：单帧位移超过阈值（瞬移 / 穿模 / 横穿场地）
      if (Math.abs(advanceMeters) > this.maxProgressJump) {
        r.illegalProgressCount++;
        this.events.push({
          type: 'illegal-progress',
          message: `检测到异常进度跳跃 ${advanceMeters.toFixed(0)}m，已忽略`,
        });
        r.distance += 0; // 不累加
      } else {
        r.distance += advanceMeters;
        if (advanceMeters > 0) r.lapDistance += advanceMeters;
      }

      // 反向行驶提示
      const forward = r.car.forward;
      const sample = this.centerline.sampleAt(t);
      const dot = forward.x * sample.tx + forward.z * sample.tz;
      const speed = r.car.telemetry.forwardSpeed;
      if (timing && dot < -0.2 && speed > 3) {
        this.wrongWayTimer += dt;
        if (this.wrongWayTimer > WRONG_WAY_TIME) this.wrongWay = true;
      } else {
        this.wrongWayTimer = 0;
        this.wrongWay = false;
      }

      // 检查点：按顺序推进。横向偏出门口的会被记为"漏过"，
      // 指针照样前移，避免玩家漏一个检查点后整圈卡死。
      if (timing && dT > 0 && advanceMeters <= this.maxProgressJump) {
        while (r.nextCheckpoint < this.checkpoints.length) {
          const cp = this.checkpoints[r.nextCheckpoint];
          if (!this.crossedForward(r.lastT, t, cp.t)) break;
          const insideGate = Math.abs(proj.lateral) <= cp.halfWidth;
          r.nextCheckpoint++;
          if (insideGate) {
            this.events.push({ type: 'checkpoint', value: r.nextCheckpoint });
          } else {
            r.lapInvalid = true;
            this.events.push({
              type: 'invalid-lap',
              message: `第 ${r.nextCheckpoint} 个检查点没有从门内通过，本圈成绩无效`,
            });
          }
        }
      }

      // 起终点线：集齐检查点后再次正向穿过才计圈
      if (timing && dT > 0 && advanceMeters <= this.maxProgressJump &&
          this.crossedForward(r.lastT, t, this.centerline.config.startT)) {
        const allCheckpoints = r.nextCheckpoint >= this.checkpoints.length;
        // 发车时车辆停在起点线后方，会立刻压过一次线：那不是"跑完一圈"。
        // 用本圈实际行驶距离区分，避免开局误报漏检查点。
        const hadRealLap = r.lapDistance > 150;

        if (allCheckpoints) {
          const lapTime = this.elapsed - r.lapStartTime;
          r.lapTimes.push(lapTime);
          r.bestLap = Math.min(r.bestLap, lapTime);
          r.lap++;
          r.lapStartTime = this.elapsed;
          r.nextCheckpoint = 0;
          r.lapDistance = 0;
          if (r.lapInvalid) {
            this.invalidLapTotal++;
            this.events.push({
              type: 'invalid-lap',
              message: `第 ${r.lapTimes.length} 圈漏过检查点，该圈不计成绩`,
            });
          }
          r.lapInvalid = false;
          this.events.push({ type: 'lap', value: lapTime });
          if (r.lap > this.totalLaps) {
            r.finished = true;
            r.finishTime = this.elapsed;
            this.events.push({ type: 'finish', value: this.elapsed });
          }
        } else if (hadRealLap) {
          // 有实际行驶距离却没集齐检查点：确实抄了近道
          this.events.push({
            type: 'invalid-lap',
            message: `还差 ${this.checkpoints.length - r.nextCheckpoint} 个检查点，本圈不计成绩`,
          });
          r.lapDistance = 0;
          r.nextCheckpoint = 0;
          r.lapInvalid = false;
        }
      }

      r.lastT = t;
      this.topSpeed = Math.max(this.topSpeed, r.car.telemetry.speed);

      // 卡住/翻车提示（只提示，不自动传送）
      const stuck = r.car.telemetry.speed < 1.2 && timing;
      r.stalledFor = stuck ? r.stalledFor + dt : 0;
      r.needsReset = r.car.upsideDownFor > 2.5 || r.stalledFor > 6;
    }
    this.updatePositions();
    if (this.phase === 'racing' && this.racers.length > 0 && this.racers.every((r) => r.finished)) {
      this.phase = 'finished';
    }
  }

  /** 判断从 lastT 到 t 的推进是否跨过了目标位置 target（沿前进方向）。 */
  private crossedForward(lastT: number, t: number, target: number): boolean {
    if (lastT <= t) return lastT < target && target <= t;
    // 跨圈回绕
    return target > lastT || target <= t;
  }

  private updatePositions(): void {
    const sorted = [...this.racers].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.distance - a.distance;
    });
    sorted.forEach((r, i) => this.positions.set(r.id, i + 1));
  }

  positionOf(id: string): number {
    return this.positions.get(id) ?? 1;
  }

  /**
   * 把参赛者送回最近一个已通过的检查点。
   * 不修改 lap / nextCheckpoint / distance 的计圈语义，只重置位置与载具状态，
   * 因此不会刷圈，也不会把玩家卡在原地。
   */
  resetRacer(id: string): void {
    const r = this.racers.find((x) => x.id === id);
    if (!r) return;
    const cps = this.checkpoints;
    // 目标位置：上一个已通过的检查点（没有则回起点）
    const t =
      r.nextCheckpoint > 0
        ? cps[r.nextCheckpoint - 1].t
        : this.centerline.config.startT;
    const p = this.centerline.pointAt(t, 0);
    const sample = this.centerline.sampleAt(t);
    r.car.teleportTo({ x: p.x, y: p.y + 0.05, z: p.z }, Math.atan2(sample.tx, sample.tz));
    // 关键：把进度基线对齐到重置点，避免重置本身被当成进度跳跃
    r.lastT = this.centerline.project(p.x, p.z, p.y).t;
    r.stalledFor = 0;
    r.needsReset = false;
    this.events.push({ type: 'reset' });
  }

  /** 取出并清空事件队列。 */
  drainEvents(): RaceEvent[] {
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }

  resultOf(id: string): RaceResult {
    const r = this.racers.find((x) => x.id === id);
    if (!r) {
      return {
        totalTime: 0,
        lapTimes: [],
        bestLap: 0,
        avgSpeed: 0,
        topSpeed: 0,
        invalidLaps: 0,
        lapsCompleted: 0,
        position: 1,
        totalRacers: this.racers.length,
      };
    }
    const lapsCompleted = r.lapTimes.length;
    return {
      totalTime: r.finished ? r.finishTime : this.elapsed,
      lapTimes: [...r.lapTimes],
      bestLap: Number.isFinite(r.bestLap) ? r.bestLap : 0,
      avgSpeed: this.elapsed > 0 ? r.distance / this.elapsed : 0,
      topSpeed: this.topSpeed,
      invalidLaps: r.illegalProgressCount,
      lapsCompleted,
      position: this.positionOf(id),
      totalRacers: this.racers.length,
    };
  }

  get invalidLapCount(): number {
    return this.invalidLapTotal;
  }
}

/** 把秒格式化为 M:SS.mmm */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--.---';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/** 把秒格式化为 M:SS.mm（更短的展示形式） */
export function formatTimeShort(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--.--';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}
