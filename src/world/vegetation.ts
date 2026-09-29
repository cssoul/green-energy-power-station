import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { EDGE, PLATFORM, PLATFORM_FADE, PLATFORM_Y, PV_FARM_BOUNDS, WATER } from "../config";
import type { MaterialSet } from "../core/materials";
import type { TwinRegistry } from "../core/registry";
import { makeRandom, variation } from "../core/rng";
import type { Terrain } from "./terrain";
import { makeGroup } from "./util";

/**
 * 植被：白桦 / 阔叶行道树 + 外圈野生林 + 湖岸芦苇丛。
 *
 * 三条做法：
 *  1. **InstancedMesh。** 每棵树的姿态都不一样，合批做不到，只能实例化。树干、树冠、
 *     灌木各一个 InstancedMesh，整片植被只有 3~4 个 draw call。
 *  2. **逐实例色差。** `instanceColor` 给每棵树一点点明暗与黄绿偏移，否则几百棵同款
 *     树会像复制粘贴。
 *  3. **风摆烘在顶点上。** `aAnchor`（根部 0、梢部 1）写进几何，shader 里按世界坐标
 *     取相位 —— 相位必须来自 `instanceMatrix[3].xz`，用 instanceId 会让整排树同频抖动，
 *     看起来像贴图坏了。
 */

type TreeSpot = { x: number; z: number; y: number; scale: number; species: number; hue: number };

/**
 * 风摆 uniform 的收集器。
 *
 * `onBeforeCompile` 是懒编译的 —— 材质第一次真正进入渲染队列之前 `material.userData.shader`
 * 都是空的，所以不能在 tick 时去那里取。这里在注入的同时把 uniform 对象的引用存下来，
 * 每帧直接写 `uTime.value`，与编译时机无关。
 */
const swayUniforms: { uTime: { value: number } }[] = [];

/** 排除区：设备区、道路、水体上不种树。 */
const EXCLUDE: { x0: number; x1: number; z0: number; z1: number }[] = [
  { x0: PV_FARM_BOUNDS.x0 - 16, x1: PV_FARM_BOUNDS.x1 + 46, z0: PV_FARM_BOUNDS.z0 - 16, z1: PV_FARM_BOUNDS.z1 + 16 },
  { x0: -80, x1: 90, z0: 26, z1: 150 }, // 储能区
  { x0: 78, x1: 290, z0: -100, z1: 90 }, // 变电站
  { x0: 150, x1: 270, z0: -220, z1: -120 }, // 运维区
  { x0: -230, x1: -150, z0: 140, z1: 200 }, // 堆场
  { x0: WATER.center[0] - 120, x1: WATER.center[0] + 120, z0: WATER.center[2] - 90, z1: WATER.center[2] + 90 },
  { x0: 400, x1: 520, z0: -170, z1: -40 }, // 铁塔走廊
];

function excluded(x: number, z: number) {
  for (const e of EXCLUDE) {
    if (x > e.x0 && x < e.x1 && z > e.z0 && z < e.z1) return true;
  }
  // 主干道
  if (Math.abs(z - 258) < 14) return true;
  // 环路两侧 5 m 内不种（避免树穿进路面）
  const onRingX = (Math.abs(x - (-290)) < 5 || Math.abs(x - 278) < 5) && z > -210 && z < 204;
  const onRingZ = (Math.abs(z - (-206)) < 5 || Math.abs(z - 200) < 5) && x > -294 && x < 282;
  if (onRingX || onRingZ) return true;
  if (Math.abs(z - 34) < 6 && x > -304 && x < 194) return true;
  return false;
}

export type VegetationBuild = {
  group: THREE.Group;
  /** 每帧推进风摆。 */
  tick(elapsed: number): void;
};

export function buildVegetation(materials: MaterialSet, terrain: Terrain, registry: TwinRegistry): VegetationBuild {
  const group = makeGroup("vegetation");
  const rand = makeRandom(31415);

  const spots: TreeSpot[] = [];
  const push = (x: number, z: number, species: number, scale: number) => {
    if (excluded(x, z)) return;
    spots.push({ x, z, y: terrain.heightAt(x, z), scale, species, hue: variation(x * 0.7 + z * 1.3) });
  };

  // ---- 环路与主干道的行道树（成排，间距均匀）----
  for (let i = 0; i < 96; i++) {
    const t = i / 95;
    const x = -286 + t * 560;
    push(x, -212 - rand() * 3, 0, 0.92 + rand() * 0.3);
    push(x + 6, 206 + rand() * 3, 0, 0.92 + rand() * 0.3);
  }
  for (let i = 0; i < 46; i++) {
    const t = i / 45;
    const z = -200 + t * 400;
    push(284 + rand() * 4, z, 0, 0.9 + rand() * 0.32);
    push(-296 - rand() * 4, z, 0, 0.9 + rand() * 0.32);
  }
  for (let i = 0; i < 72; i++) {
    // 沿主干道两侧的行道树，跨度跟着底板走
    const x = EDGE.x0 + 18 + i * ((EDGE.x1 - EDGE.x0 - 36) / 71);
    push(x, 240 - rand() * 3, 1, 1.0 + rand() * 0.4);
    push(x + 5, 276 + rand() * 4, 1, 1.0 + rand() * 0.4);
  }

  // ---- 外圈野生林：铺满平台之外的整块底板 ----
  // 用矩形散布而不是同心圆：底板是方的，圆环会在四角留下光秃秃的扇形。
  //
  // **株数是被绿化带面积反推出来的，不能照抄大底板的值。** 底板从 1160² 收到
  // 844×630 之后，平台之外只剩 ~6.2 万 m²（原来 ~61 万 m²，十分之一）；沿用 900 株
  // 等于把一条 8.8 m 间距的密林糊在板边，园区四面就成了绿墙。现取 240 株 ≈ 16 m 间距。
  for (let i = 0; i < 240; i++) {
    const x = EDGE.x0 + rand() * (EDGE.x1 - EDGE.x0);
    const z = EDGE.z0 + rand() * (EDGE.z1 - EDGE.z0);
    // 平台 + 过渡带之内不种（园区里另有零星绿化）
    if (
      x > PLATFORM.x0 - PLATFORM_FADE &&
      x < PLATFORM.x1 + PLATFORM_FADE &&
      z > PLATFORM.z0 - PLATFORM_FADE &&
      z < PLATFORM.z1 + PLATFORM_FADE
    )
      continue;
    push(x, z, rand() > 0.72 ? 1 : 0, 0.85 + rand() * 0.65);
  }
  // 站内零星绿化
  for (let i = 0; i < 120; i++) {
    const x = -300 + rand() * 580;
    const z = -230 + rand() * 460;
    if (x < EDGE.x0 || x > EDGE.x1 || z < EDGE.z0 || z > EDGE.z1) continue;
    push(x, z, 0, 0.8 + rand() * 0.35);
  }

  // ---- 湖岸白桦 ----
  // 池子在主干道**以南**，三条约束换来一个"只沿南岸与东西两端种"的环：
  //   - 北弧正对主干道，中间只有 2.7 m 净空 → 跳过（`sin(a) < 0.1`）；
  //   - r 的下限要盖过砾石压顶（1.12）；
  //   - 平台边界在 z = 330，出了就是坡地 → 夹 z ≤ 320、x 收在 232–462。
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2;
    if (Math.sin(a) < 0.1) continue;
    const r = 1.16 + rand() * 0.2;
    const x = WATER.center[0] + Math.cos(a) * WATER.rx * r;
    const z = WATER.center[2] + Math.sin(a) * WATER.rz * r;
    if (x > 462 || x < 232 || z > 320) continue;
    spots.push({ x, z, y: PLATFORM_Y - 0.1, scale: 0.85 + rand() * 0.4, species: 0, hue: variation(i * 7.3) });
  }

  // ---- 生成几何 ----
  const trunkGeo = buildTrunkGeometry();
  const canopyGeo = buildCanopyGeometry();
  const coniferGeo = buildConiferGeometry();

  const broad = spots.filter((s) => s.species === 0);
  const conifer = spots.filter((s) => s.species === 1);

  const trunkMat = makeSwayMaterial(materials.get("bark").clone(), 0.055);
  const canopyMat = makeSwayMaterial(materials.get("foliage").clone(), 0.16);
  const coniferMat = makeSwayMaterial(materials.get("foliage").clone(), 0.11);
  materials.register(trunkMat);
  materials.register(canopyMat);
  materials.register(coniferMat);

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
  const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, broad.length);
  const conifers = new THREE.InstancedMesh(coniferGeo, coniferMat, conifer.length);

  const write = (mesh: THREE.InstancedMesh, list: TreeSpot[], index: number, geoHeight: number) => {
    let n = 0;
    for (const s of list) {
      const yaw = (variation(s.x * 1.7 + s.z * 2.3) - 0.5) * Math.PI;
      dummy.position.set(s.x, s.y - 0.2, s.z);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(s.scale, s.scale * (0.92 + s.hue * 0.2), s.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
      // 树冠/树干逐实例色差：黄绿 ↔ 深绿
      const k = s.hue;
      color.setRGB(0.86 + k * 0.34, 0.92 + k * 0.22, 0.78 + k * 0.2);
      mesh.setColorAt(n, color);
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    void index;
    void geoHeight;
  };

  write(trunks, spots, 0, 1);
  write(canopies, broad, 0, 1);
  write(conifers, conifer, 0, 1);

  for (const m of [trunks, canopies, conifers]) {
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = true;
    group.add(m);
  }

  registry.add({
    id: "zone.green",
    kind: "zone",
    label: "绿化与生态",
    subtitle: `${spots.length} 株乔木 · 站区绿化带 · 湖岸生态`,
    parentId: "station",
    childIds: [],
    group,
    meshes: [trunks, canopies, conifers] as unknown as THREE.Mesh[],
    box: new THREE.Box3(
      new THREE.Vector3(EDGE.x0, PLATFORM_Y - 6, EDGE.z0),
      new THREE.Vector3(EDGE.x1, PLATFORM_Y + 20, EDGE.z1),
    ),
    pickable: false,
    revealShell: false,
    drillable: false,
  });

  // ---- 灌木 / 草丛 ----
  // 同样按缩小的底板调株数：2400 次抛点打在 10 万 m² 的平台外带上，420 株 ≈ 15 m 间距。
  const shrubGeo = buildShrubGeometry();
  const shrubMat = makeSwayMaterial(materials.get("shrub").clone(), 0.1);
  materials.register(shrubMat);
  const shrubs = new THREE.InstancedMesh(shrubGeo, shrubMat, 420);
  let sn = 0;
  for (let i = 0; i < 2400 && sn < 420; i++) {
    const x = EDGE.x0 + rand() * (EDGE.x1 - EDGE.x0);
    const z = EDGE.z0 + rand() * (EDGE.z1 - EDGE.z0);
    if (excluded(x, z)) continue;
    const s = 0.55 + rand() * 0.8;
    dummy.position.set(x, terrain.heightAt(x, z) - 0.1, z);
    dummy.rotation.set(0, rand() * Math.PI, 0);
    dummy.scale.set(s, s * (0.7 + rand() * 0.6), s);
    dummy.updateMatrix();
    shrubs.setMatrixAt(sn, dummy.matrix);
    color.setRGB(0.8 + rand() * 0.4, 0.9 + rand() * 0.24, 0.72 + rand() * 0.3);
    shrubs.setColorAt(sn, color);
    sn++;
  }
  shrubs.count = sn;
  shrubs.instanceMatrix.needsUpdate = true;
  if (shrubs.instanceColor) shrubs.instanceColor.needsUpdate = true;
  shrubs.castShadow = false;
  shrubs.receiveShadow = true;
  group.add(shrubs);

  // ---- 湖岸芦苇 ----
  const reedGeo = buildReedGeometry();
  const reeds = new THREE.InstancedMesh(reedGeo, shrubMat, 420);
  let rn = 0;
  for (let i = 0; i < 1400 && rn < 420; i++) {
    const a = rand() * Math.PI * 2;
    const r = 0.97 + rand() * 0.14;
    const x = WATER.center[0] + Math.cos(a) * WATER.rx * r;
    const z = WATER.center[2] + Math.sin(a) * WATER.rz * r;
    const s = 0.75 + rand() * 0.7;
    // 池体是抬在平台上的（水面 y = PLATFORM_Y + 0.06），芦苇基座要跟着抬，
    // 否则整丛会被砾石压顶吞掉。
    dummy.position.set(x, PLATFORM_Y - 0.3, z);
    dummy.rotation.set(0, rand() * Math.PI, 0);
    dummy.scale.set(s, s * (1 + rand() * 0.8), s);
    dummy.updateMatrix();
    reeds.setMatrixAt(rn, dummy.matrix);
    color.setRGB(0.86 + rand() * 0.3, 0.94 + rand() * 0.2, 0.6 + rand() * 0.24);
    reeds.setColorAt(rn, color);
    rn++;
  }
  reeds.count = rn;
  reeds.instanceMatrix.needsUpdate = true;
  if (reeds.instanceColor) reeds.instanceColor.needsUpdate = true;
  reeds.castShadow = false;
  group.add(reeds);

  return {
    group,
    tick(elapsed: number) {
      for (const u of swayUniforms) u.uTime.value = elapsed;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 几何
 * ------------------------------------------------------------------ */

/** 顶点上的摆动权重：根部 0、梢部 1。 */
function bakeAnchor(geo: THREE.BufferGeometry, height: number, power = 1.35) {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const anchor = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, Math.min(1, pos.getY(i) / height));
    anchor[i] = Math.pow(t, power);
  }
  geo.setAttribute("aAnchor", new THREE.BufferAttribute(anchor, 1));
  // `vertexColors: true` 的材质若配了没有 color 属性的几何，整片会渲染成纯黑。
  // 这里显式补一条全白的 color，逐实例色差交给 instanceColor 去乘。
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3));
  return geo;
}

/** 白桦树干：略呈锥形，带一点弯曲。 */
function buildTrunkGeometry() {
  const h = 6.4;
  const geo = new THREE.CylinderGeometry(0.16, 0.34, h, 7, 3);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const bend = Math.sin((y + h / 2) * 0.42) * 0.09;
    pos.setX(i, pos.getX(i) + bend);
    pos.setY(i, y + h / 2);
  }
  geo.computeVertexNormals();
  return bakeAnchor(geo, h, 1.5);
}

/** 阔叶树冠：三团球叠出蓬松的轮廓。 */
function buildCanopyGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const blobs: [number, number, number, number, number][] = [
    [0, 8.0, 0, 3.1, 0.78],
    [-1.7, 7.0, 0.9, 2.35, 0.72],
    [1.6, 7.3, -1.0, 2.5, 0.74],
    [0.4, 9.6, 0.5, 1.95, 0.7],
  ];
  for (const [x, y, z, r, squash] of blobs) {
    const g = new THREE.SphereGeometry(r, 8, 6);
    g.scale(1, squash, 1);
    g.translate(x, y, z);
    parts.push(g);
  }
  const merged = mergeAll(parts);
  return bakeAnchor(merged, 11.6, 2.1);
}

/** 针叶 / 杨树：细长圆锥。 */
function buildConiferGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const cone = new THREE.ConeGeometry(1.9, 10.5, 8, 3);
  cone.translate(0, 7.2, 0);
  parts.push(cone);
  const cone2 = new THREE.ConeGeometry(1.35, 6.0, 8, 2);
  cone2.translate(0, 11.4, 0);
  parts.push(cone2);
  const merged = mergeAll(parts);
  return bakeAnchor(merged, 14.4, 1.8);
}

/** 灌木：压扁的球丛。 */
function buildShrubGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  for (const [x, y, z, r] of [
    [0, 0.75, 0, 0.95],
    [-0.7, 0.55, 0.45, 0.7],
    [0.65, 0.6, -0.4, 0.75],
  ] as [number, number, number, number][]) {
    const g = new THREE.SphereGeometry(r, 6, 5);
    g.scale(1, 0.72, 1);
    g.translate(x, y, z);
    parts.push(g);
  }
  const merged = mergeAll(parts);
  return bakeAnchor(merged, 1.9, 1.2);
}

/** 芦苇：细长的扁平叶片丛。 */
function buildReedGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const g = new THREE.ConeGeometry(0.06, 1.7 + (i % 3) * 0.3, 4, 1);
    g.scale(1, 1, 0.35);
    g.rotateX(-0.16 - (i % 4) * 0.06);
    g.rotateY(a);
    g.translate(Math.cos(a) * 0.16, 1.0, Math.sin(a) * 0.16);
    parts.push(g);
  }
  const merged = mergeAll(parts);
  return bakeAnchor(merged, 2.3, 1.4);
}

function mergeAll(list: THREE.BufferGeometry[]) {
  const out = mergeGeometries(
    list.map((g) => g.toNonIndexed()),
    false,
  )!;
  list.forEach((g) => g.dispose());
  return out;
}

/**
 * 风摆着色器。注入到 clone 出来的材质上，原始材质保持不变。
 * 相位取自世界坐标（`instanceMatrix[3].xz`），整片林子的摆动因此不同步；
 * 用 instanceId 会让整排树同频抖动，看起来像贴图坏了。
 */
function makeSwayMaterial<T extends THREE.Material>(material: T, amplitude: number): T {
  const uniforms = { uTime: { value: 0 } };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader =
      "attribute float aAnchor;\nuniform float uTime;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec2 wp = instanceMatrix[3].xz;
        #else
          vec2 wp = vec2(0.0);
        #endif
        float phase = wp.x * 0.21 + wp.y * 0.17;
        float gust = 0.62 + 0.38 * sin(uTime * 0.27 + wp.x * 0.013 + wp.y * 0.009);
        float sway = sin(uTime * 1.35 + phase) * ${amplitude.toFixed(4)} * gust
                   + sin(uTime * 2.7 + phase * 1.9) * ${(amplitude * 0.34).toFixed(4)} * gust;
        transformed.x += sway * aAnchor;
        transformed.z += sway * 0.55 * aAnchor;`,
      );
  };
  // 源码变了，program cache key 必须跟着变，否则几个变体会共用同一个 program。
  material.customProgramCacheKey = () => `vegetation-sway-${amplitude}`;
  swayUniforms.push(uniforms);
  return material;
}
