import type { BuiltRegion } from '../world/Region';
import type { WorldSession } from '../world/WorldSession';
import type { Car } from '../vehicles/Car';

/**
 * 开放世界的自由驾驶 HUD。
 *
 * 与 race/Hud（圈速/名次）不同，这里显示的是探索向的信息：
 * 时间、里程、当前路段、速度、小地图、区域边界提示。
 * 收集物与区域完成度在 S3 加入时会扩展这里的字段，而不是重写。
 */
export class WorldHud {
  readonly root: HTMLDivElement;
  private readonly timeValue: HTMLElement;
  private readonly distValue: HTMLElement;
  private readonly segValue: HTMLElement;
  private readonly speedValue: HTMLElement;
  private readonly gearValue: HTMLElement;
  private readonly regionValue: HTMLElement;
  private readonly surfaceDot: HTMLElement;
  private readonly surfaceName: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly minimap: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private toastTimer = 0;

  constructor(private readonly region: BuiltRegion) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud__corner hud__corner--tl">
        <div class="paper hud-block" data-card>
          <div class="paper__sheet"></div>
          <div class="paper__content" style="padding:0.7em 1.05em">
            <div class="hud-label">区域</div>
            <div class="hud-value hud-value--md" data-region>—</div>
          </div>
        </div>
        <div class="paper hud-block" data-card>
          <div class="paper__sheet"></div>
          <div class="paper__content" style="padding:0.7em 1.05em">
            <div class="hud-label">里程</div>
            <div class="hud-value hud-value--lg" data-dist>0.00 km</div>
          </div>
        </div>
      </div>

      <div class="hud__corner hud__corner--tr">
        <div class="paper" data-card>
          <div class="paper__sheet"></div>
          <div class="paper__content" style="padding:0.7em 1.05em; text-align:right">
            <div class="hud-label">自由驾驶时间</div>
            <div class="hud-value hud-value--lg" data-time>0:00</div>
            <div class="fps-note" data-seg>—</div>
          </div>
        </div>
      </div>

      <div class="hud__corner hud__corner--bl">
        <div class="paper minimap" data-card>
          <div class="paper__sheet"></div>
          <div class="paper__content" style="padding:0.55em">
            <canvas data-minimap width="300" height="300"></canvas>
          </div>
        </div>
        <div class="paper" data-card>
          <div class="paper__sheet"></div>
          <div class="paper__content" style="padding:0.5em 1em">
            <div class="hud-item">
              <span class="hud-item__dot" data-surface-dot></span>
              <span data-surface-name>——</span>
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
            <div class="fps-note" data-gear>1 挡</div>
          </div>
        </div>
      </div>

      <div class="toast" data-toast></div>
    `;

    const $ = <T extends HTMLElement>(sel: string): T => {
      const el = this.root.querySelector(sel);
      if (!el) throw new Error(`WorldHud 缺少元素 ${sel}`);
      return el as T;
    };
    this.timeValue = $('[data-time]');
    this.distValue = $('[data-dist]');
    this.segValue = $('[data-seg]');
    this.speedValue = $('[data-speed]');
    this.gearValue = $('[data-gear]');
    this.regionValue = $('[data-region]');
    this.surfaceDot = $('[data-surface-dot]');
    this.surfaceName = $('[data-surface-name]');
    this.toast = $('[data-toast]');
    this.minimap = $<HTMLCanvasElement>('[data-minimap]');
    const ctx = this.minimap.getContext('2d');
    if (!ctx) throw new Error('无法创建小地图画布');
    this.ctx = ctx;
    this.regionValue.textContent = this.region.config.name;
  }

  showToast(message: string, kind: 'info' | 'warn' | 'bad' = 'info', seconds = 2.4): void {
    this.toast.textContent = message;
    this.toast.className = `toast show ${kind === 'warn' ? 'toast--warn' : kind === 'bad' ? 'toast--bad' : ''}`;
    this.toastTimer = seconds;
  }

  update(dt: number, session: WorldSession, car: Car): void {
    const s = session.current;
    const tel = car.telemetry;

    const mins = Math.floor(s.elapsed / 60);
    const secs = Math.floor(s.elapsed % 60);
    this.timeValue.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
    this.distValue.textContent = `${(s.distance / 1000).toFixed(2)} km`;
    this.speedValue.textContent = String(Math.round(tel.speed * 3.6));
    this.gearValue.textContent = tel.gear === -1 ? '倒挡' : `${tel.gear} 挡 · ${Math.round(tel.rpm)} rpm`;
    this.segValue.textContent = s.onRoad
      ? `路段 ${s.segmentId} · ${(s.segmentT * 100).toFixed(0)}%`
      : '已离开路面';

    const surfaceId = tel.surface?.id ?? '—';
    this.surfaceName.textContent = surfaceId;
    this.surfaceDot.className = `hud-item__dot hud-item__dot--${surfaceId}`;

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.classList.remove('show');
    }

    this.drawMinimap(car, s.segmentId);
  }

  /** 小地图：路网折线 + 区域边界 + 玩家。 */
  private drawMinimap(car: Car, currentSegment: string): void {
    const ctx = this.ctx;
    const size = this.minimap.width;
    const pad = 20;
    const span = size - pad * 2;
    ctx.clearRect(0, 0, size, size);
    const bnd = this.region.minimap.bounds;
    const s = span / Math.max(bnd.maxX - bnd.minX, bnd.maxZ - bnd.minZ, 1e-6);
    const ox = pad + (span - (bnd.maxX - bnd.minX) * s) / 2 - bnd.minX * s;
    const oz = pad + (span - (bnd.maxZ - bnd.minZ) * s) / 2 - bnd.minZ * s;
    const toX = (x: number) => x * s + ox;
    const toZ = (z: number) => z * s + oz;

    // 区域边界
    const rb = this.region.config.bounds;
    ctx.strokeStyle = 'rgba(47,42,36,0.28)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(toX(rb.minX), toZ(rb.minZ), (rb.maxX - rb.minX) * s, (rb.maxZ - rb.minZ) * s);
    ctx.setLineDash([]);

    // 路网
    for (const pl of this.region.minimap.polylines) {
      ctx.beginPath();
      pl.points.forEach((p, i) => {
        const x = toX(p.x);
        const y = toZ(p.z);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      if (pl.closed) ctx.closePath();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(246,241,226,0.9)';
      ctx.lineWidth = 9;
      ctx.stroke();
      ctx.strokeStyle = '#3b332b';
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }

    // 闸口
    for (const g of this.region.config.gates) {
      ctx.fillStyle = '#3f7a2a';
      ctx.beginPath();
      ctx.arc(toX(g.x), toZ(g.z), 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#f6f1e2';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    void currentSegment;

    // 玩家
    const p = car.position;
    const fwd = car.forward;
    ctx.save();
    ctx.translate(toX(p.x), toZ(p.z));
    ctx.rotate(Math.atan2(fwd.x, fwd.z));
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5.5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5.5, 6);
    ctx.closePath();
    ctx.fillStyle = '#c33a2f';
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#f6f1e2';
    ctx.stroke();
    ctx.restore();
  }
}
