import * as THREE from 'three';
import type { Centerline } from './Centerline';
import type { TrackConfig } from './types';
import { fbm, smoothstep } from '../game/random';

/**
 * 地形（纸板台面 + 层叠卡纸丘陵）。
 *
 * 地形高度 = "把中心线高程摊平到整张地图的基底" + "远处的丘陵起伏"
 * 基底通过多次模糊得到，保证路面附近的草地平缓贴合，远处才出现纸板山丘。
 * 同一份顶点数据同时用于渲染网格与 Rapier 三角网格，视觉与碰撞完全一致。
 */

export interface TerrainData {
  /** 顶点坐标（x,y,z 交错） */
  vertices: Float32Array;
  indices: Uint32Array;
  /** 每个顶点到中心线的距离（米） */
  distances: Float32Array;
  /** 走廊挖空半径（米） */
  corridorCutRadius: number;
  /** 归一化 UV（0..1 覆盖整张地图） */
  uvs: Float32Array;
  /**
   * 逐顶点颜色（rgb 交错）。用"到最近道路的距离"在 nearColor / farColor 之间过渡：
   * 紧贴路面是被修剪过的草，向外逐渐变成野地。
   * 这样地面是**一张连续的东西**，不会在路堤外沿出现"两块模型拼起来"的颜色断层。
   */
  colors?: Float32Array;
  /** 网格分辨率（每边的格子数） */
  resolution: number;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  /** 世界坐标 → 地形高度（与网格一致，双线性插值） */
  heightAt: (x: number, z: number) => number;
}

export interface TerrainOptions {
  /** 地面过渡的近端颜色（紧贴路面） */
  groundNearColor?: number;
  /** 地面过渡的远端颜色（远离路面） */
  groundFarColor?: number;
  /** 过渡的距离区间（米），默认 [16, 64] */
  groundColorFade?: [number, number];
  /** 每边格子数（越大越精细） */
  resolution?: number;
  /** 地图相对赛道的额外外扩（米） */
  margin?: number;
  /**
   * 赛道走廊挖空半径（米）。该半径内的地形三角面会被整块剔除。
   *
   * 为什么必须挖空：地形是粗网格（格边长数米），而赛道走廊的高度沿路线持续变化，
   * 一个格子里的"扭转"会让三角面插值结果高出双线性高度，从而从路面里穿出来
   * （表现为轮胎射线打到草地、车被顶飞）。整块剔除比"抬高路面"更可靠。
   * 挖掉的区域由道路自带的路堤纸带覆盖。
   */
  corridorCutRadius?: number;
}

/** 一次"最近道路"查询的结果。 */
export interface TerrainRoadSample {
  /** 到最近路面的水平距离（米） */
  distance: number;
  /** 相对路面中心线的横向偏移（米，带符号） */
  lateral: number;
  /**
   * 用于计算走廊高度的横向偏移：夹紧到 ±路面半宽。
   * 超高只作用在路面宽度内，走廊地面不应该跟着倾斜。
   */
  bankLateral: number;
  /** 该处路面的中心高程（米） */
  roadY: number;
  /** 该处路面右向量的 y 分量（用于横向超高） */
  roadRy: number;
  /**
   * 用于"走廊挖空"判定的距离。正常等于 distance；
   * 但当查询点位于**开放路段端头之外**时返回 Infinity —— 端头外没有路面/路堤覆盖，
   * 如果照样挖空，就会在路的尽头挖出一个天坑，车开出去直接掉下去。
   */
  cutDistance: number;
  /**
   * 该处路面的不平整量（米）。地形走廊必须与路面**加同一个量**，
   * 否则土路往下颠的地方，地形会从路面里穿出来。
   */
  roadBump: number;
}

/**
 * 最近道路查询的抽象。
 * 单条闭合赛道由 `centerlineProjector` 提供；开放世界路网由 `networkProjector` 提供。
 * 地形的"走廊压平 + 走廊挖空"算法本身与此无关，因此可以完全复用。
 */
export interface TerrainProjector {
  sample(x: number, z: number): TerrainRoadSample;
  /** 所有道路采样点的包围盒 */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
}

/** 单条闭合赛道的投影器。 */
export function centerlineProjector(centerline: Centerline): TerrainProjector {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const s of centerline.samples) {
    minX = Math.min(minX, s.x);
    minZ = Math.min(minZ, s.z);
    maxX = Math.max(maxX, s.x);
    maxZ = Math.max(maxZ, s.z);
  }
  return {
    bounds: { minX, minZ, maxX, maxZ },
    sample(x, z) {
      const p = centerline.project(x, z);
      const s = centerline.samples[p.index];
      return {
        distance: p.distance,
        lateral: p.lateral,
        bankLateral: Math.max(-s.halfWidth, Math.min(s.halfWidth, p.lateral)),
        roadY: s.y,
        roadRy: s.ry,
        cutDistance: cutDistanceAt(centerline.samples, p.index, x, z, p.distance, centerline.closed),
        roadBump: 0,
      };
    },
  };
}

/**
 * 判断查询点是否落在开放路段的端头之外。
 * 若是，则该点**不该**被走廊挖空（那里没有路面覆盖），返回 Infinity。
 */
function cutDistanceAt(
  samples: ReadonlyArray<{ x: number; z: number; tx: number; tz: number }>,
  index: number,
  x: number,
  z: number,
  distance: number,
  closed: boolean,
): number {
  if (closed) return distance;
  const last = samples.length - 1;
  // 只有最近点落在端点上时才可能"越出跨度"
  if (index !== 0 && index !== last) return distance;
  const s = samples[index];
  const along = (x - s.x) * s.tx + (z - s.z) * s.tz;
  if (index === 0 && along < 0) return Number.POSITIVE_INFINITY;
  if (index === last && along > 0) return Number.POSITIVE_INFINITY;
  return distance;
}

/**
 * 地形生成核心。`config` 只需要地形与纸板厚度参数。
 */
export function buildTerrainFromProjector(
  projector: TerrainProjector,
  config: TerrainSourceSpec,
  opts: TerrainOptions = {},
): TerrainData {
  const resolution = opts.resolution ?? 168;
  const margin = opts.margin ?? 150;
  const cutRadius = opts.corridorCutRadius ?? 0;

  let minX = projector.bounds.minX - margin;
  let minZ = projector.bounds.minZ - margin;
  let maxX = projector.bounds.maxX + margin;
  let maxZ = projector.bounds.maxZ + margin;
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const cells = resolution;
  const cols = cells + 1;

  // 1) 基底：每个格点取最近中心线采样点的高程
  const base = new Float32Array(cols * cols);
  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < cols; i++) {
      const x = minX + (i / cells) * spanX;
      const z = minZ + (j / cells) * spanZ;
      base[i + j * cols] = projector.sample(x, z).roadY;
    }
  }

  // 2) 多次模糊，抹平"最近点跳变"造成的折痕
  const tmp = new Float32Array(cols * cols);
  for (let pass = 0; pass < 26; pass++) {
    for (let j = 0; j < cols; j++) {
      for (let i = 0; i < cols; i++) {
        let sum = 0;
        let n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= cols || jj >= cols) continue;
            sum += base[ii + jj * cols];
            n++;
          }
        }
        tmp[i + j * cols] = sum / n;
      }
    }
    base.set(tmp);
  }

  // 3) 路面走廊严格贴合路面平面，远处才是"基底 + 丘陵"
  //
  // 关键点：不能用模糊后的基底去撑路面附近的地形。模糊会把高差摊平，
  // 在长下坡上基底会高于真实路面，地形就会从路面里穿出来（轮胎射线打到草地）。
  // 因此走廊内直接用中心线的局部路面高度（含横向超高），只减去一点"纸板抬升量"。
  const heights = new Float32Array(cols * cols);
  const distances = new Float32Array(cols * cols);
  const wantColors = opts.groundNearColor !== undefined && opts.groundFarColor !== undefined;
  const colors = wantColors ? new Float32Array(cols * cols * 3) : undefined;
  const nearC = new THREE.Color(opts.groundNearColor ?? 0xffffff);
  const farC = new THREE.Color(opts.groundFarColor ?? 0xffffff);
  const [fadeA, fadeB] = opts.groundColorFade ?? [16, 64];
  const flatInner = config.width / 2 + 3;
  const flatOuter = flatInner + 26;
  // 只有离路够远才起丘陵，避免路边出现陡坡
  const hillsStart = flatInner + 26;
  const hillsEnd = hillsStart + 95;
  // 走廊下沉量：只要略低于路面（等于纸板厚度）即可。
  // 早先为了"保证地形不会从路面穿出"把 lip 抬到 0.34m，但那会在路段端头留下台阶；
  // 现在挖空已经承担了"地形不得进入走廊"的保证，lip 可以回到纸板厚度。
  const lip = Math.max(config.paperThickness + 0.02, 0.04);

  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < cols; i++) {
      const x = minX + (i / cells) * spanX;
      const z = minZ + (j / cells) * spanZ;
      const p = projector.sample(x, z);
      const d = p.distance;
      distances[i + j * cols] = p.cutDistance;
      // 紧贴路面的走廊高度：横向超高只算到路面半宽，再往外是水平地面
      const nearH = p.roadY + p.bankLateral * p.roadRy + p.roadBump - lip;
      const corridor = 1 - smoothstep(flatInner, flatOuter, d);
      // 丘陵：只有离赛道足够远才起伏，避免赛道旁边出现陡坡
      const hillMask = smoothstep(hillsStart, hillsEnd, d);
      // 三个尺度叠加：大尺度地貌（山脊/谷地，波长数百米）+ 中尺度丘陵 + 小起伏。
      // 之前只有后两项、且 terrainAmplitude 仅 2.2 m，所以放眼望去就是一张绿桌子 ——
      // 这是"地图不像地图"的主要来源。公路修在整平过的路基上，远处才起地形，符合现实。
      const landform =
        fbm(
          x * config.terrainScale * 0.32 + 41,
          z * config.terrainScale * 0.32 - 17,
          config.seed + 4409,
          3,
        ) *
        config.terrainAmplitude *
        2.4;
      const hills =
        landform +
        fbm(x * config.terrainScale, z * config.terrainScale, config.seed, 4) *
          config.terrainAmplitude *
          1.6 +
        fbm(x * config.terrainScale * 3.7 + 11, z * config.terrainScale * 3.7 - 5, config.seed + 991, 3) *
          config.terrainAmplitude *
          0.35;
      const farH = base[i + j * cols] + hills * hillMask;
      heights[i + j * cols] = nearH * corridor + farH * (1 - corridor);
      if (colors) {
        const k = smoothstep(fadeA, fadeB, d);
        const o = (i + j * cols) * 3;
        colors[o] = nearC.r + (farC.r - nearC.r) * k;
        colors[o + 1] = nearC.g + (farC.g - nearC.g) * k;
        colors[o + 2] = nearC.b + (farC.b - nearC.b) * k;
      }
    }
  }

  // 4) 构建顶点与索引
  const vertices = new Float32Array(cols * cols * 3);
  const uvs = new Float32Array(cols * cols * 2);
  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = i + j * cols;
      vertices[idx * 3] = minX + (i / cells) * spanX;
      vertices[idx * 3 + 1] = heights[idx];
      vertices[idx * 3 + 2] = minZ + (j / cells) * spanZ;
      uvs[idx * 2] = i / cells;
      uvs[idx * 2 + 1] = j / cells;
    }
  }
  // 剔除走廊内的格子：只要四个角里有一个在半径外就保留，
  // 这样留下的三角面最多只能伸进走廊 cutRadius - 格对角长 的位置。
  const quadList: number[] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = i + j * cols;
      const b = i + 1 + j * cols;
      const c = i + (j + 1) * cols;
      const d = i + 1 + (j + 1) * cols;
      if (
        cutRadius > 0 &&
        distances[a] < cutRadius &&
        distances[b] < cutRadius &&
        distances[c] < cutRadius &&
        distances[d] < cutRadius
      ) {
        continue;
      }
      quadList.push(a, b, c, d);
    }
  }
  const indices = new Uint32Array((quadList.length / 4) * 6);
  let ii = 0;
  for (let q = 0; q < quadList.length; q += 4) {
    const a = quadList[q];
    const b = quadList[q + 1];
    const c = quadList[q + 2];
    const d = quadList[q + 3];
    indices[ii++] = a;
    indices[ii++] = c;
    indices[ii++] = b;
    indices[ii++] = b;
    indices[ii++] = c;
    indices[ii++] = d;
  }

  const cellX = spanX / cells;
  const cellZ = spanZ / cells;
  const heightAt = (x: number, z: number): number => {
    const fx = (x - minX) / cellX;
    const fz = (z - minZ) / cellZ;
    const i = Math.min(Math.max(Math.floor(fx), 0), cells - 1);
    const j = Math.min(Math.max(Math.floor(fz), 0), cells - 1);
    const tx = Math.min(Math.max(fx - i, 0), 1);
    const tz = Math.min(Math.max(fz - j, 0), 1);
    const h00 = heights[i + j * cols];
    const h10 = heights[i + 1 + j * cols];
    const h01 = heights[i + (j + 1) * cols];
    const h11 = heights[i + 1 + (j + 1) * cols];
    return (
      (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
    );
  };

  return {
    vertices,
    indices,
    uvs,
    distances,
    ...(colors ? { colors } : {}),
    corridorCutRadius: cutRadius,
    resolution: cells,
    bounds: { minX, minZ, maxX, maxZ },
    heightAt,
  };
}

/** 地形生成只需要这些字段（TrackConfig 与 RegionConfig 都能满足）。 */
export interface TerrainSourceSpec {
  terrainAmplitude: number;
  terrainScale: number;
  seed: number;
  paperThickness: number;
  width: number;
}

/** 单条闭合赛道的地形（保持原有签名，现有调用与测试不受影响）。 */
export function buildTerrain(
  config: TrackConfig,
  centerline: Centerline,
  opts: TerrainOptions = {},
): TerrainData {
  return buildTerrainFromProjector(centerlineProjector(centerline), config, opts);
}

export function terrainToGeometry(data: TerrainData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.vertices, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  if (data.colors) g.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  g.setIndex(new THREE.BufferAttribute(data.indices, 1));
  g.computeVertexNormals();
  return g;
}
