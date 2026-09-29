import * as THREE from "three";
import { EDGE, PLATFORM, PLATFORM_FADE, PLATFORM_Y, TERRAIN, WATER } from "../config";
import { blobRadius, fbm2D, makeRandom, smoothstep } from "../core/rng";
import type { MaterialSet } from "../core/materials";

/**
 * 地形：园区是**场平后的平台**（严格水平），平台之外是起伏草原。
 *
 * 为什么不做成"整个场景都是起伏地形"：园区里所有设备都要精确落位，一旦地基有起伏，
 * 每个 builder 都得在放置时采样高度，误差累积起来就是"储能柜浮空 / 组件沉进土里"。
 * 平台 + 外圈起坡既符合真实工程（光伏电站本来就先场平），又让所有 placement 都变成
 * 简单的常量 y。
 *
 * **底板是一张没有厚度的矩形面**（不再有下挂的侧壁裙板）：它是"从大地上裁下来的一块"，
 * 不是一件摆件实体。从俯视机位看只能看到草皮这一面，厚度带来的信息量是负的 ——
 * 一旦镜头压低，那圈侧壁会读成"这个园区悬在一个盒子上"。
 */

export type Terrain = {
  mesh: THREE.Mesh;
  /** 平台之外的高度采样。放置树木、围栏外侧立柱时用。 */
  heightAt(x: number, z: number): number;
  /** 是否落在平台（水平面）范围内。 */
  onPlatform(x: number, z: number): boolean;
};

/** 到平台矩形边界的带符号距离（正 = 在外面）。 */
function outsideDistance(x: number, z: number) {
  const dx = x < PLATFORM.x0 ? PLATFORM.x0 - x : x > PLATFORM.x1 ? x - PLATFORM.x1 : -1;
  const dz = z < PLATFORM.z0 ? PLATFORM.z0 - z : z > PLATFORM.z1 ? z - PLATFORM.z1 : -1;
  return Math.max(dx, dz);
}

/**
 * 地形高度 —— **造地形与"按地形放东西"共用这一个函数**。
 *
 * 三段合成：
 *   1. 平台内 → 严格水平（`PLATFORM_Y`）；
 *   2. 平台外 → fbm 丘陵 + 细节起伏，按 `PLATFORM_FADE` 从平台标高平滑过渡过去；
 *   3. **板边收平** → 距板边 20 m 之内把起伏压回 `PLATFORM_Y - 1.2`。
 *
 * 第 3 条是收板之后才需要的：底板四边只剩 ~22 m 的野草，如果不收，±10 m 的丘陵会
 * 直接把板边啃成锯齿，一块"裁下来的草地"就读成了"浮在空中的碎块"。
 */
function siteHeight(x: number, z: number) {
  const d = outsideDistance(x, z);
  if (d <= 0) return PLATFORM_Y;

  const hills = (fbm2D(x * 0.0034 + 12, z * 0.0034 - 7, 4) - 0.42) * 18;
  const detail = (fbm2D(x * 0.014, z * 0.014, 3) - 0.5) * 2.0;
  const rim = Math.min(x - EDGE.x0, EDGE.x1 - x, z - EDGE.z0, EDGE.z1 - z);
  const wild = PLATFORM_Y - 1.2 + (hills + detail) * smoothstep(0, 20, rim);

  const blend = smoothstep(0, PLATFORM_FADE, d);
  let y = PLATFORM_Y * (1 - blend) + wild * blend;
  // 平台边缘倒一个缓坡，避免出现一道"直角悬崖"
  if (d < 16) y -= smoothstep(0, 16, d) * 0.9;
  return y;
}

export function buildTerrain(materials: MaterialSet): Terrain {
  const { cx, cz, hx, hz, segments } = TERRAIN;
  const geometry = new THREE.PlaneGeometry(2 * hx, 2 * hz, segments, segments);
  geometry.rotateX(-Math.PI / 2);

  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const rand = makeRandom(90210);
  const tileMeters = 7;

  for (let i = 0; i < pos.count; i++) {
    // 把**世界坐标**直接烘进顶点（底板 Group 不动），这样 fbm 相位、顶点色分区、
    // UV 三处用的都是同一套坐标，不需要各自再加一次偏移。
    const x = pos.getX(i) + cx;
    const z = pos.getZ(i) + cz;
    pos.setX(i, x);
    pos.setZ(i, z);

    const d = outsideDistance(x, z);
    pos.setY(i, siteHeight(x, z));

    // ---- 顶点色：作为贴图的乘子，做"修剪草坪 / 野草 / 裸土 / 坡面"的分区 ----
    const detail = (fbm2D(x * 0.014, z * 0.014, 3) - 0.5) * 2.0;
    const patch = fbm2D(x * 0.02 + 3, z * 0.02 - 5, 3);
    const coarse = fbm2D(x * 0.005 - 2, z * 0.005 + 9, 2);
    let lum = 0.94 + patch * 0.22;
    let r = 1;
    let g = 1;
    let b = 1;

    if (d <= 0) {
      // 园区内：修剪草坪，色调统一略偏冷
      lum *= 1.02;
      g *= 1.01;
      r *= 0.95;
    } else {
      // 园区外：野草，偏黄绿且随 fbm 大块变化
      lum *= 0.93 + coarse * 0.2;
      r *= 0.98 + coarse * 0.14;
      b *= 0.9;
    }

    // 坡面裸土：坡度大的地方泛土黄
    const slope = Math.min(1, Math.abs(detail) * 0.3 + Math.abs(computeSlope(x, z)) * 1.6);
    if (slope > 0.1 && d > -12) {
      const k = smoothstep(0.1, 0.75, slope) * 0.5;
      r = r * (1 - k) + 1.22 * k;
      g = g * (1 - k) + 1.08 * k;
      b = b * (1 - k) + 0.78 * k;
    }

    // 大尺度明暗，让平原不至于"一马平川地均匀"
    const macro = 0.88 + fbm2D(x * 0.0016 + 30, z * 0.0016 + 41, 2) * 0.32;
    colors[i * 3] = r * lum * macro;
    colors[i * 3 + 1] = g * lum * macro;
    colors[i * 3 + 2] = b * lum * macro;

    uv.setXY(i, x / tileMeters, z / tileMeters);
  }

  pos.needsUpdate = true;
  uv.needsUpdate = true;
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, materials.get("grass"));
  mesh.name = "terrain";
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  void rand;

  return {
    mesh,
    onPlatform(x, z) {
      return outsideDistance(x, z) <= 0;
    },
    heightAt: siteHeight,
  };
}

/**
 * 坡度的粗略估计（有限差分）。只在造地形时调用一次。
 *
 * 用 `siteHeight` 而不是裸的 fbm —— 否则"裸土"会铺在平台展平后的缓坡上，
 * 出现"平地起裸土"的脏斑。
 */
function computeSlope(x: number, z: number) {
  const e = 6;
  const h1 = siteHeight(x + e, z) - siteHeight(x - e, z);
  return h1 / (2 * e);
}

/* ------------------------------------------------------------------ *
 * 生态水体（画面右下的湖泊）
 * ------------------------------------------------------------------ */

/** 两岸轮廓常量：水面轮廓 / 砾石压顶外沿。 */
const LAKE_RIM = 1.0;
const LAKE_BANK = 1.12;

/**
 * 湖不做地形开挖，而是"抬在平台上的景观水池"：砾石台 + 压顶石阶 + 略低于压顶的水面。
 *
 * **必须整座高于 `PLATFORM_Y`。** 园区平台是一整块水平不透光的板，任何低于它的
 * 东西都会被地形完全盖住 —— 之前水面写 `PLATFORM_Y - 0.65`，于是湖在画面里
 * 彻底消失（统计、包围盒、注册表全都正常，就是看不见）。
 *
 * 三层结构（从下到上）：
 *   1. 砾石台侧裙：`PLATFORM_Y → bankY`，把台面与草地之间的缝收掉；
 *   2. 压顶环（annulus）：半径 `LAKE_BANK → LAKE_RIM`，顶面在 `bankY`；
 *   3. 池壁 + 水面：水面在 `surfaceY`，与压顶顶面差出 0.2 m，形成清楚的池边。
 */
export function buildWater(materials: MaterialSet) {
  const group = new THREE.Group();
  group.name = "water-body";

  const segments = 96;
  const cx = WATER.center[0];
  const cz = WATER.center[2];
  const surfaceY = PLATFORM_Y + 0.06;
  const bankY = PLATFORM_Y + 0.26;

  /**
   * 世界坐标轮廓环，返回 (x, z)。**这是唯一的环真源** —— 岸线、池壁、
   * 水面都从这里取点，避免出现"岸线在水里、水面在站里"这种镜像错位。
   */
  const worldRing = (scale: number) => {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const r = blobRadius(a, 1.7);
      pts.push(
        new THREE.Vector2(cx + Math.cos(a) * WATER.rx * scale * r, cz + Math.sin(a) * WATER.rz * scale * r),
      );
    }
    return pts;
  };

  /**
   * 平躺环（供 ShapeGeometry 用）。**y 存的是 -z**：
   * `ShapeGeometry` 躺在 XY 平面上、法线 +Z，要让面朝上必须 `rotateX(-π/2)`，
   * 而那个变换把 (x, y) 映射成 (x, 0, **-y**)。所以这里预先把 z 取负。
   */
  const flatRing = (scale: number) => worldRing(scale).map((p) => new THREE.Vector2(p.x, -p.y));

  const shapeFrom = (pts: THREE.Vector2[]) => {
    const s = new THREE.Shape();
    s.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i].x, pts[i].y);
    s.closePath();
    return s;
  };

  /** 给平躺几何补顶点色与世界尺度 UV（1 tile = `div` 米）。 */
  const dress = (geo: THREE.BufferGeometry, tint: [number, number, number], div: number) => {
    const p = geo.getAttribute("position") as THREE.BufferAttribute;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      col[i * 3] = tint[0];
      col[i * 3 + 1] = tint[1];
      col[i * 3 + 2] = tint[2];
    }
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, p.getX(i) / div, p.getZ(i) / div);
  };

  /** 竖直环带（池壁 / 台侧裙）：沿 `scale` 轮廓从 `y0` 拉到 `y1`。 */
  const skirt = (scale: number, y0: number, y1: number, shade: number) => {
    const pts = worldRing(scale);
    const verts: number[] = [];
    const cols: number[] = [];
    for (let i = 0; i < segments; i++) {
      const p0 = pts[i];
      const p1 = pts[(i + 1) % segments];
      verts.push(p0.x, y0, p0.y, p1.x, y0, p1.y, p0.x, y1, p0.y);
      verts.push(p1.x, y0, p1.y, p1.x, y1, p1.y, p0.x, y1, p0.y);
      const near = shade * 1.06;
      const far = shade * 0.72;
      for (const c of [near, near, far, near, far, far]) {
        cols.push(c * 1.02, c, c * 0.94);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((verts.length / 3) * 2), 2));
    geo.computeVertexNormals();
    return geo;
  };

  // ---- 压顶环：砾石台顶面，中间挖出水面的洞 ----
  const bankShape = shapeFrom(flatRing(LAKE_BANK));
  bankShape.holes.push(new THREE.Path(flatRing(LAKE_RIM).reverse()));
  const bankGeo = new THREE.ShapeGeometry(bankShape, 24);
  bankGeo.rotateX(-Math.PI / 2);
  bankGeo.translate(0, bankY, 0);
  dress(bankGeo, [1.2, 1.04, 0.8], 4);
  const bank = new THREE.Mesh(bankGeo, materials.get("gravelYard"));
  bank.name = "lake-bank";
  bank.receiveShadow = true;

  // ---- 台侧裙：把砾石台和草地之间的竖缝收掉 ----
  const apron = new THREE.Mesh(skirt(LAKE_BANK, PLATFORM_Y, bankY, 0.5), materials.get("track"));
  apron.name = "lake-apron";
  apron.receiveShadow = true;

  // ---- 池壁：水面 → 压顶顶面，就是那圈 0.2 m 的池边石 ----
  const wall = new THREE.Mesh(skirt(LAKE_RIM, surfaceY, bankY, 0.36), materials.get("track"));
  wall.name = "lake-wall";

  // ---- 水面 ----
  const waterGeo = new THREE.ShapeGeometry(shapeFrom(flatRing(LAKE_RIM)), 24);
  waterGeo.rotateX(-Math.PI / 2);
  waterGeo.translate(0, surfaceY, 0);
  dress(waterGeo, [1, 1, 1], 22);
  const surface = new THREE.Mesh(waterGeo, materials.get("water"));
  surface.name = "lake-surface";
  surface.receiveShadow = false;

  group.add(apron, bank, wall, surface);
  group.traverse((o) => {
    o.matrixAutoUpdate = false;
    o.updateMatrix();
  });
  return { group, surface, bank };
}
