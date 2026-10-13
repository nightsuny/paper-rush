import * as THREE from 'three';
import { GROUND_TILE_METERS, ribbonToGeometry } from '../tracks/RoadGeometry';
import { terrainToGeometry } from '../tracks/Terrain';
import {
  cardboardTexture,
  outlineMaterial,
  paperMaterial,
  paperTexture,
  skyTexture,
  toonGradient,
} from '../scenery/PaperMaterials';
import {
  buildBarn,
  buildCardboardHills,
  buildCloud,
  buildFenceAlong,
  buildFlower,
  buildHaystack,
  buildHouse,
  buildSceneryAssets,
  buildTree,
  type SceneryAssets,
} from '../scenery/Scenery';
import { createRng, range } from '../game/random';
import type { BuiltRegion } from './Region';
import { ROAD_KINDS, type RoadBiome, type RegionConfig } from './types';

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

type SceneryKind = 'house' | 'conifer' | 'broadleaf' | 'barn' | 'haystack' | 'flower';

/**
 * 每个 biome 的景观规则。
 * `inset` 是离**路面边缘**多远（米）；`density` 是命中概率 —— 留白和密度一样重要，
 * 排满反而假。`align` 为真时朝向对齐道路（房子要正面朝街）。
 */
interface BiomeSceneryRule {
  spacing: number;
  inset: [number, number];
  kinds: SceneryKind[];
  density: number;
  align: boolean;
  bothSides: boolean;
}

const BIOME_RULES: Record<RoadBiome, BiomeSceneryRule> = {
  // 村庄：房子成排沿街（占多数）+ 少量花丛与树，密、贴街
  village: {
    spacing: 16,
    inset: [6.5, 13],
    kinds: ['house', 'house', 'house', 'house', 'flower', 'broadleaf'],
    density: 0.8,
    align: true,
    bothSides: true,
  },
  urban: { spacing: 14, inset: [7, 15], kinds: ['house', 'house', 'house'], density: 0.88, align: true, bothSides: true },
  // 林地：几乎贴到路肩的密针叶林
  forest: {
    spacing: 7,
    inset: [3.2, 30],
    kinds: ['conifer', 'conifer', 'conifer', 'broadleaf'],
    density: 0.88,
    align: false,
    bothSides: true,
  },
  // 郊野：稀疏散布，远一点，留出草地
  meadow: {
    spacing: 26,
    inset: [16, 66],
    kinds: ['broadleaf', 'conifer', 'flower', 'flower'],
    density: 0.4,
    align: false,
    bothSides: true,
  },
  // 农田：谷仓/草垛 + 零星树
  farm: {
    spacing: 30,
    inset: [12, 44],
    kinds: ['barn', 'haystack', 'haystack', 'broadleaf'],
    density: 0.5,
    align: false,
    bothSides: true,
  },
};

/** 按种类生成一个景观件。 */
function buildOne(
  assets: SceneryAssets,
  rng: () => number,
  kind: SceneryKind,
): THREE.Group {
  switch (kind) {
    case 'house':
      return buildHouse(assets, rng, range(rng, 0.88, 1.3));
    case 'barn':
      return buildBarn(assets, rng, range(rng, 0.9, 1.2));
    case 'haystack':
      return buildHaystack(assets, rng);
    case 'flower':
      return buildFlower(assets, rng);
    case 'conifer':
      return buildTree(assets, rng, 'conifer', range(rng, 1.0, 2.0));
    default:
      return buildTree(assets, rng, 'broadleaf', range(rng, 0.9, 1.9));
  }
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
  // 地面只有这一张皮：地形与路堤共用同一个贴图、同一个世界尺度（22 m/次）。
  // 顶点色负责"近路修剪过的草 → 远处野地"的过渡，颜色也由它给出。
  // 之前地形是 paperGround、路堤是 grass（两个颜色、两张贴图、34m 与 8m 两种疏密），
  // 于是路堤外沿会露出"两块不同模型拼起来"的断层。
  const terrainTex = paperTexture({
    color: 0xffffff,
    seed: config.seed + 5,
    size: 512,
    fiber: 0.5,
    blotch: 0.5,
    creases: 2,
    key: 'region-ground',
  });
  const spanX = region.terrain.bounds.maxX - region.terrain.bounds.minX;
  const spanZ = region.terrain.bounds.maxZ - region.terrain.bounds.minZ;
  terrainTex.wrapS = THREE.RepeatWrapping;
  terrainTex.wrapT = THREE.RepeatWrapping;
  terrainTex.repeat.set(spanX / GROUND_TILE_METERS, spanZ / GROUND_TILE_METERS);
  const terrainMat = paperMaterial(0xffffff, { map: terrainTex, vertexColors: true });
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
  // 路堤草地：与地形**同一张贴图、同一个世界尺度**，颜色就是顶点色的近端色，
  // 因此与地形在接缝处完全连续。
  const vergeMat = paperMaterial(theme.grass, {
    map: terrainTex,
    side: THREE.DoubleSide,
  });
  const wallMat = paperMaterial(0xc2a273, {
    map: cardboardTexture(0xc2a273, config.seed + 11),
    side: THREE.DoubleSide,
  });
  // 土路没有马路牙子：路肩与侧壁都是夯实的土/碎石色，不是红色路缘 + 牛皮纸
  const earthShoulderMat = paperMaterial(0xffffff, {
    map: dirtTextureFor(config.seed + 3),
    side: THREE.DoubleSide,
  });

  for (const seg of region.segments) {
    // 路面类型必须从**等级**解析。原来只读 seg.config.surface，而配置里没人写过它，
    // 于是所有路段（包括 kind:'dirt' 的林道、村道）全都铺了沥青 + 城市车道线。
    const kindSpec = ROAD_KINDS[seg.config.kind];
    const surface = seg.config.surface ?? kindSpec.surface;
    const isDirt = surface !== 'asphalt';
    const surfMat = isDirt ? dirtMat : roadMat;
    const segKerbMat = isDirt ? earthShoulderMat : kerbMat;
    // 土路的边坡直接用**地面材质**：土路本该平顺地融进草地，
    // 用牛皮纸/土色侧壁会在路两侧画出两条深色"排水沟"，看起来像人工沟渠。
    const segWallMat = isDirt ? vergeMat : wallMat;
    const roadMesh = new THREE.Mesh(ribbonToGeometry(seg.road.road), surfMat);
    roadMesh.receiveShadow = true;
    group.add(roadMesh);
    disposables.push(() => roadMesh.geometry.dispose());

    for (const ribbon of [seg.road.kerbLeft, seg.road.kerbRight]) {
      const m = new THREE.Mesh(ribbonToGeometry(ribbon), segKerbMat);
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
      const m = new THREE.Mesh(ribbonToGeometry(ribbon), segWallMat);
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

  // ---------------- 景观：按 biome 分块 + 沿路规则摆放 ----------------
  //
  // 旧做法是全图均匀随机撒树（还要求离路面 14~60 m），结果林地不像林地、
  // 村庄一栋房子都没有 —— 这就是"没有设计、只是在凑"的直接体现。
  // 现在每个 biome 有自己的规则：摆什么、多密、离路多远、朝哪个方向。
  // 房子必须**成排沿街、正面朝路**，因为现实里建筑是跟着道路长出来的。
  const scenery = new THREE.Group();
  const placed: Array<{ x: number; z: number }> = [];
  const NODE_CAP = quality === 'high' ? 1900 : 800;
  let nodeCount = 0;
  let fenceCount = 0;

  for (const seg of region.segments) {
    if (nodeCount >= NODE_CAP) break;
    const biome: RoadBiome = seg.config.biome ?? 'meadow';
    const rule = BIOME_RULES[biome];
    const curve = seg.curve;
    const steps = Math.max(1, Math.floor(curve.totalLength / rule.spacing));
    const isVillage = biome === 'village' || biome === 'urban';
    let lastHouseSide = 0;

    for (let k = 0; k < steps && nodeCount < NODE_CAP; k++) {
      const t = (k + 0.5) / steps;
      const s = curve.sampleAt(t);
      for (const side of rule.bothSides ? [1, -1] : [1]) {
        if (rng() > rule.density) continue;
        const inset = s.halfWidth + range(rng, rule.inset[0], rule.inset[1]);
        const x = s.x + s.rx * inset * side;
        const z = s.z + s.rz * inset * side;
        // 不能压在别的路面上（含路肩）
        const near = region.network.project(x, z);
        if (near.distance < near.halfWidth + 3.6) continue;
        // 路口要留空，否则房子会堵在路口上
        let blocked = false;
        for (const j of config.junctions) {
          if (Math.hypot(x - j.x, z - j.z) < j.radius * 0.75) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        // 排重：别让房子叠在一栋房子上
        for (const q of placed) {
          if ((q.x - x) * (q.x - x) + (q.z - z) * (q.z - z) < 7 * 7) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;

        const kind = rule.kinds[Math.floor(rng() * rule.kinds.length)];
        // 房子正面朝街：局部 +Z 指向道路中心线
        const faceRoad = Math.atan2(-s.rx * side, -s.rz * side);
        const heading = rule.align ? faceRoad + range(rng, -0.05, 0.05) : rng() * Math.PI * 2;
        const y = region.terrain.heightAt(x, z);
        const node = buildOne(assets, rng, kind);
        node.position.set(x, y, z);
        node.rotation.y = heading;
        node.traverse(obj => {
          const mesh = obj as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.castShadow = quality === 'high';
            mesh.receiveShadow = true;
          }
        });
        scenery.add(node);
        placed.push({ x, z });
        nodeCount++;

        // 村庄：房子临街一侧拉一段篱笆（这就是"路—院—屋"的关系）
        if (isVillage && kind === 'house' && side !== lastHouseSide && fenceCount < 220) {
          lastHouseSide = side;
          const along = Math.min(11, curve.totalLength / Math.max(steps, 1) - 3);
          if (along > 4) {
            const fence = buildFenceAlong(
              assets,
              rng,
              x - s.tx * (along / 2),
              z - s.tz * (along / 2),
              x + s.tx * (along / 2),
              z + s.tz * (along / 2),
              (hx, hz) => region.terrain.heightAt(hx, hz),
            );
            scenery.add(fence);
            fenceCount++;
          }
        }
      }
    }
  }
  group.add(scenery);

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
  // 半径 1600：远小于相机远平面（4200），又大于地形半幅（约 1400），不会与地形相交。
  const skyGeo = new THREE.SphereGeometry(1600, 32, 20);
  const skyMat = new THREE.MeshBasicMaterial({
    map: skyTexture(theme, config.seed),
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  // 天空球跟着相机走：这样它永远完整落在远平面内，也不会被地形/边界穿到。
  sky.renderOrder = -1000;
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

/**
 * 路面贴图 = 沥青纸底 + 车道线。
 *
 * UV 约定（见 RoadGeometry.buildRibbon）：
 *  - u ∈ [0,1] **正好横跨沥青宽度**，所以线的横向位置用比例写，换路面宽度也对
 *  - v 每 12 m 重复一次（`vRepeat = 12`），所以中央虚线按 3 m 线 + 9 m 空 = 一个周期画
 *
 * 之前路面就是"一个纯色 + 纸纤维噪声"，没有任何标线，所以读起来不像路、像灰色塑料条。
 */
function roadTextureFor(theme: RegionConfig['theme'], seed: number): THREE.Texture {
  const size = 512;
  const base = paperTexture({
    color: theme.road,
    seed,
    size,
    fiber: 0.5,
    blotch: 0.5,
    creases: 2,
    key: `region-road-${theme.road}`,
  });
  const cached = roadMarkingCache.get(theme.road);
  if (cached) return cached;

  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return base;
  ctx.drawImage(base.image as HTMLCanvasElement, 0, 0, size, size);

  const ink = `#${theme.accent.toString(16).padStart(6, '0')}`;
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = ink;
  const lineW = size * 0.028;
  // 两侧边线（实线）
  ctx.fillRect(size * 0.075 - lineW / 2, 0, lineW, size);
  ctx.fillRect(size * 0.925 - lineW / 2, 0, lineW, size);
  // 中央虚线：3 m 线 + 9 m 空（一个 12 m 周期 = 一张贴图的高度）
  ctx.fillRect(size * 0.5 - lineW / 2, 0, lineW, size * 0.25);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  roadMarkingCache.set(theme.road, tex);
  return tex;
}

const roadMarkingCache = new Map<number, THREE.Texture>();

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
