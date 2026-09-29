import * as THREE from "three";
import { ESS, PLATFORM_Y, essCabinetCenter } from "../config";
import { MeshBatcher, surfaceOf } from "../core/batcher";
import { dressVertices, merge, slab } from "../core/geo";import type { MaterialSet } from "../core/materials";
import { measure, type TwinRegistry } from "../core/registry";
import { ELECTRICAL } from "../data/mock";
import { makeGroup } from "./util";

/**
 * 储能区 —— 全场景下钻层级最深的部分：
 *
 *   储能柜 ESS-01
 *     ├── BMS 电池堆 Stack-01 … Stack-05
 *     │     ├── BMS 电池簇 Cluster-01 … Cluster-10
 *     │     │     ├── Pack-01 … Pack-08
 *     │     │     │     └── 52 × Cell
 *     ├── PCS 变流器 / EMS 能量管理 / 温控系统 / 消防系统 / 通讯系统
 *
 * 三个关键工程决策：
 *  1. **内部结构懒加载。** 10 台柜 × (5 堆 × 10 簇 + 辅助系统) 若全部预建，是几千个
 *     Mesh。这里只在第一次下钻某台柜时才生成它的内部，且**所有柜共享同一份几何**
 *     （位置一模一样），只有 Mesh 对象是各柜自己的。
 *  2. **逐堆高亮，不是逐簇。** 每台柜的内部按"堆"合并成 2 个 Mesh（框架 + 簇抽屉），
 *     于是 5 个堆可以各自高亮/淡出，而 draw call 只有 10 个。簇这一层的空间定位交给
 *     **选中框 + 外扩展开的 8 个 Pack**，比把 50 个抽屉拆成 50 个 Mesh 便宜得多，
 *     视觉上"抽屉被抽出来"也比"某个抽屉变个颜色"清楚。
 *  3. **外壳淡出而不是隐藏。** 用半透明 ghost 材质换掉外壳，柜体体积感还在，
 *     内部结构像是"装在柜子里"而不是"柜子消失了"。
 */

const CAB = ESS.size; // [12.2, 3.3, 3.4]
const L = CAB[0];
const H = CAB[1];
const D = CAB[2];
const PLINTH_H = 0.42;
const INTERIOR_Y0 = PLINTH_H + 0.08;

const STACK_COUNT = ESS.stacksPerCabinet;
const CLUSTER_COUNT = ESS.clustersPerStack;
const PACK_COUNT = ESS.packsPerCluster;
const CELL_COUNT = ESS.cellsPerPack;

/** 机架：5 个电池堆沿 X 排开，正面朝 +Z（南，朝着轴测相机）。 */
const RACK_W = 1.6;
const RACK_PITCH = 1.78;
const RACK_X0 = -5.1;
const CLUSTER_W = 0.72;
const CLUSTER_H = 0.42;
const CLUSTER_D = 1.35;
const CLUSTER_ROW_Y = [0.82, 1.28, 1.74, 2.2, 2.66];
const CLUSTER_COL_X = [-0.42, 0.42];

/** 辅助系统在 +X 端的独立舱里。 */
const AUX_BAY_X = 4.5;

/* ---- 下钻展开的"检修台"参数 -------------------------------------- *
 *
 * 真实尺寸在整站尺度下是看不见的（一个 Pack 只有 0.72 m，一颗电芯 5.8 cm）。
 * 所以展开视图一律走**显示倍数**：这是数字孪生里通行的做法 ——
 * 拆解视图是示意图，不是等比模型，读得出来比量得准重要。
 */
/** 8 个 Pack 摊在检修台上的放大倍数。 */
const PACK_DISPLAY_SCALE = 1.55;
/** 52 芯阵列的放大倍数。 */
const CELL_DISPLAY_SCALE = 1.6;
/** 8 个 Pack 的排布：4 列 × 2 行"电池盘"。 */
const GRID_COLS = 4;
const GRID_ROWS = 2;
const GRID_PITCH_X = 1.34;
const GRID_PITCH_Z = 0.9;
/** 检修台中心离柜体前脸的距离（局部 z）。 */
const DECK_OFFSET_Z = D / 2 + 2.2;
/** 检修台台板厚度。 */
const DECK_H = 0.14;
/**
 * 储能区砾石场坪的**顶面**高度（柜体局部坐标，柜体原点在 PLATFORM_Y）。
 *
 * `roads.ts` 在 PLATFORM_Y 之上铺了一块 0.3 m 厚、中心在 `PLATFORM_Y + 0.02`
 * 的碎石场坪，所以场坪面实际落在 **+0.17**。检修台与 Pack 都必须从这条线往上
 * 摆 —— 按 PLATFORM_Y 摆会被场坪整个吞掉（台板直接消失，Pack 像沉进地里）。
 * 这是水平不透光平台上的老坑：低于场坪的东西不是"被挡住"，是根本不存在。
 */
const YARD_Y = 0.17;
/** Pack 平躺：长 × 厚 × 深。 */
const PACK_W = 0.72 * PACK_DISPLAY_SCALE;
const PACK_H = 0.19 * PACK_DISPLAY_SCALE;
const PACK_D = 0.44 * PACK_DISPLAY_SCALE;
const PACK_Y = YARD_Y + DECK_H + PACK_H / 2;

type AuxSpec = {
  key: string;
  label: string;
  surface: Parameters<MeshBatcher["add"]>[1];
  size: [number, number, number];
  p: [number, number, number];
  extras?: { surface: Parameters<MeshBatcher["add"]>[1]; size: [number, number, number]; p: [number, number, number] }[];
};

const AUX_SPECS: AuxSpec[] = [
  {
    key: "pcs",
    label: "PCS 储能变流器",
    surface: "containerDark",
    size: [1.72, 0.86, 1.3],
    p: [AUX_BAY_X, 1.0, 0],
    extras: [
      { surface: "louver", size: [1.4, 0.5, 0.06], p: [AUX_BAY_X, 1.0, 0.68] },
      { surface: "glowCool", size: [0.14, 0.14, 0.06], p: [AUX_BAY_X + 0.68, 1.3, 0.68] },
    ],
  },
  {
    key: "ems",
    label: "EMS 能量管理器",
    surface: "metalDark",
    size: [1.16, 0.62, 0.78],
    p: [AUX_BAY_X - 0.3, 1.86, -0.32],
    extras: [{ surface: "glowCool", size: [0.5, 0.06, 0.04], p: [AUX_BAY_X - 0.3, 1.86, 0.08] }],
  },
  {
    key: "comm",
    label: "通讯与测控单元",
    surface: "metalDark",
    size: [0.62, 0.5, 0.6],
    p: [AUX_BAY_X + 0.75, 1.82, -0.4],
    extras: [
      { surface: "copper", size: [0.05, 1.0, 0.05], p: [AUX_BAY_X + 0.75, 2.55, -0.4] },
      { surface: "glowCool", size: [0.06, 0.06, 0.06], p: [AUX_BAY_X + 0.75, 3.06, -0.4] },
    ],
  },
  {
    key: "hvac",
    label: "温控系统",
    surface: "metal",
    size: [1.72, 0.72, 1.3],
    p: [AUX_BAY_X, 2.46, 0],
    extras: [
      { surface: "louver", size: [1.5, 0.55, 0.06], p: [AUX_BAY_X, 2.46, 0.68] },
      { surface: "metalDark", size: [0.5, 0.5, 0.06], p: [AUX_BAY_X - 0.5, 2.46, 0.68] },
      { surface: "metalDark", size: [0.5, 0.5, 0.06], p: [AUX_BAY_X + 0.5, 2.46, 0.68] },
    ],
  },
  {
    key: "fire",
    label: "消防与气体灭火",
    surface: "glowRed",
    size: [0.5, 1.1, 0.42],
    p: [AUX_BAY_X + 0.95, 1.35, 0.55],
    extras: [
      { surface: "copper", size: [0.06, 0.5, 0.06], p: [AUX_BAY_X + 0.95, 2.15, 0.55] },
      { surface: "metalDark", size: [0.14, 0.14, 0.4], p: [AUX_BAY_X + 0.95, 2.4, 0.62] },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * 共享几何原型（全部柜共用一份）
 * ------------------------------------------------------------------ */

export type EssPrototype = {
  stackGeometry: { frame: THREE.BufferGeometry; clusters: THREE.BufferGeometry }[];
  /** 每个堆里 10 个电池簇的局部包围盒（选中框用）。 */
  clusterBoxes: THREE.Box3[][];
  aux: { key: string; label: string; geometry: THREE.BufferGeometry; surface: Parameters<MeshBatcher["add"]>[1]; center: THREE.Vector3; radius: number }[];
  /** 一个 Pack（52 芯的归纳视图） */
  packGeometry: THREE.BufferGeometry;
  /** 一个 Pack 拆开后的 52 个真实电芯（13 × 4，间隙放大到肉眼可数） */
  cellsGeometry: THREE.BufferGeometry;
  /** 52 芯阵列的托架 + 行隔板，让"4 行"成为可数结构。 */
  cellsFrameGeometry: THREE.BufferGeometry;
  /** 52 芯阵列的净尺寸（未乘显示倍数），供取景与包围盒使用。 */
  cellsArraySize: THREE.Vector3;
  /** 辅助系统之外，整个"内部"的包围盒。 */
  interiorBox: THREE.Box3;
};

let prototypeCache: EssPrototype | null = null;

export function buildEssPrototype(): EssPrototype {
  if (prototypeCache) return prototypeCache;

  const stackGeometry: EssPrototype["stackGeometry"] = [];
  const clusterBoxes: THREE.Box3[][] = [];

  for (let s = 0; s < STACK_COUNT; s++) {
    const rackX = RACK_X0 + s * RACK_PITCH;
    const frames: THREE.BufferGeometry[] = [];
    const clusters: THREE.BufferGeometry[] = [];
    const boxes: THREE.Box3[] = [];

    // 框架：4 根立柱 + 顶底横梁 + 5 层搁板前缘
    const postH = 2.5;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const post = new THREE.BoxGeometry(0.08, postH, 0.08);
        post.translate(rackX + sx * (RACK_W / 2 - 0.06), INTERIOR_Y0 + postH / 2, sz * (CLUSTER_D / 2 - 0.04));
        frames.push(post);
      }
    }
    for (const y of [INTERIOR_Y0, INTERIOR_Y0 + postH]) {
      const beam = new THREE.BoxGeometry(RACK_W, 0.09, 0.09);
      beam.translate(rackX, y, CLUSTER_D / 2 - 0.04);
      frames.push(beam);
      const beamBack = new THREE.BoxGeometry(RACK_W, 0.09, 0.09);
      beamBack.translate(rackX, y, -(CLUSTER_D / 2 - 0.04));
      frames.push(beamBack);
    }
    // 背面交叉斜撑
    const cross = new THREE.BoxGeometry(0.05, postH * 1.18, 0.05);
    cross.rotateZ(Math.atan2(RACK_W * 0.7, postH) * 0.82);
    cross.translate(rackX, INTERIOR_Y0 + postH / 2, -(CLUSTER_D / 2 - 0.04));
    frames.push(cross);

    // 10 个电池簇：2 列 × 5 行
    for (let i = 0; i < CLUSTER_COUNT; i++) {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const cx = rackX + CLUSTER_COL_X[col];
      const cy = INTERIOR_Y0 + CLUSTER_ROW_Y[row];
      const drawer = new THREE.BoxGeometry(CLUSTER_W, CLUSTER_H, CLUSTER_D);
      drawer.translate(cx, cy, 0);
      clusters.push(drawer);
      const half = new THREE.Vector3(CLUSTER_W / 2, CLUSTER_H / 2, CLUSTER_D / 2);
      boxes.push(new THREE.Box3(new THREE.Vector3(cx, cy, 0).sub(half), new THREE.Vector3(cx, cy, 0).add(half)));
    }

    // 机架与簇抽屉是绕过合批器直接建 Mesh 的，必须自带顶点色（见 dressVertices）。
    stackGeometry.push({
      frame: dressVertices(merge(frames), [1, 1, 1]),
      clusters: dressVertices(merge(clusters), [1, 1, 1]),
    });
    clusterBoxes.push(boxes);
  }

  // 辅助系统：每个模块单独一个几何，便于单独点击与高亮
  const aux = AUX_SPECS.map((spec) => {
    const parts: THREE.BufferGeometry[] = [];
    const main = new THREE.BoxGeometry(...spec.size);
    main.translate(...spec.p);
    parts.push(main);
    for (const ex of spec.extras ?? []) {
      const g = new THREE.BoxGeometry(...ex.size);
      g.translate(...ex.p);
      parts.push(g);
    }
    const geometry = dressVertices(merge(parts), [1, 1, 1]);
    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    geometry.boundingBox!.getCenter(center);
    const radius = geometry.boundingBox!.getSize(new THREE.Vector3()).length() / 2;
    return { key: spec.key, label: spec.label, geometry, surface: spec.surface, center, radius };
  });

  // 一个 Pack：0.72 长 × 0.19 厚 × 0.44 深。
  //
  // **这里是"平躺"约定**（长边沿 X、厚度沿 Y、进深沿 Z）。下钻视图里 Pack 一律
  // 摊在检修台上、52 芯那一面朝上 —— 相机因此可以从 ~53° 俯角正对着看这面，
  // 而不是隔着一个斜角去看一张立起来的板子。几何按最终朝向直接生成，
  // 省掉一层 `rotation.x`，也免得后面每处偏移都要在脑子里过一遍旋转矩阵。
  const pack = new THREE.BoxGeometry(0.72, 0.19, 0.44);
  const packGeometry = dressVertices(merge([pack]), [1, 1, 1]);

  // 一个 Pack 拆开的 52 个方形电芯：13 列 × 4 行，同样平躺。
  //
  // 间距是**刻意放大**的：真实 52 芯的极片间隙只有 ~3.5 mm，缩到整站尺度后
  // 会糊成一整块蓝砖，"52"这个数字就再也读不出来。这里把间隙做到 10 mm，
  // 并给阵列配一副托架 + 3 条行隔板 —— 于是 4 行 13 列一眼可数。
  const CELL_COLS = 13;
  const CELL_ROWS = 4;
  const cellW = 0.058;
  const cellH = 0.17;
  const cellD = 0.1;
  const cellPitchX = 0.068;
  const cellPitchZ = 0.128;
  const cellsCX = (CELL_COLS - 1) / 2;
  const cellsCZ = (CELL_ROWS - 1) / 2;
  const cellParts: THREE.BufferGeometry[] = [];
  for (let r = 0; r < CELL_ROWS; r++) {
    for (let c = 0; c < CELL_COLS; c++) {
      const g = new THREE.BoxGeometry(cellW, cellH, cellD);
      g.translate((c - cellsCX) * cellPitchX, 0, (r - cellsCZ) * cellPitchZ);
      cellParts.push(g);
    }
  }
  const cellsGeometry = dressVertices(merge(cellParts), [1.02, 1.04, 1.06]);

  const arrayW = (CELL_COLS - 1) * cellPitchX + cellW;
  const arrayD = (CELL_ROWS - 1) * cellPitchZ + cellD;
  const frameParts: THREE.BufferGeometry[] = [];
  const tray = new THREE.BoxGeometry(arrayW + 0.14, 0.06, arrayD + 0.14);
  tray.translate(0, -(cellH + 0.06) / 2 - 0.03, 0);
  frameParts.push(tray);
  for (let r = 0; r < CELL_ROWS - 1; r++) {
    const rail = new THREE.BoxGeometry(arrayW + 0.08, 0.024, 0.055);
    rail.translate(0, 0, (r - cellsCZ + 0.5) * cellPitchZ);
    frameParts.push(rail);
  }
  const cellsFrameGeometry = dressVertices(merge(frameParts), [0.86, 0.88, 0.92]);
  const cellsArraySize = new THREE.Vector3(arrayW, cellH, arrayD);

  const interiorBox = new THREE.Box3(
    new THREE.Vector3(-L / 2 + 0.2, INTERIOR_Y0 - 0.1, -D / 2 + 0.2),
    new THREE.Vector3(L / 2 - 0.2, INTERIOR_Y0 + 2.6, D / 2 - 0.2),
  );

  prototypeCache = { stackGeometry, clusterBoxes, aux, packGeometry, cellsGeometry, cellsFrameGeometry, cellsArraySize, interiorBox };
  return prototypeCache;
}

/* ------------------------------------------------------------------ *
 * 单台储能柜
 * ------------------------------------------------------------------ */

export class EssCabinet {
  readonly id: string;
  readonly index: number;
  readonly center: THREE.Vector3;
  readonly nodeId: string;
  readonly group: THREE.Group;
  /** 外壳（可淡出） */
  readonly shellMeshes: THREE.Mesh[] = [];
  /** 内部结构容器（懒加载） */
  inner: THREE.Group | null = null;
  private stackMeshes: THREE.Mesh[][] = [];
  private auxMeshes: { key: string; label: string; mesh: THREE.Mesh; center: THREE.Vector3; radius: number }[] = [];
  private detailGroup: THREE.Group | null = null;
  private detailMeshes: THREE.Mesh[] = [];
  /** 上一次展开生成的 Pack / Cell 节点，收起时要一并撤销注册。 */
  private detailNodeIds: string[] = [];
  private shellGhosted = false;

  constructor(
    index: number,
    private materials: MaterialSet,
    private registry: TwinRegistry,
    private proto: EssPrototype,
  ) {
    this.index = index;
    this.id = `ess.${String(index).padStart(2, "0")}`;
    const [x, , z] = essCabinetCenter(index - 1);
    this.center = new THREE.Vector3(x, PLATFORM_Y, z);
    this.group = makeGroup(this.id);
    this.group.position.copy(this.center);

    this.buildShell();
    this.nodeId = this.id;
  }

  private buildShell() {
    const b = new MeshBatcher(this.materials);
    const base = PLINTH_H;

    // 基础墩
    const plinth = new THREE.BoxGeometry(L + 0.5, PLINTH_H, D + 0.5);
    b.add(plinth, "concrete", { p: [0, PLINTH_H / 2, 0] }, { shade: 0.88 });
    plinth.dispose();

    // 柜体
    const body = new THREE.BoxGeometry(L, H - PLINTH_H - 0.22, D);
    b.add(body, "container", { p: [0, base + (H - PLINTH_H - 0.22) / 2, 0] });
    body.dispose();

    // 顶盖（略带出檐）
    const roof = new THREE.BoxGeometry(L + 0.5, 0.18, D + 0.4);
    b.add(roof, "metalRoof", { p: [0, H - 0.09, 0] });
    roof.dispose();

    // 正面两扇百叶检修门
    for (const dx of [-2.9, 2.9]) {
      const door = new THREE.BoxGeometry(5.3, 2.0, 0.1);
      b.add(door, "louver", { p: [dx, 1.78, D / 2 + 0.03] });
      door.dispose();
      const frame = new THREE.BoxGeometry(5.5, 2.14, 0.06);
      b.add(frame, "metal", { p: [dx, 1.78, D / 2 - 0.02] }, { shade: 0.9 });
      frame.dispose();
    }

    // 端面通风百叶（PCS 侧）
    const sideDoor = new THREE.BoxGeometry(0.1, 1.5, 2.4);
    b.add(sideDoor, "louver", { p: [L / 2 + 0.03, 1.9, 0] });
    sideDoor.dispose();

    // 柜顶走线槽与直流母线箱
    const cableBox = new THREE.BoxGeometry(2.2, 0.5, 1.2);
    b.add(cableBox, "metalDark", { p: [-4.0, H + 0.15, -0.7] });
    cableBox.dispose();
    const busBox = new THREE.BoxGeometry(1.6, 0.42, 1.0);
    b.add(busBox, "metalDark", { p: [3.6, H + 0.1, -0.7] });
    busBox.dispose();

    // 铭牌 + 状态灯
    const plate = new THREE.BoxGeometry(2.6, 0.5, 0.06);
    b.add(plate, "sign", { p: [-4.0, 2.98, D / 2 + 0.05] });
    plate.dispose();
    const lamp = new THREE.BoxGeometry(0.22, 0.22, 0.08);
    b.add(lamp, "glowCool", { p: [4.6, 2.98, D / 2 + 0.05] });
    lamp.dispose();
    const vent = new THREE.BoxGeometry(0.9, 0.34, 0.06);
    b.add(vent, "louver", { p: [4.6, 2.5, D / 2 + 0.04] });
    vent.dispose();

    const { meshes } = b.build(this.id);
    for (const m of meshes) {
      this.group.add(m);
      // 外壳中的柜体 / 门 / 顶盖可以被淡出，基础与铭牌不参与
      if (/container|containerDark|louver|metalRoof|metal$/.test(m.name)) this.shellMeshes.push(m);
    }
  }

  /** 生成内部结构（第一次下钻时调用）。几何全部来自共享原型。 */
  ensureInternals() {
    if (this.inner) return this.inner;
    const proto = this.proto;
    const inner = makeGroup(`${this.id}.inner`);
    inner.visible = false;

    this.stackMeshes = [];
    for (let s = 0; s < STACK_COUNT; s++) {
      const g = proto.stackGeometry[s];
      const frame = new THREE.Mesh(g.frame, this.materials.get("metalDark"));
      const clusters = new THREE.Mesh(g.clusters, this.materials.get("cluster"));
      frame.name = `${this.id}:stack${s + 1}:frame`;
      clusters.name = `${this.id}:stack${s + 1}:clusters`;
      // 内部零件的名字是多段式的，材质名必须显式标注（见 batcher.surfaceOf）。
      frame.userData.surface = "metalDark";
      clusters.userData.surface = "cluster";
      inner.add(frame, clusters);
      this.stackMeshes.push([frame, clusters]);
    }

    this.auxMeshes = [];
    for (const a of proto.aux) {
      const mesh = new THREE.Mesh(a.geometry, this.materials.get(a.surface));
      mesh.name = `${this.id}:aux:${a.key}`;
      mesh.userData.surface = a.surface;
      inner.add(mesh);
      this.auxMeshes.push({ key: a.key, label: a.label, mesh, center: a.center.clone(), radius: a.radius });
    }

    this.group.add(inner);
    this.inner = inner;

    const detail = makeGroup(`${this.id}.detail`);
    detail.visible = false;
    this.group.add(detail);
    this.detailGroup = detail;

    // 注册内部节点
    for (let s = 0; s < STACK_COUNT; s++) {
      const stackId = `${this.id}.stack.${String(s + 1).padStart(2, "0")}`;
      const stackGroup = makeGroup(stackId);
      this.stackMeshes[s].forEach((m) => stackGroup.add(m));
      inner.add(stackGroup);
      this.registry.add({
        id: stackId,
        kind: "bmsStack",
        label: `Battery Stack ${String(s + 1).padStart(2, "0")}`,
        subtitle: `${CLUSTER_COUNT} 簇 · ${CLUSTER_COUNT * PACK_COUNT} Pack · ${(CLUSTER_COUNT * PACK_COUNT * CELL_COUNT).toLocaleString("en-US")} Cells`,
        parentId: this.id,
        childIds: [],
        group: stackGroup,
        meshes: this.stackMeshes[s],
        box: this.stackBox(s),
        pickable: true,
        revealShell: false,
        drillable: true,
        dataKey: stackId,
      });

      // 电池簇这一级不建独立的 Mesh（会多出 50 个 draw call），
      // 拾取改走"射线 × 50 个 Box3"的解析法，见 pickCluster()。
      for (let c = 0; c < CLUSTER_COUNT; c++) {
        const clusterId = `${stackId}.cluster.${String(c + 1).padStart(2, "0")}`;
        const clusterGroup = makeGroup(clusterId);
        inner.add(clusterGroup);
        this.registry.add({
          id: clusterId,
          kind: "bmsCluster",
          label: `Cluster ${String(c + 1).padStart(2, "0")}`,
          subtitle: `${PACK_COUNT} Pack · ${PACK_COUNT * CELL_COUNT} Cells · ${ELECTRICAL.cluster.voltage} V`,
          parentId: stackId,
          childIds: [],
          group: clusterGroup,
          meshes: [],
          box: this.clusterBox(s, c),
          pickable: false,
          revealShell: false,
          drillable: true,
          dataKey: clusterId,
        });
      }
    }

    for (const a of this.auxMeshes) {
      const auxId = `${this.id}.aux.${a.key}`;
      const auxGroup = makeGroup(auxId);
      auxGroup.add(a.mesh);
      inner.add(auxGroup);
      const worldCenter = a.center.clone().add(this.center);
      const box = new THREE.Box3().setFromCenterAndSize(
        worldCenter,
        new THREE.Vector3(a.radius * 2, a.radius * 2, a.radius * 2),
      );
      this.registry.add({
        id: auxId,
        kind: a.key as "pcs",
        label: a.label,
        subtitle: "柜内集成 · 支持独立下钻",
        parentId: this.id,
        childIds: [],
        group: auxGroup,
        meshes: [a.mesh],
        box,
        pickable: true,
        revealShell: false,
        drillable: false,
        dataKey: this.id,
      });
    }

    return inner;
  }

  private stackBox(s: number) {
    const rackX = RACK_X0 + s * RACK_PITCH;
    const center = new THREE.Vector3(rackX, INTERIOR_Y0 + 1.3, 0).add(this.center);
    return new THREE.Box3().setFromCenterAndSize(
      center,
      new THREE.Vector3(RACK_W + 0.1, 2.6, CLUSTER_D + 0.15),
    );
  }

  /** 某个电池簇在世界坐标下的包围盒。 */
  clusterBox(stackIndex: number, clusterIndex: number) {
    const local = this.proto.clusterBoxes[stackIndex][clusterIndex];
    return local.clone().translate(this.center);
  }

  showInternals(on: boolean) {
    if (on) this.ensureInternals();
    if (this.inner) this.inner.visible = on;
    if (!on) this.setDetail(null);
  }

  /**
   * 切材质。`undefined` 一律拒绝赋值 —— 材质名对不上时宁可保持原样，
   * 也不能把 `mesh.material` 设成 undefined：WebGLRenderer 的 projectObject
   * 会读 `material.visible`，一崩就是整条渲染循环，画面直接冻住。
   */
  private swap(mesh: THREE.Mesh, target: THREE.Material | undefined) {
    if (target && mesh.material !== target) mesh.material = target;
  }

  /** 外壳淡出。 */
  ghostShell(on: boolean) {
    if (on === this.shellGhosted) return;
    this.shellGhosted = on;
    for (const mesh of this.shellMeshes) {
      const surface = surfaceOf(mesh);
      this.swap(mesh, on ? this.materials.ghostOf(surface) : this.materials.get(surface));
    }
  }

  /** 只让某个电池堆保持正常，其余降透明度。传 null 恢复。 */
  focusStack(index: number | null) {
    for (let s = 0; s < this.stackMeshes.length; s++) {
      for (const mesh of this.stackMeshes[s]) {
        const surface = surfaceOf(mesh);
        const dim = index !== null && s !== index;
        this.swap(
          mesh,
          dim
            ? this.materials.dimOf(surface)
            : index === s
              ? this.materials.hotOf(surface) ?? this.materials.get(surface)
              : this.materials.get(surface),
        );
      }
    }
    for (const a of this.auxMeshes) {
      const surface = surfaceOf(a.mesh);
      this.swap(a.mesh, index !== null ? this.materials.dimOf(surface) : this.materials.get(surface));
    }
  }

  /** 只让某个辅助模块高亮，其余降透明度。 */
  focusAux(key: string | null) {
    for (const a of this.auxMeshes) {
      const surface = surfaceOf(a.mesh);
      this.swap(
        a.mesh,
        key === a.key
          ? this.materials.hotOf(surface) ?? this.materials.get(surface)
          : key
            ? this.materials.dimOf(surface)
            : this.materials.get(surface),
      );
    }
    if (key) {
      for (const meshes of this.stackMeshes) {
        for (const mesh of meshes) {
          this.swap(mesh, this.materials.dimOf(surfaceOf(mesh)));
        }
      }
    } else {
      this.focusStack(null);
    }
  }

  /**
   * 电池簇拾取：射线直接和 50 个 Box3 求交，不依赖任何代理 Mesh。
   * 这比给每簇建一个不可见拾取体更干净 —— 拾取优先级完全由我们自己控制。
   */
  pickCluster(ray: THREE.Ray): { stack: number; cluster: number } | null {
    if (!this.inner) return null;
    let best: { stack: number; cluster: number; distance: number } | null = null;
    for (let s = 0; s < this.proto.clusterBoxes.length; s++) {
      const boxes = this.proto.clusterBoxes[s];
      for (let c = 0; c < boxes.length; c++) {
        const world = boxes[c].clone().translate(this.center);
        const hit = ray.intersectBox(world, new THREE.Vector3());
        if (hit) {
          const d = hit.distanceTo(ray.origin);
          if (!best || d < best.distance) best = { stack: s, cluster: c, distance: d };
        }
      }
    }
    return best ? { stack: best.stack, cluster: best.cluster } : null;
  }

  /** 让单个电池簇"跳出来"：该簇对应的堆保持高亮，其余堆淡化。 */
  focusCluster(stackIndex: number, clusterIndex: number, on: boolean) {
    if (!on) {
      this.resetFocus();
      return;
    }
    this.focusStack(stackIndex);
    void clusterIndex;
  }

  resetFocus() {
    for (const meshes of this.stackMeshes) {
      for (const mesh of meshes) this.swap(mesh, this.materials.get(surfaceOf(mesh)));
    }
    for (const a of this.auxMeshes) {
      this.swap(a.mesh, this.materials.get(surfaceOf(a.mesh)));
    }
  }

  /**
   * 展开某个电池簇的 8 个 Pack —— 柜前地面上一块 **4 列 × 2 行"电池盘"**。
   *
   * 这里修掉过一个很隐蔽的错：原先 8 块 Pack 沿 Z 一字排开、间距写 0.44 m，
   * 而 Pack 长边正好 0.72 m —— **相邻两块互相重叠 0.28 m**，8 块糊成一条
   * 连续的黑带，"8 个 Pack"这个信息完全丢失（截图上是把黑色长剑）。
   * 现在横向间距 1.36 m（板宽 1.224 m，留 0.136 m 缝）、纵向 0.72 m
   * （板厚 0.323 m，缝 0.4 m），并整体放大 1.7 倍，8 块一眼可数。
   *
   * 另外：Pack **一律平躺**（52 芯那一面朝上）。这是为了让 53° 俯角的
   * "检修台视角"能正对着看到那张 13 × 4 的脸，而不是隔着一个斜角去看
   * 一张立起来的板子。
   */
  explodeCluster(stackIndex: number, clusterIndex: number) {
    this.ensureInternals();
    this.setDetail(null);
    const group = this.detailGroup!;
    const clusterCenter = this.proto.clusterBoxes[stackIndex][clusterIndex].getCenter(new THREE.Vector3());
    const stackId = `${this.id}.stack.${String(stackIndex + 1).padStart(2, "0")}`;
    const clusterId = `${stackId}.cluster.${String(clusterIndex + 1).padStart(2, "0")}`;

    // 检修台跟着"它从哪个机架里出来"走，但不许探出柜体两端。
    const gridCX = THREE.MathUtils.clamp(clusterCenter.x, -L / 2 + 3.1, L / 2 - 3.1);
    const deckW = (GRID_COLS - 1) * GRID_PITCH_X + PACK_W + 0.54;
    const deckD = (GRID_ROWS - 1) * GRID_PITCH_Z + PACK_D + 0.54;

    const deckGeo = dressVertices(slab(deckW, DECK_H, deckD), [1.06, 1.03, 0.97]);
    const deck = new THREE.Mesh(deckGeo, this.materials.get("concrete"));
    deck.userData.surface = "concrete";
    deck.position.set(gridCX, YARD_Y + DECK_H / 2, DECK_OFFSET_Z);
    deck.receiveShadow = true;
    group.add(deck);
    this.detailMeshes.push(deck);

    for (let p = 0; p < PACK_COUNT; p++) {
      const packId = `${clusterId}.pack.${String(p + 1).padStart(2, "0")}`;
      const col = p % GRID_COLS;
      const row = Math.floor(p / GRID_COLS);

      const packGroup = makeGroup(packId);
      packGroup.position.set(
        gridCX + (col - (GRID_COLS - 1) / 2) * GRID_PITCH_X,
        PACK_Y,
        DECK_OFFSET_Z + (row - (GRID_ROWS - 1) / 2) * GRID_PITCH_Z,
      );
      packGroup.scale.setScalar(PACK_DISPLAY_SCALE);

      const shell = new THREE.Mesh(this.proto.packGeometry, this.materials.get("battery"));
      shell.userData.surface = "battery";
      // 长边后沿的汇流母排。纯色板子摊平后正/背、上/下分不清，
      // 加一根铜排当"把手"，朝向立刻读得出来。
      const bus = new THREE.Mesh(this.proto.packGeometry, this.materials.get("copper"));
      bus.userData.surface = "copper";
      bus.scale.set(0.86, 0.3, 0.1);
      bus.position.set(0, 0.125, -0.18);

      packGroup.add(shell, bus);
      group.add(packGroup);
      this.detailMeshes.push(shell, bus);
      this.detailNodeIds.push(packId);

      this.registry.add({
        id: packId,
        kind: "bmsPack",
        label: `Pack ${String(p + 1).padStart(2, "0")}`,
        subtitle: `${CELL_COUNT} Cells · ${ELECTRICAL.pack.voltage} V · 物理层级`,
        parentId: clusterId,
        group: packGroup,
        meshes: [shell, bus],
        box: measure(packGroup),
        pickable: true,
        revealShell: false,
        drillable: true,
        dataKey: packId,
      });
    }

    group.visible = true;
    // 返回整块检修台（台板 + 8 个 Pack）的联合包围盒，交给场景取景。
    return new THREE.Box3().setFromObject(group).expandByScalar(0.18);
  }

  /**
   * 把某个 Pack 拆成 52 个真实电芯：13 列 × 4 行的极片阵列，
   * **从 Pack 的正面揭起来，悬在它正上方**。
   *
   * 两点和旧版不同：
   *  1. 阵列整体放大 1.6 倍并配一副金属托架（托架 + 3 条行隔板让"4 行"可数）。
   *     旧版是 (3.8, 2.6, 1.2) 的**非等比**缩放 —— 电芯被压扁成薄片，
   *     13 列的缝只剩 2 px，看上去就是"一簇蓝色小方块"，与"52 颗"无关。
   *  2. 返回 **Pack ∪ 52 芯阵列的联合包围盒**（世界坐标）。旧版只把 Pack 的
   *     1 m 盒子交给镜头，而阵列被抬到 1.05 m 之上、还在画面之外，等于没取景。
   */
  explodePack(packId: string) {
    this.ensureInternals();
    const packNode = this.registry.get(packId);
    if (!packNode) return null;
    const base = packNode.group;
    base.updateWorldMatrix(true, true);

    const rig = makeGroup(`${packId}.rig`);
    // 阵列整体**悬在这块 Pack 的正上方**：托盘底沿留 0.06 m 缝。读作
    // "52 颗是从脚下这块 Pack 的正面揭下来的"，而不是另一件无关的展品。
    const trayBottom = -(this.proto.cellsArraySize.y + 0.06) / 2 - 0.06;
    rig.position.copy(base.position);
    rig.position.y = PACK_Y + PACK_H / 2 + 0.06 - trayBottom * CELL_DISPLAY_SCALE;
    rig.scale.setScalar(CELL_DISPLAY_SCALE);

    const cells = new THREE.Mesh(this.proto.cellsGeometry, this.materials.get("cellShell"));
    cells.userData.surface = "cellShell";
    const frame = new THREE.Mesh(this.proto.cellsFrameGeometry, this.materials.get("metalDark"));
    frame.userData.surface = "metalDark";
    rig.add(cells, frame);

    const cellId = `${packId}.cells`;
    const cellGroup = makeGroup(cellId);
    cellGroup.add(rig);
    this.detailGroup!.add(cellGroup);
    this.detailMeshes.push(cells, frame);
    this.detailNodeIds.push(cellId);

    const cellsBox = measure(cellGroup);
    const packBox = new THREE.Box3().setFromObject(base);
    const focus = cellsBox.clone().union(packBox).expandByScalar(0.1);

    this.registry.add({
      id: cellId,
      kind: "bmsPack",
      label: `52 × 方形电芯`,
      subtitle: `${ELECTRICAL.cell.voltage} V / ${ELECTRICAL.cell.capacityAh} Ah · 单芯 ${(ELECTRICAL.cell.kwh * 1000).toFixed(0)} Wh · 13 列 × 4 行`,
      parentId: packId,
      group: cellGroup,
      meshes: [cells, frame],
      box: cellsBox,
      pickable: true,
      revealShell: false,
      drillable: false,
      dataKey: packId,
    });
    void CELL_COUNT;
    return focus;
  }

  /** 清空展开出来的细节（Pack / Cell），并撤销它们在树里的注册。 */
  setDetail(_unused: unknown) {
    if (!this.detailGroup) return;
    for (const mesh of this.detailMeshes) mesh.removeFromParent();
    this.detailMeshes = [];
    for (const id of this.detailNodeIds) {
      const node = this.registry.nodes.get(id);
      if (node) {
        node.group.removeFromParent();
        this.registry.nodes.delete(id);
      }
    }
    this.detailNodeIds = [];
    this.detailGroup.clear();
    this.detailGroup.visible = false;
  }

  meshesForHighlight(): THREE.Mesh[] {
    return this.shellMeshes;
  }
}

/* ------------------------------------------------------------------ *
 * 储能区
 * ------------------------------------------------------------------ */

export type EssBuild = {
  group: THREE.Group;
  cabinets: EssCabinet[];
  anchors: { id: string; center: THREE.Vector3; ac: THREE.Vector3 }[];
};

export function buildEss(materials: MaterialSet, registry: TwinRegistry, count: number): EssBuild {
  const group = makeGroup("ess-farm");
  const proto = buildEssPrototype();

  const zone = registry.add({
    id: "zone.ess",
    kind: "essFarm",
    label: "储能区",
    subtitle: `${count} 台大型户外储能柜 · ${((count * ELECTRICAL.cabinet.kwh) / 1000).toFixed(1)} MWh / 25 MW`,
    parentId: "station",
    childIds: [],
    group,
    meshes: [],
    box: new THREE.Box3(),
    pickable: false,
    revealShell: false,
    drillable: true,
  });

  const cabinets: EssCabinet[] = [];
  const anchors: EssBuild["anchors"] = [];
  const zoneBox = new THREE.Box3();

  for (let i = 1; i <= count; i++) {
    const cabinet = new EssCabinet(i, materials, registry, proto);
    cabinets.push(cabinet);
    group.add(cabinet.group);

    // 内部结构懒加载，所以这里必须先量一次外壳的包围盒；
    // 下钻后再用 measure(cabinet.group) 更新（内部结构在同一 Group 下）。
    const box = measure(cabinet.group);

    registry.add({
      id: cabinet.id,
      kind: "essCabinet",
      label: `ESS-${String(i).padStart(2, "0")} 储能柜`,
      subtitle: `${(ELECTRICAL.cabinet.kwh / 1000).toFixed(2)} MWh · ${ESS.stacksPerCabinet} 电池堆 × ${ESS.clustersPerStack} 簇 × ${ESS.packsPerCluster} Pack × ${ESS.cellsPerPack} Cells`,
      parentId: "zone.ess",
      childIds: [],
      group: cabinet.group,
      meshes: cabinet.shellMeshes,
      box,
      pickable: true,
      revealShell: true,
      drillable: true,
      dataKey: cabinet.id,
    });
    cabinet.group.traverse((o) => {
      o.userData.nodeId = cabinet.id;
    });
    zoneBox.union(box);

    anchors.push({
      id: cabinet.id,
      center: cabinet.center.clone().setY(PLATFORM_Y + 1.7),
      ac: cabinet.center.clone().setY(PLATFORM_Y + 3.6),
    });
  }

  zone.box.copy(zoneBox);
  return { group, cabinets, anchors };
}
