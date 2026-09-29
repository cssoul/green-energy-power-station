import * as THREE from "three";
import type { MaterialSet } from "./materials";
import { MeshBatcher } from "./batcher";

/**
 * 数字孪生的层级树。
 *
 * 节点即"可下钻的实体"：电站 → 分区 → 设备 → 部件 → 元件。每个节点自己持有
 * 场景 Group、自己的 Mesh 列表（用于高亮）、自己的包围盒（用于取景与轮廓框）。
 *
 * 相机、面板、面包屑全部由这棵树驱动，不要在各处硬编码 id。
 */

export type NodeKind =
  | "station"
  | "zone"
  | "pvFarm"
  | "pvBlock"
  | "combiner"
  | "inverter"
  | "essFarm"
  | "essCabinet"
  | "bmsStack"
  | "bmsCluster"
  | "bmsPack"
  | "pcs"
  | "ems"
  | "hvac"
  | "fire"
  | "comm"
  | "substation"
  | "transformer"
  | "gis"
  | "gantry"
  | "tower"
  | "transmission"
  | "building"
  | "vehicle"
  | "water"
  | "road";

/** 面板的分类配色，与场景中设备的实际涂装呼应。 */
export const KIND_META: Record<NodeKind, { label: string; color: string }> = {
  station: { label: "电站", color: "#1fb6d6" },
  zone: { label: "分区", color: "#8f9aa6" },
  pvFarm: { label: "光伏区", color: "#2f6fd0" },
  pvBlock: { label: "光伏阵列", color: "#2f6fd0" },
  combiner: { label: "直流汇流箱", color: "#3f8fd8" },
  inverter: { label: "逆变升压一体舱", color: "#e08a2e" },
  essFarm: { label: "储能区", color: "#24d6a8" },
  essCabinet: { label: "储能柜", color: "#24d6a8" },
  bmsStack: { label: "BMS 电池堆", color: "#17b98f" },
  bmsCluster: { label: "BMS 电池簇", color: "#12a07c" },
  bmsPack: { label: "电池 Pack", color: "#0d8163" },
  pcs: { label: "PCS 变流器", color: "#e0a52e" },
  ems: { label: "EMS 能量管理", color: "#7c8ce0" },
  hvac: { label: "温控系统", color: "#4fb8e8" },
  fire: { label: "消防系统", color: "#e0574f" },
  comm: { label: "通讯系统", color: "#a07ce0" },
  substation: { label: "升压变电站", color: "#ff9a3c" },
  transformer: { label: "主变压器", color: "#ff9a3c" },
  gis: { label: "GIS 配电楼", color: "#e0e3e0" },
  gantry: { label: "户外构架", color: "#b0b6bc" },
  tower: { label: "输电铁塔", color: "#ff4d4d" },
  transmission: { label: "高压输电线路", color: "#ff4d4d" },
  building: { label: "运维建筑", color: "#9aa4ae" },
  vehicle: { label: "运维车辆", color: "#e5b323" },
  water: { label: "生态水体", color: "#2c8fa0" },
  road: { label: "运维道路", color: "#7d848a" },
};

export type TwinNode = {
  id: string;
  kind: NodeKind;
  label: string;
  /** 面板标题下的副标题（型号、容量之类的静态信息）。 */
  subtitle?: string;
  parentId: string | null;
  childIds: string[];
  /** 场景中承载该节点的容器。 */
  group: THREE.Group;
  /** 高亮时切换材质引用的 Mesh（不含内部零件之外的东西）。 */
  meshes: THREE.Mesh[];
  /** 世界坐标包围盒，取景与轮廓框都用它。 */
  box: THREE.Box3;
  pickable: boolean;
  /** 选中时是否把外壳淡出以露出内部（储能柜 / 逆变舱）。 */
  revealShell: boolean;
  /** 关联到遥测树的键，例如 "pv.03" / "ess.01" / "ess.01.stack.02"。 */
  dataKey?: string;
  /** 允许的下钻深度（面包屑 & 双击进入）。 */
  drillable: boolean;
};

export class TwinRegistry {
  readonly nodes = new Map<string, TwinNode>();
  readonly root: TwinNode;
  /** 射线拾取的目标集合（已经剔除不可选与隐藏的）。 */
  readonly pickTargets: THREE.Object3D[] = [];

  constructor() {
    const group = new THREE.Group();
    group.name = "twin-root";
    this.root = {
      id: "station",
      kind: "station",
      label: "绿能光伏电站",
      subtitle: "120 MWp · 储能 40 MWh / 20 MW",
      parentId: null,
      childIds: [],
      group,
      meshes: [],
      box: new THREE.Box3(),
      pickable: false,
      revealShell: false,
      drillable: true,
    };
    this.nodes.set(this.root.id, this.root);
  }

  /**
   * `childIds` 由树自己维护，调用方可以不写（写了也会被忽略），
   * 避免每个建节点的函数都要背一个 `childIds: []` 的仪式。
   */
  add(node: Omit<TwinNode, "childIds"> & { childIds?: string[] }): TwinNode {
    const { childIds: _ignored, ...rest } = node;
    void _ignored;
    const full: TwinNode = { ...rest, childIds: [] };
    this.nodes.set(full.id, full);
    if (full.parentId) {
      const parent = this.nodes.get(full.parentId);
      if (parent) parent.childIds.push(full.id);
      else throw new Error(`未知父节点 ${full.parentId}（子节点 ${full.id}）`);
    } else {
      this.root.childIds.push(full.id);
    }
    if (full.pickable) this.pickTargets.push(full.group);
    return full;
  }

  get(id: string): TwinNode | undefined {
    return this.nodes.get(id);
  }

  /** 从根到该节点的 id 链，用于面包屑与"上级"导航。 */
  path(id: string): TwinNode[] {
    const chain: TwinNode[] = [];
    let cursor = this.nodes.get(id);
    while (cursor) {
      chain.unshift(cursor);
      cursor = cursor.parentId ? this.nodes.get(cursor.parentId) : undefined;
    }
    return chain;
  }

  children(id: string): TwinNode[] {
    const node = this.nodes.get(id);
    if (!node) return [];
    return node.childIds.map((c) => this.nodes.get(c)!).filter(Boolean);
  }

  /** 叶子到底的统计（面板脚注用）。 */
  stats() {
    let objects = 0;
    this.nodes.forEach((n) => {
      if (n.pickable) objects++;
    });
    return { nodes: this.nodes.size, objects };
  }

  dispose() {
    this.nodes.forEach((n) => {
      MeshBatcher.dispose(n.meshes);
    });
    this.nodes.clear();
  }
}

/** 世界包围盒（忽略隐藏对象），用于相机取景。 */
export function measure(object: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  object.updateWorldMatrix(true, true);
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const local = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
    box.union(local);
  });
  if (box.isEmpty()) box.setFromObject(object);
  return box;
}
