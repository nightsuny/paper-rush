import { DRIVERS, type DriverSpecies } from '../vehicles/CarVisual';
import { DEFAULT_AUDIO_SETTINGS, type AudioSettings } from '../audio/AudioEngine';

export interface MenuSettings {
  quality: 'high' | 'low';
  showDebug: boolean;
}

/** 菜单需要展示的区域信息（与具体数据结构解耦，便于将来加区域）。 */
export interface MenuRegionInfo {
  chapter: number;
  name: string;
  subtitle: string;
  difficulty: number;
  roadLengthMeters: number;
  segmentCount: number;
  gateCount: number;
  junctionCount: number;
  minimapPolylines: Array<{ points: Array<{ x: number; z: number }>; closed: boolean }>;
  minimapBounds: { minX: number; minZ: number; maxX: number; maxZ: number };
}

export interface MenuCallbacks {
  onStart: () => void;
  onSettingsChange: (settings: MenuSettings) => void;
  onDriverChange: (species: DriverSpecies) => void;
  onAudioChange: (settings: AudioSettings) => void;
  onRestart: () => void;
  onBackToMenu: () => void;
}

const DRIVER_ORDER: DriverSpecies[] = ['bear', 'cat', 'rabbit', 'fox'];

/**
 * 主菜单（开放世界版）。
 * 只放"做决定所需要的信息"：这是哪个区域、有多大、怎么开、车手长什么样。
 */
export class Menu {
  readonly root: HTMLDivElement;
  private settings: MenuSettings;
  private driver: DriverSpecies = 'bear';
  private audio: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };
  private readonly info: MenuRegionInfo;
  private bound = false;

  constructor(
    info: MenuRegionInfo,
    initialSettings: MenuSettings,
    initialAudio: AudioSettings,
    private readonly cb: MenuCallbacks,
  ) {
    this.info = info;
    this.settings = { ...initialSettings };
    this.audio = { ...initialAudio };
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

  refresh(): void {
    this.syncSelection();
  }

  setAudioSettings(next: AudioSettings): void {
    this.audio = { ...next };
    this.syncSelection();
  }

  private build(): void {
    const info = this.info;
    const km = info.roadLengthMeters / 1000;
    // 按 45 km/h 巡航粗估绕完全区的时间
    const driveMinutes = (info.roadLengthMeters / 1000 / 45) * 60;

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
            <div class="kicker">开放世界 · 纸艺驾驶</div>
            <h1 class="stamp menu__title">纸上狂飙</h1>
            <div class="menu__sub">PAPER&nbsp;RUSH</div>
            <button class="btn btn--primary menu__start" data-start type="button">
              开始探索 <span class="btn__key">Enter</span>
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
              <li><kbd>R</kbd><span>回到出生点</span></li>
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
                <div class="kicker">区域 ${info.chapter}</div>
                <div class="stamp stamp--md">${info.name}</div>
                <div class="sub">${info.subtitle}</div>
              </div>
              <canvas class="menu__shape" data-shape width="140" height="140"></canvas>
            </div>
            <div class="hand-line" style="margin:0.9em 0 0.8em"></div>
            <div class="stat-row">
              <div class="stat"><b>${km.toFixed(1)}</b><span>km</span><em>路网总长</em></div>
              <div class="stat"><b>${info.segmentCount}</b><span>段</span><em>路段数</em></div>
              <div class="stat"><b>${info.junctionCount}</b><span>处</span><em>路口 / 环岛</em></div>
              <div class="stat"><b>${Math.round(driveMinutes)}</b><span>分</span><em>绕完全区约</em></div>
            </div>
            <div class="fps-note menu__note">
              有 ${info.gateCount} 个通往下一区域的闸口；下一区尚未开放，边界处是不可见墙
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
              <span class="setting__label">音乐</span>
              <input class="slider" type="range" min="0" max="100" step="5" data-audio="music" />
            </div>
            <div class="setting">
              <span class="setting__label">音效</span>
              <input class="slider" type="range" min="0" max="100" step="5" data-audio="sfx" />
            </div>
            <div class="setting">
              <span class="setting__label">静音</span>
              <span class="seg" data-mute>
                <button data-m="off" type="button">有声</button>
                <button data-m="on" type="button">静音</button>
              </span>
            </div>
            <div class="setting">
              <span class="setting__label">调试面板</span>
              <span class="seg" data-debug>
                <button data-d="on" type="button">开</button>
                <button data-d="off" type="button">关</button>
              </span>
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
    this.root.querySelectorAll('[data-m]').forEach((el) => {
      el.addEventListener('click', () => {
        this.audio.muted = (el as HTMLElement).dataset.m === 'on';
        this.cb.onAudioChange(this.audio);
        this.syncSelection();
      });
    });
    this.root.querySelectorAll('[data-audio]').forEach((el) => {
      const input = el as HTMLInputElement;
      input.addEventListener('input', () => {
        const key = input.dataset.audio as 'music' | 'sfx';
        this.audio[key] = Number(input.value) / 100;
        this.cb.onAudioChange(this.audio);
      });
    });
  }

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
    this.root.querySelectorAll('[data-m]').forEach((el) => {
      const on = (el as HTMLElement).dataset.m === 'on';
      el.setAttribute('aria-pressed', String(on === this.audio.muted));
    });
    this.root.querySelectorAll('[data-audio]').forEach((el) => {
      const input = el as HTMLInputElement;
      const key = input.dataset.audio as 'music' | 'sfx';
      input.value = String(Math.round(this.audio[key] * 100));
    });
  }

  /** 用真实路网数据画一张区域形状缩略图。 */
  private drawShape(): void {
    const canvas = this.root.querySelector('[data-shape]') as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const b = this.info.minimapBounds;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 1e-6);
    const pad = 14;
    const s = (w - pad * 2) / span;
    const ox = (w - (b.maxX - b.minX) * s) / 2 - b.minX * s;
    const oz = (h - (b.maxZ - b.minZ) * s) / 2 - b.minZ * s;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const pl of this.info.minimapPolylines) {
      const path = new Path2D();
      pl.points.forEach((p, i) => {
        const x = p.x * s + ox;
        const y = p.z * s + oz;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
      if (pl.closed) path.closePath();
      ctx.strokeStyle = 'rgba(201,189,162,0.85)';
      ctx.lineWidth = 6;
      ctx.stroke(path);
      ctx.strokeStyle = '#35302a';
      ctx.lineWidth = 1.8;
      ctx.stroke(path);
    }
  }
}
