import * as THREE from 'three';
import type { Car } from './Car';
import { createRng, range } from '../game/random';
import {
  addOutline,
  cardboardTexture,
  outlineMaterial,
  paperMaterial,
  paperTexture,
} from '../scenery/PaperMaterials';
import { WHEEL_COUNT, WHEEL_IS_FRONT, type VehicleSpec } from './VehicleSpec';

/**
 * 纸板玩具车外观。
 *
 * 组成（全部代码生成）：
 *  - 车身：分层纸盒（底盘盒 + 上盖 + 折角挡风板 + 侧裙），每层都有可见厚度
 *  - 车轮：低多边形八边形胎 + 纸轮毂 + 折纸轮辐
 *  - 悬挂连杆：可见的纸卷避震
 *  - 车手：折纸动物（熊/猫/兔/狐狸），坐在车里挥手/握方向盘
 *  - 描边：反向外壳，模拟手绘轮廓线
 *
 * 外观与车辆物理完全解耦：这里只读车辆状态，不写任何物理量。
 */

export type DriverSpecies = 'bear' | 'cat' | 'rabbit' | 'fox';

export interface DriverColors {
  fur: number;
  furDark: number;
  belly: number;
}

export const DRIVERS: Record<DriverSpecies, { name: string; colors: DriverColors }> = {
  bear: { name: '绒绒', colors: { fur: 0xb07a45, furDark: 0x8c5c32, belly: 0xf0dcc0 } },
  cat: { name: '煤球', colors: { fur: 0x5a5f6b, furDark: 0x40444e, belly: 0xd9dde4 } },
  rabbit: { name: '胡萝卜', colors: { fur: 0xf2ead8, furDark: 0xd8cdb6, belly: 0xfffaf0 } },
  fox: { name: '肉桂', colors: { fur: 0xd8833a, furDark: 0xb0632a, belly: 0xf7e6d0 } },
};

export interface CarVisual {
  root: THREE.Group;
  /** 更新车轮转动、转向角、车身姿态 */
  update: (dt: number, car: Car, wheelRoll: number[]) => void;
  dispose: () => void;
}

interface WheelVisual {
  pivot: THREE.Object3D;
  spin: THREE.Object3D;
  radius: number;
  front: boolean;
}

function flat(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

/**
 * 低多边形车轮。
 *
 * 轴向约定：车轮绕**局部 X 轴**旋转（与物理的车轴 axle = -X、以及
 * `spin.rotation.x` 一致）。因此轮胎圆环必须建在 YZ 平面、厚度沿 X 方向。
 * （早期版本把圆环建在 XY 平面、厚度沿 Z，等于整车车轮转了 90°。）
 */
function makeWheelGeometry(radius: number, width: number, sides = 10): {
  tire: THREE.BufferGeometry;
  tread: THREE.BufferGeometry;
  hub: THREE.BufferGeometry;
  spokes: THREE.BufferGeometry;
} {
  const hw = width / 2;
  const tirePos: number[] = [];
  const treadPos: number[] = [];

  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    // 圆环位于 YZ 平面
    const y0 = Math.cos(a0) * radius;
    const z0 = Math.sin(a0) * radius;
    const y1 = Math.cos(a1) * radius;
    const z1 = Math.sin(a1) * radius;

    // 胎面：外圈四边形带（厚度沿 X）
    treadPos.push(-hw, y0, z0, hw, y0, z0, hw, y1, z1);
    treadPos.push(-hw, y0, z0, hw, y1, z1, -hw, y1, z1);

    // 两侧胎壁：从外圈向内收一点，形成胎肩厚度
    const r2 = radius * 0.74;
    const iy0 = Math.cos(a0) * r2;
    const iz0 = Math.sin(a0) * r2;
    const iy1 = Math.cos(a1) * r2;
    const iz1 = Math.sin(a1) * r2;
    // 外侧胎壁（+X）
    tirePos.push(hw, y0, z0, hw, iy0, iz0, hw, iy1, iz1);
    tirePos.push(hw, y0, z0, hw, iy1, iz1, hw, y1, z1);
    // 内侧胎壁（-X）
    tirePos.push(-hw, iy0, iz0, -hw, y0, z0, -hw, y1, z1);
    tirePos.push(-hw, iy0, iz0, -hw, y1, z1, -hw, iy1, iz1);
  }

  const tire = new THREE.BufferGeometry();
  tire.setAttribute('position', new THREE.Float32BufferAttribute(tirePos, 3));
  const tread = new THREE.BufferGeometry();
  tread.setAttribute('position', new THREE.Float32BufferAttribute(treadPos, 3));

  // 轮毂：圆柱轴向沿 X
  const hubGeo = new THREE.CylinderGeometry(radius * 0.52, radius * 0.52, width * 1.08, sides);
  hubGeo.rotateZ(Math.PI / 2);
  const hub = flat(hubGeo);

  // 轮辐：五根纸条，贴在两侧轮毂面上
  const spokePos: number[] = [];
  const spokeCount = 5;
  for (const side of [1, -1]) {
    for (let i = 0; i < spokeCount; i++) {
      const a = (i / spokeCount) * Math.PI * 2;
      const w = 0.05 * radius;
      const len = radius * 0.62;
      const dy = Math.cos(a);
      const dz = Math.sin(a);
      const py = -dz * w;
      const pz = dy * w;
      const x = side * hw * 0.82;
      spokePos.push(x, py, pz, x, dy * len + py, dz * len + pz, x, -py, -pz);
      spokePos.push(x, py, pz, x, -py, -pz, x, dy * len - py, dz * len - pz);
    }
  }
  const spokes = new THREE.BufferGeometry();
  spokes.setAttribute('position', new THREE.Float32BufferAttribute(spokePos, 3));

  return { tire: flat(tire), tread: flat(tread), hub, spokes: flat(spokes) };
}

/** 折纸动物车手：头 + 耳朵 + 口鼻 + 身体 + 双臂。 */
function buildDriver(species: DriverSpecies, seed: number): { group: THREE.Group; armR: THREE.Object3D } {
  const rng = createRng(seed + species.length * 131);
  const info = DRIVERS[species];
  const c = info.colors;
  const fur = paperMaterial(c.fur, {
    map: paperTexture({ color: c.fur, seed, fiber: 0.6, blotch: 0.35, creases: 1, key: `fur-${species}-${c.fur}` }),
  });
  const furDark = paperMaterial(c.furDark);
  const belly = paperMaterial(c.belly);
  const dark = paperMaterial(0x2e2a24);

  const g = new THREE.Group();

  // 身体：一个略微收腰的纸盒
  const body = new THREE.Mesh(flat(new THREE.CylinderGeometry(0.20, 0.26, 0.42, 7)), fur);
  body.position.y = 0.21;
  body.castShadow = true;
  g.add(body);
  const bellyPatch = new THREE.Mesh(new THREE.CircleGeometry(0.13, 7), belly);
  bellyPatch.position.set(0, 0.2, 0.245);
  g.add(bellyPatch);

  // 头
  const head = new THREE.Mesh(flat(new THREE.IcosahedronGeometry(0.23, 0)), fur);
  head.position.y = 0.58;
  head.scale.set(1, 0.95, 1.02);
  head.castShadow = true;
  g.add(head);
  addOutline(head, 0.05, g, outlineMaterial(0x352f27));

  // 耳朵（按种族）
  const earMat = fur;
  if (species === 'bear') {
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(flat(new THREE.CylinderGeometry(0.085, 0.085, 0.05, 7)), earMat);
      ear.rotation.x = Math.PI / 2;
      ear.position.set(s * 0.15, 0.75, -0.02);
      g.add(ear);
    }
  } else if (species === 'cat' || species === 'fox') {
    for (const s of [-1, 1]) {
      const pos: number[] = [];
      const h = species === 'fox' ? 0.24 : 0.18;
      const w = species === 'fox' ? 0.11 : 0.1;
      // 三角形纸片 + 厚度
      pos.push(-w, 0, 0.02, w, 0, 0.02, 0, h, 0.02);
      pos.push(w, 0, -0.02, -w, 0, -0.02, 0, h, -0.02);
      pos.push(-w, 0, 0.02, 0, h, 0.02, 0, h, -0.02);
      pos.push(-w, 0, 0.02, 0, h, -0.02, -w, 0, -0.02);
      pos.push(w, 0, -0.02, 0, h, -0.02, 0, h, 0.02);
      pos.push(w, 0, -0.02, 0, h, 0.02, w, 0, 0.02);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const ear = new THREE.Mesh(flat(geo), species === 'fox' ? furDark : earMat);
      ear.position.set(s * 0.14, 0.72, 0);
      ear.rotation.z = s * 0.22;
      g.add(ear);
    }
  } else {
    // 兔子：两只长耳朵
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(flat(new THREE.CylinderGeometry(0.055, 0.075, 0.42, 6)), earMat);
      ear.position.set(s * 0.09, 0.94, -0.03);
      ear.rotation.z = s * 0.16;
      g.add(ear);
      const inner = new THREE.Mesh(new THREE.CircleGeometry(0.032, 6), belly);
      inner.position.set(s * 0.115, 0.95, 0.04);
      g.add(inner);
    }
  }

  // 口鼻
  const muzzle = new THREE.Mesh(flat(new THREE.ConeGeometry(0.09, 0.13, 6)), belly);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.set(0, 0.54, 0.22);
  g.add(muzzle);
  const nose = new THREE.Mesh(new THREE.CircleGeometry(0.026, 5), dark);
  nose.position.set(0, 0.55, 0.285);
  g.add(nose);

  // 眼睛
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.CircleGeometry(0.026, 6), dark);
    eye.position.set(s * 0.085, 0.63, 0.2);
    g.add(eye);
    const glint = new THREE.Mesh(new THREE.CircleGeometry(0.011, 5), paperMaterial(0xfffdf5));
    glint.position.set(s * 0.085 + 0.008, 0.64, 0.212);
    g.add(glint);
  }

  // 手臂：一只握方向盘，一只举起挥手
  const armL = new THREE.Mesh(flat(new THREE.CylinderGeometry(0.045, 0.05, 0.30, 6)), fur);
  armL.position.set(-0.24, 0.36, 0.12);
  armL.rotation.set(0.9, 0, 0.7);
  g.add(armL);
  const armR = new THREE.Mesh(flat(new THREE.CylinderGeometry(0.045, 0.05, 0.34, 6)), fur);
  armR.position.set(0.26, 0.52, 0.06);
  armR.rotation.set(-0.3, 0, -1.15);
  g.add(armR);

  // 围巾：一圈纸条
  const scarf = new THREE.Mesh(flat(new THREE.TorusGeometry(0.185, 0.028, 5, 9)), paperMaterial(0xd05a4e));
  scarf.rotation.x = Math.PI / 2;
  scarf.position.y = 0.4;
  g.add(scarf);
  void rng;
  void range;
  return { group: g, armR };
}

/**
 * 构建整车外观。
 * @param spec 车辆参数（用于按车身尺寸生成纸盒）
 */
export function buildCarVisual(
  spec: VehicleSpec,
  options: {
    species: DriverSpecies;
    bodyColor: number;
    accentColor: number;
    seed?: number;
    quality?: 'high' | 'low';
  },
): CarVisual {
  const seed = options.seed ?? 1234;
  const quality = options.quality ?? 'high';
  const root = new THREE.Group();
  const disposables: Array<() => void> = [];

  const bodyMat = paperMaterial(options.bodyColor, {
    map: paperTexture({
      color: options.bodyColor,
      seed,
      fiber: 0.6,
      blotch: 0.45,
      creases: 2,
      edgeShade: 0.25,
      key: `car-body-${options.bodyColor}`,
    }),
  });
  const accentMat = paperMaterial(options.accentColor);
  const cardboardMat = paperMaterial(0xc2a273, { map: cardboardTexture(0xc2a273, seed + 7) });
  const darkMat = paperMaterial(0x35302a);
  const outlineMat = outlineMaterial(0x2b2620);

  const hw = spec.bodyHalfWidth;
  const hl = spec.bodyHalfLength;
  const hh = spec.bodyHalfHeight;
  const originY = 0.0; // 视觉根节点位于刚体原点（重心高度）

  // ---------- 底盘纸盒 ----------
  const chassis = new THREE.Mesh(flat(new THREE.BoxGeometry(hw * 2, hh * 1.05, hl * 2)), cardboardMat);
  chassis.position.set(0, -0.13, 0.02);
  chassis.castShadow = true;
  root.add(chassis);

  // ---------- 车身外壳（略小的纸板壳，露出底盘边缘，形成层次） ----------
  const shell = new THREE.Mesh(flat(new THREE.BoxGeometry(hw * 1.9, hh * 0.72, hl * 1.82)), bodyMat);
  shell.position.set(0, -0.045, 0.01);
  shell.castShadow = true;
  root.add(shell);
  addOutline(shell, 0.035, root, outlineMat);

  // ---------- 折角挡风板 ----------
  const cowlPos: number[] = [];
  const w2 = hw * 0.86;
  const cowlH = 0.30;
  const zFront = hl * 0.62;
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    cowlPos.push(...a, ...b, ...c, ...a, ...c, ...d);
  };
  quad(
    [-w2, -0.02, zFront],
    [w2, -0.02, zFront],
    [w2 * 0.94, cowlH, zFront - 0.1],
    [-w2 * 0.94, cowlH, zFront - 0.1],
  );
  quad(
    [w2, -0.02, zFront],
    [-w2, -0.02, zFront],
    [-w2 * 0.94, cowlH, zFront - 0.1],
    [w2 * 0.94, cowlH, zFront - 0.1],
  );
  const cowlGeo = new THREE.BufferGeometry();
  cowlGeo.setAttribute('position', new THREE.Float32BufferAttribute(cowlPos, 3));
  const cowl = new THREE.Mesh(flat(cowlGeo), accentMat);
  cowl.castShadow = true;
  root.add(cowl);

  // ---------- 侧裙 / 纸板折边 ----------
  for (const s of [-1, 1]) {
    const skirt = new THREE.Mesh(flat(new THREE.BoxGeometry(0.045, 0.10, hl * 1.55)), accentMat);
    skirt.position.set(s * (hw * 0.97), -0.15, 0.0);
    root.add(skirt);
  }

  // ---------- 座椅 + 方向盘 ----------
  const seat = new THREE.Mesh(flat(new THREE.BoxGeometry(0.42, 0.20, 0.34)), darkMat);
  seat.position.set(0, 0.085, -0.16);
  root.add(seat);
  const wheelRing = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.022, 5, 10), darkMat);
  wheelRing.position.set(0, 0.30, 0.16);
  wheelRing.rotation.x = 0.35;
  root.add(wheelRing);
  const steerColumn = new THREE.Mesh(flat(new THREE.CylinderGeometry(0.022, 0.022, 0.3, 5)), cardboardMat);
  steerColumn.position.set(0, 0.2, 0.22);
  steerColumn.rotation.x = 0.5;
  root.add(steerColumn);

  // ---------- 车手 ----------
  const driver = buildDriver(options.species, seed + 61);
  driver.group.position.set(0, 0.02, -0.20);
  root.add(driver.group);
  const driverArmR = driver.armR;

  // ---------- 尾翼 / 前唇 ----------
  const wingPostGeo = new THREE.BoxGeometry(0.05, 0.22, 0.05);
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(flat(wingPostGeo), cardboardMat);
    post.position.set(s * hw * 0.6, 0.12, -hl * 0.86);
    root.add(post);
  }
  const wing = new THREE.Mesh(flat(new THREE.BoxGeometry(hw * 1.7, 0.035, 0.22)), accentMat);
  wing.position.set(0, 0.24, -hl * 0.88);
  root.add(wing);
  const splitter = new THREE.Mesh(flat(new THREE.BoxGeometry(hw * 1.8, 0.03, 0.18)), cardboardMat);
  splitter.position.set(0, -0.235, hl * 0.95);
  root.add(splitter);

  // ---------- 车轮 ----------
  const wheels: WheelVisual[] = [];
  const wheelGeo = makeWheelGeometry(spec.wheelRadius, spec.wheelWidth);
  const tireMat = paperMaterial(0x3b3733, {
    map: paperTexture({ color: 0x3b3733, seed: seed + 3, fiber: 0.8, blotch: 0.3, creases: 0, key: 'tire' }),
  });
  const treadMat = paperMaterial(0x2a2724, {
    map: paperTexture({ color: 0x2a2724, seed: seed + 9, fiber: 1.0, blotch: 0.2, creases: 0, key: 'tread' }),
  });
  const hubMat = paperMaterial(options.accentColor);
  const halfTrack = spec.trackWidth / 2;
  const halfBase = spec.wheelbase / 2;
  for (let i = 0; i < WHEEL_COUNT; i++) {
    const front = WHEEL_IS_FRONT[i];
    const side = i % 2 === 0 ? 1 : -1; // 本工程中车的右侧是 -X
    const pivot = new THREE.Object3D();
    pivot.position.set(side * halfTrack, -spec.suspensionRestLength + spec.targetStaticCompression, front ? halfBase : -halfBase);
    const spin = new THREE.Object3D();
    const tire = new THREE.Mesh(wheelGeo.tire, tireMat);
    const tread = new THREE.Mesh(wheelGeo.tread, treadMat);
    const hub = new THREE.Mesh(wheelGeo.hub, hubMat);
    const spokes = new THREE.Mesh(wheelGeo.spokes, darkMat);
    tire.castShadow = quality === 'high';
    tread.castShadow = quality === 'high';
    spin.add(tire);
    spin.add(tread);
    spin.add(hub);
    spin.add(spokes);
    pivot.add(spin);
    root.add(pivot);
    wheels.push({ pivot, spin, radius: spec.wheelRadius, front });
  }

  // 悬挂纸卷避震（可视）
  for (const w of wheels) {
    const shock = new THREE.Mesh(flat(new THREE.CylinderGeometry(0.035, 0.035, 0.24, 5)), cardboardMat);
    shock.position.copy(w.pivot.position);
    shock.position.y += 0.12;
    root.add(shock);
  }

  void originY;
  disposables.push(() => {
    wheelGeo.tire.dispose();
    wheelGeo.tread.dispose();
    wheelGeo.hub.dispose();
    wheelGeo.spokes.dispose();
    treadMat.dispose();
    bodyMat.dispose();
    accentMat.dispose();
    cardboardMat.dispose();
    darkMat.dispose();
    outlineMat.dispose();
    tireMat.dispose();
    hubMat.dispose();
  });

  let wave = 0;
  let lastRoll = 0;

  return {
    root,
    update: (dt, car, wheelRoll) => {
      const t = car.telemetry;
      // 转向：前轮绕 Y 轴
      const steerAngle = t.wheels.length > 0 ? car.vehicle.wheelSteering(0) ?? 0 : 0;
      for (const w of wheels) {
        if (w.front) w.pivot.rotation.y = steerAngle;
        const roll = wheelRoll[wheels.indexOf(w)] ?? 0;
        w.spin.rotation.x = roll;
      }
      void lastRoll;
      // 车身姿态：轻微俯仰与侧倾，来自真实物理量的视觉反馈
      const pitch = THREE.MathUtils.clamp(-t.longitudinalAccel * 0.004, -0.06, 0.06);
      const roll = THREE.MathUtils.clamp(t.lateralAccel * 0.0035, -0.07, 0.07);
      shell.rotation.x += (pitch - shell.rotation.x) * Math.min(1, dt * 8);
      shell.rotation.z += (roll - shell.rotation.z) * Math.min(1, dt * 8);
      // 车手挥手
      wave += dt * 3.2;
      driverArmR.rotation.z = -1.15 + Math.sin(wave) * 0.25;
      driver.group.rotation.z += (roll * 0.6 - driver.group.rotation.z) * Math.min(1, dt * 6);
    },
    dispose: () => {
      for (const d of disposables) d();
      root.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.geometry && !disposables.length) m.geometry.dispose();
      });
      root.clear();
    },
  };
}
