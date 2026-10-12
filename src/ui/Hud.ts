import type { BuiltTrack } from '../tracks/Track';
import type { RacerProgress, RaceSession } from '../race/RaceSession';
import { formatTime, formatTimeShort } from '../race/RaceSession';

/**
 * 比赛 HUD：名次、速度、圈数、时间、单圈表、小地图、当前路面。
 * 全部用 HTML/CSS 绘制（不把文字烤进 3D 贴图），方便修改与本地化。
 */
export class Hud {
  readonly root: HTMLDivElement;
  private readonly posValue: HTMLElement;
  private readonly lapValue: HTMLElement;
  private readonly timeValue: HTMLElement;
  private readonly speedValue: HTMLElement;
  private readonly gearValue: HTMLElement;
  private readonly lapList: HTMLElement;
  private readonly surfaceDot: HTMLElement;
  private readonly surfaceName: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly countdown: HTMLElement;
  private readonly countdownNum: HTMLElement;
  private readonly minimapCanvas: HTMLCanvasElement;
  private readonly minimapCtx: CanvasRenderingContext2D;
  private toastTimer = 0;
  private lastLapCount = 0;

  constructor(private readonly track: BuiltTrack) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud__corner hud__corner--tl">
        <div class="paper hud-block" data-card>
          <div class="paper__sheet"></div>
          <div class="paper__content" style="padding:0.7em 1.05em">
            <div class="hud-label">名次</div>
            <div class="hud-value hud-value--xl" data-pos>1/1</div>
          </div>
        </div>
        <div class="paper hud-block" data-card>
          <div class="paper__sheet"></div>
          <div class="paper__content" style="padding:0.7em 1.05em">
            <div class="hud-label">圈数</div>
            <div class="hud-value hud-value--xl" data-lap>1/4</div>
          </div>
        </div>
      </div>

      <div class="hud__corner hud__corner--tr">
        <div class="paper" data-card>
          <div class="paper__sheet"></div>
          <div class="paper__content" style="padding:0.7em 1.05em">
            <div class="hud-label">总时间</div>
            <div class="hud-value hud-value--lg" data-time>0:00.00</div>
            <div class="hud-lap-list" data-laps></div>
          </div>
        </div>
      </div>

      <div class="hud__corner hud__corner--bl">
        <div class="paper minimap" data-card>
          <div class="paper__sheet"></div>
          <div class="paper__content" style="padding:0.55em">
            <canvas data-minimap width="280" height="280"></canvas>
          </div>
        </div>
        <div class="paper" data-card>
          <div class="paper__sheet"></div>
          <div class="paper__content" style="padding:0.5em 1em">
            <div class="hud-item">
              <span class="hud-item__dot" data-surface-dot></span>
              <span data-surface-name>沥青纸</span>
            </div>
          </div>
        </div>
      </div>

      <div class="hud__corner hud__corner--br">
        <div class="paper" data-card>
          <div class="paper__sheet"></div>
          <div class="paper__content" style="padding:0.7em 1.1em; text-align:right">
            <div class="hud-label">速度</div>
            <div class="hud-speed">
              <span class="hud-value hud-value--xl" data-speed>0</span>
              <span class="hud-speed__unit">km/h</span>
            </div>
            <div class="fps-note" data-gear>1 挡 · 怠速</div>
          </div>
        </div>
      </div>

      <div class="countdown hidden" data-countdown>
        <div class="countdown__num" data-countdown-num>3</div>
      </div>
      <div class="toast" data-toast></div>
    `;

    const $ = <T extends HTMLElement>(sel: string): T => {
      const el = this.root.querySelector(sel);
      if (!el) throw new Error(`HUD 缺少元素 ${sel}`);
      return el as T;
    };
    this.posValue = $('[data-pos]');
    this.lapValue = $('[data-lap]');
    this.timeValue = $('[data-time]');
    this.speedValue = $('[data-speed]');
    this.gearValue = $('[data-gear]');
    this.lapList = $('[data-laps]');
    this.surfaceDot = $('[data-surface-dot]');
    this.surfaceName = $('[data-surface-name]');
    this.toast = $('[data-toast]');
    this.countdown = $('[data-countdown]');
    this.countdownNum = $('[data-countdown-num]');
    this.minimapCanvas = $<HTMLCanvasElement>('[data-minimap]');
    const ctx = this.minimapCanvas.getContext('2d');
    if (!ctx) throw new Error('无法创建小地图画布');
    this.minimapCtx = ctx;
    void formatTimeShort;
  }

  /** 中央提示条。 */
  showToast(message: string, kind: 'info' | 'warn' | 'bad' = 'info', seconds = 2.4): void {
    this.toast.textContent = message;
    this.toast.className = `toast show ${kind === 'warn' ? 'toast--warn' : kind === 'bad' ? 'toast--bad' : ''}`;
    this.toastTimer = seconds;
  }

  update(dt: number, session: RaceSession, racer: RacerProgress, playerName: string): void {
    const tel = racer.car.telemetry;
    const pos = session.positionOf(racer.id);
    this.posValue.textContent = `${pos}/${Math.max(session.racers.length, 1)}`;
    this.lapValue.textContent = `${Math.min(racer.lap, session.totalLaps)}/${session.totalLaps}`;
    this.timeValue.textContent = formatTime(session.elapsed);
    this.speedValue.textContent = String(Math.round(tel.speed * 3.6));
    this.gearValue.textContent =
      tel.gear === -1
        ? '倒挡'
        : tel.shifting
          ? `${tel.gear} 挡 · 换挡中`
          : tel.throttle < 0.05 && tel.speed > 2
            ? `${tel.gear} 挡 · 滑行`
            : `${tel.gear} 挡 · ${Math.round(tel.rpm)} rpm`;

    // 单圈列表（只更新变化时，避免每帧重排）
    if (racer.lapTimes.length !== this.lastLapCount) {
      this.lastLapCount = racer.lapTimes.length;
      const rows = racer.lapTimes
        .map((t, i) => {
          const isBest = Math.abs(t - racer.bestLap) < 1e-6;
          return `<div class="${isBest ? 'best' : ''}">第 ${i + 1} 圈　${formatTimeShort(t)}</div>`;
        })
        .join('');
      const current = racer.finished
        ? ''
        : `<div style="opacity:.6">第 ${racer.lap} 圈　进行中</div>`;
      this.lapList.innerHTML = rows + current;
    }

    // 路面
    const surfaceId = tel.surface?.id ?? 'asphalt';
    const label: Record<string, string> = {
      asphalt: '沥青纸',
      kerb: '纸路肩',
      grass: '草地',
      cardboard: '纸板',
      wall: '护栏',
      void: '界外',
    };
    this.surfaceName.textContent = label[surfaceId] ?? surfaceId;
    this.surfaceDot.className = `hud-item__dot hud-item__dot--${surfaceId}`;

    // 倒计时
    if (session.phase === 'countdown') {
      this.countdown.classList.remove('hidden');
      const label2 = session.countdownLabel;
      const isGo = label2 === 'GO!';
      if (this.countdownNum.textContent !== label2) {
        this.countdownNum.textContent = label2;
        this.countdownNum.className = `countdown__num${isGo ? ' countdown__num--go' : ''}`;
        // 重新触发 pop 动画
        this.countdownNum.style.animation = 'none';
        void this.countdownNum.offsetWidth;
        this.countdownNum.style.animation = '';
      }
    } else {
      this.countdown.classList.add('hidden');
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.classList.remove('show');
    }

    this.drawMinimap(session, racer, playerName);
  }

  private drawMinimap(session: RaceSession, racer: RacerProgress, playerName: string): void {
    const ctx = this.minimapCtx;
    const size = this.minimapCanvas.width;
    const pad = 22;
    const span = size - pad * 2;
    ctx.clearRect(0, 0, size, size);

    const toX = (nx: number) => pad + nx * span;
    const toY = (nz: number) => pad + nz * span;

    // 赛道底线（手绘风：先画粗白再画黑）
    const pts = this.track.minimap.points;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = toX(p.x);
      const y = toY(p.z);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.strokeStyle = 'rgba(246,241,226,0.95)';
    ctx.lineWidth = 11;
    ctx.stroke();
    ctx.strokeStyle = '#3b332b';
    ctx.lineWidth = 2.4;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(185,176,160,0.85)';
    ctx.lineWidth = 6;
    ctx.stroke();

    // 检查点
    for (const cp of this.track.checkpoints) {
      const idx = cp.index / this.track.centerline.samples.length;
      const mm = mapTToMinimap(this.track, idx);
      ctx.fillStyle = 'rgba(47,42,36,0.35)';
      ctx.beginPath();
      ctx.arc(toX(mm.x), toY(mm.z), 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // 起点
    const start = mapTToMinimap(this.track, this.track.config.startT);
    ctx.fillStyle = '#c33a2f';
    ctx.fillRect(toX(start.x) - 4, toY(start.z) - 4, 8, 8);

    // 所有参赛者（阶段一只有 1 辆）
    for (const r of session.racers) {
      const p = r.car.position;
      const proj = this.track.centerline.project(p.x, p.z, p.y);
      const mm = mapWorldToMinimap(this.track, p.x, p.z);
      const isPlayer = r.id === 'player';
      ctx.beginPath();
      ctx.arc(toX(mm.x), toY(mm.z), isPlayer ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = isPlayer ? '#c33a2f' : '#2f4468';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#f6f1e2';
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = '#3b332b';
      ctx.stroke();
      void proj;
      void playerName;
    }
    void racer;
  }
}

/** 世界坐标 → 小地图归一化坐标（与 BuiltTrack.minimap 使用同一包围盒）。 */
function mapWorldToMinimap(track: BuiltTrack, x: number, z: number): { x: number; z: number } {
  const b = track.minimap.bounds;
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 1);
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  return { x: (x - cx) / span + 0.5, z: (z - cz) / span + 0.5 };
}

function mapTToMinimap(track: BuiltTrack, t: number): { x: number; z: number } {
  const p = track.centerline.pointAt(t);
  return mapWorldToMinimap(track, p.x, p.z);
}
