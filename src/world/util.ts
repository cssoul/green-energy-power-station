import * as THREE from "three";
import { MeshBatcher } from "../core/batcher";
import type { MaterialSet } from "../core/materials";
import { measure, TwinRegistry, type NodeKind, type TwinNode } from "../core/registry";

/** 建节点的共同收尾：合批 → 挂进 Group → 量包围盒 → 注册到树。 */
export function finalizeNode(opts: {
  registry: TwinRegistry;
  id: string;
  kind: NodeKind;
  label: string;
  subtitle?: string;
  parentId: string | null;
  group: THREE.Group;
  batcher: MeshBatcher;
  revealShell?: boolean;
  drillable?: boolean;
  dataKey?: string;
  /** 包围盒额外向上/外扩，避免取景贴脸。 */
  boxPadding?: number;
}): { node: TwinNode; meshes: THREE.Mesh[]; box: THREE.Box3 } {
  const { meshes } = opts.batcher.build(opts.id);
  for (const m of meshes) opts.group.add(m);
  const box = measure(opts.group);
  if (opts.boxPadding) box.expandByScalar(opts.boxPadding);
  const node = opts.registry.add({
    id: opts.id,
    kind: opts.kind,
    label: opts.label,
    subtitle: opts.subtitle,
    parentId: opts.parentId,
    group: opts.group,
    meshes,
    box,
    pickable: true,
    revealShell: opts.revealShell ?? false,
    drillable: opts.drillable ?? true,
    dataKey: opts.dataKey,
  });
  // 射线拾取要能顺着任意子网格找到所属节点
  opts.group.traverse((o) => {
    o.userData.nodeId = opts.id;
  });
  return { node, meshes, box };
}

/** 建一个空分组，统一命名与矩阵策略（静态物体全部关闭 matrixAutoUpdate）。 */
export function makeGroup(name: string) {
  const g = new THREE.Group();
  g.name = name;
  return g;
}

/** 圆柱形设备的常用件：油枕、套管、母线筒。 */
export function addCylinder(
  b: MeshBatcher,
  surface: Parameters<MeshBatcher["add"]>[1],
  radius: number,
  height: number,
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
  segments = 12,
  shade = 1,
) {
  const geo = new THREE.CylinderGeometry(radius, radius, height, segments);
  b.add(geo, surface, { p: position, r: rotation }, { shade });
  geo.dispose();
}

/** 由若干点串成的导线 / 母线。 */
export function addCable(
  b: MeshBatcher,
  surface: Parameters<MeshBatcher["add"]>[1],
  points: [number, number, number][],
  radius = 0.09,
  shade = 1,
) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  const geo = new THREE.TubeGeometry(curve, Math.max(12, points.length * 6), radius, 4, false);
  b.add(geo, surface, {}, { shade });
  geo.dispose();
}

/** 设备基础墩。 */
export function addPad(
  b: MeshBatcher,
  x: number,
  z: number,
  w: number,
  d: number,
  y: number,
  shade = 0.9,
) {
  const geo = new THREE.BoxGeometry(w, 0.4, d);
  b.add(geo, "concrete", { p: [x, y + 0.2, z] }, { shade });
  geo.dispose();
}

export type { MaterialSet };
