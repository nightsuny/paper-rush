import * as THREE from 'three';
import { ribbonToGeometry } from '../tracks/RoadGeometry';
import { terrainToGeometry } from '../tracks/Terrain';
import {
  cardboardTexture,
  outlineMaterial,
  paperMaterial,
  paperTexture,
  skyTexture,
  toonGradient,
} from '../scenery/PaperMaterials';
import { buildCloud, buildCardboardHills, buildSceneryAssets, buildTree } from '../scenery/Scenery';
import { createRng, range } from '../game/random';
import type { BuiltRegion } from './Region';
import type { RegionConfig } from './types';

/**
 * 区域的渲染层。
 *
 * 与 scenery/TrackView 的分工：
 *  - RegionView 负责"路网 + 地形 + 边界 + 路口"这些结构件的渲染
 *  - 景观（树/花/房屋/地标）在 S2 按 biome 分块补齐，S1 只做很轻的散布，
 *    避免骨架阶段看起来是一片空白绿地
 */

export interface RegionView {
  group: THREE.Group;
  update: (dt: number, cameraPosition: THREE.Vector3) => void;
  /** 调试用：把路网中心线与区域边界画出来 */
  setDebugVisible: (visible: boolean) => void;
  dispose: () => void;
}

export function buildRegionView(region: BuiltRegion, quality: 'high' | 'low' = 'high'): RegionView {
  const config: RegionConfig = region.config;
  const theme = config.theme;
  const group = new THREE.Group();
  const rng = createRng(config.seed);
  const assets = buildSceneryAssets(theme, config.seed);
  const disposables: Array<() => void> = [];

  // ---------------- 地形 ----------------
  const terrainGeo = terrainToGeometry(region.terrain);
  const terrainTex = paperTexture({
    color: theme.paperGround,
    seed: config.seed + 5,
    size: 512,
    fiber: 0.45,
    blotch: 0.55,
    creases: 3,
    grid: 0,
    edgeShade: 0.18,
    key: `region-terrain-${theme.paperGround}`,
  });
  const spanX = region.terrain.bounds.maxX - region.terrain.bounds.minX;
  const spanZ = region.terrain.bounds.maxZ - region.terrain.bounds.minZ;
  terrainTex.wrapS = THREE.RepeatWrapping;
  terrainTex.wrapT = THREE.RepeatWrapping;
  terrainTex.repeat.set(spanX / 34, spanZ / 34);
  const terrainMat = paperMaterial(theme.paperGround, { map: terrainTex });
  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.receiveShadow = true;
  group.add(terrainMesh);
  disposables.push(() => {
    terrainGeo.dispose();
    terrainMat.dispose();
  });

  // ---------------- 每个路段 ----------------
  const roadMat = paperMaterial(0xffffff, { map: roadTextureFor(theme, config.seed) });
  const dirtMat = paperMaterial(0xffffff, { map: dirtTextureFor(config.seed) });
  const kerbMat = paperMaterial(0xffffff, {
    map: kerbTextureFor(theme, config.seed),
    side: THREE.DoubleSide,
  });
  const vergeMat = paperMaterial(0xffffff, {
    map: paperTexture({
      color: theme.grass,
      seed: config.seed + 41,
      size: 256,
      fiber: 0.7,
      blotch: 0.5,
      creases: 1,
      key: `region-verge-${theme.grass}`,
    }),
    side: THREE.DoubleSide,
  });
  const wallMat = paperMaterial(0xc2a273, {
    map: cardboardTexture(0xc2a273, config.seed + 11),
    side: THREE.DoubleSide,
  });

  for (const seg of region.segments) {
    const isDirt = (seg.config.surface ?? '') === 'dirt';
    const surfMat = isDirt ? dirtMat : roadMat;
    const roadMesh = new THREE.Mesh(ribbonToGeometry(seg.road.road), surfMat);
    roadMesh.receiveShadow = true;
    group.add(roadMesh);
    disposables.push(() => roadMesh.geometry.dispose());

    for (const ribbon of [seg.road.kerbLeft, seg.road.kerbRight]) {
      const m = new THREE.Mesh(ribbonToGeometry(ribbon), kerbMat);
      m.receiveShadow = true;
      group.add(m);
      disposables.push(() => m.geometry.dispose());
    }
    for (const ribbon of [seg.road.apronLeft, seg.road.apronRight]) {
      const m = new THREE.Mesh(ribbonToGeometry(ribbon), vergeMat);
      m.receiveShadow = true;
      group.add(m);
      disposables.push(() => m.geometry.dispose());
    }
    // 路肩外的卡纸侧壁（可见的纸板厚度）
    for (const ribbon of [seg.road.wallLeft, seg.road.wallRight]) {
      const m = new THREE.Mesh(ribbonToGeometry(ribbon), wallMat);
      m.receiveShadow = true;
      group.add(m);
      disposables.push(() => m.geometry.dispose());
    }

    // 护栏（视觉与碰撞盒一一对应）
    const boxes = seg.guardrails.boxes;
    if (boxes.length > 0) {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const railMat = paperMaterial(0xece3cc, { map: cardboardTexture(0xece3cc, config.seed + 13) });
      const rails = new THREE.InstancedMesh(geo, railMat, boxes.length);
      const dummy = new THREE.Object3D();
      boxes.forEach((b, i) => {
        dummy.position.set(b.x, b.y, b.z);
        dummy.rotation.set(0, b.heading, 0);
        dummy.scale.set(b.halfThickness * 2, b.visualHalfHeight * 2, b.halfLength * 2);
        dummy.updateMatrix();
        rails.setMatrixAt(i, dummy.matrix);
      });
      rails.instanceMatrix.needsUpdate = true;
      rails.castShadow = quality === 'high';
      group.add(rails);
      disposables.push(() => {
        geo.dispose();
        railMat.dispose();
      });
      // 立柱
      const postCount = seg.guardrails.postRotations.length;
      if (postCount > 0) {
        const postGeo = new THREE.BoxGeometry(0.13, 0.62, 0.13);
        const postMat = paperMaterial(0x9b6b45, { map: cardboardTexture(0x9b6b45, config.seed + 17) });
        const posts = new THREE.InstancedMesh(postGeo, postMat, postCount);
        for (let i = 0; i < postCount; i++) {
          dummy.position.set(
            seg.guardrails.postPositions[i * 3],
            seg.guardrails.postPositions[i * 3 + 1] + 0.31,
            seg.guardrails.postPositions[i * 3 + 2],
          );
          dummy.rotation.set(0, seg.guardrails.postRotations[i], 0);
          dummy.scale.setScalar(1);
          dummy.updateMatrix();
          posts.setMatrixAt(i, dummy.matrix);
        }
        posts.instanceMatrix.needsUpdate = true;
        group.add(posts);
        disposables.push(() => {
          postGeo.dispose();
          postMat.dispose();
        });
      }
    }
  }
  disposables.push(() => {
    roadMat.dispose();
    dirtMat.dispose();
    kerbMat.dispose();
    vergeMat.dispose();
    wallMat.dispose();
  });

  // ---------------- 路口中央岛 ----------------
  const islandMat = paperMaterial(theme.grass, {
    map: paperTexture({
      color: theme.grass,
      seed: config.seed + 77,
      size: 256,
      fiber: 0.6,
      blotch: 0.5,
      creases: 2,
      key: `region-island-${theme.grass}`,
    }),
  });
  const islandFlowerMat = paperMaterial(theme.accent, { side: THREE.DoubleSide });
  for (const island of region.islands) {
    const top = new THREE.Mesh(new THREE.CylinderGeometry(island.radius, island.radius * 1.02, island.height, 28), islandMat);
    top.position.set(island.x, island.y + island.height / 2, island.z);
    top.receiveShadow = true;
    top.castShadow = quality === 'high';
    group.add(top);
    disposables.push(() => top.geometry.dispose());
    // 中央放一株纸花做视觉焦点，提示"这是一座环岛"
    const flower = new THREE.Mesh(new THREE.CircleGeometry(island.radius * 0.5, 16), islandFlowerMat);
    flower.rotation.x = -Math.PI / 2;
    flower.position.set(island.x, island.y + island.height + 0.01, island.z);
    group.add(flower);
    disposables.push(() => flower.geometry.dispose());
  }
  disposables.push(() => {
    islandMat.dispose();
    islandFlowerMat.dispose();
  });

  // ---------------- 区域边界：不可见墙 + 很淡的纸边脊线 ----------------
  // 空气墙本身要"不可见"（这是需求），但完全看不到会让人以为是 bug，
  // 所以在边界内侧铺一条极淡的纸边脊线作为视觉暗示。
  const ridgePts: number[] = [];
  const ridgeH = 0.35;
  const b = config.bounds;
  const ridge2 = (x0: number, z0: number, x1: number, z1: number): void => {
    const steps = Math.max(2, Math.round(Math.hypot(x1 - x0, z1 - z0) / 25));
    for (let i = 0; i < steps; i++) {
      const ax = x0 + ((x1 - x0) * i) / steps;
      const az = z0 + ((z1 - z0) * i) / steps;
      const bx = x0 + ((x1 - x0) * (i + 1)) / steps;
      const bz = z0 + ((z1 - z0) * (i + 1)) / steps;
      const ay = region.terrain.heightAt(ax, az);
      const by = region.terrain.heightAt(bx, bz);
      const inset = 2;
      const nx = ax === bx ? (x0 === b.minX ? inset : -inset) : 0;
      const nz = az === bz ? (z0 === b.minZ ? inset : -inset) : 0;
      ridgePts.push(ax + nx, ay + ridgeH, az + nz, bx + nx, by + ridgeH, bz + nz);
    }
  };
  ridge2(b.minX, b.minZ, b.maxX, b.minZ);
  ridge2(b.maxX, b.minZ, b.maxX, b.maxZ);
  ridge2(b.maxX, b.maxZ, b.minX, b.maxZ);
  ridge2(b.minX, b.maxZ, b.minX, b.minZ);
  const ridgeGeo = new THREE.BufferGeometry();
  ridgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(ridgePts, 3));
  const ridgeMat = new THREE.LineBasicMaterial({ color: 0xb9a882, transparent: true, opacity: 0.55 });
  const ridge = new THREE.LineSegments(ridgeGeo, ridgeMat);
  group.add(ridge);
  disposables.push(() => {
    ridgeGeo.dispose();
    ridgeMat.dispose();
  });

  // ---------------- S1 轻度景观（S2 会按 biome 补齐） ----------------
  const treeCount = quality === 'high' ? 260 : 110;
  const treeGroup = new THREE.Group();
  for (let i = 0; i < treeCount; i++) {
    // 沿某条路段随机取点，横向 14~60 m 之外散布
    const segIdx = Math.floor(rng() * region.segments.length);
    const curve = region.segments[segIdx].curve;
    const t = rng();
    const s = curve.sampleAt(t);
    const side = rng() > 0.5 ? 1 : -1;
    const lateral = side * range(rng, s.halfWidth + 14, s.halfWidth + 62);
    const x = s.x + s.rx * lateral;
    const z = s.z + s.rz * lateral;
    // 别摆进别的路段的路面上
    const near = region.network.project(x, z);
    if (near.distance < near.halfWidth + 8) continue;
    const y = region.terrain.heightAt(x, z);
    const tree = buildTree(assets, rng, rng() > 0.55 ? 'conifer' : 'broadleaf', range(rng, 1.0, 2.1));
    tree.position.set(x, y, z);
    treeGroup.add(tree);
  }
  group.add(treeGroup);

  // 远景：层叠纸板山丘 + 云
  const centre = {
    x: (b.minX + b.maxX) / 2,
    z: (b.minZ + b.maxZ) / 2,
  };
  // 远景层叠山丘：分两处、尺寸克制一些，避免变成一大块没有细节的色块
  const hillsFar = buildCardboardHills(theme, rng, 1500, 120, 4);
  hillsFar.position.set(centre.x - 220, -22, centre.z - 1300);
  group.add(hillsFar);
  const hillsNear = buildCardboardHills(theme, rng, 900, 80, 3);
  hillsNear.position.set(centre.x + 620, -14, centre.z - 900);
  hillsNear.rotation.y = -0.22;
  group.add(hillsNear);
  const clouds: THREE.Mesh[] = [];
  for (let i = 0; i < 18; i++) {
    const cloud = buildCloud(assets, rng, 1.6);
    const ang = rng() * Math.PI * 2;
    const dist = range(rng, 600, 1500);
    cloud.position.set(centre.x + Math.cos(ang) * dist, range(rng, 110, 230), centre.z + Math.sin(ang) * dist);
    group.add(cloud);
    clouds.push(cloud);
  }

  // ---------------- 天空 ----------------
  const skyGeo = new THREE.SphereGeometry(2600, 24, 16);
  const skyMat = new THREE.MeshBasicMaterial({
    map: skyTexture(theme, config.seed),
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  group.add(sky);
  disposables.push(() => {
    skyGeo.dispose();
    skyMat.dispose();
  });
  void toonGradient;

  // ---------------- 调试叠加：路网中心线 + 边界 ----------------
  const debugGeo = new THREE.BufferGeometry();
  const debugPts: number[] = [];
  for (const seg of region.segments) {
    const step = Math.max(1, Math.floor(seg.curve.samples.length / 200));
    for (let i = 0; i + step < seg.curve.samples.length; i += step) {
      const a = seg.curve.samples[i];
      const c = seg.curve.samples[Math.min(i + step, seg.curve.samples.length - 1)];
      debugPts.push(a.x, a.y + 1.2, a.z, c.x, c.y + 1.2, c.z);
    }
  }
  // 边界矩形（离地 3m，便于俯瞰时看到）
  const by = 3;
  const corners: Array<[number, number]> = [
    [b.minX, b.minZ],
    [b.maxX, b.minZ],
    [b.maxX, b.maxZ],
    [b.minX, b.maxZ],
  ];
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = corners[i];
    const [x1, z1] = corners[(i + 1) % 4];
    debugPts.push(x0, by, z0, x1, by, z1);
  }
  debugGeo.setAttribute('position', new THREE.Float32BufferAttribute(debugPts, 3));
  const debugMat = new THREE.LineBasicMaterial({ color: 0xff4d3d, transparent: true, opacity: 0.9 });
  const debugLines = new THREE.LineSegments(debugGeo, debugMat);
  debugLines.visible = false;
  group.add(debugLines);
  disposables.push(() => {
    debugGeo.dispose();
    debugMat.dispose();
  });

  let elapsed = 0;
  return {
    group,
    update: (dt, cameraPosition) => {
      elapsed += dt;
      for (let i = 0; i < clouds.length; i++) {
        const c = clouds[i];
        c.rotation.y = Math.atan2(cameraPosition.x - c.position.x, cameraPosition.z - c.position.z);
        c.position.x += Math.sin(elapsed * 0.04 + i) * 0.02;
      }
      sky.position.x = cameraPosition.x;
      sky.position.z = cameraPosition.z;
    },
    setDebugVisible: (visible: boolean) => {
      debugLines.visible = visible;
    },
    dispose: () => {
      for (const d of disposables) d();
      group.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
      group.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// 纹理：区域版路面/路肩（复用 PaperMaterials 的生成器）
// ---------------------------------------------------------------------------

function roadTextureFor(theme: RegionConfig['theme'], seed: number): THREE.Texture {
  return paperTexture({
    color: theme.road,
    seed,
    size: 512,
    fiber: 0.5,
    blotch: 0.5,
    creases: 2,
    key: `region-road-${theme.road}`,
  });
}

function dirtTextureFor(seed: number): THREE.Texture {
  return paperTexture({
    color: 0xb08a5c,
    seed: seed + 3,
    size: 512,
    fiber: 0.9,
    blotch: 0.6,
    creases: 2,
    key: 'region-dirt',
  });
}

function kerbTextureFor(theme: RegionConfig['theme'], seed: number): THREE.Texture {
  return paperTexture({
    color: theme.kerb,
    seed: seed + 7,
    size: 128,
    fiber: 0.4,
    blotch: 0.3,
    creases: 1,
    key: `region-kerb-${theme.kerb}`,
  });
}

export { outlineMaterial };
