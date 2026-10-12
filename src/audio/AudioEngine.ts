import type { Car } from '../vehicles/Car';
import type { RaceSession } from '../race/RaceSession';

/**
 * 程序化音频：全部由 Web Audio 合成，不引入任何外部录音素材。
 *
 * 组成：
 *  - 引擎：两个失谐锯齿波 + 低通，频率跟随转速，音量跟随油门；再加一层气流噪声
 *  - 轮胎滑移：带通白噪声，音量跟随滑移量
 *  - 风噪/滚动：低通白噪声，音量跟随车速
 *  - 碰撞：一次冲击就触发一次噪声爆音 + 低频闷响
 *  - 提示音：倒计时、检查点、单圈、完赛、结算
 *  - 背景音乐：程序生成的循环和弦 + 琶音，用前瞻调度器排队
 *
 * 线程安全：所有参数更新都用 setTargetAtTime 平滑，不做每帧创建节点；
 * 音乐的排程在音频时钟上提前 0.6 s 排好，因此不会阻塞物理循环。
 */

export interface AudioSettings {
  /** 主音量 0..1 */
  master: number;
  /** 音乐音量 0..1 */
  music: number;
  /** 音效音量 0..1 */
  sfx: number;
  muted: boolean;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  master: 0.75,
  music: 0.5,
  sfx: 0.85,
  muted: false,
};

export type AudioCue =
  | 'countdown'
  | 'go'
  | 'checkpoint'
  | 'lap'
  | 'invalid'
  | 'finish'
  | 'reset'
  | 'crash'
  | 'ui';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private settings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };

  // 混音总线
  private masterGain!: GainNode;
  private musicGain!: GainNode;
  private sfxGain!: GainNode;

  // 引擎
  private engineOscA: OscillatorNode | null = null;
  private engineOscB: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;

  // 滑移 / 风噪
  private noiseBuffer: AudioBuffer | null = null;
  private slipSource: AudioBufferSourceNode | null = null;
  private slipGain: GainNode | null = null;
  private slipFilter: BiquadFilterNode | null = null;
  private windSource: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;

  // 音乐调度
  private musicTimer: number | null = null;
  private nextNoteTime = 0;
  private step = 0;
  private musicPlaying = false;

  /** 上一次物理步的速度，用于检测撞击冲量 */
  private lastSpeed = 0;
  private crashCooldown = 0;

  get isRunning(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get contextState(): string {
    return this.ctx ? this.ctx.state : 'closed';
  }

  /**
   * 在用户首次交互后调用。浏览器要求音频上下文由用户手势启动。
   * 幂等：重复调用只会恢复被挂起的上下文。
   */
  async resume(): Promise<boolean> {
    if (!this.ctx) {
      try {
        const Ctor: typeof AudioContext =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return false;
        this.ctx = new Ctor();
        this.buildGraph();
      } catch {
        return false;
      }
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        return false;
      }
    }
    return this.ctx.state === 'running';
  }

  private buildGraph(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.settings.muted ? 0 : this.settings.master;
    this.masterGain.connect(ctx.destination);

    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = this.settings.music;
    this.musicGain.connect(this.masterGain);

    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = this.settings.sfx;
    this.sfxGain.connect(this.masterGain);

    // 白噪声缓冲（滑移、风噪、碰撞共用）
    const len = Math.floor(ctx.sampleRate * 1.2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = (seed / 0x3fffffff - 1) * 0.9;
    }
    this.noiseBuffer = buf;

    // ---- 引擎：两个失谐锯齿 + 低通 ----
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 3.5;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.sfxGain);

    this.engineOscA = ctx.createOscillator();
    this.engineOscA.type = 'sawtooth';
    this.engineOscA.frequency.value = 60;
    this.engineOscA.connect(this.engineFilter);
    this.engineOscA.start();

    this.engineOscB = ctx.createOscillator();
    this.engineOscB.type = 'square';
    this.engineOscB.frequency.value = 90;
    const bGain = ctx.createGain();
    bGain.gain.value = 0.35;
    this.engineOscB.connect(bGain);
    bGain.connect(this.engineFilter);
    this.engineOscB.start();

    // ---- 轮胎滑移 ----
    this.slipFilter = ctx.createBiquadFilter();
    this.slipFilter.type = 'bandpass';
    this.slipFilter.frequency.value = 1800;
    this.slipFilter.Q.value = 1.1;
    this.slipGain = ctx.createGain();
    this.slipGain.gain.value = 0;
    this.slipFilter.connect(this.slipGain);
    this.slipGain.connect(this.sfxGain);
    this.slipSource = ctx.createBufferSource();
    this.slipSource.buffer = buf;
    this.slipSource.loop = true;
    this.slipSource.connect(this.slipFilter);
    this.slipSource.start();

    // ---- 风噪 / 滚动 ----
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 420;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.sfxGain);
    this.windSource = ctx.createBufferSource();
    this.windSource.buffer = buf;
    this.windSource.loop = true;
    this.windSource.connect(this.windFilter);
    this.windSource.start();
  }

  setSettings(next: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...next };
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const ramp = (param: AudioParam, v: number) => param.setTargetAtTime(v, t, 0.05);
    ramp(this.masterGain.gain, this.settings.muted ? 0 : clamp01(this.settings.master));
    ramp(this.musicGain.gain, clamp01(this.settings.music));
    ramp(this.sfxGain.gain, clamp01(this.settings.sfx));
  }

  get currentSettings(): AudioSettings {
    return { ...this.settings };
  }

  /**
   * 每帧更新连续音源。传 dt（渲染帧时间）而不是物理步长。
   * 注意：这里只做参数平滑，不做节点创建，开销很低。
   */
  update(dt: number, car: Car, session: RaceSession): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const tel = car.telemetry;

    // ---- 引擎 ----
    // 转速 1200..8200 映射到 70..260 Hz（基频），音量随油门与挡位变化
    const rpm = Math.max(tel.rpm, 600);
    const base = 62 + (rpm / 8200) * 210;
    const load = Math.max(tel.throttle, tel.speed > 1 ? 0.25 : 0.12);
    if (this.engineOscA) {
      this.engineOscA.frequency.setTargetAtTime(base, now, 0.05);
    }
    if (this.engineOscB) {
      this.engineOscB.frequency.setTargetAtTime(base * 1.503, now, 0.05);
    }
    if (this.engineFilter) {
      // 转速越高，音色越亮
      this.engineFilter.frequency.setTargetAtTime(500 + (rpm / 8200) * 2400, now, 0.08);
    }
    if (this.engineGain) {
      const target = 0.028 + load * 0.075;
      this.engineGain.gain.setTargetAtTime(clamp01(target), now, 0.09);
    }

    // ---- 轮胎滑移 ----
    if (this.slipGain) {
      const slip = clamp01(tel.slipAmount);
      // 只有真的在滑（打滑或大侧滑角）才出声，避免低速也嘶嘶响
      const amount = slip > 0.25 ? (slip - 0.25) / 0.75 : 0;
      this.slipGain.gain.setTargetAtTime(clamp01(amount) * 0.16, now, 0.06);
    }
    if (this.slipFilter) {
      const pitch = 1300 + clamp01(Math.abs(tel.slipAngle) / 0.7) * 1500;
      this.slipFilter.frequency.setTargetAtTime(pitch, now, 0.1);
    }

    // ---- 风噪 / 滚动 ----
    const speed = tel.speed;
    const inAir = tel.airborne;
    if (this.windGain) {
      const target = inAir ? 0.0 : clamp01(speed / 42) * 0.075;
      this.windGain.gain.setTargetAtTime(target, now, 0.15);
    }
    if (this.windFilter) {
      this.windFilter.frequency.setTargetAtTime(300 + clamp01(speed / 42) * 900, now, 0.2);
    }

    // ---- 撞击检测：单位时间内速度骤降视为碰撞 ----
    this.crashCooldown = Math.max(0, this.crashCooldown - dt);
    const drop = this.lastSpeed - speed;
    if (this.crashCooldown <= 0 && drop > 3.2 && this.lastSpeed > 6) {
      const strength = clamp01(drop / 18);
      this.crash(strength);
      this.crashCooldown = 0.22;
    }
    this.lastSpeed = speed;
    void session;
  }

  /** 碰撞音：噪声爆音 + 低频闷响。 */
  private crash(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuffer) return;
    const now = ctx.currentTime;
    const dur = 0.16 + strength * 0.2;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 1.4 - strength * 0.5;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 260 + strength * 900;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.35 * strength + 0.05, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.sfxGain);
    src.start(now);
    src.stop(now + dur + 0.05);

    // 低频闷响
    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(120, now);
    thud.frequency.exponentialRampToValueAtTime(46, now + 0.18);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, now);
    tg.gain.exponentialRampToValueAtTime(0.28 * strength + 0.04, now + 0.01);
    tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
    thud.connect(tg);
    tg.connect(this.sfxGain);
    thud.start(now);
    thud.stop(now + 0.3);
  }

  /** 一次性提示音。 */
  cue(cue: AudioCue): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const tone = (
      freq: number,
      dur: number,
      type: OscillatorType,
      gain: number,
      delay = 0,
      slideTo?: number,
    ) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      const t0 = now + delay;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(this.sfxGain);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    };

    switch (cue) {
      case 'countdown':
        tone(660, 0.18, 'triangle', 0.22);
        break;
      case 'go':
        tone(880, 0.22, 'triangle', 0.26);
        tone(1320, 0.3, 'triangle', 0.16, 0.02);
        break;
      case 'checkpoint':
        tone(1180, 0.1, 'triangle', 0.12);
        break;
      case 'lap':
        tone(880, 0.12, 'triangle', 0.2);
        tone(1318, 0.22, 'triangle', 0.16, 0.1);
        break;
      case 'invalid':
        tone(300, 0.2, 'sawtooth', 0.16, 0, 180);
        tone(200, 0.3, 'sawtooth', 0.12, 0.14, 120);
        break;
      case 'finish':
        // 完赛小号角
        tone(523, 0.16, 'triangle', 0.22);
        tone(659, 0.16, 'triangle', 0.22, 0.14);
        tone(784, 0.16, 'triangle', 0.22, 0.28);
        tone(1046, 0.5, 'triangle', 0.26, 0.42);
        break;
      case 'reset':
        tone(420, 0.12, 'sine', 0.16, 0, 620);
        break;
      case 'crash':
        this.crash(0.5);
        break;
      case 'ui':
        tone(760, 0.06, 'triangle', 0.1);
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // 背景音乐：程序生成的循环进行
  // -------------------------------------------------------------------------

  /** 简易五声音阶 + 三个和弦的循环，风格轻快、不抢戏。 */
  private readonly chords: number[][] = [
    [261.63, 329.63, 392.0], // C
    [220.0, 261.63, 349.23], // Am
    [174.61, 220.0, 261.63], // F
    [196.0, 246.94, 392.0], // G
  ];
  private readonly arpScale = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];

  startMusic(): void {
    if (!this.ctx || this.ctx.state !== 'running' || this.musicPlaying) return;
    this.musicPlaying = true;
    this.nextNoteTime = this.ctx.currentTime + 0.08;
    this.step = 0;
    // 前瞻调度：每 120 ms 排一次，提前排未来 0.6 s 的音符
    this.musicTimer = window.setInterval(() => this.scheduleMusic(), 120);
  }

  stopMusic(): void {
    this.musicPlaying = false;
    if (this.musicTimer !== null) {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  private scheduleMusic(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicPlaying) return;
    const lookahead = 0.6;
    while (this.nextNoteTime < ctx.currentTime + lookahead) {
      this.playStep(this.nextNoteTime);
      // 160 BPM 的八分音符
      this.nextNoteTime += 60 / 160 / 2;
      this.step = (this.step + 1) % 32;
    }
  }

  private playStep(time: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const chordIndex = Math.floor(this.step / 8) % this.chords.length;
    const chord = this.chords[chordIndex];

    // 每小节一次柔和的和弦垫
    if (this.step % 8 === 0) {
      chord.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = freq * 0.5;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, time);
        g.gain.linearRampToValueAtTime(0.055 / (i + 1), time + 0.06);
        g.gain.exponentialRampToValueAtTime(0.0001, time + 1.2);
        osc.connect(g);
        g.connect(this.musicGain);
        osc.start(time);
        osc.stop(time + 1.35);
      });
    }

    // 琶音：在五声音阶里按步骤取音，制造轻快的律动
    const idx = (this.step * 3 + chordIndex * 2) % this.arpScale.length;
    const freq = this.arpScale[idx];
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.05, time + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.28);
    osc.connect(g);
    g.connect(this.musicGain);
    osc.start(time);
    osc.stop(time + 0.32);
  }

  dispose(): void {
    this.stopMusic();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
