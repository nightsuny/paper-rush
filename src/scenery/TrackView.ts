import * as THREE from 'three';
import type { BuiltTrack } from '../tracks/Track';
import type { Centerline } from '../tracks/Centerline';
import { ribbonToGeometry } from '../tracks/RoadGeometry';
import { terrainToGeometry } from '../tracks/Terrain';
import type { DecorationKind, TrackConfig, TrackTheme } from '../tracks/types';
import {
  cardboardTexture,
  checkerTexture,
  kerbTexture,
  makeSignTexture,
  outlineMaterial,
  paperMaterial,
  paperTexture,
  roadTexture,
  skyTexture,
} from './PaperMaterials';
import {
  buildBarn,
  buildCardboardHills,
  buildChevronSign,
  buildCloud,
  buildCrate,
  buildFenceRun,
  buildFlower,
  buildHaystack,
  buildHouse,
  buildPond,
  buildSceneryAssets,
  buildTree,
  buildWindmill,
  type SceneryAssets,
} from './Scenery';
import { createRng, range } from '../game/random';

export interface TrackView {
  group: THREE.Group;
  /** 需要每帧更新的对象（风车叶片旋转等） */
  update: (elapsed: number, cameraPosition: THREE.Vector3) => void;
  dispose: () => void;
}

/** 地图特色装饰区：在赛道外围成片摆放，决定这张地图的性格。 */
const FEATURE_ZONES: Array<{ from: number; to: number; side: 1 | -1; kind: 'fence' | 'hay' | 'barn' | 'pond' }> = [
  { from: 0.015, to: 0.075, side: -1, kind: 'fence' },
  { from: 0.04, to: 0.1, side: 1, kind: 'hay' },
  { from: 0.2, to: 0.3, side: 1, kind: 'fence' },
  { from: 0.24, to: 0.34, side: -1, kind: 'hay' },
  { from: 0.36, to: 0.46, side: -1, kind: 'barn' },
  { from: 0.5, to: 0.62, side: 1, kind: 'pond' },
  { from: 0.62, to: 0.72, side: -1, kind: 'fence' },
  { from: 0.74, to: 0.84, side: 1, kind: 'hay' },
  { from: 0.86, to: 0.95, side: -1, kind: 'barn' },
];

/** 沿赛道路肩外侧布置装饰的横向偏移（米）。 */
const DECOR_MIN_OFFSET = 2.2;
const DECOR_MAX_OFFSET = 42;
/** 紧贴赛道的一圈花草带宽（米），让路边始终有细节 */
const TRACKSIDE_STRIP_INNER = 1.6;
const TRACKSIDE_STRIP_OUTER = 7.5;

function disposeGroup(group: THREE.Object3D, disposeMaterials = false): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    if (disposeMaterials && mesh.material) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) m.dispose();
    }
  });
}

/**
 * 把赛道与纸艺世界组装成可渲染的场景。
 *
 * 所有可见内容都由代码生成：程序化纹理、参数化几何、实例化密排的草花树木，
 * 没有外部模型或贴图。
 */
export function buildTrackView(
  track: BuiltTrack,
  theme: TrackTheme,
  quality: 'high' | 'low' = 'high',
): TrackView {
  const config: TrackConfig = track.config;
  const group = new THREE.Group();
  const rng = createRng(config.seed);
  const assets = buildSceneryAssets(theme, config.seed);
  const cl = track.centerline;
  const disposables: Array<() => void> = [];

  // ---------- 地形（纸板台面） ----------
  const terrainGeo = terrainToGeometry(track.terrain);
  const terrainMat = paperMaterial(theme.paperGround, {
    map: paperTexture({
      color: theme.paperGround,
      seed: config.seed + 5,
      size: 512,
      fiber: 0.45,
      blotch: 0.55,
      creases: 3,
      // 只留一点点网格暗示"手工垫板"，太重会像瓷砖
      grid: 0.28,
      edgeShade: 0.18,
      key: `terrain-${theme.paperGround}`,
    }),
  });
  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.receiveShadow = true;
  const spanX = track.terrain.bounds.maxX - track.terrain.bounds.minX;
  const spanZ = track.terrain.bounds.maxZ - track.terrain.bounds.minZ;
  const terrainMap = terrainMat.map as THREE.Texture | null;
  if (terrainMap) {
    terrainMap.wrapS = THREE.RepeatWrapping;
    terrainMap.wrapT = THREE.RepeatWrapping;
    terrainMap.repeat.set(spanX / 34, spanZ / 34);
  }
  group.add(terrainMesh);
  disposables.push(() => {
    terrainGeo.dispose();
    terrainMat.dispose();
  });

  // ---------- 道路 ----------
  const roadGeo = ribbonToGeometry(track.road.road);
  const roadMat = paperMaterial(0xffffff, {
    map: roadTexture(theme, config.seed + 3),
  });
  const roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.receiveShadow = true;
  group.add(roadMesh);
  disposables.push(() => {
    roadGeo.dispose();
    roadMat.dispose();
  });

  // ---------- 路肩 ----------
  const kerbMap = kerbTexture(theme);
  const kerbMat = paperMaterial(0xffffff, { map: kerbMap, side: THREE.DoubleSide });
  for (const ribbon of [track.road.kerbLeft, track.road.kerbRight]) {
    const geo = ribbonToGeometry(ribbon);
    const mesh = new THREE.Mesh(geo, kerbMat);
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(() => geo.dispose());
  }
  disposables.push(() => kerbMat.dispose());

  // ---------- 路堤纸带（把赛道"放"在桌面上的那一圈纸） ----------
  const apronMap = paperTexture({
    color: theme.grass,
    seed: config.seed + 41,
    size: 256,
    fiber: 0.7,
    blotch: 0.5,
    creases: 1,
    key: `apron-${theme.grass}`,
  });
  const apronMat = paperMaterial(0xffffff, { map: apronMap, side: THREE.DoubleSide });
  for (const ribbon of [track.road.apronLeft, track.road.apronRight]) {
    const geo = ribbonToGeometry(ribbon);
    const mesh = new THREE.Mesh(geo, apronMat);
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(() => geo.dispose());
  }
  disposables.push(() => apronMat.dispose());

  // ---------- 卡纸侧壁（纸板厚度） ----------
  const wallMap = cardboardTexture(0xc2a273, config.seed + 11);
  const wallMat = paperMaterial(0xc2a273, { map: wallMap, side: THREE.DoubleSide });
  for (const ribbon of [track.road.wallLeft, track.road.wallRight]) {
    const geo = ribbonToGeometry(ribbon);
    const mesh = new THREE.Mesh(geo, wallMat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    group.add(mesh);
    disposables.push(() => geo.dispose());
  }
  disposables.push(() => wallMat.dispose());

  // ---------- 护栏（视觉与碰撞盒体一一对应） ----------
  const railGeo = new THREE.BoxGeometry(1, 1, 1);
  const railPostGeo = new THREE.BoxGeometry(0.13, 0.62, 0.13);
  const railMat = paperMaterial(0xece3cc, { map: cardboardTexture(0xece3cc, config.seed + 13) });
  const postMat = paperMaterial(0x9b6b45, { map: cardboardTexture(0x9b6b45, config.seed + 17) });
  const railCount = track.guardrails.boxes.length;
  const postCount = track.guardrails.postRotations.length;
  if (railCount > 0) {
    const rails = new THREE.InstancedMesh(railGeo, railMat, railCount);
    const dummy = new THREE.Object3D();
    track.guardrails.boxes.forEach((b, i) => {
      dummy.position.set(b.x, b.y, b.z);
      dummy.rotation.set(0, b.heading, 0);
      dummy.scale.set(b.halfThickness * 2, b.visualHalfHeight * 2, b.halfLength * 2);
      dummy.updateMatrix();
      rails.setMatrixAt(i, dummy.matrix);
    });
    rails.instanceMatrix.needsUpdate = true;
    rails.castShadow = quality === 'high';
    group.add(rails);
  }
  if (postCount > 0) {
    const posts = new THREE.InstancedMesh(railPostGeo, postMat, postCount);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < postCount; i++) {
      dummy.position.set(
        track.guardrails.postPositions[i * 3],
        track.guardrails.postPositions[i * 3 + 1] + 0.31,
        track.guardrails.postPositions[i * 3 + 2],
      );
      dummy.rotation.set(0, track.guardrails.postRotations[i], 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      posts.setMatrixAt(i, dummy.matrix);
    }
    posts.instanceMatrix.needsUpdate = true;
    group.add(posts);
  }
  disposables.push(() => {
    railGeo.dispose();
    railPostGeo.dispose();
    railMat.dispose();
    postMat.dispose();
  });

  // ---------- 起点龙门架 + 地标路牌 ----------
  group.add(buildStartGantry(track, theme, config.seed));
  group.add(buildTracksideSign(track, config, theme, 0.045, 1));
  group.add(buildTracksideSign(track, config, theme, 0.52, -1));

  // ---------- 检查点拱门（视觉，判定走中心线进度） ----------
  const gateMat = paperMaterial(theme.accent2, { map: cardboardTexture(theme.accent2, config.seed + 19) });
  const gatePostGeo = new THREE.BoxGeometry(0.22, 1, 0.22);
  const cpCount = track.checkpoints.length;
  if (cpCount > 0) {
    const posts = new THREE.InstancedMesh(gatePostGeo, gateMat, cpCount * 2);
    const bannerGeo = new THREE.PlaneGeometry(1, 1);
    const bannerMat = paperMaterial(theme.accent, { map: checkerTexture(8), side: THREE.DoubleSide });
    const banners = new THREE.InstancedMesh(bannerGeo, bannerMat, cpCount);
    const dummy = new THREE.Object3D();
    track.checkpoints.forEach((cp, i) => {
      const w = cp.halfWidth + 1.4;
      const h = 2.6;
      for (let s = 0; s < 2; s++) {
        const sign = s === 0 ? 1 : -1;
        const along = cp.t;
        const sample = cl.sampleAt(along);
        dummy.position.set(
          sample.x + sample.rx * w * sign,
          sample.y + sample.ry * w * sign + h / 2,
          sample.z + sample.rz * w * sign,
        );
        dummy.rotation.set(0, Math.atan2(sample.tx, sample.tz), 0);
        dummy.scale.setScalar(1);
        dummy.scale.y = h;
        dummy.updateMatrix();
        posts.setMatrixAt(i * 2 + s, dummy.matrix);
      }
      dummy.position.set(cp.x, cp.y + h + 0.22, cp.z);
      dummy.rotation.set(0, Math.atan2(cp.tx, cp.tz), 0);
      dummy.scale.set(w * 2, 0.44, 1);
      dummy.updateMatrix();
      banners.setMatrixAt(i, dummy.matrix);
    });
    posts.instanceMatrix.needsUpdate = true;
    banners.instanceMatrix.needsUpdate = true;
    group.add(posts);
    group.add(banners);
    disposables.push(() => {
      gatePostGeo.dispose();
      gateMat.dispose();
      bannerGeo.dispose();
      bannerMat.dispose();
    });
  }

  // ---------- 装饰 ----------
  group.add(
    buildDecorations(track, assets, config, theme, rng, quality),
  );

  // ---------- 地标：大纸风车 ----------
  // 地标：大纸风车。放在起跑直道内侧约 55 m 处，
  // 发车与回到起跑直道时都能看到，远距离也能靠轮廓辨认。
  const windmill = buildWindmill(theme, config.seed + 23);
  const center = loopCenter(cl);
  const lmSample = cl.sampleAt(0.045);
  const lmInward = Math.sign(lmSample.signedCurvature || 1);
  const lmLat = -lmInward * 55;
  const lmX = lmSample.x + lmSample.rx * lmLat;
  const lmZ = lmSample.z + lmSample.rz * lmLat;
  windmill.group.position.set(lmX, track.terrain.heightAt(lmX, lmZ), lmZ);
  windmill.group.scale.setScalar(2.6);
  windmill.group.rotation.y = 0.6;
  group.add(windmill.group);

  // ---------- 背景：纸板山丘 + 云 ----------
  const hills = buildCardboardHills(theme, rng, 1400, 150, 4);
  hills.position.set(center.x - 300, -20, center.z - 620);
  hills.rotation.y = 0.12;
  group.add(hills);
  const hills2 = buildCardboardHills(theme, rng, 1100, 120, 3);
  hills2.position.set(center.x + 420, -14, center.z - 540);
  hills2.rotation.y = -0.25;
  group.add(hills2);

  const clouds: THREE.Mesh[] = [];
  for (let i = 0; i < 14; i++) {
    const cloud = buildCloud(assets, rng, 1);
    const ang = rng() * Math.PI * 2;
    const dist = range(rng, 320, 820);
    cloud.position.set(
      center.x + Math.cos(ang) * dist,
      range(rng, 70, 165),
      center.z + Math.sin(ang) * dist,
    );
    group.add(cloud);
    clouds.push(cloud);
  }

  // ---------- 天空 ----------
  const skyGeo = new THREE.SphereGeometry(1500, 24, 16);
  const skyMat = new THREE.MeshBasicMaterial({
    map: skyTexture(theme, config.seed),
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.position.set(center.x, 0, center.z);
  group.add(sky);
  disposables.push(() => {
    skyGeo.dispose();
    skyMat.dispose();
  });

  let elapsed = 0;
  return {
    group,
    update: (dt, cameraPosition) => {
      elapsed += dt;
      windmill.blades.rotation.z = elapsed * 0.55;
      // 云朵缓慢漂移 + 始终面向摄像机（保持纸片感）
      for (let i = 0; i < clouds.length; i++) {
        const c = clouds[i];
        c.rotation.y = Math.atan2(
          cameraPosition.x - c.position.x,
          cameraPosition.z - c.position.z,
        );
        c.position.x += Math.sin(elapsed * 0.05 + i) * 0.01;
      }
      sky.position.x = cameraPosition.x;
      sky.position.z = cameraPosition.z;
    },
    dispose: () => {
      for (const d of disposables) d();
      disposeGroup(group);
      group.clear();
    },
  };
}

function loopCenter(cl: Centerline): { x: number; z: number } {
  let x = 0;
  let z = 0;
  for (const s of cl.samples) {
    x += s.x;
    z += s.z;
  }
  return { x: x / cl.samples.length, z: z / cl.samples.length };
}

/** 起终点：龙门架 + 黑白格地面 + 纸牌。 */
function buildStartGantry(track: BuiltTrack, theme: TrackTheme, seed: number): THREE.Group {
  const g = new THREE.Group();
  const cl = track.centerline;
  const gate = track.startGate;
  const postMat = paperMaterial(0xd8cfb4, { map: cardboardTexture(0xd8cfb4, seed + 29) });
  // 贴图本身是 2×2 格；横向重复 8 次 → 每格约 0.95 m，
  // 纵向 0.5 次 → 每格约 1.1 m，接近正方形。（格子太密在透视下会糊成摩尔纹）
  const beamMap = checkerTexture(2);
  beamMap.repeat.set(8, 0.5);
  const beamMat = paperMaterial(0xffffff, { map: beamMap });
  const w = track.config.width / 2 + 1.6;
  const h = 6.4;

  for (const sign of [1, -1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, h, 0.7), postMat);
    post.position.set(
      gate.x + cl.sampleAt(gate.t).rx * w * sign,
      gate.y + h / 2,
      gate.z + cl.sampleAt(gate.t).rz * w * sign,
    );
    post.castShadow = true;
    g.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(w * 2, 1.1, 0.5), beamMat);
  const sample = cl.sampleAt(gate.t);
  beam.position.set(gate.x, gate.y + h - 0.3, gate.z);
  beam.rotation.y = Math.atan2(sample.tx, sample.tz);
  beam.castShadow = true;
  g.add(beam);

  // 地面黑白格。
  // 注意：必须先把**几何**绕 X 摆平，再只用 rotation.y 对准赛道方向。
  // 直接写 rotation.set(-PI/2, 0, yaw) 会因为欧拉角 XYZ 的顺序（先 Z 后 X）
  // 让格纹在路面上整体歪掉 —— 这正是之前"起点黑白格是歪的"的原因。
  const lineGeo = new THREE.PlaneGeometry(track.config.width, 2.6);
  lineGeo.rotateX(-Math.PI / 2);
  // 贴图含 12×12 格：横向铺 1 次 → 12 格 / 12 m = 每格 1 m；
  // 纵向铺 2.6/12 次 → 约 2.6 格 / 2.6 m，也是每格 1 m。
  const lineMap = checkerTexture(12);
  lineMap.repeat.set(1, 2.6 / track.config.width);
  const lineMat = paperMaterial(0xffffff, { map: lineMap });
  const line = new THREE.Mesh(lineGeo, lineMat);
  line.rotation.y = Math.atan2(sample.tx, sample.tz);
  line.position.set(gate.x, gate.y + 0.025, gate.z);
  g.add(line);

  // 龙门架上的纸牌
  const signTex = makeSignTexture({ title: track.config.name, subtitle: `章节 ${track.config.chapter}`, seed });
  const signMat = new THREE.MeshBasicMaterial({ map: signTex, side: THREE.DoubleSide, transparent: true });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 2.6), signMat);
  sign.position.set(gate.x, gate.y + h + 1.6, gate.z);
  sign.rotation.y = Math.atan2(sample.tx, sample.tz) + Math.PI;
  g.add(sign);
  void theme;
  return g;
}

/** 路边的地名纸牌（像参考风格里立着的地图标识）。 */
function buildTracksideSign(
  track: BuiltTrack,
  config: TrackConfig,
  theme: TrackTheme,
  t: number,
  side: 1 | -1,
): THREE.Group {
  const g = new THREE.Group();
  const cl = track.centerline;
  const s = cl.sampleAt(t);
  const lateral = side * (s.halfWidth + 5.4);
  const x = s.x + s.rx * lateral;
  const z = s.z + s.rz * lateral;
  const y = track.terrain.heightAt(x, z);

  const postMat = paperMaterial(0xa8825a, { map: cardboardTexture(0xa8825a, config.seed + 31) });
  for (const dx of [-1.5, 1.5]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.4, 0.16), postMat);
    post.position.set(x + s.tx * dx, y + 1.2, z + s.tz * dx);
    post.castShadow = true;
    g.add(post);
  }
  const tex = makeSignTexture({
    title: config.name,
    subtitle: config.subtitle,
    titleColor: `#c33a2f`,
    seed: config.seed + 37,
  });
  const boardMat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true });
  const board = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 2.2), boardMat);
  board.position.set(x, y + 3.1, z);
  board.rotation.y = Math.atan2(s.tx, s.tz) + Math.PI;
  board.castShadow = false;
  g.add(board);
  void theme;
  return g;
}

/** 按配置的装饰区生成纸艺植物/建筑。 */
function buildDecorations(
  track: BuiltTrack,
  assets: SceneryAssets,
  config: TrackConfig,
  theme: TrackTheme,
  rng: () => number,
  quality: 'high' | 'low',
): THREE.Group {
  const group = new THREE.Group();
  const cl = track.centerline;
  const total = cl.totalLength;
  const densityScale = quality === 'high' ? 1 : 0.5;

  const placeOnGround = (x: number, z: number): number => track.terrain.heightAt(x, z);

  const buckets: Record<DecorationKind, number> = {
    flowers: 0,
    trees: 0,
    hills: 0,
    houses: 0,
    rocks: 0,
    none: 0,
  };

  for (const zone of config.decorations) {
    const spanMeters = Math.abs(zone.to - zone.from) * total;
    if (spanMeters < 4) continue;
    const count = Math.max(1, Math.round((spanMeters / 50) * zone.density * densityScale));
    for (let i = 0; i < count; i++) {
      const t = zone.from + (zone.to - zone.from) * rng();
      const side = zone.side === 'both' ? (rng() > 0.5 ? 1 : -1) : zone.side === 'right' ? 1 : -1;
      const s = cl.sampleAt(t);
      const lateral = side * range(rng, s.halfWidth + DECOR_MIN_OFFSET, s.halfWidth + DECOR_MAX_OFFSET);
      // 避免摆到赛道的另一侧（那里可能也有路）
      const x = s.x + s.rx * lateral;
      const z = s.z + s.rz * lateral;
      const near = cl.project(x, z);
      if (near.distance < near.halfWidth + 1.4) continue;
      const y = placeOnGround(x, z);

      switch (zone.kind) {
        case 'flowers': {
          const bushOrFlower = rng();
          if (bushOrFlower > 0.62) {
            const tree = buildTree(assets, rng, rng() > 0.5 ? 'conifer' : 'broadleaf', range(rng, 0.8, 1.5));
            tree.position.set(x, y, z);
            group.add(tree);
            buckets.trees++;
          } else if (bushOrFlower > 0.28) {
            const bush = new THREE.Mesh(assets.geometries.bush, assets.materials.leaf);
            bush.scale.setScalar(range(rng, 0.8, 1.8));
            bush.position.set(x, y, z);
            bush.castShadow = quality === 'high';
            group.add(bush);
            buckets.flowers++;
          } else {
            const clump = new THREE.Group();
            const n = 3 + Math.floor(rng() * 4);
            for (let k = 0; k < n; k++) {
              const f = buildFlower(assets, rng);
              f.position.set(x + range(rng, -1.6, 1.6), y, z + range(rng, -1.6, 1.6));
              clump.add(f);
            }
            group.add(clump);
            buckets.flowers++;
          }
          break;
        }
        case 'trees': {
          const tree = buildTree(assets, rng, rng() > 0.35 ? 'conifer' : 'broadleaf', range(rng, 1.0, 2.0));
          tree.position.set(x, y, z);
          group.add(tree);
          buckets.trees++;
          break;
        }
        case 'houses': {
          const house = buildHouse(assets, rng, range(rng, 0.8, 1.25));
          house.position.set(x, y, z);
          group.add(house);
          buckets.houses++;
          break;
        }
        case 'rocks': {
          const rock = new THREE.Mesh(assets.geometries.rock, assets.materials.rock);
          rock.scale.setScalar(range(rng, 0.7, 1.8));
          rock.rotation.set(rng(), rng() * 6, rng());
          rock.position.set(x, y, z);
          rock.castShadow = quality === 'high';
          group.add(rock);
          buckets.rocks++;
          break;
        }
        case 'hills': {
          // 低矮的层叠纸板坡
          const w = range(rng, 18, 34);
          const h = range(rng, 3, 6);
          const geo = new THREE.ConeGeometry(w / 2, h, 7, 1);
          const pos = geo.attributes.position as THREE.BufferAttribute;
          for (let v = 0; v < pos.count; v++) {
            pos.setX(v, pos.getX(v) * range(rng, 0.75, 1.3));
            pos.setZ(v, pos.getZ(v) * range(rng, 0.75, 1.3));
          }
          geo.computeVertexNormals();
          const hill = new THREE.Mesh(geo, assets.materials.hill[Math.floor(rng() * 3)]);
          hill.position.set(x, y - h * 0.35, z);
          hill.rotation.y = rng() * 6.28;
          hill.castShadow = quality === 'high';
          group.add(hill);
          buckets.hills++;
          break;
        }
        default:
          break;
      }
    }
  }

  // 紧贴赛道的连续装饰带：纸花 / 草簇 / 小灌木，
  // 保证玩家在任何位置看向路边都有层次，而不是一片空绿地。
  const stripStep = 4.2;
  const stripCount = Math.floor(total / stripStep);
  for (let i = 0; i < stripCount; i++) {
    const t = i / stripCount;
    for (const side of [1, -1] as const) {
      const s = cl.sampleAt(t);
      const lateral = side * range(rng, s.halfWidth + TRACKSIDE_STRIP_INNER, s.halfWidth + TRACKSIDE_STRIP_OUTER);
      const x = s.x + s.rx * lateral;
      const z = s.z + s.rz * lateral;
      const near = cl.project(x, z);
      if (near.distance < near.halfWidth + 1.0) continue;
      const y = placeOnGround(x, z);
      const roll = rng();
      if (roll < 0.62) {
        // 花簇：3–7 朵挤在一起，像田间野花
        const clump = new THREE.Group();
        const n = 3 + Math.floor(rng() * 5);
        for (let k = 0; k < n; k++) {
          const f = buildFlower(assets, rng);
          f.position.set(x + range(rng, -1.1, 1.1), y, z + range(rng, -1.1, 1.1));
          clump.add(f);
        }
        group.add(clump);
        buckets.flowers++;
      } else if (roll < 0.86) {
        const bush = new THREE.Mesh(assets.geometries.bush, rng() > 0.5 ? assets.materials.leaf : assets.materials.leafDark);
        bush.scale.setScalar(range(rng, 0.5, 1.1));
        bush.position.set(x, y, z);
        bush.castShadow = quality === 'high';
        group.add(bush);
        buckets.flowers++;
      } else {
        const rock = new THREE.Mesh(assets.geometries.rock, assets.materials.rock);
        rock.scale.setScalar(range(rng, 0.4, 0.9));
        rock.rotation.set(rng(), rng() * 6.28, rng());
        rock.position.set(x, y, z);
        group.add(rock);
        buckets.rocks++;
      }
    }
  }

  // ---------------------------------------------------------------
  // 地图特色：成段栅栏、干草堆、谷仓、纸片水塘
  // ---------------------------------------------------------------
  for (const zone of FEATURE_ZONES) {
    const mid = (zone.from + zone.to) / 2;
    const smp = cl.sampleAt(mid);
    const lateral = zone.side * range(rng, smp.halfWidth + 12, smp.halfWidth + 26);
    const x = smp.x + smp.rx * lateral;
    const z = smp.z + smp.rz * lateral;
    if (cl.project(x, z).distance < smp.halfWidth + 4) continue;
    const y = placeOnGround(x, z);
    if (zone.kind === 'fence') {
      const run = buildFenceRun(assets, rng, range(rng, 26, 46));
      run.position.set(x, y, z);
      run.rotation.y = Math.atan2(smp.tx, smp.tz);
      group.add(run);
    } else if (zone.kind === 'hay') {
      const n = 3 + Math.floor(rng() * 4);
      for (let i = 0; i < n; i++) {
        const hx = x + range(rng, -6, 6);
        const hz = z + range(rng, -6, 6);
        const hay = buildHaystack(assets, rng);
        hay.position.set(hx, placeOnGround(hx, hz), hz);
        group.add(hay);
      }
    } else if (zone.kind === 'barn') {
      const barn = buildBarn(assets, rng, range(rng, 0.95, 1.25));
      barn.position.set(x, y, z);
      group.add(barn);
    } else {
      const pond = buildPond(rng, range(rng, 10, 16));
      pond.position.set(x, y, z);
      group.add(pond);
    }
  }

  // ---------------------------------------------------------------
  // 弯道箭头牌：自动放在全场最急的几个弯外侧。
  // 既提示弯向，也让地图看起来是"有人设计过"而不是随机铺草。
  // ---------------------------------------------------------------
  const corners: Array<{ t: number; k: number }> = [];
  const scanStep = Math.max(1, Math.floor(cl.samples.length / 400));
  for (let i = 0; i < cl.samples.length; i += scanStep) {
    corners.push({ t: cl.samples[i].s / cl.totalLength, k: cl.samples[i].curvature });
  }
  corners.sort((a, b) => b.k - a.k);
  const chosen: number[] = [];
  for (const cand of corners) {
    if (chosen.length >= 8) break;
    if (chosen.some((t) => Math.abs(t - cand.t) < 0.03)) continue;
    chosen.push(cand.t);
  }
  for (const t of chosen) {
    const smp = cl.sampleAt(t);
    const turnLeft = smp.signedCurvature > 0;
    const board = buildChevronSign(theme, turnLeft ? -1 : 1, config.seed + Math.round(t * 997));
    const lateral = (turnLeft ? 1 : -1) * (smp.halfWidth + 4.2);
    const bx = smp.x + smp.rx * lateral;
    const bz = smp.z + smp.rz * lateral;
    board.position.set(bx, placeOnGround(bx, bz), bz);
    board.rotation.y = Math.atan2(smp.tx, smp.tz) + Math.PI;
    group.add(board);
  }

  return group;
}

/** 纸箱障碍（阶段四会正式接入赛道机关，这里提供可碰撞的纸箱本体）。 */
export function createCrateObstacle(
  theme: TrackTheme,
  seed: number,
  position: { x: number; y: number; z: number },
  rotY = 0,
): { mesh: THREE.Mesh; half: [number, number, number] } {
  const size = 1.4;
  const mesh = buildCrate(theme, seed, size);
  mesh.position.set(position.x, position.y + size * 0.45, position.z);
  mesh.rotation.y = rotY;
  return { mesh, half: [size / 2, (size * 0.9) / 2, size / 2] };
}

export { outlineMaterial };
