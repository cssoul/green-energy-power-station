import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { NO_CAST, NO_RECEIVE, SURFACE_TILE, type MaterialSet, type SurfaceName } from "./materials";
import { placed, type Placement, type Vec3 } from "./geo";

/**
 * 分材质合批器。
 *
 * 一个可选单元（一个光伏阵列 / 一台储能柜 / 一座铁塔）用**一个独立的 Batcher**，
 * 这样它内部的几十上百个零件会被压成每种材质 1 个 Mesh —— 既能被单独选中高亮，
 * draw call 又只有个位数。
 *
 * 两件在这里一次性烘焙掉的事：
 *  - **世界单位 UV**：按顶点法线选主轴投影重算 uv，于是"1 张 tile = N 米"在整个场景
 *    成立，大构件与小构件上的纹理缝距一致（否则会出现"大字报配蚊蝇腿"）。
 *  - **廉价 AO**：法线朝下的顶点乘 0.74、朝上的乘 1，构件交接处自然变暗，不开 SSAO。
 */

export type AddOptions = {
  /** 亮度乘子，烘焙进顶点色。用来压暗底面、檐下、背光面。 */
  shade?: number;
  /** 一次性色彩偏移（逐通道乘子）。用来做同类构件的细微色差。 */
  tint?: Vec3;
};

export class MeshBatcher {
  private buckets = new Map<SurfaceName, THREE.BufferGeometry[]>();

  pieces = 0;

  constructor(private materials: MaterialSet) {}

  add(geometry: THREE.BufferGeometry, surface: SurfaceName, t: Placement = {}, opts: AddOptions = {}) {
    const g = placed(geometry, t);

    const tile = SURFACE_TILE[surface];
    if (tile) bakeWorldUV(g, tile);

    const pos = g.getAttribute("position");
    const nor = g.getAttribute("normal");
    const count = pos.count;
    const color = new Float32Array(count * 3);
    const shade = opts.shade ?? 1;
    const tint = opts.tint ?? [1, 1, 1];
    for (let i = 0; i < count; i++) {
      const ny = nor ? nor.getY(i) : 1;
      // smoothstep(-0.85 → 0.15) 把"朝下"映射到 0.74，"朝上/侧向"映射到 1。
      const k = smoothstep(-0.85, 0.15, ny);
      const occ = 0.74 + 0.26 * k;
      const f = shade * occ;
      color[i * 3] = tint[0] * f;
      color[i * 3 + 1] = tint[1] * f;
      color[i * 3 + 2] = tint[2] * f;
    }
    g.setAttribute("color", new THREE.BufferAttribute(color, 3));
    if (!g.getAttribute("uv")) {
      g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    for (const key of Object.keys(g.attributes)) {
      if (!["position", "normal", "uv", "color"].includes(key)) g.deleteAttribute(key);
    }

    let bucket = this.buckets.get(surface);
    if (!bucket) {
      bucket = [];
      this.buckets.set(surface, bucket);
    }
    bucket.push(g);
    this.pieces++;
    return this;
  }

  /** 一次提交一组几何（同一材质、同一变换）。 */
  addAll(geometries: THREE.BufferGeometry[], surface: SurfaceName, t: Placement = {}, opts: AddOptions = {}) {
    for (const g of geometries) this.add(g, surface, t, opts);
    return this;
  }

  get surfaces(): SurfaceName[] {
    return [...this.buckets.keys()];
  }

  /** 合并每个材质桶，产出 Mesh。调用方负责挂到场景 / 分组下。 */
  build(namePrefix: string): { meshes: THREE.Mesh[]; triangles: number } {
    const meshes: THREE.Mesh[] = [];
    let triangles = 0;
    for (const [surface, list] of this.buckets) {
      const combined = list.length === 1 ? list[0] : mergeGeometries(list, false)!;
      if (list.length > 1) list.forEach((g) => g.dispose());
      combined.computeBoundingSphere();
      combined.computeBoundingBox();
      const material = this.materials.get(surface);
      const mesh = new THREE.Mesh(combined, material);
      mesh.name = `${namePrefix}:${surface}`;
      // 材质名一律走 userData.surface。`name` 只是给人看的 —— 储能柜内部零件
      // 的名字是 `ess.03:stack1:frame` 这种三段式，靠 `name.split(":")[1]`
      // 反查会拿到 "stack1"，`materials.get()` 返回 undefined，
      // 于是 `mesh.material = undefined`，渲染器在 projectObject 里直接抛异常。
      mesh.userData.surface = surface;
      mesh.castShadow = !NO_CAST.includes(surface);
      mesh.receiveShadow = !NO_RECEIVE.includes(surface);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      const index = combined.getIndex();
      triangles += (index ? index.count : combined.getAttribute("position").count) / 3;
      meshes.push(mesh);
    }
    this.buckets.clear();
    return { meshes, triangles };
  }

  /**
   * 把一批 Mesh 在"基础材质"与"高亮材质"之间切换。
   * 高亮不是克隆材质，而是换成全局共享的 hot 变体 —— 材质总数保持在常数级。
   */
  static highlight(meshes: THREE.Mesh[], materials: MaterialSet, on: boolean) {
    for (const mesh of meshes) {
      const surface = surfaceOf(mesh);
      const hotMat = on ? materials.hotOf(surface) : undefined;
      const target = hotMat ?? materials.get(surface);
      if (mesh.material !== target) mesh.material = target;
    }
  }

  static hide(meshes: THREE.Mesh[], hidden: boolean) {
    for (const mesh of meshes) if (hidden) mesh.visible = false;
  }

  static dispose(meshes: THREE.Mesh[]) {
    for (const mesh of meshes) {
      mesh.geometry.dispose();
      mesh.removeFromParent();
    }
  }
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1e-6)));
  return t * t * (3 - 2 * t);
}

/** 按顶点法线选主轴，把世界坐标投影成 uv。于是 1 tile = `tile` 米。 */
function bakeWorldUV(g: THREE.BufferGeometry, tile: number) {
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  const count = pos.count;
  const uv = new Float32Array(count * 2);
  const inv = 1 / tile;
  for (let i = 0; i < count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const ax = nor ? Math.abs(nor.getX(i)) : 0;
    const ay = nor ? Math.abs(nor.getY(i)) : 1;
    const az = nor ? Math.abs(nor.getZ(i)) : 0;
    let u: number;
    let v: number;
    if (ay >= ax && ay >= az) {
      u = px;
      v = pz;
    } else if (ax >= az) {
      u = pz;
      v = py;
    } else {
      u = px;
      v = py;
    }
    uv[i * 2] = u * inv;
    uv[i * 2 + 1] = v * inv;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

/** 由若干包围盒组成的复合 Bounds（选中框架用）。 */
export function unionBoxes(boxes: THREE.Box3[]) {
  const out = new THREE.Box3();
  for (const b of boxes) out.union(b);
  return out;
}

/**
 * 反查一个 Mesh 用的是哪种材质名。
 *
 * 优先读 `userData.surface`（合批器与手动建 Mesh 时都会写）；
 * 退化路径才去解析 `name`（老式的 `<前缀>:<surface>` 命名）。
 * 手工建的 Mesh 请务必写 `userData.surface`，不要依赖 name 的段数。
 */
export function surfaceOf(mesh: THREE.Mesh): SurfaceName {
  const tagged = mesh.userData?.surface as SurfaceName | undefined;
  if (tagged) return tagged;
  return (mesh.name.split(":")[1] ?? "") as SurfaceName;
}
