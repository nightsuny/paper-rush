import type { RaceResult, RaceSession } from '../race/RaceSession';
import { formatTime, formatTimeShort } from '../race/RaceSession';

export interface ResultsCallbacks {
  onRestart: () => void;
  onBackToMenu: () => void;
}

/** 结算界面：排名、总时间、单圈明细、最高速度。奖励系统属于阶段三。 */
export class Results {
  readonly root: HTMLDivElement;

  constructor(private readonly cb: ResultsCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'overlay hidden';
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  show(
    session: RaceSession,
    result: RaceResult,
    bestLapOverall: number,
    playerName: string,
    rewardNote: string,
  ): void {
    const podium = result.position === 1 ? '第 1 名' : `第 ${result.position} 名`;
    const headline = result.position === 1 ? '冲线！第一名' : `完赛 · ${podium}`;
    const rows = result.lapTimes
      .map((t, i) => {
        const isBest = Math.abs(t - bestLapOverall) < 1e-6;
        const delta = i === 0 ? null : t - result.lapTimes[i - 1];
        const deltaText =
          delta === null
            ? '—'
            : `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}`;
        return `<tr class="${isBest ? 'is-best' : ''}"><td>第 ${i + 1} 圈</td><td>${formatTimeShort(t)}</td><td>${deltaText}</td></tr>`;
      })
      .join('');

    this.root.innerHTML = `
      <div class="paper panel" style="position:relative">
        <div class="paper__sheet"></div>
        <div class="paper__content" style="padding:2em 2.4em">
          <div class="kicker">${session.centerline.config.name} · ${session.totalLaps} 圈</div>
          <div class="stamp stamp--lg">${headline}</div>
          <div class="sub" style="margin-top:0.4em">车手 ${playerName}</div>
          <div class="hand-line" style="margin:1.1em 0"></div>
          <div class="panel__row"><span>总时间</span><span>${formatTime(result.totalTime)}</span></div>
          <div class="panel__row"><span>最快单圈</span><span>${formatTime(result.bestLap)}</span></div>
          <div class="panel__row"><span>平均速度</span><span>${(result.avgSpeed * 3.6).toFixed(1)} km/h</span></div>
          <div class="panel__row"><span>最高速度</span><span>${(result.topSpeed * 3.6).toFixed(1)} km/h</span></div>
          <div class="panel__row"><span>完成圈数</span><span>${result.lapsCompleted} / ${session.totalLaps}</span></div>
          <div class="panel__row"><span>漏过检查点圈数</span><span>${session.invalidLapCount}</span></div>
          <div class="panel__row"><span>奖励</span><span>${rewardNote}</span></div>
          <table class="lap-table">
            <thead><tr><th>圈</th><th>用时</th><th>与上圈差</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="panel__actions">
            <button class="btn btn--primary" data-again>再跑一场 <span class="btn__key">Enter</span></button>
            <button class="btn" data-menu>返回主菜单 <span class="btn__key">Esc</span></button>
          </div>
        </div>
      </div>
    `;
    this.root.querySelector('[data-again]')?.addEventListener('click', () => this.cb.onRestart());
    this.root.querySelector('[data-menu]')?.addEventListener('click', () => this.cb.onBackToMenu());
  }
}

/** 暂停界面。 */
export class PauseOverlay {
  readonly root: HTMLDivElement;

  constructor(private readonly cb: ResultsCallbacks & { onResume: () => void }) {
    this.root = document.createElement('div');
    this.root.className = 'overlay hidden';
    this.root.innerHTML = `
      <div class="paper panel" style="max-width:30em;position:relative">
        <div class="paper__sheet"></div>
        <div class="paper__content" style="padding:1.8em 2.2em">
          <div class="stamp stamp--md">暂停</div>
          <div class="sub" style="margin-top:0.5em">物理与计时已经停止。</div>
          <div class="panel__actions">
            <button class="btn btn--primary" data-resume>继续 <span class="btn__key">Esc</span></button>
            <button class="btn" data-again>重新开始 <span class="btn__key">R</span></button>
            <button class="btn" data-menu>返回主菜单</button>
          </div>
          <div class="sub" style="margin-top:1em;font-size:0.9em">提示：比赛中按 R 会把车送回最近通过的检查点，不会重置成绩。</div>
        </div>
      </div>
    `;
    this.root.querySelector('[data-resume]')?.addEventListener('click', () => this.cb.onResume());
    this.root.querySelector('[data-again]')?.addEventListener('click', () => this.cb.onRestart());
    this.root.querySelector('[data-menu]')?.addEventListener('click', () => this.cb.onBackToMenu());
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }
}
