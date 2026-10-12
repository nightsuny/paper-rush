"""把 Game 从"单条闭合赛道"改为"开放世界区域"。
- TrackBuilder/TrackView/RaceSession/Hud  →  RegionBuilder/RegionView/WorldSession/WorldHud
- 去掉圈数/结算流程，改为自由驾驶 + 暂停
- 保留音频、调试面板、追车相机、画质档位、HMR 清理
运行： python tools/s1-wire-game.py
"""
import io, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
p = os.path.join(ROOT, 'src', 'game', 'Game.ts')
s = io.open(p, encoding='utf-8').read()


def rep(old, new, n=1):
    global s
    assert old in s, '找不到片段:\n' + old[:160]
    s = s.replace(old, new, n)


# ---- imports ----
rep("""import { TrackBuilder, type BuiltTrack } from '../tracks/Track';
import { validateTrack, type ValidationReport } from '../tracks/validate';
import { MEADOW } from '../tracks/catalog/meadow';""",
    """import { RegionBuilder, type BuiltRegion } from '../world/Region';
import { REGION_SKELETON } from '../world/catalog/region1';
import { WorldSession } from '../world/WorldSession';
import { buildRegionView, type RegionView } from '../world/RegionView';
import type { NetworkProjection } from '../world/RoadNetwork';""")

rep("""import { buildTrackView, type TrackView } from '../scenery/TrackView';
import { paperMaterial, paperTexture } from '../scenery/PaperMaterials';
import { RaceSession } from '../race/RaceSession';
import { Input } from './Input';
import { ChaseCamera } from './ChaseCamera';
import { Hud } from '../ui/Hud';
import { Menu } from '../ui/Menu';
import { DebugPanel, type DebugStats } from '../ui/DebugPanel';
import { PauseOverlay, Results } from '../ui/Results';""",
    """import { Input } from './Input';
import { ChaseCamera } from './ChaseCamera';
import { WorldHud } from '../ui/WorldHud';
import { Menu, type MenuRegionInfo } from '../ui/Menu';
import { DebugPanel, type DebugStats } from '../ui/DebugPanel';
import { PauseOverlay } from '../ui/Results';""")

# ---- 状态类型 ----
rep("export type AppState = 'menu' | 'racing' | 'paused' | 'finished';",
    "export type AppState = 'menu' | 'driving' | 'paused';")

# ---- 字段 ----
rep("""  private readonly world: PhysicsWorld;
  private readonly track: BuiltTrack;
  private readonly validation: ValidationReport;
  private readonly derived: DerivedVehicle;
  private readonly car: Car;
  private readonly session: RaceSession;
  private readonly trackView: TrackView;""",
    """  private readonly world: PhysicsWorld;
  private readonly region: BuiltRegion;
  private readonly derived: DerivedVehicle;
  private readonly car: Car;
  private readonly session: WorldSession;
  private readonly regionView: RegionView;""")

rep("""  private readonly hud: Hud;
  private readonly menu: Menu;
  private readonly debug: DebugPanel;
  private readonly results: Results;
  private readonly pause: PauseOverlay;""",
    """  private readonly hud: WorldHud;
  private readonly menu: Menu;
  private readonly debug: DebugPanel;
  private readonly pause: PauseOverlay;""")

rep("""  private readonly sun: THREE.DirectionalLight;
  private readonly turntable: THREE.Mesh;
  private readonly turntableCollider: R.Collider;
  private carVisual: CarVisual;""",
    """  private readonly sun: THREE.DirectionalLight;
  private carVisual: CarVisual;
  private lastProjection: NetworkProjection;""")

# ---- 构造器参数与赋值 ----
rep("""    parts: {
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
    },""",
    """    parts: {
      world: PhysicsWorld;
      region: BuiltRegion;
      derived: DerivedVehicle;
      car: Car;
      session: WorldSession;
      regionView: RegionView;
      carVisual: CarVisual;
      sun: THREE.DirectionalLight;
      chase: ChaseCamera;
    },""")

rep("""    this.world = parts.world;
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
    this.chase = parts.chase;""",
    """    this.world = parts.world;
    this.region = parts.region;
    this.derived = parts.derived;
    this.car = parts.car;
    this.session = parts.session;
    this.regionView = parts.regionView;
    this.carVisual = parts.carVisual;
    this.sun = parts.sun;
    this.chase = parts.chase;
    this.lastProjection = this.region.network.project(parts.car.position.x, parts.car.position.z);""")

# ---- UI 构造：Hud/Results → WorldHud，去掉结算面板 ----
rep("""    this.hud = new Hud(this.track);
    this.debug = new DebugPanel();
    this.menu = new Menu(
      MEADOW,
      this.validation.stats,
      this.track.minimap.points,
      { quality: this.settings.quality, showDebug: this.settings.showDebug },
      this.audioSettings,""",
    """    this.hud = new WorldHud(this.region);
    this.debug = new DebugPanel();
    this.menu = new Menu(
      regionInfoOf(this.region),
      { quality: this.settings.quality, showDebug: this.settings.showDebug },
      this.audioSettings,""")

rep("""    this.results = new Results({
      onRestart: () => this.startRace(),
      onBackToMenu: () => this.showMenu(),
    });
    this.pause = new PauseOverlay({""",
    """    this.pause = new PauseOverlay({""")

rep("""    this.uiRoot.append(
      this.menu.root,
      this.hud.root,
      this.debug.root,
      this.results.root,
      this.pause.root,
    );""",
    """    this.uiRoot.append(
      this.menu.root,
      this.hud.root,
      this.debug.root,
      this.pause.root,
    );""")

# ---- 菜单回调：startRace → startDriving ----
s = s.replace("onStart: () => this.startRace(),", "onStart: () => this.startDriving(),")
s = s.replace("onRestart: () => this.startRace(),", "onRestart: () => this.startDriving(),")

# ---- 静态 create ----
rep("""    const derived = deriveVehicle(STOCK_KART);
    const world = new PhysicsWorld(-derived.gravity);
    const track = new TrackBuilder(MEADOW, world).built;
    const validation = validateTrack(MEADOW, track.centerline);
    const trackView = buildTrackView(track, MEADOW.theme, settings.quality);

    const theme = MEADOW.theme;""",
    """    const derived = deriveVehicle(STOCK_KART);
    const world = new PhysicsWorld(-derived.gravity);
    const region = new RegionBuilder(REGION_SKELETON, world).built;
    const regionView = buildRegionView(region, settings.quality);

    const theme = REGION_SKELETON.theme;""")

rep("""    const spawn = track.spawns[0];
    const car = new Car({
      spec: STOCK_KART,
      world,
      position: { x: spawn.x, y: spawn.y + 0.4, z: spawn.z },
      heading: spawn.heading,
    });""",
    """    const spawn = region.spawn;
    const car = new Car({
      spec: STOCK_KART,
      world,
      position: { x: spawn.x, y: spawn.y, z: spawn.z },
      heading: spawn.heading,
    });""")

# 去掉菜单转盘（开放世界里不再需要）——保留代码但在区域里不创建
old_turntable = s[s.index("    // 主菜单的旋转纸盘（有真实碰撞体，车辆会稳稳停在上面）"):s.index("    const session = new RaceSession({")]
s = s.replace(old_turntable, "")

rep("""    const session = new RaceSession({
      centerline: track.centerline,
      checkpoints: track.checkpoints,
      laps: MEADOW.laps,
      name: MEADOW.name,
      startT: MEADOW.startT,
    });
    session.addRacer('player', car);""",
    """    const session = new WorldSession({
      config: region.config,
      network: region.network,
      car,
      spawn,
    });""")

rep("""    const chase = new ChaseCamera(1);

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
    });""",
    """    const chase = new ChaseCamera(1);

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
    });""")

rep("""    game.scene.add(trackView.group);
    game.scene.add(turntable);""",
    """    game.scene.add(regionView.group);""")

# ---- 画质：同步区域视图的调试层 ----
rep("""  private applyQuality(): void {
    const preset = QUALITY_PRESETS[this.settings.quality];""",
    """  private applyQuality(): void {
    const preset = QUALITY_PRESETS[this.settings.quality];""")

# ---- 流程：showMenu / startRace → startDriving ----
rep("""  showMenu(): void {
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
  }""",
    """  showMenu(): void {
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
  }""")

rep("""  private resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'racing';""",
    """  private resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'driving';""")

rep("""  private pauseGame(): void {
    if (this.state !== 'racing') return;""",
    """  private pauseGame(): void {
    if (this.state !== 'driving') return;""")

# 删除 finishRace
old_finish = s[s.index("  private finishRace(): void {"):s.index("  private rebuildCarVisual(): void {")]
s = s.replace(old_finish, "")

# ---- tick：simulating/timing ----
rep("""    this.handleActions();
    // 除了暂停，所有状态都推进物理：菜单里车辆会自然落到旋转纸盘上
    const simulating = this.state !== 'paused';
    const timing = this.state === 'racing' || this.state === 'finished';
    let steps = 0;""",
    """    this.handleActions();
    // 除了暂停，所有状态都推进物理（菜单里车辆也自然落地）
    const simulating = this.state !== 'paused';
    let steps = 0;""")

s = s.replace("        this.stepPhysics(PHYSICS_DT, timing);", "        this.stepPhysics(PHYSICS_DT);")

# 事件循环 & HUD
old_events = s[s.index("    for (const ev of this.session.drainEvents()) {"):s.index("    this.updateSun();")]
s = s.replace(old_events, """    if (this.session.takeBoundaryHit()) {
      this.hud.showToast('此区域尚未开放', 'warn', 2.0);
      this.audio.cue('ui');
    }

    if (this.state === 'driving') {
      this.hud.update(frameSeconds, this.session, this.car);
    }

""")

rep("""  private stepPhysics(dt: number, timing: boolean): void {
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
    if (timing) this.session.update(dt);""",
    """  private stepPhysics(dt: number): void {
    const allowControl = this.state === 'driving';
    const keyboard = this.input.sample(dt, allowControl);
    const input = this.debugInput && allowControl ? this.debugInput : keyboard;
    this.car.step(dt, input);
    this.world.step();
    const p = this.car.position;
    this.lastProjection = this.region.network.project(p.x, p.z, p.y);
    if (allowControl) this.session.update(dt, this.lastProjection);""")

# ---- 动作：R 回出生点 ----
rep("""        case 'reset':
          if (this.state === 'racing') this.session.resetRacer('player');
          break;""",
    """        case 'reset':
          if (this.state === 'driving') {
            this.session.resetToSpawn();
            this.chase.snapTo(this.car);
            this.hud.showToast('已回到出生点', 'info', 1.4);
            this.audio.cue('reset');
          }
          break;""")

rep("""        case 'pause':
          if (this.state === 'racing') this.pauseGame();
          else if (this.state === 'paused') this.resume();
          else if (this.state === 'finished') this.showMenu();
          break;""",
    """        case 'pause':
          if (this.state === 'driving') this.pauseGame();
          else if (this.state === 'paused') this.resume();
          break;""")

rep("""        case 'debug':
          this.settings.showDebug = !this.settings.showDebug;
          this.debug.setVisible(this.settings.showDebug);
          this.menu.refresh();
          break;""",
    """        case 'debug':
          this.settings.showDebug = !this.settings.showDebug;
          this.debug.setVisible(this.settings.showDebug);
          this.regionView.setDebugVisible(this.settings.showDebug);
          this.menu.refresh();
          break;""")

rep("""        case 'restart':
          if (this.state !== 'racing') this.startRace();
          break;""",
    """        case 'restart':
          if (this.state === 'menu') this.startDriving();
          break;""")

# ---- 相机：菜单绕车旋转用区域出生点 ----
rep("""    this.trackView.update(frameSeconds, this.chase.camera.position);""",
    """    this.regionView.update(frameSeconds, this.chase.camera.position);""")

# ---- 对外接口 ----
rep("""  get raceSession(): RaceSession {
    return this.session;
  }

  get validationReport(): ValidationReport {
    return this.validation;
  }""",
    """  get worldSession(): WorldSession {
    return this.session;
  }""")

rep("""  get builtTrack(): BuiltTrack {
    return this.track;
  }""",
    """  get builtRegion(): BuiltRegion {
    return this.region;
  }""")

# snapshot
rep("""    const p = this.car.position;
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
    };""",
    """    const p = this.car.position;
    const proj = this.region.network.project(p.x, p.z, p.y);
    const tel = this.car.telemetry;
    const stats = this.session.current;
    return {
      state: this.state,
      speedKmh: tel.speed * 3.6,
      elapsed: stats.elapsed,
      distanceKm: stats.distance / 1000,
      segmentId: proj.segmentId,
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
    };""")

s = s.replace("""    state: AppState;
    speedKmh: number;
    lap: number;
    elapsed: number;""", """    state: AppState;
    speedKmh: number;
    elapsed: number;
    distanceKm: number;
    segmentId: string;""")

# ---- dispose ----
rep("""    this.trackView.dispose();""", """    this.regionView.dispose();""")

# ---- 顶部补一个区域信息构造函数 ----
s = s.replace("const TMP_QA = new THREE.Quaternion();",
    """/** 把区域数据折算成菜单要展示的信息。 */
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

const TMP_QA = new THREE.Quaternion();""")

io.open(p, 'w', encoding='utf-8').write(s)
print('game wired to open world')
