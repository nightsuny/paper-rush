import * as THREE from 'three';
import { initPhysics, PhysicsWorld, PHYSICS_DT } from '../physics/PhysicsWorld';
import { RegionBuilder, type BuiltRegion } from '../world/Region';
import { REGION_QINGYE } from "../world/catalog/region1";
import { WorldSession } from '../world/WorldSession';
import { buildRegionView, type RegionView } from '../world/RegionView';
import type { NetworkProjection } from '../world/RoadNetwork';
import { Car } from '../vehicles/Car';
import { STOCK_KART } from '../vehicles/vehicleCatalog';
import { deriveVehicle, type DerivedVehicle } from '../vehicles/VehicleSpec';
import { buildCarVisual, type CarVisual, type DriverSpecies } from '../vehicles/CarVisual';
import { Input } from './Input';
import { ChaseCamera } from './ChaseCamera';
import { WorldHud } from '../ui/WorldHud';
import { Menu, type MenuRegionInfo } from '../ui/Menu';
import { DebugPanel, type DebugStats } from '../ui/DebugPanel';
import { PauseOverlay } from '../ui/Results';
import { AudioEngine, DEFAULT_AUDIO_SETTINGS, type AudioSettings } from '../audio/AudioEngine';

export type AppState = 'menu' | 'driving' | 'paused';

export interface QualitySettings {
  quality: 'high' | 'low';
  showDebug: boolean;
}

const QUALITY_PRESETS = {
  high: { pixelRatio: 2, shadows: true, shadowMapSize: 2048, shadowRadius: 2.5 },
  low: { pixelRatio: 0.8, shadows: false, shadowMapSize: 512, shadowRadius: 0 },
} as const;

/**
 * 游戏主循环与流程（开放世界版）。
 *
 * 物理固定 60 Hz 步进，渲染帧率与物理解耦：累加真实帧时间 → 用固定步长消化 →
 * 用剩余比例 alpha 对刚体位姿做插值渲染。因此 30fps 与 200fps 下车辆行为完全一致。
 */
export class Game {
  private readonly canvas: HTMLCanvasElement;
  private readonly uiRoot: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly input: Input;
  private readonly clock = new THREE.Clock();
  private readonly carMeshRoot = new THREE.Group();
  private readonly audio = new AudioEngine();
  private audioSettings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };
  private audioStarted = false;

  private readonly world: PhysicsWorld;
  private readonly region: BuiltRegion;
  private readonly derived: DerivedVehicle;
  private readonly car: Car;
  private readonly session: WorldSession;
  private readonly regionView: RegionView;
  private readonly sun: THREE.DirectionalLight;
  private readonly chase: ChaseCamera;
  private carVisual: CarVisual;

  private readonly hud: WorldHud;
  private readonly menu: Menu;
  private readonly debug: DebugPanel;
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
  private readonly wheelRollVisual = [0, 0, 0, 0];
  private debugInput: { throttle: number; brake: number; steer: number; handbrake: boolean } | null = null;
  private lastProjection: NetworkProjection;
  private disposed = false;

  private constructor(
    canvas: HTMLCanvasElement,
    uiRoot: HTMLElement,
    settings: QualitySettings,
    parts: {
      world: PhysicsWorld;
      region: BuiltRegion;
      derived: DerivedVehicle;
      car: Car;
      session: WorldSession;
      regionView: RegionView;
      carVisual: CarVisual;
      sun: THREE.DirectionalLight;
      chase: ChaseCamera;
    },
  ) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;
    this.settings = settings;
    this.world = parts.world;
    this.region = parts.region;
    this.derived = parts.derived;
    this.car = parts.car;
    this.session = parts.session;
    this.regionView = parts.regionView;
    this.carVisual = parts.carVisual;
    this.sun = parts.sun;
    this.chase = parts.chase;
    this.lastProjection = this.region.network.project(
      parts.car.position.x,
      parts.car.position.z,
      parts.car.position.y,
    );

    this.input = new Input(window);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // 高光滚降：纸艺是浅色调，没有色调映射时亮部会直接顶到纯白、显得很"平"。
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(REGION_QINGYE.theme.skyBottom);
    this.applyQuality();

    this.scene.add(this.carMeshRoot);
    this.carMeshRoot.add(this.carVisual.root);

    this.hud = new WorldHud(this.region);
    this.debug = new DebugPanel();
    this.menu = new Menu(
      regionInfoOf(this.region),
      { quality: this.settings.quality, showDebug: this.settings.showDebug },
      this.audioSettings,
      {
        onStart: () => this.startDriving(),
        onRestart: () => this.startDriving(),
        onBackToMenu: () => this.showMenu(),
        onSettingsChange: (s) => {
          this.settings = { ...s };
          this.debug.setVisible(s.showDebug);
          this.regionView.setDebugVisible(s.showDebug);
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
    this.pause = new PauseOverlay({
      onResume: () => this.resume(),
      onRestart: () => this.startDriving(),
      onBackToMenu: () => this.showMenu(),
    });

    this.uiRoot.append(this.menu.root, this.hud.root, this.debug.root, this.pause.root);
    this.hud.root.classList.add('hidden');
    this.debug.setVisible(this.settings.showDebug);
    this.regionView.setDebugVisible(this.settings.showDebug);

    // 首次用户手势启动音频
    const kick = (): void => this.ensureAudio();
    window.addEventListener('pointerdown', kick);
    window.addEventListener('keydown', kick);
    window.addEventListener('resize', this.onResize);
    this.onResize();
    this.showMenu();
    this.renderer.setAnimationLoop(this.tick);
  }

  static async create(
    canvas: HTMLCanvasElement,
    uiRoot: HTMLElement,
    settings: QualitySettings = { quality: 'high', showDebug: false },
  ): Promise<Game> {
    await initPhysics();

    const derived = deriveVehicle(STOCK_KART);
    const world = new PhysicsWorld(-derived.gravity);
    const region = new RegionBuilder(REGION_QINGYE, world).built;
    const regionView = buildRegionView(region, settings.quality);

    const theme = REGION_QINGYE.theme;
    const hemi = new THREE.HemisphereLight(theme.ambient, theme.grass, theme.ambientIntensity);
    const sun = new THREE.DirectionalLight(theme.sun, theme.sunIntensity);
    sun.castShadow = QUALITY_PRESETS[settings.quality].shadows;
    sun.shadow.mapSize.set(
      QUALITY_PRESETS[settings.quality].shadowMapSize,
      QUALITY_PRESETS[settings.quality].shadowMapSize,
    );
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 320;
    const half = 48;
    sun.shadow.camera.left = -half;
    sun.shadow.camera.right = half;
    sun.shadow.camera.top = half;
    sun.shadow.camera.bottom = -half;
    sun.shadow.bias = -0.0007;
    sun.shadow.normalBias = 0.04;
    sun.shadow.radius = QUALITY_PRESETS[settings.quality].shadowRadius;

    const spawn = region.spawn;
    const car = new Car({
      spec: STOCK_KART,
      world,
      position: { x: spawn.x, y: spawn.y, z: spawn.z },
      heading: spawn.heading,
    });

    const session = new WorldSession({
      config: region.config,
      network: region.network,
      car,
      spawn,
    });

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
      region,
      derived,
      car,
      session,
      regionView,
      carVisual,
      sun,
      chase,
    });

    game.scene.add(hemi);
    game.scene.add(sun);
    game.scene.add(sun.target);
    game.scene.add(regionView.group);
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
  // 流程
  // -------------------------------------------------------------------------

  showMenu(): void {
    this.state = 'menu';
    this.menu.setVisible(true);
    this.hud.root.classList.add('hidden');
    this.pause.setVisible(false);
    const spawn = this.region.spawn;
    this.car.teleportTo({ x: spawn.x, y: spawn.y, z: spawn.z }, spawn.heading);
    this.menuOrbit = 0;
  }

  /** 进入自由驾驶。 */
  startDriving(): void {
    this.ensureAudio();
    this.audio.cue('ui');
    this.menu.setVisible(false);
    this.pause.setVisible(false);
    this.hud.root.classList.remove('hidden');
    this.session.resetToSpawn();
    this.chase.snapTo(this.car);
    this.accumulator = 0;
    this.state = 'driving';
    this.hud.showToast('自由驾驶：沿路网探索；边界空气墙之外尚未开放', 'info', 3.4);
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'driving';
    this.pause.setVisible(false);
    this.accumulator = 0;
  }

  private pauseGame(): void {
    if (this.state !== 'driving') return;
    this.state = 'paused';
    this.pause.setVisible(true);
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
    const simulating = this.state !== 'paused';
    let steps = 0;

    if (simulating) {
      this.accumulator += frameSeconds;
      const maxSteps = 6;
      const t0 = performance.now();
      while (this.accumulator >= PHYSICS_DT && steps < maxSteps) {
        this.stepPhysics(PHYSICS_DT);
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
    this.regionView.update(frameSeconds, this.chase.camera.position);

    if (this.session.takeBoundaryHit()) {
      this.hud.showToast('此区域尚未开放', 'warn', 2.0);
      this.audio.cue('ui');
    }
    if (this.state === 'driving') {
      this.hud.update(frameSeconds, this.session, this.car);
    }

    this.updateSun();

    if (this.audioStarted) this.audio.update(frameSeconds, this.car, null);

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

  /** 一个固定物理步。 */
  private stepPhysics(dt: number): void {
    const allowControl = this.state === 'driving';
    const keyboard = this.input.sample(dt, allowControl);
    const input = this.debugInput && allowControl ? this.debugInput : keyboard;
    // 菜单里车停在路上：不拉手刹会在坡道上自己溜走
    if (this.state === 'menu') {
      input.handbrake = true;
      input.brake = 0;
      input.throttle = 0;
    }
    this.car.step(dt, input);
    this.world.step();

    const p = this.car.position;
    this.lastProjection = this.region.network.project(p.x, p.z, p.y);
    if (allowControl) this.session.update(dt, this.lastProjection);

    // 车轮视觉转角取物理真实值（车轴指向 -X 故取负）
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
      // 菜单：绕车缓慢旋转展示
      this.menuOrbit += dt * 0.22;
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
          if (this.state === 'driving') this.pauseGame();
          else if (this.state === 'paused') this.resume();
          break;
        case 'reset':
          if (this.state === 'driving') {
            this.session.resetToSpawn();
            this.chase.snapTo(this.car);
            this.hud.showToast('已回到出生点', 'info', 1.4);
            this.audio.cue('reset');
          }
          break;
        case 'debug':
          this.settings.showDebug = !this.settings.showDebug;
          this.debug.setVisible(this.settings.showDebug);
          this.regionView.setDebugVisible(this.settings.showDebug);
          this.menu.refresh();
          break;
        case 'camera':
          this.chase.cycleMode();
          break;
        case 'mute': {
          this.audioSettings = { ...this.audioSettings, muted: !this.audioSettings.muted };
          this.audio.setSettings(this.audioSettings);
          this.menu.setAudioSettings(this.audioSettings);
          this.hud.showToast(
            this.audioSettings.muted ? '已静音（M 恢复）' : '已恢复声音',
            'info',
            1.4,
          );
          break;
        }
        case 'restart':
          if (this.state === 'menu') this.startDriving();
          break;
        default:
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 对外接口（自动化验证 / 控制台诊断）
  // -------------------------------------------------------------------------

  get appState(): AppState {
    return this.state;
  }

  get worldSession(): WorldSession {
    return this.session;
  }

  get builtRegion(): BuiltRegion {
    return this.region;
  }

  get physicsWorld(): PhysicsWorld {
    return this.world;
  }

  get playerCar(): Car {
    return this.car;
  }

  /** 仅用于测试/诊断脚本：直接注入车辆输入。 */
  setDebugInput(
    input: { throttle: number; brake: number; steer: number; handbrake: boolean } | null,
  ): void {
    this.debugInput = input;
  }

  snapshot(): {
    state: AppState;
    speedKmh: number;
    elapsed: number;
    distanceKm: number;
    segmentId: string;
    onRoad: boolean;
    lateral: number;
    wheelContacts: number;
    surface: string;
    physicsSteps: number;
    fps: number;
    position: { x: number; y: number; z: number };
    rpm: number;
    gear: number;
    cameraMode: string;
    distanceToBoundary: number;
    boundaryHits: number;
  } {
    const p = this.car.position;
    const proj = this.lastProjection;
    const tel = this.car.telemetry;
    const stats = this.session.current;
    return {
      state: this.state,
      speedKmh: tel.speed * 3.6,
      elapsed: stats.elapsed,
      distanceKm: stats.distance / 1000,
      segmentId: proj.segmentId,
      onRoad: proj.distance <= proj.halfWidth,
      lateral: proj.lateral,
      wheelContacts: tel.wheelContacts,
      surface: tel.surface?.id ?? '—',
      physicsSteps: this.physicsStepsLastFrame,
      fps: this.fps,
      position: { x: p.x, y: p.y, z: p.z },
      rpm: tel.rpm,
      gear: tel.gear,
      cameraMode: this.chase.modeName,
      distanceToBoundary: stats.distanceToBoundary,
      boundaryHits: stats.boundaryHits,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.audio.dispose();
    this.regionView.dispose();
    this.carVisual.dispose();
    this.world.dispose();
    this.renderer.dispose();
    this.canvas.remove();
    this.uiRoot.replaceChildren();
  }
}

/** 把区域数据折算成菜单要展示的信息。 */
function regionInfoOf(region: BuiltRegion): MenuRegionInfo {
  return {
    chapter: 1,
    name: region.config.name,
    subtitle: region.config.subtitle,
    difficulty: 1,
    roadLengthMeters: region.stats.totalRoadLength,
    segmentCount: region.stats.segmentCount,
    gateCount: region.config.gates.length,
    junctionCount: region.config.junctions.length,
    minimapPolylines: region.minimap.polylines,
    minimapBounds: region.minimap.bounds,
  };
}

const TMP_QA = new THREE.Quaternion();
const TMP_QB = new THREE.Quaternion();
