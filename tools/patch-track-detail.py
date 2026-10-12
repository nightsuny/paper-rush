"""把地图特色构件接到赛道视图：谷仓/干草堆/水塘/栅栏/弯道箭头牌，
并把风车地标放大、移到能看见的位置。
运行： python tools/patch-track-detail.py
"""
import io, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
p = os.path.join(ROOT, 'src', 'scenery', 'TrackView.ts')
s = io.open(p, encoding='utf-8').read()

# 1) 引入新构件
s = s.replace(
    "import {\n  buildCardboardHills,\n  buildCloud,\n  buildCrate,\n  buildFlower,\n  buildHouse,\n  buildSceneryAssets,\n  buildTree,\n  buildWindmill,\n  type SceneryAssets,\n} from './Scenery';",
    "import {\n  buildBarn,\n  buildCardboardHills,\n  buildChevronSign,\n  buildCloud,\n  buildCrate,\n  buildFenceRun,\n  buildFlower,\n  buildHaystack,\n  buildHouse,\n  buildPond,\n  buildSceneryAssets,\n  buildTree,\n  buildWindmill,\n  type SceneryAssets,\n} from './Scenery';")

# 2) 装饰类型扩展
s = s.replace(
    "/** 沿赛道路肩外侧布置装饰的横向偏移（米）。 */",
    "/** 地图特色装饰区：在赛道外围成片摆放，决定地图的"性格"。 */\nconst FEATURE_ZONES: Array<{ from: number; to: number; side: 1 | -1; kind: 'fence' | 'hay' | 'barn' | 'pond' }> = [\n  { from: 0.015, to: 0.075, side: -1, kind: 'fence' },\n  { from: 0.04, to: 0.1, side: 1, kind: 'hay' },\n  { from: 0.2, to: 0.3, side: 1, kind: 'fence' },\n  { from: 0.24, to: 0.34, side: -1, kind: 'hay' },\n  { from: 0.36, to: 0.46, side: -1, kind: 'barn' },\n  { from: 0.5, to: 0.62, side: 1, kind: 'pond' },\n  { from: 0.62, to: 0.72, side: -1, kind: 'fence' },\n  { from: 0.74, to: 0.84, side: 1, kind: 'hay' },\n  { from: 0.86, to: 0.95, side: -1, kind: 'barn' },\n];\n\n/** 沿赛道路肩外侧布置装饰的横向偏移（米）。 */")

# 3) 在装饰函数末尾追加特色区 + 弯道箭头牌
anchor = "  return group;\n}\n\n/** 纸箱障碍"
addition = '''  // ---------------------------------------------------------------
  // 地图特色：栅栏成段、干草堆、谷仓、纸片水塘
  // ---------------------------------------------------------------
  for (const zone of FEATURE_ZONES) {
    const mid = (zone.from + zone.to) / 2;
    const smp = cl.sampleAt(mid);
    const lateral = zone.side * range(rng, smp.halfWidth + 12, smp.halfWidth + 26);
    const x = smp.x + smp.rx * lateral;
    const z = smp.z + smp.rz * lateral;
    if (cl.project(x, z).distance < smp.halfWidth + 4) continue;
    const y = placeOnGround(x, z);
    switch (zone.kind) {
      case 'fence': {
        const run = buildFenceRun(assets, rng, range(rng, 26, 46));
        run.position.set(x, y, z);
        run.rotation.y = Math.atan2(smp.tx, smp.tz);
        group.add(run);
        break;
      }
      case 'hay': {
        const n = 3 + Math.floor(rng() * 4);
        for (let i = 0; i < n; i++) {
          const hay = buildHaystack(assets, rng);
          hay.position.set(
            x + range(rng, -6, 6),
            placeOnGround(x + range(rng, -6, 6), z + range(rng, -6, 6)),
            z + range(rng, -6, 6),
          );
          group.add(hay);
        }
        break;
      }
      case 'barn': {
        const barn = buildBarn(assets, rng, range(rng, 0.95, 1.25));
        barn.position.set(x, y, z);
        group.add(barn);
        break;
      }
      case 'pond': {
        const pond = buildPond(rng, range(rng, 10, 16));
        pond.position.set(x, y, z);
        group.add(pond);
        break;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------
  // 弯道箭头牌：自动放在全场最急的几个弯外侧，既提示弯向也增加"有人设计过"的感觉
  // ---------------------------------------------------------------
  const cornerCandidates: Array<{ t: number; k: number }> = [];
  const scanStep = Math.max(1, Math.floor(cl.samples.length / 400));
  for (let i = 0; i < cl.samples.length; i += scanStep) {
    const smp = cl.samples[i];
    cornerCandidates.push({ t: smp.s / cl.totalLength, k: smp.curvature });
  }
  cornerCandidates.sort((a, b) => b.k - a.k);
  const chosen: number[] = [];
  for (const cand of cornerCandidates) {
    if (chosen.length >= 8) break;
    // 相邻 3% 内只放一个，避免在同一弯里插满牌子
    if (chosen.some((t) => Math.abs(t - cand.t) < 0.03)) continue;
    chosen.push(cand.t);
  }
  for (const t of chosen) {
    const smp = cl.sampleAt(t);
    // 箭头指向弯内：正曲率（左转）时箭头朝左
    const direction: 1 | -1 = smp.signedCurvature > 0 ? -1 : 1;
    const sign = cl.sampleAt(t);
    const lateral = -Math.sign(sign.signedCurvature || 1) * (sign.halfWidth + 4.2);
    const x = sign.x + sign.rx * lateral;
    const z = sign.z + sign.rz * lateral;
    const board = buildChevronSign(theme, direction, config.seed + Math.round(t * 997));
    board.position.set(x, placeOnGround(x, z), z);
    board.rotation.y = Math.atan2(sign.tx, sign.tz) + Math.PI;
    group.add(board);
  }

  return group;
}

/** 纸箱障碍'''
assert anchor in s
s = s.replace(anchor, addition, 1)

# 4) 风车地标：放大并放到起跑直道内侧可见处
s = s.replace(
    """  const windmill = buildWindmill(theme, config.seed + 23);
  const center = loopCenter(cl);
  windmill.group.position.set(center.x, track.terrain.heightAt(center.x, center.z), center.z);
  windmill.group.scale.setScalar(1.55);
  group.add(windmill.group);""",
    """  // 地标：大纸风车。放在起跑直道内侧、离赛道约 55 m 的位置，
  // 这样发车和回到起跑直道时都能看到它，远距离也能靠轮廓辨认。
  const windmill = buildWindmill(theme, config.seed + 23);
  const center = loopCenter(cl);
  const landmarkT = 0.045;
  const lmSample = cl.sampleAt(landmarkT);
  const lmInward = Math.sign(lmSample.signedCurvature || 1);
  const lmLat = -lmInward * 55;
  const lmX = lmSample.x + lmSample.rx * lmLat;
  const lmZ = lmSample.z + lmSample.rz * lmLat;
  windmill.group.position.set(lmX, track.terrain.heightAt(lmX, lmZ), lmZ);
  windmill.group.scale.setScalar(2.6);
  windmill.group.rotation.y = 0.6;
  group.add(windmill.group);""")

io.open(p, 'w', encoding='utf-8').write(s)
print('track view wired with map features')
