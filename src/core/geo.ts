import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** 可复用的几何工厂。所有返回值都是"可以被合批"的裸 BufferGeometry。 */

export type Vec3 = [number, number, number];

const cache = new Map<string, THREE.BufferGeometry>();

/** 带缓存的几何获取：同样的参数只造一次。 */
export function cached<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let g = cache.get(key) as T | undefined;
  if (!g) {
    g = make();
    cache.set(key, g);
  }
  return g;
}

export function clearGeoCache() {
  cache.forEach((g) => g.dispose());
  cache.clear();
}

/** 立方体。`min(w,h,d) >= 0.18` 时走带倒角的挤出体，让棱边能吃到一道高光。 */
export function box(w: number, h: number, d: number) {
  return cached(`box:${w},${h},${d}`, () => {
    if (Math.min(w, h, d) < 0.18) return new THREE.BoxGeometry(w, h, d);
    const r = Math.min(w, h, d) * 0.05;
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2 + r, -h / 2 + r);
    shape.lineTo(w / 2 - r, -h / 2 + r);
    shape.lineTo(w / 2 - r, h / 2 - r);
    shape.lineTo(-w / 2 + r, h / 2 - r);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: d - 2 * r,
      bevelEnabled: true,
      bevelThickness: r,
      bevelSize: r,
      bevelSegments: 1,
      steps: 1,
    });
    g.translate(0, 0, -d / 2 + r);
    return g;
  });
}

/** 直角平板（不做倒角，省三角面）。用于场地大板、道路、水面这类大面积薄板。 */
export function slab(w: number, h: number, d: number) {
  return cached(`slab:${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d, 1, 1, 1));
}

export function cylinder(top: number, bottom: number, height: number, segments = 12) {
  return cached(
    `cyl:${top},${bottom},${height},${segments}`,
    () => new THREE.CylinderGeometry(top, bottom, height, segments),
  );
}

export function cone(radius: number, height: number, segments = 12) {
  return cached(`cone:${radius},${height},${segments}`, () => new THREE.ConeGeometry(radius, height, segments));
}

export function sphere(radius: number, detail: number) {
  return cached(`sph:${radius},${detail}`, () => new THREE.SphereGeometry(radius, detail, Math.max(6, detail >> 1)));
}

/** 由一串点生成的管（母线、导线、坡道扶手）。 */
export function tube(points: Vec3[], radius: number, tubularSegments = 24, radialSegments = 5) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
  return new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false);
}

export type Placement = {
  p?: Vec3;
  /** 欧拉角（弧度） */
  r?: Vec3;
  s?: Vec3 | number;
};

const m = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const vP = new THREE.Vector3();
const vS = new THREE.Vector3();

/** 返回几何的一个"已变换"副本（深拷贝 + 矩阵烘焙）。 */
export function placed(geo: THREE.BufferGeometry, t: Placement): THREE.BufferGeometry {
  const out = geo.index ? geo.toNonIndexed() : geo.clone();
  e.set(...(t.r ?? [0, 0, 0]));
  q.setFromEuler(e);
  vP.set(...(t.p ?? [0, 0, 0]));
  const s = t.s ?? 1;
  if (typeof s === "number") vS.set(s, s, s);
  else vS.set(s[0], s[1], s[2]);
  m.compose(vP, q, vS);
  out.applyMatrix4(m);
  return out;
}

/** 就地变换（用于自己新造的几何，避免多余拷贝）。 */
export function transform(geo: THREE.BufferGeometry, t: Placement) {
  e.set(...(t.r ?? [0, 0, 0]));
  q.setFromEuler(e);
  vP.set(...(t.p ?? [0, 0, 0]));
  const s = t.s ?? 1;
  if (typeof s === "number") vS.set(s, s, s);
  else vS.set(s[0], s[1], s[2]);
  m.compose(vP, q, vS);
  geo.applyMatrix4(m);
  return geo;
}

/** 合并一组几何。自动补齐缺失的 uv / normal，避免 mergeGeometries 因属性集不一致而失败。 */
export function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = list.map((g) => {
    if (g.index) {
      const nonIndexed = g.toNonIndexed();
      g.dispose();
      return nonIndexed;
    }
    return g;
  });
  for (const g of clean) {
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    if (!g.getAttribute("uv")) {
      g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(g.getAttribute("position").count * 2), 2));
    }
  }
  if (clean.length === 1) return clean[0];
  const out = mergeGeometries(clean, false)!;
  clean.forEach((g, i) => {
    if (out !== g) void i;
  });
  clean.forEach((g) => g.dispose());
  return out;
}

/** 变换 + 合并的简写：`pieces([[boxGeo, {p:[...]}, ...]])`。 */
export function pieces(items: [THREE.BufferGeometry, Placement?][]): THREE.BufferGeometry {
  return merge(items.map(([g, t]) => (t ? placed(g, t) : placed(g, { s: 1 }))));
}

/**
 * 给"手工建的几何"补顶点色。
 *
 * 全场景的材质都开了 `vertexColors`（合批器把廉价 AO 烘焙进顶点色），所以
 * **任何绕过 `MeshBatcher` 直接建 Mesh 的几何都必须自带 color 属性**。
 * 缺它既不报错、也不会回落到白色 —— 整块直接渲成纯黑。这是本项目里最阴的
 * 一类静默失败：几何、包围盒、draw call 全部正常，只是"看起来是黑的"。
 * 储能区的 8 个 Pack、52 芯阵列、检修台板和柜内机架都这么黑过一轮。
 *
 * 默认按法线做一份与合批器一致的廉价 AO：朝下的顶点 ×0.74、朝上/侧向 ×1，
 * 所以手工件与合批件摆在一起不会有"一个亮一个哑"的接缝感。
 * 必须在几何的朝向**已经定稿之后**再调用（它读的是法线）。
 */
export function dressVertices(geo: THREE.BufferGeometry, tint: Vec3 = [1, 1, 1], gain = 1) {
  const pos = geo.getAttribute("position");
  if (!pos) return geo;
  const nor = geo.getAttribute("normal");
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const ny = nor ? nor.getY(i) : 1;
    const t = Math.min(1, Math.max(0, (ny + 0.85) / 1.0));
    const occ = 0.74 + 0.26 * (t * t * (3 - 2 * t));
    const f = gain * occ;
    col[i * 3] = tint[0] * f;
    col[i * 3 + 1] = tint[1] * f;
    col[i * 3 + 2] = tint[2] * f;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return geo;
}

/** 由二维轮廓拉出的棱柱（围栏立柱基础、坡道侧墙之类的异形件）。
 * 轮廓位于 XY 平面，沿 Z 拉伸 `depth`。
 */
export function extrude(points: [number, number][], depth: number) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** 圆角矩形轮廓拉出的薄板（数字孪生里"地贴轮廓"用）。 */
export function roundedRectShape(w: number, h: number, r: number) {
  const s = new THREE.Shape();
  const hw = w / 2;
  const hh = h / 2;
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - r, -hh);
  s.quadraticCurveTo(hw, -hh, hw, -hh + r);
  s.lineTo(hw, hh - r);
  s.quadraticCurveTo(hw, hh, hw - r, hh);
  s.lineTo(-hw + r, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - r);
  s.lineTo(-hw, -hh + r);
  s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  return s;
}

/** 轮廓 → 平铺在 XZ 平面上的面片（法线 +Y）。 */
export function flatShape(shape: THREE.Shape) {
  const g = new THREE.ShapeGeometry(shape, 8);
  g.rotateX(-Math.PI / 2);
  return g;
}
