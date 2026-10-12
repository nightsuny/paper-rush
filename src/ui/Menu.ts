import type { TrackConfig } from '../tracks/types';
import type { ValidationReport } from '../tracks/validate';
import { deriveVehicle } from '../vehicles/VehicleSpec';
import { STOCK_KART } from '../vehicles/vehicleCatalog';
import { DRIVERS, type DriverSpecies } from '../vehicles/CarVisual';

export interface MenuSettings {
  quality: 'high' | 'low';
  showDebug: boolean;
}

export interface MenuCallbacks {
  onStart: () => void;
  onSettingsChange: (settings: MenuSettings) => void;
  onDriverChange: (species: DriverSpecies) => void;
  onRestart: () => void;
  onBackToMenu: () => void;
}

const DRIVER_ORDER: DriverSpecies[] = ['bear', 'cat', 'rabbit', 'fox'];

/**
 * 主菜单。
 *
 * 设计取舍：菜单只放"做决定所需要的信息"——这是什么赛道、要跑多久、
 * 车手什么样子、画质怎么选。整车参数表那种高密度数据搬到调试面板（F3），
 * 否则一屏全是数字，既不好看也读不完。
 */
export class Menu {
  readonly root: HTMLDivElement;
  private settings: MenuSettings;
  private driver: DriverSpecies = 'bear';
  private readonly track: TrackConfig;
  private readonly stats: ValidationReport['stats'] | null;
  private readonly minimapPoints: ReadonlyArray<{ x: number; z: number }>;
  private bound = false;

  constructor(
    track: TrackConfig,
    stats: ValidationReport['stats'] | null,
    minimapPoints: ReadonlyArray<{ x: number; z: number }>,
    initialSettings: MenuSettings,
    private readonly cb: MenuCallbacks,
  ) {
    this.track = track;
    this.stats = stats;
    this.minimapPoints = minimapPoints;
    this.settings = { ...initialSettings };
    this.root = document.createElement('div');
    this.root.className = 'menu';
    this.build();
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  get currentSettings(): MenuSettings {
    return { ...this.settings };
  }

  get currentDriver(): DriverSpecies {
    return this.driver;
  }

  /** 外部改动设置后刷新选中态（不重建 DOM）。 */
  refresh(): void {
    this.syncSelection();
  }

  private build(): void {
    const spec = STOCK_KART;
    const derived = deriveVehicle(spec);
    const lengthM = this.stats?.length ?? 0;
    const estSeconds = lengthM > 0 ? (lengthM / 22) * this.track.laps : 0;
    const estText =
      estSeconds > 0 ? `${Math.floor(estSeconds / 60)} 分 ${Math.round(estSeconds % 60)} 秒` : '—';

    const driverCards = DRIVER_ORDER.map((key) => {
      const d = DRIVERS[key];
      const hex = d.colors.fur.toString(16).padStart(6, '0');
      return `
        <button class="driver" data-driver="${key}" type="button">
          <span class="driver__chip" style="--fur:#${hex}"></span>
          <span class="driver__name">${d.name}</span>
        </button>`;
    }).join('');

    this.root.innerHTML = `
      <div class="menu__left">
        <div class="paper menu__hero">
          <div class="paper__sheet"></div>
          <div class="paper__content">
            <div class="kicker">纯代码生成 · 纸艺赛车</div>
            <h1 class="stamp menu__title">纸上狂飙</h1>
            <div class="menu__sub">PAPER&nbsp;RUSH</div>
            <button class="btn btn--primary menu__start" data-start type="button">
              开始计时赛 <span class="btn__key">Enter</span>
            </button>
          </div>
        </div>

        <div class="paper menu__help">
          <div class="paper__sheet paper__sheet--soft"></div>
          <div class="paper__content">
            <div class="stamp stamp--sm">操作</div>
            <ul class="help-list">
              <li><kbd>W</kbd><span>加速</span></li>
              <li><kbd>S</kbd><span>刹车 / 倒车</span></li>
              <li><kbd>A</kbd><kbd>D</kbd><span>转向</span></li>
              <li><kbd>空格</kbd><span>手刹漂移</span></li>
              <li><kbd>R</kbd><span>回到检查点</span></li>
              <li><kbd>Esc</kbd><span>暂停</span></li>
              <li><kbd>C</kbd><span>切换镜头</span></li>
              <li><kbd>F3</kbd><span>调试面板</span></li>
            </ul>
          </div>
        </div>
      </div>

      <div class="menu__right">
        <div class="paper menu__track">
          <div class="paper__sheet"></div>
          <div class="paper__content">
            <div class="menu__track-head">
              <div class="menu__track-text">
                <div class="kicker">第 ${this.track.chapter} 章</div>
                <div class="stamp stamp--md">${this.track.name}</div>
                <div class="sub">${this.track.subtitle}</div>
              </div>
              <canvas class="menu__shape" data-shape width="140" height="140"></canvas>
            </div>
            <div class="hand-line" style="margin:0.9em 0 0.8em"></div>
            <div class="stat-row">
              <div class="stat"><b>${lengthM.toFixed(0)}</b><span>米</span><em>赛道长度</em></div>
              <div class="stat"><b>${this.track.laps}</b><span>圈</span><em>赛程</em></div>
              <div class="stat"><b>${estText}</b><em>预计用时</em></div>
              <div class="stat"><b class="stars">${'★'.repeat(this.track.difficulty)}${'☆'.repeat(5 - this.track.difficulty)}</b><em>难度</em></div>
            </div>
          </div>
        </div>

        <div class="paper menu__driver">
          <div class="paper__sheet paper__sheet--soft"></div>
          <div class="paper__content">
            <div class="menu__row-head">
              <span class="stamp stamp--sm">车手</span>
              <span class="fps-note">只改变外观</span>
            </div>
            <div class="driver-row" data-drivers>${driverCards}</div>
            <div class="hand-line" style="margin:1em 0 0.8em"></div>
            <div class="setting">
              <span class="setting__label">画质</span>
              <span class="seg" data-quality>
                <button data-q="high" type="button">1080p / 60</button>
                <button data-q="low" type="button">720p / 30</button>
              </span>
            </div>
            <div class="setting">
              <span class="setting__label">调试面板</span>
              <span class="seg" data-debug>
                <button data-d="on" type="button">开</button>
                <button data-d="off" type="button">关</button>
              </span>
            </div>
            <div class="fps-note menu__note">
              ${spec.name}　${spec.mass} kg　${(spec.engineMaxPower / 1000).toFixed(0)} kW　红线极速 ${(derived.theoreticalTopSpeed * 3.6).toFixed(0)} km/h
            </div>
          </div>
        </div>
      </div>
    `;

    this.bind();
    this.syncSelection();
    this.drawShape();
  }

  private bind(): void {
    if (this.bound) return;
    this.bound = true;
    this.root.querySelector('[data-start]')?.addEventListener('click', () => this.cb.onStart());
    this.root.querySelectorAll('[data-driver]').forEach((el) => {
      el.addEventListener('click', () => {
        this.driver = (el as HTMLElement).dataset.driver as DriverSpecies;
        this.cb.onDriverChange(this.driver);
        this.syncSelection();
      });
    });
    this.root.querySelectorAll('[data-q]').forEach((el) => {
      el.addEventListener('click', () => {
        this.settings.quality = (el as HTMLElement).dataset.q as 'high' | 'low';
        this.cb.onSettingsChange(this.settings);
        this.syncSelection();
      });
    });
    this.root.querySelectorAll('[data-d]').forEach((el) => {
      el.addEventListener('click', () => {
        this.settings.showDebug = (el as HTMLElement).dataset.d === 'on';
        this.cb.onSettingsChange(this.settings);
        this.syncSelection();
      });
    });
  }

  /** 只切换选中态，不重建 DOM（重建会丢焦点，也更容易闪）。 */
  private syncSelection(): void {
    this.root.querySelectorAll('[data-driver]').forEach((el) => {
      const active = (el as HTMLElement).dataset.driver === this.driver;
      el.classList.toggle('is-active', active);
      el.setAttribute('aria-pressed', String(active));
    });
    this.root.querySelectorAll('[data-q]').forEach((el) => {
      el.setAttribute('aria-pressed', String((el as HTMLElement).dataset.q === this.settings.quality));
    });
    this.root.querySelectorAll('[data-d]').forEach((el) => {
      const on = (el as HTMLElement).dataset.d === 'on';
      el.setAttribute('aria-pressed', String(on === this.settings.showDebug));
    });
  }

  /** 用真实中心线数据把赛道形状画成一张小图。 */
  private drawShape(): void {
    const canvas = this.root.querySelector('[data-shape]') as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const pts = this.minimapPoints;
    if (pts.length < 3) return;

    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minZ = Math.min(minZ, p.z);
      maxX = Math.max(maxX, p.x);
      maxZ = Math.max(maxZ, p.z);
    }
    const span = Math.max(maxX - minX, maxZ - minZ, 1e-6);
    const pad = 16;
    const s = (w - pad * 2) / span;
    const ox = (w - (maxX - minX) * s) / 2 - minX * s;
    const oz = (h - (maxZ - minZ) * s) / 2 - minZ * s;

    const path = new Path2D();
    pts.forEach((p, i) => {
      const x = p.x * s + ox;
      const y = p.z * s + oz;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    path.closePath();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(201,189,162,0.85)';
    ctx.lineWidth = 10;
    ctx.stroke(path);
    ctx.strokeStyle = '#35302a';
    ctx.lineWidth = 2.8;
    ctx.stroke(path);

    const start = pts[0];
    ctx.fillStyle = '#c33a2f';
    ctx.beginPath();
    ctx.arc(start.x * s + ox, start.z * s + oz, 4.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#f6f1e2';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
}
