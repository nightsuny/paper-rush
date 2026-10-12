import * as THREE from 'three';
import { createRng, range } from '../game/random';
import {
  addOutline,
  cardboardTexture,
  makeChevronTexture,
  outlineMaterial,
  paperMaterial,
  paperTexture,
} from './PaperMaterials';
import type { TrackTheme } from '../tracks/types';

/**
 * 纸艺场景件：全部由代码几何生成，强调"纸张厚度 / 拼接 / 层次 / 轮廓"。
 *
 * 造型原则（对照参考风格）：
 *  - 用少量平面折成的多面体，而不是光滑曲面 —— 折纸的棱线可见
 *  - 每片纸都有厚度：主体 + 一圈略大的深色背板形成轮廓与厚度
 *  - 层叠：山丘用多层剪影前后叠出景深
 */

export interface SceneryAssets {
  materials: {
    trunk: THREE.Material;
    leaf: THREE.Material;
    leafDark: THREE.Material;
    petal: THREE.Material;
    petalCore: THREE.Material;
    stem: THREE.Material;
    houseWall: THREE.Material;
    houseRoof: THREE.Material;
    houseWood: THREE.Material;
    window: THREE.Material;
    rock: THREE.Material;
    cloud: THREE.Material;
    hill: THREE.Material[];
    outline: THREE.Material;
  };
  geometries: {
    treeA: THREE.BufferGeometry;
    treeB: THREE.BufferGeometry;
    bush: THREE.BufferGeometry;
    flower: THREE.BufferGeometry;
    flowerStem: THREE.BufferGeometry;
    rock: THREE.BufferGeometry;
    cloud: THREE.BufferGeometry;
    fencePanel: THREE.BufferGeometry;
  };
}

function flat(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

/** 折纸树叶：由若干三角形纸片折成的锥体，边缘不规则。 */
function makeFoliage(rng: () => number, sides: number, layers: number, radius: number, height: number): THREE.BufferGeometry {
  const positions: number[] = [];
  for (let l = 0; l < layers; l++) {
    const t = l / layers;
    const r = radius * (1 - t * 0.72) * range(rng, 0.9, 1.08);
    const y0 = height * t * 0.82;
    const y1 = y0 + height * (0.95 - t * 0.6) / layers * 1.5;
    for (let s = 0; s < sides; s++) {
      const a0 = (s / sides) * Math.PI * 2 + rng() * 0.15;
      const a1 = ((s + 1) / sides) * Math.PI * 2 + rng() * 0.15;
      const rr = r * range(rng, 0.88, 1.12);
      // 每个面片都是一片独立的纸：外沿两个点 + 顶部一个点
      positions.push(
        Math.cos(a0) * rr, y0, Math.sin(a0) * rr,
        Math.cos(a1) * rr, y0, Math.sin(a1) * rr,
        0, y1, 0,
      );
      // 内侧折面，形成纸的厚度
      positions.push(
        Math.cos(a1) * rr, y0, Math.sin(a1) * rr,
        Math.cos(a0) * rr * 0.55, y0 + height * 0.06, Math.sin(a0) * rr * 0.55,
        0, y1, 0,
      );
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return flat(g);
}

/** 折纸树（针叶型）。 */
function makeConifer(rng: () => number): THREE.BufferGeometry {
  return makeFoliage(rng, 7, 4, 1.0, 2.6);
}

/** 折纸树（阔叶型）：一团由三角片组成的球。 */
function makeBroadleaf(rng: () => number): THREE.BufferGeometry {
  const positions: number[] = [];
  const rings = 3;
  const seg = 8;
  for (let r = 0; r < rings; r++) {
    const phi0 = (r / rings) * Math.PI;
    const phi1 = ((r + 1) / rings) * Math.PI;
    for (let s = 0; s < seg; s++) {
      const th0 = (s / seg) * Math.PI * 2;
      const th1 = ((s + 1) / seg) * Math.PI * 2;
      const p = (phi: number, th: number, scale: number) => [
        Math.sin(phi) * Math.cos(th) * scale,
        Math.cos(phi) * scale,
        Math.sin(phi) * Math.sin(th) * scale,
      ];
      const jitter = () => range(rng, 0.86, 1.14);
      const a = p(phi0, th0, jitter());
      const b = p(phi0, th1, jitter());
      const c = p(phi1, th1, jitter());
      const d = p(phi1, th0, jitter());
      positions.push(...a, ...b, ...c);
      positions.push(...a, ...c, ...d);
      // 加一层向外偏移的纸片，制造层叠纸张感
      positions.push(...a.map((v) => v * 1.06) as number[], ...b.map((v) => v * 1.06) as number[], ...c.map((v) => v * 1.06) as number[]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return flat(g);
}

/** 灌木：半球形的折纸片。 */
function makeBush(rng: () => number): THREE.BufferGeometry {
  const positions: number[] = [];
  const seg = 9;
  for (let s = 0; s < seg; s++) {
    const th0 = (s / seg) * Math.PI * 2;
    const th1 = ((s + 1) / seg) * Math.PI * 2;
    const r0 = range(rng, 0.7, 1.0);
    const r1 = range(rng, 0.7, 1.0);
    positions.push(
      Math.cos(th0) * r0, 0, Math.sin(th0) * r0,
      Math.cos(th1) * r1, 0, Math.sin(th1) * r1,
      0, range(rng, 0.55, 0.85), 0,
    );
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return flat(g);
}

/** 雏菊花：6–9 片纸花瓣 + 花心（在 XY 平面，朝向 +Z）。 */
function makeFlower(rng: () => number): THREE.BufferGeometry {
  const positions: number[] = [];
  const petals = 6 + Math.floor(rng() * 4);
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * Math.PI * 2;
    const w = 0.34;
    const len = range(rng, 1.5, 1.9);
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const px = -dy * w;
    const py = dx * w;
    // 花瓣：一个细长四边形折成两半
    positions.push(
      px * 0.4, py * 0.4, 0,
      dx * len, dy * len, 0.02,
      -px * 0.4, -py * 0.4, 0,
    );
    positions.push(
      px, py, 0,
      dx * len * 0.5, dy * len * 0.5, 0.06,
      -px, -py, 0,
    );
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return flat(g);
}

function makeCircleDisc(rng: () => number, radius: number, seg: number, wobble: number): THREE.BufferGeometry {
  const positions: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const r0 = radius * range(rng, 1 - wobble, 1 + wobble);
    const r1 = radius * range(rng, 1 - wobble, 1 + wobble);
    positions.push(
      Math.cos(a0) * r0, Math.sin(a0) * r0, 0,
      Math.cos(a1) * r1, Math.sin(a1) * r1, 0,
      0, 0, 0,
    );
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return flat(g);
}

/** 云：几个圆片叠成的手绘白云（朝 +Z 的平面片）。 */
function makeCloud(rng: () => number): THREE.BufferGeometry {
  const positions: number[] = [];
  const blobs = 4 + Math.floor(rng() * 3);
  for (let b = 0; b < blobs; b++) {
    const cx = (b - blobs / 2) * 0.55;
    const cy = range(rng, -0.12, 0.18);
    const r = range(rng, 0.5, 0.82);
    const seg = 10;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      positions.push(
        cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, 0,
        cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, 0,
        cx, cy, 0,
      );
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return flat(g);
}

/** 石头：不规则的折纸多面体。 */
function makeRock(rng: () => number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.55, 0);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) * range(rng, 0.7, 1.3),
      pos.getY(i) * range(rng, 0.5, 1.0),
      pos.getZ(i) * range(rng, 0.7, 1.3),
    );
  }
  return flat(g);
}

/** 栅栏板：一根带斜切顶的纸板条。 */
function makeFencePanel(): THREE.BufferGeometry {
  const positions: number[] = [];
  const w = 0.09;
  const h = 0.85;
  const quad = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
  ) => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    positions.push(ax, ay, az, cx, cy, cz, dx, dy, dz);
  };
  // 正面
  quad(-w, 0, 0.02, w, 0, 0.02, w, h - 0.12, 0.02, -w, h, 0.02);
  // 背面
  quad(w, 0, -0.02, -w, 0, -0.02, -w, h, -0.02, w, h - 0.12, -0.02);
  // 侧面（纸的厚度）
  quad(w, 0, 0.02, w, 0, -0.02, w, h - 0.12, -0.02, w, h - 0.12, 0.02);
  quad(-w, 0, -0.02, -w, 0, 0.02, -w, h, 0.02, -w, h, -0.02);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return flat(g);
}

/** 生成整套场景素材（每个赛道主题生成一次并复用）。 */
export function buildSceneryAssets(theme: TrackTheme, seed: number): SceneryAssets {
  const rng = createRng(seed);
  const paperMat = (color: number, key: string, opts: Partial<Parameters<typeof paperTexture>[0]> = {}) =>
    paperMaterial(color, {
      map: paperTexture({ color, seed: seed + key.length, fiber: 0.55, blotch: 0.4, creases: 1, key: `sc-${key}-${color}`, ...opts }),
    });

  return {
    materials: {
      trunk: paperMat(0x8a6a45, 'trunk', { fiber: 0.85 }),
      leaf: paperMat(theme.grass, 'leaf'),
      leafDark: paperMat(theme.grass, 'leafDark', { edgeShade: 0.5 }),
      petal: paperMat(theme.accent, 'petal', { blotch: 0.2, creases: 0 }),
      petalCore: paperMat(theme.accent2, 'petalCore', { blotch: 0.25, creases: 0 }),
      stem: paperMat(0x7fa84e, 'stem', { fiber: 0.8 }),
      houseWall: paperMat(0xe7dcc2, 'houseWall'),
      houseRoof: paperMat(theme.accent3, 'houseRoof'),
      houseWood: paperMat(0x9b6b45, 'houseWood'),
      window: new THREE.MeshToonMaterial({ color: 0x8fb8cf, gradientMap: undefined }),
      rock: paperMat(0xa9a396, 'rock', { fiber: 0.7 }),
      cloud: paperMaterial(0xfbf7ea),
      hill: [
        paperMaterial(0xa8cf86),
        paperMaterial(0x93c073),
        paperMaterial(0x7fae66),
      ],
      outline: outlineMaterial(0x3a3229),
    },
    geometries: {
      treeA: makeConifer(rng),
      treeB: makeBroadleaf(rng),
      bush: makeBush(rng),
      flower: makeFlower(rng),
      flowerStem: makeCircleDisc(rng, 0.05, 4, 0.1),
      rock: makeRock(rng),
      cloud: makeCloud(rng),
      fencePanel: makeFencePanel(),
    },
  };
}

// ---------------------------------------------------------------------------
// 单体构建函数（返回可直接加入场景的对象）
// ---------------------------------------------------------------------------

/** 一棵纸树：树干 + 折纸树冠 + 描边。 */
export function buildTree(
  assets: SceneryAssets,
  rng: () => number,
  type: 'conifer' | 'broadleaf',
  scale = 1,
): THREE.Group {
  const g = new THREE.Group();
  const trunkH = range(rng, 1.0, 1.6) * scale;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12 * scale, 0.18 * scale, trunkH * 1.18, 6),
    assets.materials.trunk,
  );
  // 树干整体上移一点，让顶端真正埋进树冠里（不要刚好停在树冠底面）
  trunk.position.y = (trunkH * 1.18) / 2;
  trunk.castShadow = true;
  g.add(trunk);

  const crownGeo = type === 'conifer' ? assets.geometries.treeA : assets.geometries.treeB;
  const crown = new THREE.Mesh(crownGeo, type === 'conifer' ? assets.materials.leaf : assets.materials.leafDark);
  const cs = range(rng, 0.85, 1.25) * scale * (type === 'conifer' ? 1.0 : 0.9);
  crown.scale.setScalar(cs);
  // 关键：针叶树冠的几何是从自己局部 y=0 往上长的，
  // 所以它必须放在树干**中段**（而不是树干顶再往上），否则会露出一截悬空的树干。
  crown.position.y = type === 'conifer' ? trunkH * 0.62 : trunkH * 0.78;
  crown.rotation.y = rng() * Math.PI * 2;
  crown.castShadow = true;
  g.add(crown);
  addOutline(crown, 0.045, g, assets.materials.outline);
  return g;
}

/** 一朵雏菊：绿色茎 + 花瓣朝上的花盘。 */
export function buildFlower(assets: SceneryAssets, rng: () => number): THREE.Group {
  const g = new THREE.Group();
  const h = range(rng, 0.5, 0.95);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, h, 5), assets.materials.stem);
  stem.position.y = h / 2;
  g.add(stem);

  const petal = new THREE.Mesh(assets.geometries.flower, assets.materials.petal);
  petal.scale.setScalar(range(rng, 0.20, 0.32));
  petal.position.y = h;
  // 花盘略微倾斜，朝向天空/侧面
  petal.rotation.set(-Math.PI / 2 + range(rng, -0.5, 0.5), rng() * Math.PI * 2, 0);
  g.add(petal);

  const core = new THREE.Mesh(new THREE.CircleGeometry(0.075, 8), assets.materials.petalCore);
  core.position.set(0, h + 0.012, 0);
  core.rotation.x = -Math.PI / 2;
  g.add(core);
  petal.add(core.clone());
  return g;
}

/** 玩具农舍：纸盒墙体 + 折角屋顶 + 门 + 窗 + 烟囱。 */
export function buildHouse(assets: SceneryAssets, rng: () => number, scale = 1): THREE.Group {
  const g = new THREE.Group();
  const w = range(rng, 4.2, 6.4) * scale;
  const d = range(rng, 3.4, 5.2) * scale;
  const h = range(rng, 2.4, 3.2) * scale;

  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), assets.materials.houseWall);
  wall.position.y = h / 2;
  wall.castShadow = true;
  g.add(wall);
  addOutline(wall, 0.03, g, assets.materials.outline);

  // 屋顶：两片斜纸板
  const roofH = range(rng, 1.3, 1.9) * scale;
  const roofGeo = new THREE.BufferGeometry();
  const hw = w / 2 + 0.22 * scale;
  const hd = d / 2 + 0.22 * scale;
  const verts = [
    -hw, 0, -hd, hw, 0, -hd, hw, 0, hd, -hw, 0, hd,
    0, roofH, -hd, 0, roofH, hd,
  ];
  const idx = [
    0, 2, 1, 0, 3, 2, // 底面（补齐厚度）
    0, 1, 4, // 前坡
    3, 5, 2, // 后坡
    1, 2, 5, 1, 5, 4, // 右侧山墙
    0, 4, 5, 0, 5, 3, // 左侧山墙
  ];
  roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  roofGeo.setIndex(idx);
  const roof = new THREE.Mesh(flat(roofGeo), assets.materials.houseRoof);
  roof.position.y = h;
  roof.castShadow = true;
  g.add(roof);
  addOutline(roof, 0.03, g, assets.materials.outline);

  // 门
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.9 * scale, 1.7 * scale, 0.1 * scale), assets.materials.houseWood);
  door.position.set(range(rng, -w / 4, w / 4), 0.85 * scale, d / 2 + 0.02);
  g.add(door);

  // 窗 + 十字窗棂
  const winCount = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < winCount; i++) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.8 * scale, 0.8 * scale, 0.1 * scale), assets.materials.window);
    win.position.set(range(rng, -w / 3, w / 3), h - 0.9 * scale, d / 2 + 0.02);
    g.add(win);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.86 * scale, 0.1 * scale, 0.12 * scale), assets.materials.houseWall);
    frame.position.copy(win.position);
    frame.position.z += 0.01;
    g.add(frame);
    const frame2 = new THREE.Mesh(new THREE.BoxGeometry(0.1 * scale, 0.86 * scale, 0.12 * scale), assets.materials.houseWall);
    frame2.position.copy(frame.position);
    g.add(frame2);
  }

  // 烟囱
  const chimney = new THREE.Mesh(
    new THREE.BoxGeometry(0.5 * scale, roofH * 0.9, 0.5 * scale),
    assets.materials.houseWood,
  );
  chimney.position.set(w / 3, h + roofH * 0.55, -d / 6);
  chimney.castShadow = true;
  g.add(chimney);

  g.rotation.y = rng() * Math.PI * 2;
  return g;
}

/** 层叠纸板山丘：几圈由小到大的剪影叠在一起，形成层次。 */
export function buildCardboardHills(
  theme: TrackTheme,
  rng: () => number,
  width: number,
  height: number,
  layers = 4,
): THREE.Group {
  const g = new THREE.Group();
  const colors = [
    paperMaterial(0xb9d9a0),
    paperMaterial(0xa3cb86),
    paperMaterial(0x8bb970),
    paperMaterial(0x76a55e),
  ];
  void theme;
  for (let l = 0; l < layers; l++) {
    const t = l / Math.max(layers - 1, 1);
    const w = width * (1 - t * 0.22);
    const h = height * (0.6 + t * 0.55);
    const seg = 12;
    const positions: number[] = [];
    // 一条起伏的山脊剪影，挤出成薄纸板
    const ridge: Array<[number, number]> = [];
    for (let i = 0; i <= seg; i++) {
      const x = (i / seg - 0.5) * w;
      const bump = Math.sin((i / seg) * Math.PI) ** 0.7;
      const y = h * bump * range(rng, 0.75, 1.12) * 0.9 + h * 0.15;
      ridge.push([x, y]);
    }
    const zFront = -l * 18;
    const zBack = zFront - 2.2;
    for (let i = 0; i < seg; i++) {
      const [x0, y0] = ridge[i];
      const [x1, y1] = ridge[i + 1];
      // 前后面
      positions.push(x0, y0, zFront, x1, y1, zFront, x0, 0, zFront);
      positions.push(x1, y1, zFront, x1, 0, zFront, x0, 0, zFront);
      positions.push(x0, 0, zBack, x1, y1, zBack, x0, y0, zBack);
      positions.push(x1, 0, zBack, x1, y1, zBack, x0, 0, zBack);
      // 顶面（纸板厚度）
      positions.push(x0, y0, zFront, x1, y1, zFront, x1, y1, zBack);
      positions.push(x0, y0, zFront, x1, y1, zBack, x0, y0, zBack);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mesh = new THREE.Mesh(flat(geo), colors[l % colors.length]);
    mesh.position.z = zFront;
    g.add(mesh);
  }
  return g;
}

/** 手绘白云（平面纸片，永远面向摄像机所在方向由场景侧处理朝向）。 */
export function buildCloud(assets: SceneryAssets, rng: () => number, scale = 1): THREE.Mesh {
  const m = new THREE.Mesh(assets.geometries.cloud, assets.materials.cloud);
  m.scale.setScalar(range(rng, 4, 9) * scale);
  return m;
}

/**
 * 地标：大纸风车（雏菊草甸）。
 * 塔身由多段折纸棱台堆叠，叶片是可旋转的平面纸片。
 */
export function buildWindmill(theme: TrackTheme, seed: number): { group: THREE.Group; blades: THREE.Object3D } {
  const rng = createRng(seed);
  const group = new THREE.Group();
  const bodyMat = paperMaterial(0xf2e8cf, {
    map: paperTexture({ color: 0xf2e8cf, seed, fiber: 0.6, blotch: 0.35, creases: 1, key: 'windmill-body' }),
  });
  const roofMat = paperMaterial(theme.accent3);
  const bladeMat = paperMaterial(0xf7f2e2);
  const trimMat = paperMaterial(theme.accent2);

  // 塔身：4 段棱台，越往上越细（层叠纸板感）
  const segments = 5;
  let y = 0;
  let r = 3.2;
  for (let i = 0; i < segments; i++) {
    const h = 3.2;
    const rTop = r * 0.86;
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(rTop, r, h, 8, 1), bodyMat);
    seg.position.y = y + h / 2;
    seg.castShadow = true;
    group.add(seg);
    y += h;
    r = rTop;
  }
  // 塔身腰线
  for (let i = 1; i < segments; i++) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(3.25 - i * 0.22, 3.25 - i * 0.22, 0.22, 8), trimMat);
    ring.position.y = i * 3.2;
    group.add(ring);
  }

  // 顶帽
  const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 1.25, 2.6, 8), roofMat);
  cap.position.y = y + 1.3;
  cap.castShadow = true;
  group.add(cap);
  addOutline(cap, 0.035, group, outlineMaterial(0x3a3229));

  // 叶片：4 片大纸片 + 中央轴
  const blades = new THREE.Object3D();
  blades.position.set(0, y - 1.6, r * 0.92 + 0.4);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.0, 8), trimMat);
  hub.rotation.x = Math.PI / 2;
  blades.add(hub);
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Object3D();
    arm.rotation.z = (i / 4) * Math.PI * 2;
    const positions: number[] = [];
    // 叶片骨架：一片长梯形
    const L = 9.5;
    const wIn = 0.7;
    const wOut = 0.28;
    const quad = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number, zFront: number) => {
      positions.push(ax, ay, zFront, bx, by, zFront, cx, cy, zFront);
      positions.push(ax, ay, zFront, cx, cy, zFront, dx, dy, zFront);
    };
    quad(wIn, 0.6, wOut, L, -wOut, L, -wIn, 0.6, 0.12);
    quad(-wIn, 0.6, -wOut, L, wOut, L, wIn, 0.6, -0.12);
    // 横向木条
    for (let k = 1; k <= 6; k++) {
      const t = k / 7;
      const yy = 0.6 + L * t;
      const hw = wIn + (wOut - wIn) * t;
      positions.push(-hw, yy, 0.16, hw, yy, 0.16, hw, yy + 0.18, 0.16);
      positions.push(-hw, yy, 0.16, hw, yy + 0.18, 0.16, -hw, yy + 0.18, 0.16);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const blade = new THREE.Mesh(flat(geo), i % 2 === 0 ? bladeMat : trimMat);
    blade.castShadow = true;
    arm.add(blade);
    blades.add(arm);
  }
  addOutline(hub, 0.05, blades, outlineMaterial(0x3a3229));
  group.add(blades);
  void rng;

  // 底座纸板
  const base = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 5.0, 0.5, 10), paperMaterial(0xb9cf8f));
  base.position.y = 0.25;
  base.receiveShadow = true;
  group.add(base);

  return { group, blades };
}

/** 纸箱障碍（可碰撞）：带折盖的纸板箱。 */
export function buildCrate(theme: TrackTheme, seed: number, size = 1.4): THREE.Mesh {
  const mat = paperMaterial(0xc79a63, {
    map: cardboardTexture(0xc79a63, seed),
  });
  void theme;
  const geo = new THREE.BoxGeometry(size, size * 0.9, size);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// 地图特色构件
// ---------------------------------------------------------------------------

/** 大谷仓：砖红屋顶 + 米白墙 + 双开门，作为次级地标。 */
export function buildBarn(assets: SceneryAssets, rng: () => number, scale = 1): THREE.Group {
  const g = new THREE.Group();
  const w = range(rng, 8.5, 11) * scale;
  const d = range(rng, 6.5, 8.5) * scale;
  const h = range(rng, 4.4, 5.6) * scale;

  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), assets.materials.houseWall);
  wall.position.y = h / 2;
  wall.castShadow = true;
  g.add(wall);
  addOutline(wall, 0.02, g, assets.materials.outline);

  // 双坡屋顶
  const roofH = range(rng, 2.6, 3.4) * scale;
  const hw = w / 2 + 0.4 * scale;
  const hd = d / 2 + 0.4 * scale;
  const verts = [
    -hw, 0, -hd, hw, 0, -hd, hw, 0, hd, -hw, 0, hd,
    0, roofH, -hd, 0, roofH, hd,
  ];
  const idx = [0, 2, 1, 0, 3, 2, 0, 1, 4, 3, 5, 2, 1, 2, 5, 1, 5, 4, 0, 4, 5, 0, 5, 3];
  const roofGeo = new THREE.BufferGeometry();
  roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  roofGeo.setIndex(idx);
  const roof = new THREE.Mesh(flat(roofGeo), assets.materials.houseRoof);
  roof.position.y = h;
  roof.castShadow = true;
  g.add(roof);
  addOutline(roof, 0.02, g, assets.materials.outline);

  // 白色门框 + 双开门
  const frame = new THREE.Mesh(new THREE.BoxGeometry(3.4 * scale, 3.6 * scale, 0.2 * scale), assets.materials.petal);
  frame.position.set(0, 1.8 * scale, d / 2 + 0.02);
  g.add(frame);
  for (const side of [-1, 1]) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.5 * scale, 3.3 * scale, 0.24 * scale), assets.materials.houseRoof);
    door.position.set(side * 0.8 * scale, 1.65 * scale, d / 2 + 0.06);
    g.add(door);
  }
  // 山墙窗
  const win = new THREE.Mesh(new THREE.CircleGeometry(0.5 * scale, 12), assets.materials.window);
  win.position.set(0, h + roofH * 0.42, d / 2 + 0.06);
  g.add(win);
  g.rotation.y = rng() * Math.PI * 2;
  return g;
}

/** 干草堆：圆锥形纸卷 + 顶部纹理。 */
export function buildHaystack(assets: SceneryAssets, rng: () => number): THREE.Group {
  const g = new THREE.Group();
  const r = range(rng, 1.1, 1.7);
  const h = range(rng, 1.6, 2.3);
  const body = new THREE.Mesh(
    flat(new THREE.ConeGeometry(r, h, 9, 2)),
    paperMaterial(0xe0c07a, {
      map: paperTexture({ color: 0xe0c07a, seed: 7711, fiber: 1.0, blotch: 0.4, creases: 2, key: 'hay' }),
    }),
  );
  body.position.y = h / 2;
  body.castShadow = true;
  g.add(body);
  addOutline(body, 0.03, g, assets.materials.outline);
  // 顶上的小尖
  const tip = new THREE.Mesh(flat(new THREE.ConeGeometry(r * 0.28, h * 0.3, 7)), assets.materials.houseWood);
  tip.position.y = h + h * 0.12;
  g.add(tip);
  return g;
}

/** 纸片水塘：一块浅蓝纸片 + 深色纸边 + 几片草叶。 */
export function buildPond(
  rng: () => number,
  radius = 9,
  heightAt?: (x: number, z: number) => number,
): THREE.Group {
  const g = new THREE.Group();
  const seg = 14;
  const mkDisc = (r: number, lift: number, color: number, key: string) => {
    const positions: number[] = [];
    const h = (x: number, z: number) => (heightAt ? heightAt(x, z) : 0) + lift;
    const hc = h(0, 0);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const r0 = r * range(rng, 0.86, 1.14);
      const r1 = r * range(rng, 0.86, 1.14);
      // 每个顶点各自贴合地形，水面才会顺着地面起伏而不是斜插进去
      const x0 = Math.cos(a0) * r0;
      const z0 = Math.sin(a0) * r0;
      const x1 = Math.cos(a1) * r1;
      const z1 = Math.sin(a1) * r1;
      positions.push(
        x0, h(x0, z0), z0,
        x1, h(x1, z1), z1,
        0, hc, 0,
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mesh = new THREE.Mesh(
      flat(geo),
      paperMaterial(color, {
        map: paperTexture({ color, seed: 3311 + key.length, fiber: 0.5, blotch: 0.5, creases: 1, key: `pond-${key}` }),
        side: THREE.DoubleSide,
      }),
    );
    mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };
  // 深色纸边（下）→ 浅蓝水面（上），形成"纸片贴在桌上"的层次
  mkDisc(radius * 1.16, 0.02, 0x8fb0a4, 'bank');
  mkDisc(radius, 0.05, 0x9fc7db, 'water');
  return g;
}

/** 一段木栅栏：沿给定朝向排开若干栅栏板 + 横杆。 */
export function buildFenceRun(
  assets: SceneryAssets,
  rng: () => number,
  length: number,
  heightAt?: (x: number, z: number) => number,
  panelSpacing = 1.5,
): THREE.Group {
  const g = new THREE.Group();
  const count = Math.max(2, Math.round(length / panelSpacing));
  const railMat = paperMaterial(0xb98a5c);
  const baseY = (x: number, z: number) => (heightAt ? heightAt(x, z) : 0);
  for (let i = 0; i < count; i++) {
    const px = (i - (count - 1) / 2) * panelSpacing;
    const pz = range(rng, -0.03, 0.03);
    const panel = new THREE.Mesh(assets.geometries.fencePanel, assets.materials.houseWood);
    // 每根栅栏板各自贴地，否则长栅栏在坡上会一头悬空一头埋掉
    panel.position.set(px, baseY(px, pz), pz);
    panel.rotation.y = range(rng, -0.04, 0.04);
    panel.castShadow = true;
    g.add(panel);
  }
  // 两道横杆（分段跟随地形，避免长条盒子斜穿地面）
  const segs = Math.max(1, count - 1);
  for (const y of [0.28, 0.62]) {
    for (let i = 0; i < segs; i++) {
      const x0 = (i - (count - 1) / 2) * panelSpacing;
      const x1 = (i + 1 - (count - 1) / 2) * panelSpacing;
      const my = (baseY(x0, -0.045) + baseY(x1, -0.045)) / 2 + y;
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(panelSpacing * 1.02, 0.06, 0.035),
        railMat,
      );
      rail.position.set((x0 + x1) / 2, my, -0.045);
      g.add(rail);
    }
  }
  return g;
}

/** 弯道箭头牌：一根木柱 + 一块连续箭头纸牌。 */
export function buildChevronSign(
  theme: TrackTheme,
  direction: 1 | -1,
  seed: number,
): THREE.Group {
  const g = new THREE.Group();
  const postMat = paperMaterial(0x9b6b45, { map: cardboardTexture(0x9b6b45, seed) });
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.7, 0.14), postMat);
  post.position.y = 0.85;
  post.castShadow = true;
  g.add(post);
  const boardMat = new THREE.MeshBasicMaterial({
    map: makeChevronTexture(direction, 3),
    side: THREE.DoubleSide,
  });
  const board = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.85), boardMat);
  board.position.set(0, 1.55, 0.08);
  g.add(board);
  void theme;
  return g;
}
