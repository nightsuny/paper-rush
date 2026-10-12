import type { Car } from '../vehicles/Car';
import type { DerivedVehicle } from '../vehicles/VehicleSpec';
import type { PhysicsWorld } from '../physics/PhysicsWorld';

export interface DebugStats {
  fps: number;
  frameMs: number;
  physicsStepsPerFrame: number;
  physicsMs: number;
  triangles: number;
  drawCalls: number;
  bodies: number;
  colliders: number;
}

/**
 * 调试面板（F3）。
 * 显示真实物理量：发动机、变速箱、逐轮载荷/附着/滑移、外力分解、渲染开销。
 * 这些数字全部来自物理求解结果，不是根据 UI 反推的。
 */
export class DebugPanel {
  readonly root: HTMLDivElement;
  private acc = 0;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'debug paper hidden';
    this.root.innerHTML = `
      <div class="paper__sheet paper__sheet--soft"></div>
      <div class="paper__content" style="padding:0.7em 1.1em">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:1em">
          <div class="stamp stamp--sm">调试 · F3</div>
          <div class="fps-note" data-summary></div>
        </div>
        <div class="debug__grid" data-body></div>
        <div class="debug__wheels" data-wheels></div>
      </div>
    `;
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  update(
    dt: number,
    car: Car,
    derived: DerivedVehicle,
    stats: DebugStats,
    world: PhysicsWorld,
  ): void {
    if (!this.visible) return;
    this.acc += dt;
    if (this.acc < 0.08) return;
    this.acc = 0;

    const tel = car.telemetry;
    const spec = derived.spec;
    const body = this.root.querySelector('[data-body]');
    const summary = this.root.querySelector('[data-summary]');
    const wheels = this.root.querySelector('[data-wheels]');
    if (!body || !summary || !wheels) return;

    const rows: Array<[string, string]> = [
      ['速度', `${(tel.speed * 3.6).toFixed(1)} km/h (${tel.speed.toFixed(2)} m/s)`],
      ['前向 / 侧向', `${tel.forwardSpeed.toFixed(2)} / ${tel.lateralSpeed.toFixed(2)} m/s`],
      ['发动机', `${tel.rpm.toFixed(0)} rpm · ${tel.gear === -1 ? 'R' : tel.gear} 挡${tel.shifting ? ' · 换挡中' : ''}`],
      ['油门（含延迟）', `${(tel.throttle * 100).toFixed(0)} %`],
      ['纵向加速度', `${tel.longitudinalAccel.toFixed(2)} m/s²`],
      ['侧向加速度', `${tel.lateralAccel.toFixed(2)} m/s² (${(Math.abs(tel.lateralAccel) / 9.81).toFixed(2)} g)`],
      ['侧滑角', `${((tel.slipAngle * 180) / Math.PI).toFixed(1)}°`],
      ['空气阻力', `${tel.dragForce.toFixed(0)} N`],
      ['下压力', `${tel.downforce.toFixed(0)} N`],
      ['滚动阻力', `${tel.rollingForce.toFixed(0)} N`],
      ['总纵向力', `${tel.appliedLongitudinalForce.toFixed(0)} N`],
      ['离地高度', `${tel.groundHeight.toFixed(3)} m`],
      ['轮胎接触', `${tel.wheelContacts}/4${tel.airborne ? ' · 腾空' : ''}${tel.upsideDown ? ' · 翻车' : ''}`],
      ['当前路面', tel.surface?.id ?? '—'],
      ['本车碰撞体', `${spec.colliders.length} 个`],
      ['静态碰撞体', `${world.world.colliders.len()}`],
      ['刚体总数', `${world.world.bodies.len()}`],
      ['渲染三角面', `${(stats.triangles / 1000).toFixed(1)}k`],
      ['绘制调用', `${stats.drawCalls}`],
      ['物理步/帧', `${stats.physicsStepsPerFrame}（固定 60Hz）`],
      ['物理耗时', `${stats.physicsMs.toFixed(2)} ms`],
      ['渲染耗时', `${stats.frameMs.toFixed(2)} ms`],
      ['FPS', `${stats.fps.toFixed(0)}`],
    ];

    body.innerHTML = rows
      .map(
        ([k, v]) =>
          `<div class="debug__row"><span>${k}</span><b>${v}</b></div>`,
      )
      .join('');

    summary.textContent = `${stats.fps.toFixed(0)} fps · 物理 ${stats.physicsMs.toFixed(1)} ms · 三角面 ${(stats.triangles / 1000).toFixed(0)}k · 绘制 ${stats.drawCalls}`;

    wheels.innerHTML = tel.wheels
      .map((w, i) => {
        const names = ['前左', '前右', '后左', '后右'];
        const loadPct = Math.min(w.loadRatio * 100, 100);
        const spin = w.wheelspin ? '<span class="tag tag--warn">打滑</span>' : '';
        return `
          <div class="debug__wheel">
            <h4>${names[i]} ${spin}</h4>
            <div class="debug__row"><span>载荷</span><b>${w.normalLoad.toFixed(0)} N</b></div>
            <div class="bar"><div class="bar__fill" style="width:${loadPct}%"></div></div>
            <div class="debug__row"><span>摩擦 μ</span><b>${w.friction.toFixed(2)}</b></div>
            <div class="debug__row"><span>悬挂</span><b>${w.suspensionLength.toFixed(3)} m</b></div>
            <div class="debug__row"><span>纵向力</span><b>${w.longitudinalForce.toFixed(0)} N</b></div>
            <div class="debug__row"><span>侧向力</span><b>${w.lateralForce.toFixed(0)} N</b></div>
            <div class="debug__row"><span>接触</span><b>${w.contact ? '是' : '否'}</b></div>
          </div>`;
      })
      .join('');
  }
}
