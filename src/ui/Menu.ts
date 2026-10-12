import type { TrackConfig } from '../tracks/types';
import type { ValidationReport } from '../tracks/validate';
import { estimateRaceSeconds } from '../tracks/validate';
import { VEHICLES } from '../vehicles/vehicleCatalog';
import { deriveVehicle, type VehicleSpec } from '../vehicles/VehicleSpec';
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

/**
 * 主菜单。内容全部是真实数据：赛道长度、预计赛程、驾驶参数都来自
 * 参数表与赛道自检结果，不写死文案。
 */
export class Menu {
  readonly root: HTMLDivElement;
  private settings: MenuSettings;
  private driver: DriverSpecies = 'bear';
  private readonly track: TrackConfig;
  private readonly stats: ValidationReport['stats'] | null;
  private readonly speedRef: number;

  constructor(
    track: TrackConfig,
    stats: ValidationReport['stats'] | null,
    initialSettings: MenuSettings,
    private readonly cb: MenuCallbacks,
  ) {
    this.track = track;
    this.stats = stats;
    this.settings = { ...initialSettings };
    const spec: VehicleSpec = VEHICLES[0];
    this.speedRef = spec.engineMaxPower;
    this.root = document.createElement('div');
    this.root.className = 'menu';
    this.render();
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

  private render(): void {
    const spec = VEHICLES[0];
    const derived = deriveVehicle(spec);
    const lengthM = this.stats?.length ?? 0;
    const laps = this.track.laps;
    const est = lengthM > 0 ? estimateRaceSeconds(lengthM, laps, 22) : 0;
    const refLap = lengthM > 0 ? lengthM / 22 : 0;

    const driverCards = (Object.keys(DRIVERS) as DriverSpecies[])
      .map((key) => {
        const d = DRIVERS[key];
        const active = key === this.driver;
        return `<button class="btn btn--sm" data-driver="${key}" style="${active ? 'background:#fff6e2;border-style:solid' : 'border-style:dashed'}">
            ${d.name}<span class="hud-item__dot" style="background:#${d.colors.fur.toString(16).padStart(6, '0')}"></span>
          </button>`;
      })
      .join('');

    this.root.innerHTML = `
      <div class="menu__left">
        <div class="paper" style="position:relative">
          <div class="paper__sheet"></div>
          <div class="paper__content">
            <div class="kicker">纯代码生成 · 纸艺赛车</div>
            <h1 class="stamp menu__title">纸上狂飙</h1>
            <div class="menu__sub">PAPER RUSH</div>
            <div class="paper__content" style="padding:0.9em 0 0">
              <div class="menu__buttons">
                <button class="btn btn--primary" data-start>开始计时赛 <span class="btn__key">Enter</span></button>
                <button class="btn" data-restart>重新开始 <span class="btn__key">R</span></button>
              </div>
            </div>
          </div>
        </div>

        <div class="paper" style="position:relative">
          <div class="paper__sheet paper__sheet--soft"></div>
          <div class="paper__content">
            <div class="stamp stamp--sm">操作</div>
            <ul class="help-list">
              <li><kbd>W</kbd><kbd>↑</kbd><span>加速</span></li>
              <li><kbd>S</kbd><kbd>↓</kbd><span>刹车 / 倒车</span></li>
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
        <div class="paper" style="position:relative">
          <div class="paper__sheet"></div>
          <div class="paper__content">
            <div class="kicker">章节 ${this.track.chapter}</div>
            <div class="stamp stamp--md">${this.track.name}</div>
            <div class="sub">${this.track.subtitle}</div>
            <div class="hand-line" style="margin:0.8em 0"></div>
            <dl class="info-grid">
              <dt>赛道长度</dt><dd>${lengthM.toFixed(0)} m</dd>
              <dt>圈数</dt><dd>${laps} 圈</dd>
              <dt>参考单圈</dt><dd>${refLap.toFixed(0)} s（80 km/h 巡航估算）</dd>
              <dt>预计赛程</dt><dd>${est.toFixed(0)} s ≈ ${(est / 60).toFixed(1)} 分钟</dd>
              <dt>最小弯道半径</dt><dd>${this.stats ? this.stats.minCornerRadius.toFixed(0) : '—'} m</dd>
              <dt>最大坡度</dt><dd>${this.stats ? ((Math.atan(this.stats.maxGrade) * 180) / Math.PI).toFixed(1) : '—'}°</dd>
              <dt>难度</dt><dd>${'★'.repeat(this.track.difficulty)}${'☆'.repeat(5 - this.track.difficulty)}</dd>
            </dl>
          </div>
        </div>

        <div class="paper" style="position:relative">
          <div class="paper__sheet paper__sheet--soft"></div>
          <div class="paper__content">
            <div class="stamp stamp--sm">车辆 · ${spec.name}</div>
            <div class="hand-line" style="margin:0.5em 0 0.7em"></div>
            <dl class="info-grid">
              <dt>整车质量</dt><dd>${spec.mass} kg</dd>
              <dt>最大功率</dt><dd>${(this.speedRef / 1000).toFixed(0)} kW / ${(this.speedRef / 745.7).toFixed(0)} hp</dd>
              <dt>最大扭矩</dt><dd>${spec.engineMaxTorque} N·m @ ${spec.enginePeakTorqueRpm} rpm</dd>
              <dt>驱动形式</dt><dd>${spec.driveLayout === 'rwd' ? '后轮驱动' : spec.driveLayout === 'fwd' ? '前轮驱动' : '四轮驱动'}</dd>
              <dt>轮胎摩擦系数</dt><dd>前 ${spec.tyreFrictionFront} / 后 ${spec.tyreFrictionRear}</dd>
              <dt>阻力面积 Cd·A</dt><dd>${spec.dragArea} m²</dd>
              <dt>理论红线极速</dt><dd>${(derived.theoreticalTopSpeed * 3.6).toFixed(0)} km/h</dd>
              <dt>每轮弹簧刚度</dt><dd>${derived.springRatePerWheel.toFixed(0)} N/m</dd>
            </dl>
            ${
              this.settings.showDebug
                ? `<div class="hand-line" style="margin:0.9em 0 0.6em"></div>
                   <div class="sub" style="font-size:0.9em">比功率 ${(this.speedRef / spec.mass).toFixed(1)} W/kg ·
                   推重比 ${((spec.engineMaxTorque * spec.gearRatios[0] * spec.finalDrive * spec.drivetrainEfficiency) / spec.wheelRadius / (spec.mass * derived.gravity)).toFixed(2)} g（1 挡轮端）</div>`
                : ''
            }
          </div>
        </div>

        <div class="paper" style="position:relative">
          <div class="paper__sheet paper__sheet--soft"></div>
          <div class="paper__content">
            <div class="stamp stamp--sm">车手</div>
            <div class="menu__buttons" data-drivers>${driverCards}</div>
            <div class="hand-line" style="margin:1em 0 0.7em"></div>
            <div class="setting">
              <span class="setting__label">画质</span>
              <span class="seg" data-quality>
                <button data-q="high" aria-pressed="${this.settings.quality === 'high'}">1080p / 60</button>
                <button data-q="low" aria-pressed="${this.settings.quality === 'low'}">720p / 30</button>
              </span>
            </div>
            <div class="setting">
              <span class="setting__label">调试面板</span>
              <span class="seg" data-debug>
                <button data-d="on" aria-pressed="${this.settings.showDebug}">开</button>
                <button data-d="off" aria-pressed="${!this.settings.showDebug}">关</button>
              </span>
            </div>
            <div class="fps-note">车手只改变外观，不叠加物理属性。</div>
          </div>
        </div>
      </div>
    `;

    this.bind();
  }

  private bind(): void {
    this.root.querySelector('[data-start]')?.addEventListener('click', () => this.cb.onStart());
    this.root.querySelector('[data-restart]')?.addEventListener('click', () => this.cb.onRestart());

    this.root.querySelectorAll('[data-driver]').forEach((el) => {
      el.addEventListener('click', () => {
        const key = (el as HTMLElement).dataset.driver as DriverSpecies;
        this.driver = key;
        this.cb.onDriverChange(key);
        this.render();
      });
    });

    this.root.querySelectorAll('[data-q]').forEach((el) => {
      el.addEventListener('click', () => {
        const q = (el as HTMLElement).dataset.q as 'high' | 'low';
        this.settings.quality = q;
        this.cb.onSettingsChange(this.settings);
        this.render();
      });
    });

    this.root.querySelectorAll('[data-d]').forEach((el) => {
      el.addEventListener('click', () => {
        const on = (el as HTMLElement).dataset.d === 'on';
        this.settings.showDebug = on;
        this.cb.onSettingsChange(this.settings);
        this.render();
      });
    });
  }

  /** 重新渲染（外部改动了统计信息时）。 */
  refresh(): void {
    this.render();
  }
}
