import * as THREE from 'three';
import { initPhysics, PhysicsWorld, PHYSICS_DT, RAPIER as R } from '../physics/PhysicsWorld';
import { surfaceById } from '../physics/CollisionGroups';
import { TrackBuilder, type BuiltTrack } from '../tracks/Track';
import { validateTrack, type ValidationReport } from '../tracks/validate';
import { MEADOW } from '../tracks/catalog/meadow';
import { Car } from '../vehicles/Car';
import { STOCK_KART } from '../vehicles/vehicleCatalog';
import { deriveVehicle, type DerivedVehicle } from '../vehicles/VehicleSpec';
import { buildCarVisual, DRIVERS, type CarVisual, type DriverSpecies } from '../vehicles/CarVisual';
import { buildTrackView, type TrackView } from '../scenery/TrackView';
import { paperMaterial, paperTexture } from '../scenery/PaperMaterials';
import { RaceSession } from '../race/RaceSession';
import { Input } from './Input';
import { ChaseCamera } from './ChaseCamera';
import { Hud } from '../ui/Hud';
import { Menu } from '../ui/Menu';
import { DebugPanel, type DebugStats } from '../ui/DebugPanel';
import { PauseOverlay, Results } from '../ui/Results';
import { AudioEngine, DEFAULT_AUDIO_SETTINGS, type AudioSettings } from '../audio/AudioEngine';

export type AppState = 'menu' | 'racing' | 'paused' | 'finished';

export interface QualitySettings {
  quality: 'high' | 'low';
  showDebug: boolean;
}

const QUALITY_PRESETS = {
  high: { pixelRatio: 2, shadows: true, shadowMapSize: 2048, shadowRadius: 2.5 },
  low: { pixelRatio: 0.8, shadows: false, shadowMapSize: 512, shadowRadius: 0 },
} as const;

/**
 * 游戏主循环与流程。
 *
 * 物理固定 60 Hz 步进，渲染帧率与物理解耦：
 *   累加真实帧时间 → 用固定步长消化 → 用剩余比例 alpha 对刚体位姿做插值渲染。
 * 因此 30fps 与 144fps 下车辆行为完全一致（相同输入 → 完全相同结果）。
 */
export class Game {
  private readonly canvas: HTMLCanvasElement;
  private readonly uiRoot: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly input: Input;
  private readonly clock = new THREE.Clock();
  private readonly carMeshRoot = new THREE.Group();

  private readonly world: PhysicsWorld;
  private readonly track: BuiltTrack;
  private readonly validation: ValidationReport;
  private readonly derived: DerivedVehicle;
  private readonly car: Car;
  private readonly session: RaceSession;
  private readonly trackView: TrackView;
  private readonly chase: ChaseCamera;
  private readonly sun: THREE.DirectionalLight;
  private readonly turntable: THREE.Mesh;
  private readonly turntableCollider: R.Collider;
  private carVisual: CarVisual;

  private readonly audio = new AudioEngine();
  private audioSettings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };
  private audioStarted = false;
  private readonly hud: Hud;
  private readonly menu: Menu;
  private readonly debug: DebugPanel;
  private readonly results: Results;
  private readonly pause: PauseOverlay;

  private settings: QualitySettings;
  private driver: DriverSpecies = 'bear';
  private state: AppState = 'menu';
  private accumulator = 0;
  private physicsStepsLastFrame = 0;
  private physicsMs = 0;
  private frameMs = 0;
  private fps = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private menuOrbit = 0;
  private lastCountdownLabel = '';
  private readonly wheelRollVisual = [0, 0, 0, 0];
  private debugInput: { throttle: number; brake: number; steer: number; handbrake: boolean } | null = null;
  private disposed = false;

  private constructor(
    canvas: HTMLCanvasElement,
    uiRoot: HTMLElement,
    settings: QualitySettings,
    parts: {
      world: PhysicsWorld;
      track: BuiltTrack;
      validation: ValidationReport;
      derived: DerivedVehicle;
      car: Car;
      session: RaceSession;
      trackView: TrackView;
      carVisual: CarVisual;
      sun: THREE.DirectionalLight;
      turntable: THREE.Mesh;
      turntableCollider: R.Collider;
      chase: ChaseCamera;
    },
  ) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;
    this.settings = settings;
    this.world = parts.world;
    this.track = parts.track;
    this.validation = parts.validation;
    this.derived = parts.derived;
    this.car = parts.car;
    this.session = parts.session;
    this.trackView = parts.trackView;
    this.carVisual = parts.carVisual;
    this.sun = parts.sun;
    this.turntable = parts.turntable;
    this.turntableCollider = parts.turntableCollider;
    this.chase = parts.chase;

    this.input = new Input(window);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(MEADOW.theme.skyBottom);
    this.applyQuality();

    this.scene.add(this.carMeshRoot);
    this.carMeshRoot.add(this.carVisual.root);

    this.hud = new Hud(this.track);
    this.debug = new DebugPanel();
    this.menu = new Menu(
      MEADOW,
      this.validation.stats,
      this.track.minimap.points,
      { quality: this.settings.quality, showDebug: this.settings.showDebug },
      this.audioSettings,
      {
        onStart: () => this.startRace(),
        onRestart: () => this.startRace(),
        onBackToMenu: () => this.showMenu(),
        onSettingsChange: (s) => {
          this.settings = { ...s };
          this.debug.setVisible(s.showDebug);
          this.applyQuality();
        },
        onDriverChange: (species) => {
          this.driver = species;
          this.rebuildCarVisual();
        },
        onAudioChange: (a) => {
          this.audioSettings = { ...a };
          this.audio.setSettings(a);
        },
      },
    );
    this.results = new Results({
      onRestart: () => this.startRace(),
      onBackToMenu: () => this.showMenu(),
    });
    this.pause = new PauseOverlay({
      onResume: () => this.resume(),
      onRestart: () => this.startRace(),
      onBackToMenu: () => this.showMenu(),
    });

    this.uiRoot.append(
      this.menu.root,
      this.hud.root,
      this.debug.root,
      this.results.root,
      this.pause.root,
    );
    this.hud.root.classList.add('hidden');
    this.debug.setVisible(this.settings.showDebug);

    // 任意用户手势都尝试启动音频（只需成功一次）
    const kick = () => this.ensureAudio();
    window.addEventListener('pointerdown', kick, { once: false });
    window.addEventListener('keydown', kick, { once: false });

    window.addEventListener('resize', this.onResize);
    this.onResize();
    this.showMenu();
    this.renderer.setAnimationLoop(this.tick);
  }

  /** 初始化物理、赛道、车辆与界面，返回可用的 Game。 */
  static async create(
    canvas: HTMLCanvasElement,
    uiRoot: HTMLElement,
    settings: QualitySettings = { quality: 'high', showDebug: false },
  ): Promise<Game> {
    await initPhysics();

    const derived = deriveVehicle(STOCK_KART);
    const world = new PhysicsWorld(-derived.gravity);
    const track = new TrackBuilder(MEADOW, world).built;
    const validation = validateTrack(MEADOW, track.centerline);
    const trackView = buildTrackView(track, MEADOW.theme, settings.quality);

    const theme = MEADOW.theme;
    const hemi = new THREE.HemisphereLight(theme.ambient, theme.grass, theme.ambientIntensity);
    const sun = new THREE.DirectionalLight(theme.sun, theme.sunIntensity);
    sun.castShadow = QUALITY_PRESETS[settings.quality].shadows;
    sun.shadow.mapSize.set(
      QUALITY_PRESETS[settings.quality].shadowMapSize,
      QUALITY_PRESETS[settings.quality].shadowMapSize,
    );
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 260;
    const half = 44;
    sun.shadow.camera.left = -half;
    sun.shadow.camera.right = half;
    sun.shadow.camera.top = half;
    sun.shadow.camera.bottom = -half;
    sun.shadow.bias = -0.0007;
    sun.shadow.normalBias = 0.04;
    sun.shadow.radius = QUALITY_PRESETS[settings.quality].shadowRadius;

    const spawn = track.spawns[0];
    const car = new Car({
      spec: STOCK_KART,
      world,
      position: { x: spawn.x, y: spawn.y + 0.4, z: spawn.z },
      heading: spawn.heading,
    });

    // 主菜单的旋转纸盘（有真实碰撞体，车辆会稳稳停在上面）
    const discRadius = 3.4;
    const discGeo = new THREE.CylinderGeometry(discRadius, discRadius, 0.14, 28);
    const discMat = paperMaterial(0xffffff, {
      map: paperTexture({
        color: 0xe8c982,
        seed: 4242,
        size: 512,
        fiber: 0.4,
        blotch: 0.6,
        creases: 2,
        grid: 1,
        edgeShade: 0.3,
        key: 'turntable',
      }),
    });
    const turntable = new THREE.Mesh(discGeo, discMat);
    turntable.position.set(spawn.x, spawn.y - 0.02, spawn.z);
    turntable.receiveShadow = true;
    const discBody = world.createStaticBody(spawn.x, spawn.y - 0.09, spawn.z);
    const turntableCollider = world.addStaticCollider(
      discBody,
      R.ColliderDesc.cylinder(0.07, discRadius).setFriction(0.9),
      surfaceById('cardboard'),
    );

    const session = new RaceSession({
      centerline: track.centerline,
      checkpoints: track.checkpoints,
      laps: MEADOW.laps,
    });
    session.addRacer('player', car);

    const carVisual = buildCarVisual(STOCK_KART, {
      species: 'bear',
      bodyColor: 0xe8a92b,
      accentColor: 0xcf5b4a,
      number: 7,
      seed: 913,
      quality: settings.quality,
    });

    const chase = new ChaseCamera(1);

    const game = new Game(canvas, uiRoot, settings, {
      world,
      track,
      validation,
      derived,
      car,
      session,
      trackView,
      carVisual,
      sun,
      turntable,
      turntableCollider,
      chase,
    });

    // 场景装配放到构造之后，保证 UI 与光照都已就绪
    game.scene.add(hemi);
    game.scene.add(sun);
    game.scene.add(sun.target);
    game.scene.add(trackView.group);
    game.scene.add(turntable);
    game.scene.fog = new THREE.Fog(theme.fog, theme.fogNear, theme.fogFar);

    return game;
  }

  private applyQuality(): void {
    const preset = QUALITY_PRESETS[this.settings.quality];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatio));
    this.renderer.shadowMap.enabled = preset.shadows;
    if (this.sun) {
      this.sun.castShadow = preset.shadows;
      this.sun.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
      this.sun.shadow.radius = preset.shadowRadius;
      (this.sun.shadow.camera as THREE.OrthographicCamera).updateProjectionMatrix();
    }
  }

  private onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.chase.setAspect(w / Math.max(h, 1));
  };

  // -------------------------------------------------------------------------
  // 流程控制
  // -------------------------------------------------------------------------

  showMenu(): void {
    this.state = 'menu';
    this.menu.setVisible(true);
    this.hud.root.classList.add('hidden');
    this.results.setVisible(false);
    this.pause.setVisible(false);
    this.turntable.visible = true;
    this.turntableCollider.setEnabled(true);
    const spawn = this.track.spawns[0];
    this.car.teleportTo({ x: spawn.x, y: spawn.y + 0.06, z: spawn.z }, spawn.heading);
    this.menuOrbit = 0;
  }

  /** 浏览器要求音频由用户手势启动，所以在第一次点按/按键时尝试恢复。 */
  private ensureAudio(): void {
    if (this.audioStarted) return;
    this.audioStarted = true;
    void this.audio.resume().then((ok) => {
      if (!ok) {
        this.audioStarted = false;
        return;
      }
      this.audio.setSettings(this.audioSettings);
      this.audio.startMusic();
    });
  }

  startRace(): void {
    this.ensureAudio();
    this.audio.cue('ui');
    this.menu.setVisible(false);
    this.results.setVisible(false);
    this.pause.setVisible(false);
    this.hud.root.classList.remove('hidden');
    this.turntable.visible = false;
    this.turntableCollider.setEnabled(false);
    this.session.restart();
    this.session.goToCountdown();
    const spawn = this.track.spawns[0];
    this.car.teleportTo({ x: spawn.x, y: spawn.y + 0.3, z: spawn.z }, spawn.heading);
    this.chase.snapTo(this.car);
    this.accumulator = 0;
    this.state = 'racing';
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'racing';
    this.pause.setVisible(false);
    this.accumulator = 0;
  }

  private pauseGame(): void {
    if (this.state !== 'racing') return;
    this.state = 'paused';
    this.pause.setVisible(true);
  }

  private finishRace(): void {
    if (this.state === 'finished') return;
    this.state = 'finished';
    this.results.show(
      this.session,
      this.session.resultOf('player'),
      this.session.racers[0].bestLap,
      DRIVERS[this.driver].name,
      '阶段一暂不发放彩纸币（奖励与配件系统属于阶段三）',
    );
    this.results.setVisible(true);
  }

  private rebuildCarVisual(): void {
    this.carMeshRoot.remove(this.carVisual.root);
    this.carVisual.dispose();
    this.carVisual = buildCarVisual(STOCK_KART, {
      species: this.driver,
      bodyColor: 0xe8a92b,
      accentColor: 0xcf5b4a,
      number: 7,
      seed: 913,
      quality: this.settings.quality,
    });
    this.carMeshRoot.add(this.carVisual.root);
  }

  // -------------------------------------------------------------------------
  // 主循环
  // -------------------------------------------------------------------------

  private tick = (): void => {
    if (this.disposed) return;
    const frameSeconds = Math.min(this.clock.getDelta(), 0.25);
    this.frameMs = frameSeconds * 1000;
    this.fpsAccum += frameSeconds;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    this.handleActions();
    // 除了暂停，所有状态都推进物理：菜单里车辆会自然落到旋转纸盘上
    const simulating = this.state !== 'paused';
    const timing = this.state === 'racing' || this.state === 'finished';
    let steps = 0;

    if (simulating) {
      this.accumulator += frameSeconds;
      const maxSteps = 6;
      const t0 = performance.now();
      while (this.accumulator >= PHYSICS_DT && steps < maxSteps) {
        this.stepPhysics(PHYSICS_DT, timing);
        this.accumulator -= PHYSICS_DT;
        steps++;
      }
      if (this.accumulator > PHYSICS_DT * maxSteps) this.accumulator = 0;
      this.physicsMs = performance.now() - t0;
    } else {
      this.physicsMs = 0;
    }
    this.physicsStepsLastFrame = steps;

    const alpha = simulating ? Math.min(this.accumulator / PHYSICS_DT, 1) : 1;
    this.syncCarVisual(alpha);
    this.updateCamera(frameSeconds);
    this.trackView.update(frameSeconds, this.chase.camera.position);

    for (const ev of this.session.drainEvents()) {
      if (ev.type === 'invalid-lap') {
        this.hud.showToast(ev.message ?? '本圈无效', 'bad', 3.2);
        this.audio.cue('invalid');
      } else if (ev.type === 'wrong-way') {
        this.hud.showToast('行驶方向反了', 'warn', 2.5);
      } else if (ev.type === 'illegal-progress') {
        this.hud.showToast(ev.message ?? '检测到异常移动', 'warn', 2.5);
      } else if (ev.type === 'checkpoint') {
        this.audio.cue('checkpoint');
      } else if (ev.type === 'lap') {
        this.hud.showToast(`第 ${this.session.racers[0].lapTimes.length} 圈完成`, 'info', 1.5);
        this.audio.cue('lap');
      } else if (ev.type === 'finish') {
        this.audio.cue('finish');
        this.finishRace();
      } else if (ev.type === 'reset') {
        this.hud.showToast('已回到最近检查点', 'info', 1.4);
        this.audio.cue('reset');
      } else if (ev.type === 'go') {
        this.audio.cue('go');
      }
    }

    const racer = this.session.racers[0];
    if (this.state === 'racing' || this.state === 'finished') {
      this.hud.update(frameSeconds, this.session, racer, DRIVERS[this.driver].name);
    }
    // 倒计时整秒提示音
    if (this.state === 'racing' && this.session.phase === 'countdown') {
      const label = this.session.countdownLabel;
      if (label !== this.lastCountdownLabel) {
        this.lastCountdownLabel = label;
        if (label !== '' && label !== 'GO!') this.audio.cue('countdown');
      }
    } else {
      this.lastCountdownLabel = '';
    }

    this.updateSun();
    if (this.audioStarted) this.audio.update(frameSeconds, this.car, this.session);

    if (this.debug.visible) {
      const info = this.renderer.info;
      const stats: DebugStats = {
        fps: this.fps,
        frameMs: this.frameMs,
        physicsStepsPerFrame: this.physicsStepsLastFrame,
        physicsMs: this.physicsMs,
        triangles: info.render.triangles,
        drawCalls: info.render.calls,
        bodies: 0,
        colliders: 0,
      };
      this.debug.update(frameSeconds, this.car, this.derived, stats, this.world);
    }

    this.renderer.render(this.scene, this.chase.camera);
  };

  /**
   * 一个固定物理步。
   * @param timing 是否推进比赛计时与计圈（菜单里只跑物理，不计时）
   */
  private stepPhysics(dt: number, timing: boolean): void {
    const allowControl = this.state === 'racing' && !this.session.racers[0].finished;
    const keyboard = this.input.sample(dt, allowControl && this.session.phase === 'racing');
    const input = this.debugInput && allowControl ? this.debugInput : keyboard;
    // 倒计时（以及暂停恢复后的第一帧）自动拉住手刹：
    // 发车位通常在坡上，不给油又不拉手刹会自己溜下去（表现为"开局自动倒退"）。
    // 用手刹而不是刹车键，因为刹车键在低速时会被判定为倒挡输入。
    if (this.session.phase === 'countdown') {
      input.handbrake = true;
      input.brake = 0;
      input.throttle = 0;
    }
    this.car.step(dt, input);
    this.world.step();
    if (timing) this.session.update(dt);

    // 车轮视觉转角取物理真实值（Rapier 累计的车轮旋转；车轴指向 -X 故取负）
    for (let i = 0; i < 4; i++) {
      const rot = this.car.vehicle.wheelRotation(i);
      if (rot !== null) this.wheelRollVisual[i] = -rot;
    }
  }

  private syncCarVisual(alpha: number): void {
    const t = this.car.tracked;
    const px = t.prev.px + (t.curr.px - t.prev.px) * alpha;
    const py = t.prev.py + (t.curr.py - t.prev.py) * alpha;
    const pz = t.prev.pz + (t.curr.pz - t.prev.pz) * alpha;
    const qPrev = TMP_QA.set(t.prev.qx, t.prev.qy, t.prev.qz, t.prev.qw);
    const qCurr = TMP_QB.set(t.curr.qx, t.curr.qy, t.curr.qz, t.curr.qw);
    const q = qPrev.slerp(qCurr, alpha);
    this.carMeshRoot.position.set(px, py, pz);
    this.carMeshRoot.quaternion.copy(q);
    this.carVisual.update(1 / 60, this.car, this.wheelRollVisual);
  }

  private updateCamera(dt: number): void {
    const cam = this.chase.camera;
    if (this.state === 'menu') {
      this.menuOrbit += dt * 0.22;
      // 展示用旋转纸盘（视觉旋转，转轴与车身分离，避免把车蹭跑）
      this.turntable.rotation.y += dt * 0.34;
      const p = this.car.position;
      const r = 9.5;
      cam.position.set(
        p.x + Math.cos(this.menuOrbit) * r,
        p.y + 3.5 + Math.sin(this.menuOrbit * 0.7) * 0.7,
        p.z + Math.sin(this.menuOrbit) * r,
      );
      cam.lookAt(p.x, p.y + 0.9, p.z);
      if (cam.fov !== 46) {
        cam.fov = 46;
        cam.updateProjectionMatrix();
      }
      return;
    }
    this.chase.update(dt, this.car);
  }

  private updateSun(): void {
    const p = this.car.position;
    this.sun.position.set(p.x + 62, p.y + 98, p.z + 44);
    this.sun.target.position.set(p.x, p.y, p.z);
    this.sun.target.updateMatrixWorld();
  }

  private handleActions(): void {
    for (const action of this.input.takeActions()) {
      switch (action) {
        case 'pause':
          if (this.state === 'racing') this.pauseGame();
          else if (this.state === 'paused') this.resume();
          else if (this.state === 'finished') this.showMenu();
          break;
        case 'reset':
          if (this.state === 'racing') this.session.resetRacer('player');
          break;
        case 'debug':
          this.settings.showDebug = !this.settings.showDebug;
          this.debug.setVisible(this.settings.showDebug);
          this.menu.refresh();
          break;
        case 'camera':
          this.chase.cycleMode();
          break;
        case 'mute': {
          this.audioSettings = { ...this.audioSettings, muted: !this.audioSettings.muted };
          this.audio.setSettings(this.audioSettings);
          this.menu.setAudioSettings(this.audioSettings);
          this.hud.showToast(this.audioSettings.muted ? '已静音（M 恢复）' : '已恢复声音', 'info', 1.4);
          break;
        }
        case 'restart':
          if (this.state !== 'racing') this.startRace();
          break;
        default:
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 给外部（自动化验证 / 控制台诊断）读取的接口
  // -------------------------------------------------------------------------

  get appState(): AppState {
    return this.state;
  }

  get raceSession(): RaceSession {
    return this.session;
  }

  get validationReport(): ValidationReport {
    return this.validation;
  }

  get playerCar(): Car {
    return this.car;
  }

  get builtTrack(): BuiltTrack {
    return this.track;
  }

  get physicsWorld(): PhysicsWorld {
    return this.world;
  }

  /**
   * 供自动化验证使用的驾驶接口：直接注入车辆输入。
   * 仅用于测试/诊断脚本，正常游玩走 Input 的键盘路径。
   */
  setDebugInput(input: { throttle: number; brake: number; steer: number; handbrake: boolean } | null): void {
    this.debugInput = input;
  }

  /** 直接请求换挡/倒挡等状态（用于自动化脚本）。 */
  get hudElement(): Hud {
    return this.hud;
  }

  snapshot(): {
    state: AppState;
    speedKmh: number;
    lap: number;
    elapsed: number;
    wheelContacts: number;
    surface: string;
    physicsSteps: number;
    fps: number;
    position: { x: number; y: number; z: number };
    onTrack: boolean;
    lateral: number;
    rpm: number;
    gear: number;
    cameraMode: string;
  } {
    const p = this.car.position;
    const proj = this.track.centerline.project(p.x, p.z, p.y);
    const tel = this.car.telemetry;
    return {
      state: this.state,
      speedKmh: tel.speed * 3.6,
      lap: this.session.racers[0]?.lap ?? 1,
      elapsed: this.session.elapsed,
      wheelContacts: tel.wheelContacts,
      surface: tel.surface?.id ?? '—',
      physicsSteps: this.physicsStepsLastFrame,
      fps: this.fps,
      position: { x: p.x, y: p.y, z: p.z },
      onTrack: proj.distance <= proj.halfWidth,
      lateral: proj.lateral,
      rpm: tel.rpm,
      gear: tel.gear,
      cameraMode: this.chase.modeName,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.trackView.dispose();
    this.carVisual.dispose();
    this.world.dispose();
    this.renderer.dispose();
    this.canvas.remove();
    this.uiRoot.replaceChildren();
  }
}

const TMP_QA = new THREE.Quaternion();
const TMP_QB = new THREE.Quaternion();
