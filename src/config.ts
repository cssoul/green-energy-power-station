/**
 * 全站布局常量 —— 单一真源。
 *
 * 尺度契约：**1 世界单位 = 1 米**。任何道具的比例都要能对着这里的数字自检
 * （"这棵白桦 11 米，那它是组件高度的几倍？"）。改了这里的任何一个数，
 * 引用它的 builder 会自动跟着变，不要在各处硬编码坐标。
 *
 * 坐标约定：X 向右、Z 向前（朝观察者），Y 向上。
 * 相机位于 +X / +Y / +Z 象限俯视，于是：
 *   -X-Z（画面左上·远景）= 光伏农场
 *   +X-Z（画面右上·远景）= 运维建筑 / 铁塔
 *   +X+Z（画面右下·近景）= 水体
 *   -X+Z / 0+Z（画面中下）= 储能区
 */
import type { ViewPreset } from "./core/cameraRig";

/** 园区平台（场平后抬高的作业面）标高。围栏内一切物体都落在这个面上。 */
export const PLATFORM_Y = 2.0;

/**
 * 平台边缘 → 外围野草的过渡宽度。
 *
 * 底板收成一圈**窄**绿化带之后，这个过渡必须在带子宽度之内走完：带子只有 ~22 m，
 * 原来写 30 m 会"过渡没走完就撞到板边"，四边于是停在平台标高上，既没有起伏也读不出
 * "已经出了园区"。收窄到 16 m 之后，外圈 6 m 是完整的野草。
 */
export const PLATFORM_FADE = 16;

/**
 * 园区平台矩形（场平后的水平作业面，不含过渡带）。
 *
 * 必须盖住全部内容，四边再各留 ~20 m 野草：
 *   围栏 `x -312…300 / z -228…238`、铁塔（x 到 450）、水池（x 到 449、z 到 324）。
 */
export const PLATFORM = { x0: -330, x1: 468, z0: -248, z1: 340 };

/**
 * 地形板 —— 这块板就是"桌面上的微缩沙盘"。
 *
 * **收板原则：内容 + 一圈窄绿化带，多余的草地一律不要。**
 * 早先是一块 1160 × 1160 的正方形，四边挂着 250–350 m 的纯草地，园区只占到底板宽度的
 * 一半多；现按参考图的红框收到 **844 × 630（面积约为原来的 40%）**。
 *
 * 板子做成**矩形而不是正方形**：园区内容本身就是横长的（围栏 612 m 宽、466 m 深，
 * 东侧还要多出铁塔与水池 130 m），套正方形等于在东西两边白送草地。所以这里用
 * `cx/cz + hx/hz` 描述 —— 底板中心跟着内容中心一起东移、南移，四边留边才能等宽。
 *
 * 缩板会连带牵动三处"内容外延"，改之前先确认它们收在新边界内：
 *   1. `roads.ts` 主干道铺装范围（现按 `EDGE.x0/x1 ± 6` 自动算）；
 *   2. `roads.ts` 主干道上的车辆巡航路径（现按 `EDGE.x0/x1 ∓ 70`）；
 *   3. `substation.ts` 末塔之后出图的导线外延（现按"伸到板边内侧 8 m"自动算）。
 */
export const TERRAIN = { cx: 70, cz: 47, hx: 422, hz: 315, segments: 128 };

/** 底板四条边（世界坐标）。给 roads / vegetation / substation 引用，避免各处硬编码。 */
export const EDGE = {
  x0: TERRAIN.cx - TERRAIN.hx,
  x1: TERRAIN.cx + TERRAIN.hx,
  z0: TERRAIN.cz - TERRAIN.hz,
  z1: TERRAIN.cz + TERRAIN.hz,
};

/** 围栏矩形（贴地，园区边界）。 */
export const FENCE = { x0: -312, x1: 300, z0: -228, z1: 238, h: 2.4 };

/* ------------------------------------------------------------------ *
 * 光伏农场：20 个阵列组
 * ------------------------------------------------------------------ */

export const PV = {
  /** 单组沿 X 的组件数（缩短宽度，避免最西侧阵列压到检修道） */
  cols: 16,
  /** 单排沿 Z 的排数（用户要求从 20 排减到 10 排，缓解过密） */
  rows: 10,
  /** 组件宽度（沿排方向，X）—— 2.3 m 是主流 182/210 组件的长边 */
  cellW: 2.3,
  /** 组件高度（沿斜面）—— 1.15 m 是主流组件的短边 */
  cellH: 1.15,
  /** 组件厚（含边框） */
  cellT: 0.045,
  /** 组件下沿离地高（支架前立柱） */
  legH: 1.05,
  /** 倾角（弧度），22° 是黄淮海地区常见的最佳倾角 */
  tilt: (22 * Math.PI) / 180,
  /** 排距（沿 Z，中心到中心）→ 2.4 m 让组内行距更舒展，减少农场上下空白草地 */
  rowPitch: 2.4,
  /** 同排内组件间隙 */
  cellGap: 0.02,
  /** 相邻排之间的横向檩条数 */
  purlins: 2,
  /** 网格：列数 × 行数，共 20 组 */
  grid: { cols: 5, rows: 4 },
  /** 组间通道（沿 X / 沿 Z） */
  gapX: 10,
  gapZ: 12,
  /** 农场中心（世界坐标） */
  center: [-152, 0, -98] as [number, number, number],
} as const;

/** 单组阵列的外框尺寸（派生值，不要手改）。 */
export const PV_BLOCK = {
  w: PV.cols * (PV.cellW + PV.cellGap),
  d: PV.rows * PV.rowPitch,
} as const;

/** 农场整体外框。 */
export const PV_FARM = {
  w: PV.grid.cols * PV_BLOCK.w + (PV.grid.cols - 1) * PV.gapX,
  d: PV.grid.rows * PV_BLOCK.d + (PV.grid.rows - 1) * PV.gapZ,
} as const;

/** 第 n 个阵列组（0..19）的中心坐标。 */
export function pvBlockCenter(index: number): [number, number, number] {
  const c = index % PV.grid.cols;
  const r = Math.floor(index / PV.grid.cols);
  const x = PV.center[0] - PV_FARM.w / 2 + PV_BLOCK.w / 2 + c * (PV_BLOCK.w + PV.gapX);
  const z = PV.center[2] - PV_FARM.d / 2 + PV_BLOCK.d / 2 + r * (PV_BLOCK.d + PV.gapZ);
  return [x, PLATFORM_Y, z];
}

export const PV_FARM_BOUNDS = {
  x0: PV.center[0] - PV_FARM.w / 2,
  x1: PV.center[0] + PV_FARM.w / 2,
  z0: PV.center[2] - PV_FARM.d / 2,
  z1: PV.center[2] + PV_FARM.d / 2,
};

/* ------------------------------------------------------------------ *
 * 汇流 / 逆变廊道（农场东侧）
 * ------------------------------------------------------------------ */

export const INVERTER = {
  count: 10,
  /** 集装箱式逆变升压一体舱 */
  size: [7.4, 3.35, 3.2] as [number, number, number],
  x: PV_FARM_BOUNDS.x1 + 22,
  z0: PV_FARM_BOUNDS.z0 + 16,
  pitch: 21,
};

/** 直流汇流箱：挂在每个阵列组南端通道口。 */
export const COMBINER = {
  size: [1.35, 1.75, 0.72] as [number, number, number],
  perBlock: 3,
};

/* ------------------------------------------------------------------ *
 * 储能区（画面中下）
 * ------------------------------------------------------------------ */

export const ESS = {
  /** 大型户外储能柜（20 尺集装箱尺度放大到电池舱） */
  size: [12.2, 3.3, 3.4] as [number, number, number],
  /** 2 排 × 5 列 = 10 台 */
  cols: 5,
  rows: 2,
  gapX: 5.5,
  gapZ: 9,
  center: [6, PLATFORM_Y, 92] as [number, number, number],
  /** 每柜内部：5 个电池堆，每堆 10 个电池簇，每簇 8 个 Pack，每 Pack 52 个 Cell */
  stacksPerCabinet: 5,
  clustersPerStack: 10,
  packsPerCluster: 8,
  cellsPerPack: 52,
} as const;

export function essCabinetCenter(index: number): [number, number, number] {
  const c = index % ESS.cols;
  const r = Math.floor(index / ESS.cols);
  const totalW = ESS.cols * ESS.size[0] + (ESS.cols - 1) * ESS.gapX;
  const totalD = ESS.rows * ESS.size[2] + (ESS.rows - 1) * ESS.gapZ;
  const x = ESS.center[0] - totalW / 2 + ESS.size[0] / 2 + c * (ESS.size[0] + ESS.gapX);
  const z = ESS.center[2] - totalD / 2 + ESS.size[2] / 2 + r * (ESS.size[2] + ESS.gapZ);
  return [x, PLATFORM_Y, z];
}

/* ------------------------------------------------------------------ *
 * 升压变电站（画面右侧）
 * ------------------------------------------------------------------ */

export const SUBSTATION = {
  center: [176, PLATFORM_Y, -6] as [number, number, number],
  /** 主变压器 ×3，沿 Z 并排 */
  transformer: { size: [8.6, 5.4, 6.2] as [number, number, number], pitch: 17, count: 3 },
  /** GIS 综合楼 */
  gis: { size: [26, 8.4, 14] as [number, number, number], offset: [-4, 0, 34] as [number, number, number] },
  /** 户外配电装置构架（门型架 + 母线） */
  gantry: { span: 46, height: 13.5, z: -30 },
} as const;

/** 高压铁塔：自变电站向 +X 引出的三座塔。 */
export const TOWERS = {
  count: 3,
  height: 46,
  base: 6.4,
  positions: [
    [268, PLATFORM_Y, -48],
    [352, PLATFORM_Y, -76],
    [438, PLATFORM_Y, -108],
  ] as [number, number, number][],
} as const;

/* ------------------------------------------------------------------ *
 * 运维建筑区
 * ------------------------------------------------------------------ */

export const OANDM = {
  center: [206, PLATFORM_Y, -176] as [number, number, number],
  main: { size: [34, 9.6, 18] as [number, number, number] },
  annex: { size: [12, 5.2, 10] as [number, number, number] },
  parking: { w: 40, d: 17 },
} as const;

/* ------------------------------------------------------------------ *
 * 道路网
 * ------------------------------------------------------------------ */

export const ROAD = {
  /** 对外主干道：沿 X 横穿画面最下方 */
  highway: { z: 258, w: 13 },
  /** 园区环路 */
  ring: { x0: FENCE.x0 + 22, x1: FENCE.x1 - 22, z0: FENCE.z0 + 26, z1: 176, w: 7.6 },
  /** 农场与储能区之间的东西向支路 */
  spine: { z: 34, w: 7 },
} as const;

/* ------------------------------------------------------------------ *
 * 水体（画面右下）
 * ------------------------------------------------------------------ */

/**
 * 景观水池。整个池体**抬在平台面之上**（见 `buildWater`），因为园区平台是一块
 * 不透光的水平板 —— 挖到板下等于消失。
 *
 * 位置：**围墙外、对外主干道以南的东南角**，与 `assets.png` 设计稿一致
 * （设计稿里水面就在道路外侧的右下方）。
 *
 * 这个位置的好处是四周都在平台上、又不压任何构筑物，只需守住三条线：
 *   - 主干道路肩南沿 `z = ROAD.highway.z + (w + 1.6) / 2 = 265.3`
 *   - 平台边界 `x = PLATFORM.x1 = 468`、`z = PLATFORM.z1 = 340`（出了平台就是坡地）
 * 现值池体外沿（×1.12）落在 x 251–449、z 268–324，三条线都留出余量。
 *
 * 早先放在主干道以北时，池子被环路东/南腿、围墙、主干道四面包夹，最近处只剩
 * 1.2 m —— 路缘会切进水里。换到路南之后这些约束一次性全没了。
 */
export const WATER = {
  center: [350, PLATFORM_Y, 296] as [number, number, number],
  rx: 88,
  rz: 25,
} as const;

/* ------------------------------------------------------------------ *
 * 外观与主题色
 * ------------------------------------------------------------------ */

export const THEME = {
  accent: 0x1fb6d6,
  accentWarm: 0xffb547,
  select: 0x25e0ff,
  hover: 0x8fe9ff,
  /** 能源流分色（对齐设计稿的箭头配色） */
  flow: {
    dc: 0x2f6fd0,
    ac: 0xff9a3c,
    storage: 0x24d6a8,
    grid: 0xff4d4d,
  },
} as const;

export const CAMERA = {
  fov: 26,
  near: 2,
  far: 6000,
  /** 默认轴测机位方向（从目标指向相机，单位向量化的方向由 azimuth/elevation 决定） */
  azimuth: (46 * Math.PI) / 180,
  elevation: (39 * Math.PI) / 180,
} as const;

/* ------------------------------------------------------------------ *
 * 机位预设
 *
 * `distance` 是**相机到目标点的距离（米）**，按"要看到多大范围"反算：
 *   横向可见宽度 ≈ 2 · tan(fov/2) · aspect · distance ≈ **0.82 · distance**
 * （fov 26°、aspect 1.78）。
 *
 * 放在 config 里而不是 UI 里，是为了让 `resetView()` 能复用同一个"全景"，
 * 避免"点按钮"和"点重置"两个全景对不上。
 *
 * **全景（overview）是按"微缩摆件"定的，不是按"装下整块底板"定的。**
 * 底板收到 844 × 630 之后，1.15 km 的全景距离下横向可见约 944 m —— 底板左右两边
 * 刚好压住构图，上下留出背景（底板在 33° 俯角下进深只投影出 0.55 倍，630 → ~345）。
 * 这个距离是看着画面调的，不是套公式套出来的。
 * ------------------------------------------------------------------ */

export const VIEW_PRESETS: ViewPreset[] = [
  { id: "overview", label: "全景", target: [72, 3, 46], azimuth: 0.86, elevation: 0.58, distance: 1150 },
  { id: "pv", label: "光伏区", target: [-152, 4, -98], azimuth: 0.9, elevation: 0.5, distance: 280 },
  { id: "ess", label: "储能区", target: [6, 3, 92], azimuth: 0.98, elevation: 0.5, distance: 104 },
  { id: "substation", label: "升压站", target: [196, 7, 8], azimuth: 0.9, elevation: 0.5, distance: 132 },
  { id: "grid", label: "输电线路", target: [352, 24, -78], azimuth: 0.98, elevation: 0.44, distance: 240 },
  { id: "water", label: "生态水体", target: [350, 3, 296], azimuth: 1.06, elevation: 0.5, distance: 165 },
];

export const OVERVIEW_PRESET = VIEW_PRESETS[0];
