/**
 * 键盘输入。只负责把按键状态翻译成车辆输入，不直接触碰物理。
 *
 * W/↑ 加速，S/↓ 刹车与倒车，A/D 或 ←/→ 转向，空格 手刹，
 * R 重置到最近检查点，Esc 暂停，F3 调试面板，C 切换镜头。
 */

export interface InputState {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
}

export type GameAction = 'pause' | 'reset' | 'debug' | 'camera' | 'restart';

const KEY_ALIASES: Record<string, string> = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  ' ': 'space',
  escape: 'esc',
  esc: 'esc',
};

export class Input {
  private readonly down = new Set<string>();
  private readonly pressedThisFrame = new Set<string>();
  /** 平滑后的转向输入，避免键盘的 0/1 突变 */
  private steerValue = 0;
  /** 暂停/重置等一次性动作 */
  private readonly actions: GameAction[] = [];

  constructor(private readonly target: Window = window) {
    this.target.addEventListener('keydown', this.onKeyDown);
    this.target.addEventListener('keyup', this.onKeyUp);
    this.target.addEventListener('blur', this.onBlur);
  }

  private normalize(event: KeyboardEvent): string {
    const key = event.key.toLowerCase();
    return KEY_ALIASES[key] ?? key;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const key = this.normalize(event);
    if (
      key === 'up' ||
      key === 'down' ||
      key === 'left' ||
      key === 'right' ||
      key === 'space'
    ) {
      event.preventDefault();
    }
    if (!this.down.has(key)) {
      this.down.add(key);
      this.pressedThisFrame.add(key);
      if (key === 'esc') this.actions.push('pause');
      if (key === 'r') this.actions.push('reset');
      if (key === 'f3') this.actions.push('debug');
      if (key === 'c') this.actions.push('camera');
      if (key === 'enter') this.actions.push('restart');
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.down.delete(this.normalize(event));
  };

  private onBlur = (): void => {
    this.down.clear();
  };

  isDown(key: string): boolean {
    return this.down.has(key);
  }

  /** 消费一次性动作。 */
  takeActions(): GameAction[] {
    const out = this.actions.slice();
    this.actions.length = 0;
    return out;
  }

  /**
   * 得到本步的车辆输入。
   * @param dt 物理步长（转向平滑使用）
   * @param enabled 是否允许操控（倒计时/暂停时为 false）
   */
  sample(dt: number, enabled: boolean): InputState {
    if (!enabled) {
      this.steerValue *= Math.max(0, 1 - dt * 8);
      return { throttle: 0, brake: 0, steer: this.steerValue, handbrake: false };
    }
    const up = this.isDown('w') || this.isDown('up');
    const down = this.isDown('s') || this.isDown('down');
    const left = this.isDown('a') || this.isDown('left');
    const right = this.isDown('d') || this.isDown('right');
    const handbrake = this.isDown('space');

    const target = (left ? 1 : 0) - (right ? 1 : 0); // 正为左转
    // 键盘只有 0/1，用一个短时间常数让转向更顺滑（不是物理量，只是输入整形）
    const rate = target === 0 ? 12 : 9;
    this.steerValue += (target - this.steerValue) * Math.min(1, dt * rate);

    return {
      throttle: up ? 1 : 0,
      brake: down ? 1 : 0,
      steer: this.steerValue,
      handbrake,
    };
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
  }
}
