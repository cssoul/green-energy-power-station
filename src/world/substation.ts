import * as THREE from "three";
import { EDGE, PLATFORM_Y, SUBSTATION, TOWERS } from "../config";
import { MeshBatcher } from "../core/batcher";
import type { MaterialSet } from "../core/materials";
import { measure, type TwinRegistry } from "../core/registry";
import { variation } from "../core/rng";
import { addCable, addPad, finalizeNode, makeGroup } from "./util";

/**
 * 升压变电站 + 高压输电线路。
 *
 * 站内按真实 110 kV 升压站的顺序排布：
 *   逆变升压舱 0.69 kV → 主变（0.69/110 kV）→ 户外 GIS / 断路器 / 隔离开关
 *   → 门型构架与母线 → 出线 → 输电铁塔 → 电网
 *
 * 铁塔是真正的格构式：4 条渐变主材 + 每 5 m 一道水平腰带 + 每面交叉斜材 +
 * 三层横担，绝缘子串单独成串。远看才像塔，近看能数清节间。
 */

/* ------------------------------------------------------------------ *
 * 主变压器
 * ------------------------------------------------------------------ */

function buildTransformer(materials: MaterialSet, registry: TwinRegistry, index: number, center: THREE.Vector3) {
  const id = `tx.${String(index).padStart(2, "0")}`;
  const group = makeGroup(id);
  group.position.copy(center);
  const b = new MeshBatcher(materials);

  const [w, h, d] = SUBSTATION.transformer.size;

  addPad(b, 0, 0, w + 2.6, d + 2.2, 0, 0.9);
  // 变压器箱体
  b.add(new THREE.BoxGeometry(w, h * 0.62, d), "metalDark", { p: [0, 0.4 + h * 0.31, 0] }, { shade: 0.86 });
  // 顶部油枕
  b.add(new THREE.BoxGeometry(w * 0.72, 0.62, d * 0.5), "metal", { p: [-w * 0.06, 0.4 + h * 0.62 + 0.3, 0] }, { shade: 0.94 });
  // 散热片（两侧各 8 片）
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 8; i++) {
      const z = -d * 0.4 + (i / 7) * d * 0.8;
      b.add(new THREE.BoxGeometry(0.16, h * 0.5, 0.9), "metal", {
        p: [sx * (w / 2 + 0.32), 0.4 + h * 0.28, z],
      }, { shade: 0.88 });
    }
    b.add(new THREE.BoxGeometry(0.9, 0.7, d), "metalDark", { p: [sx * (w / 2 + 0.36), 0.4 + h * 0.52, 0] }, { shade: 0.82 });
  }
  // 高压套管（110 kV 侧，3 只）+ 低压套管（0.69 kV 侧，3 只）
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * (w * 0.28);
    const hTot = 4.6;
    b.add(new THREE.CylinderGeometry(0.19, 0.24, hTot, 10), "porcelain", { p: [x, 0.4 + h * 0.62 + 0.6 + hTot / 2 - 0.9, d * 0.22 - 0.6] });
    // 伞裙
    for (let k = 0; k < 6; k++) {
      b.add(new THREE.CylinderGeometry(0.34, 0.34, 0.09, 10), "porcelain", {
        p: [x, 0.4 + h * 0.62 + 0.6 + hTot * (0.18 + k * 0.14), d * 0.22 - 0.6],
      });
    }
    b.add(new THREE.CylinderGeometry(0.16, 0.2, 2.4, 10), "porcelain", { p: [x, 0.4 + h * 0.55, -d * 0.3] });
  }
  // 有载调压开关与控制柜
  b.add(new THREE.BoxGeometry(1.5, 2.0, 1.1), "metalDark", { p: [w * 0.62, 1.4, d * 0.6] }, { shade: 0.9 });
  b.add(new THREE.BoxGeometry(1.1, 0.5, 0.7), "sign", { p: [-w * 0.5, 1.5, d * 0.62] });
  // 接地引下线
  for (const sx of [-1, 1]) {
    b.add(new THREE.BoxGeometry(0.08, h * 0.62, 0.08), "copper", { p: [sx * (w / 2 - 0.2), 0.4 + h * 0.31, -d / 2 - 0.06] });
  }

  const measured = finalizeNode({
    registry,
    id,
    kind: "transformer",
    label: `主变 #${index}`,
    subtitle: "SZ11-2000/110 · 0.69/110 kV · YNd11",
    parentId: "zone.substation",
    group,
    batcher: b,
    dataKey: id,
    drillable: false,
    boxPadding: 1,
  });

  // 顶部通向构架的软母线
  return measured;
}

/* ------------------------------------------------------------------ *
 * 户外配电装置：断路器 / 隔离开关 / 避雷器 / 电流互感器
 * ------------------------------------------------------------------ */

function buildSwitchgear(materials: MaterialSet, registry: TwinRegistry, center: THREE.Vector3) {
  const id = "zone.switchgear";
  const group = makeGroup(id);
  group.position.copy(center);
  const b = new MeshBatcher(materials);

  for (let i = 0; i < 6; i++) {
    const x = (i - 2.5) * 9.5;
    // 支柱绝缘子
    for (const dx of [-0.9, 0.9]) {
      addCyl(b, dx, 0, 3.4, 0.28);
      addCyl(b, dx, 0, 3.4, 0.28);
    }
    // 断路器罐体
    b.add(new THREE.CylinderGeometry(0.5, 0.5, 3.4, 12), "metal", { p: [0, 4.4, 0] }, { shade: 0.95 });
    b.add(new THREE.BoxGeometry(2.6, 0.24, 0.24), "metal", { p: [0, 6.0, 0] });
    // 隔离开关刀闸
    b.add(new THREE.BoxGeometry(0.12, 2.4, 0.12), "metal", { p: [-1.6, 4.4, 0], r: [0, 0, 0.5] });
    b.add(new THREE.BoxGeometry(0.12, 2.4, 0.12), "metal", { p: [1.6, 4.4, 0], r: [0, 0, -0.5] });
    // 避雷器
    b.add(new THREE.CylinderGeometry(0.24, 0.24, 3.0, 10), "porcelain", { p: [2.9, 2.2, 0] });
    // 电流互感器
    b.add(new THREE.CylinderGeometry(0.36, 0.36, 2.0, 10), "porcelain", { p: [-2.9, 2.7, 0] });
    // 操作机构箱
    b.add(new THREE.BoxGeometry(1.4, 1.5, 0.9), "metalDark", { p: [0, 0.85, 1.7] }, { shade: 0.88 });
    // 构架母线
    addCable(b, "copper", [
      [x - 4.7, 8.4, 0],
      [x - 2.4, 6.7, 0],
      [x, 6.15, 0],
      [x + 2.4, 6.7, 0],
      [x + 4.7, 8.4, 0],
    ], 0.11);
  }

  finalizeNode({
    registry,
    id,
    kind: "gantry",
    label: "户外配电装置",
    subtitle: "110 kV 断路器 / 隔离开关 / 避雷器 / CT",
    parentId: "zone.substation",
    group,
    batcher: b,
    drillable: false,
    boxPadding: 1,
  });
}

function addCyl(b: MeshBatcher, x: number, z: number, h: number, r: number) {
  b.add(new THREE.CylinderGeometry(r, r * 1.15, h, 10), "porcelain", { p: [x, h / 2 + 0.4, z] });
}

/* ------------------------------------------------------------------ *
 * 门型构架 + 母线
 * ------------------------------------------------------------------ */

function buildGantry(materials: MaterialSet, registry: TwinRegistry, center: THREE.Vector3) {
  const id = "zone.gantry";
  const group = makeGroup(id);
  group.position.copy(center);
  const b = new MeshBatcher(materials);
  const { span, height, z } = SUBSTATION.gantry;

  /**
   * 出线挂点：`[榀][相]`，世界坐标，取**绝缘子串下端**（导线夹）。
   *
   * 这里回传挂点而不是让调用方自己算 `center ± 10`，是因为"线没接到构架上"这个
   * 问题栽过一次：`buildSubstation` 里原来手算 `gantryCenter.z + 15`，而构架实际
   * 立在 `gantryCenter.z + {-30, -15}` —— 起点比构架偏南 30 m，六根出线全从空中
   * 起头、从构架顶上飘过去，画面上就是"铁塔的线和设备没有任何连接"。
   * **挂点只有构架自己知道，就必须由构架 export。**
   */
  const anchors: THREE.Vector3[][] = [];
  const stringBottom = height * 0.98 - 0.9;

  for (let i = 0; i < 2; i++) {
    const gz = z + i * 15;
    for (const sx of [-1, 1]) {
      const x = sx * span * 0.36;
      // A 字柱：两条主材 + 横撑
      for (const lean of [-1, 1]) {
        const baseX = x + lean * 1.5;
        b.add(new THREE.BoxGeometry(0.26, height * 1.02, 0.26), "metal", {
          p: [(x + baseX) / 2, height * 0.51 + 0.4, gz],
          r: [0, 0, -Math.atan2(lean * 1.5, height)],
        }, { shade: 0.94 });
      }
      for (let k = 1; k <= 5; k++) {
        const y = 0.4 + (height * k) / 6;
        const w = 3.0 * (1 - k / 6);
        b.add(new THREE.BoxGeometry(w, 0.14, 0.14), "metal", { p: [x, y, gz] }, { shade: 0.9 });
        b.add(new THREE.BoxGeometry(w * 1.35, 0.1, 0.1), "metal", { p: [x, y + 0.55, gz], r: [0, 0, 0.42] }, { shade: 0.86 });
        b.add(new THREE.BoxGeometry(w * 1.35, 0.1, 0.1), "metal", { p: [x, y + 0.55, gz], r: [0, 0, -0.42] }, { shade: 0.86 });
      }
      b.add(new THREE.BoxGeometry(2.2, 0.5, 2.2), "concrete", { p: [x, 0.25, gz] }, { shade: 0.86 });
    }
    // 横梁
    for (const y of [height * 0.72, height * 0.98]) {
      b.add(new THREE.BoxGeometry(span * 0.78, 0.3, 0.3), "metal", { p: [0, y + 0.4, gz] }, { shade: 0.96 });
      b.add(new THREE.BoxGeometry(span * 0.44, 0.12, 0.12), "metal", { p: [0, y - 0.6, gz], r: [0, 0, 0.42] }, { shade: 0.86 });
      b.add(new THREE.BoxGeometry(span * 0.44, 0.12, 0.12), "metal", { p: [0, y - 0.6, gz], r: [0, 0, -0.42] }, { shade: 0.86 });
    }
    // 悬式绝缘子串
    const row: THREE.Vector3[] = [];
    for (let s = 0; s < 3; s++) {
      const sx = (s - 1) * span * 0.22;
      for (let k = 0; k < 7; k++) {
        b.add(new THREE.CylinderGeometry(0.2, 0.24, 0.085, 8), "porcelain", {
          p: [sx, height * 0.98 + 0.2 - k * 0.16, gz],
        });
      }
      row.push(new THREE.Vector3(center.x + sx, center.y + stringBottom, center.z + gz));
    }
    anchors.push(row);
  }
  // 管型母线把两组构架连起来
  for (let s = 0; s < 3; s++) {
    const sx = (s - 1) * span * 0.22;
    addCable(b, "metal", [
      [sx, height * 0.98 - 0.9, z],
      [sx, height * 0.98 - 1.2, z + 7.5],
      [sx, height * 0.98 - 0.9, z + 15],
    ], 0.1);
  }

  finalizeNode({
    registry,
    id,
    kind: "gantry",
    label: "110 kV 门型构架与母线",
    subtitle: "管型母线 · 悬式绝缘子串 · 出线间隔",
    parentId: "zone.substation",
    group,
    batcher: b,
    drillable: false,
    boxPadding: 1,
  });

  return { anchors };
}

/* ------------------------------------------------------------------ *
 * GIS 配电楼
 * ------------------------------------------------------------------ */

function buildGisBuilding(materials: MaterialSet, registry: TwinRegistry, center: THREE.Vector3) {
  const id = "zone.gis";
  const group = makeGroup(id);
  group.position.copy(center);
  const b = new MeshBatcher(materials);
  const [w, h, d] = SUBSTATION.gis.size;

  addPad(b, 0, 0, w + 3, d + 3, 0, 0.92);
  b.add(new THREE.BoxGeometry(w, h, d), "panelWall", { p: [0, 0.4 + h / 2, 0] });
  // 压顶女儿墙
  b.add(new THREE.BoxGeometry(w + 0.7, 0.5, d + 0.7), "metalRoof", { p: [0, 0.4 + h + 0.25, 0] });
  // 屋面设备
  for (let i = 0; i < 3; i++) {
    b.add(new THREE.BoxGeometry(2.6, 0.9, 2.0), "metalDark", { p: [-w * 0.3 + i * 5.6, 0.4 + h + 0.95, 0] }, { shade: 0.9 });
  }
  // 带形窗
  for (const sz of [-1, 1]) {
    b.add(new THREE.BoxGeometry(w * 0.86, 1.9, 0.08), "glass", { p: [0, 0.4 + h * 0.62, sz * (d / 2 + 0.05)] });
  }
  b.add(new THREE.BoxGeometry(0.08, 1.9, d * 0.8), "glass", { p: [w / 2 + 0.05, 0.4 + h * 0.62, 0] });
  // 入口雨篷与门
  b.add(new THREE.BoxGeometry(7.5, 0.35, 3.4), "metalRoof", { p: [0, 0.4 + h * 0.42, d / 2 + 1.7] });
  for (const dx of [-2.6, 2.6]) {
    b.add(new THREE.BoxGeometry(0.24, h * 0.42, 0.24), "metal", { p: [dx, 0.4 + h * 0.21, d / 2 + 3.2] });
  }
  b.add(new THREE.BoxGeometry(3.2, 2.6, 0.14), "glassClear", { p: [0, 0.4 + 1.3, d / 2 + 0.06] });
  b.add(new THREE.BoxGeometry(6.5, 0.7, 0.1), "sign", { p: [0, 0.4 + h * 0.86, d / 2 + 0.06] });
  // 室外 GIS 套管舱
  b.add(new THREE.BoxGeometry(w * 0.6, 3.4, 4.2), "metalDark", { p: [0, 0.4 + 1.7, -d / 2 - 2.6] }, { shade: 0.9 });
  for (let i = 0; i < 3; i++) {
    b.add(new THREE.CylinderGeometry(0.22, 0.26, 4.4, 10), "porcelain", { p: [(i - 1) * 5.2, 0.4 + 3.4 + 2.2, -d / 2 - 2.6] });
  }

  finalizeNode({
    registry,
    id,
    kind: "gis",
    label: "110 kV GIS 配电楼",
    subtitle: "GIS 组合电器 · 继保室 · 站用电",
    parentId: "zone.substation",
    group,
    batcher: b,
    dataKey: id,
    drillable: false,
    boxPadding: 1,
  });
}

/* ------------------------------------------------------------------ *
 * 输电铁塔 + 导线
 * ------------------------------------------------------------------ */

export type TowerBuild = {
  group: THREE.Group;
  /** 每座塔的挂线点（三层横担左右各一），供输电线路连接。 */
  arms: THREE.Vector3[][];
  box: THREE.Box3;
};

function buildTower(materials: MaterialSet, registry: TwinRegistry, index: number, base: THREE.Vector3) {
  const id = `tower.${String(index).padStart(2, "0")}`;
  const group = makeGroup(id);
  group.position.copy(base);
  const b = new MeshBatcher(materials);

  const H = TOWERS.height;
  const baseHalf = TOWERS.base / 2;
  const topHalf = 0.85;
  const beltH = 5.6;
  const belts = Math.round(H / beltH);

  const halfAt = (y: number) => {
    const t = Math.min(1, y / H);
    return baseHalf * (1 - t) + topHalf * t;
  };

  // 主材（4 条渐变折线）
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (let k = 0; k < belts; k++) {
        const y0 = k * beltH;
        const y1 = Math.min(H, (k + 1) * beltH);
        const h0 = halfAt(y0);
        const h1 = halfAt(y1);
        const len = Math.hypot(y1 - y0, (h0 - h1) * Math.SQRT2);
        const mid = new THREE.Vector3(sx * (h0 + h1) / 2, (y0 + y1) / 2, sz * (h0 + h1) / 2);
        const lean = Math.atan2((h0 - h1) * Math.SQRT2 * 0.5, (y1 - y0) * 0.5);
        b.add(new THREE.BoxGeometry(0.24, len, 0.24), "metal", {
          p: [mid.x, mid.y + PLATFORM_Y, mid.z],
          r: [0, 0, -lean],
        }, { shade: 0.95 });
        b.add(new THREE.BoxGeometry(0.24, len, 0.24), "metal", {
          p: [mid.x, mid.y + PLATFORM_Y, mid.z],
          r: [lean, 0, 0],
        }, { shade: 0.95 });
      }
    }
  }

  // 水平腰带 + 每面的交叉斜材
  for (let k = 0; k <= belts; k++) {
    const y = Math.min(H, k * beltH);
    const h = halfAt(y);
    for (const axis of ["x", "z"] as const) {
      for (const s of [-1, 1]) {
        const size: [number, number, number] = axis === "x" ? [h * 2, 0.16, 0.16] : [0.16, 0.16, h * 2];
        const p: [number, number, number] = axis === "x" ? [0, y + PLATFORM_Y, s * h] : [s * h, y + PLATFORM_Y, 0];
        b.add(new THREE.BoxGeometry(...size), "metal", { p }, { shade: 0.9 });
      }
    }
    if (k < belts) {
      const y1 = Math.min(H, (k + 1) * beltH);
      const h1 = halfAt(y1);
      const segLen = Math.hypot(beltH, (h + h1));
      const ang = Math.atan2(h + h1, beltH);
      for (const axis of ["x", "z"] as const) {
        for (const s of [-1, 1]) {
          for (const dir of [-1, 1]) {
            const p: [number, number, number] =
              axis === "x" ? [0, (y + y1) / 2 + PLATFORM_Y, s * (h + h1) / 2] : [s * (h + h1) / 2, (y + y1) / 2 + PLATFORM_Y, 0];
            const r: [number, number, number] =
              axis === "x" ? [dir * ang, 0, 0] : [0, 0, -dir * ang];
            b.add(new THREE.BoxGeometry(0.14, segLen, 0.14), "metal", { p, r }, { shade: 0.84 });
          }
        }
      }
    }
  }

  // 三层横担
  const armYs = [H * 0.68, H * 0.8, H * 0.92];
  const armLens = [10.5, 9.0, 7.0];
  const armEnds: THREE.Vector3[] = [];
  armYs.forEach((y, i) => {
    const len = armLens[i];
    for (const sx of [-1, 1]) {
      const h = halfAt(y);
      // 上弦 + 下弦 + 斜材
      b.add(new THREE.BoxGeometry(0.18, 0.18, len), "metal", { p: [sx * h, y + 0.55 + PLATFORM_Y, sx > 0 ? len / 2 : -len / 2] }, { shade: 0.94 });
      b.add(new THREE.BoxGeometry(0.18, 0.18, len), "metal", { p: [sx * h, y - 0.55 + PLATFORM_Y, sx > 0 ? len / 2 : -len / 2] }, { shade: 0.94 });
      for (let k = 1; k < 6; k++) {
        const z = (len * k) / 6;
        b.add(new THREE.BoxGeometry(0.1, 1.25, 0.1), "metal", {
          p: [sx * h, y + PLATFORM_Y, sx > 0 ? z : -z],
        }, { shade: 0.86 });
        b.add(new THREE.BoxGeometry(0.09, 1.9, 0.09), "metal", {
          p: [sx * h, y + PLATFORM_Y, sx > 0 ? z - len / 12 : -(z - len / 12)],
          r: [sx > 0 ? -0.62 : 0.62, 0, 0],
        }, { shade: 0.82 });
      }
      // 绝缘子串
      for (let k = 0; k < 8; k++) {
        b.add(new THREE.CylinderGeometry(0.2, 0.24, 0.09, 8), "porcelain", {
          p: [sx * h, y - 1.35 - k * 0.17, sx > 0 ? len * 0.94 : -len * 0.94],
        });
      }
      armEnds.push(new THREE.Vector3(sx * h, y + PLATFORM_Y - 2.8, sx > 0 ? len * 0.94 : -len * 0.94).add(base));
    }
  });

  // 塔顶地线支架与避雷针
  b.add(new THREE.BoxGeometry(0.16, 0.16, TOWERS.base * 1.5), "metal", { p: [0, H + 0.9 + PLATFORM_Y, 0] }, { shade: 0.92 });
  b.add(new THREE.CylinderGeometry(0.1, 0.12, 3.2, 8), "metal", { p: [0, H + 2.4 + PLATFORM_Y, 0] }, { shade: 0.9 });

  // 塔基
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.add(new THREE.BoxGeometry(1.5, 0.9, 1.5), "concrete", { p: [sx * baseHalf, 0.45 + PLATFORM_Y, sz * baseHalf] }, { shade: 0.88 });
    }
  }

  const measured = finalizeNode({
    registry,
    id,
    kind: "tower",
    label: `输电铁塔 T${index}`,
    subtitle: "110 kV 双回路 · 干字型 · 呼高 46 m",
    parentId: "zone.transmission",
    group,
    batcher: b,
    dataKey: id,
    drillable: false,
    boxPadding: 1,
  });

  // 挂线点按"每层左右各一"重排
  const arms: THREE.Vector3[][] = [];
  for (let i = 0; i < armYs.length; i++) arms.push([armEnds[i * 2], armEnds[i * 2 + 1]]);
  return { group, arms, box: measured.box };
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

export type SubstationBuild = {
  group: THREE.Group;
  /** 主变中心，供能源流动画取端点。 */
  transformerAnchors: THREE.Vector3[];
  /** 门型构架母线中点，供能源流动画"主变 → 构架"段取端点。 */
  gantryBus: THREE.Vector3;
  /** 门型构架出线挂点：`[榀][相]`，即站内六根出线的起点。 */
  gantryAnchors: THREE.Vector3[][];
  /** 出线挂点，供高压线路取端点。 */
  /** 每基塔的挂线点：`[塔][横担层][左/右]`。 */
  towerArms: THREE.Vector3[][][];
  towerCenters: THREE.Vector3[];
};

export function buildSubstation(materials: MaterialSet, registry: TwinRegistry): SubstationBuild {
  const root = makeGroup("substation");

  const zone = registry.add({
    id: "zone.substation",
    kind: "substation",
    label: "升压变电站",
    subtitle: "3 × 2 MVA 主变 · 110 kV 户外配电装置",
    parentId: "station",
    childIds: [],
    group: root,
    meshes: [],
    box: new THREE.Box3(),
    pickable: false,
    revealShell: false,
    drillable: true,
  });

  const C = SUBSTATION.center;
  // 把主变与 GIS 楼整体向北（-Z）平移，让 substation 巡检路线从南侧绕行，避免车辆穿越设备。
  const NORTH_SHIFT = 32;
  const transformerAnchors: THREE.Vector3[] = [];
  const zoneBox = new THREE.Box3();
  for (let i = 1; i <= SUBSTATION.transformer.count; i++) {
    const z = C[2] + (i - 2) * SUBSTATION.transformer.pitch - NORTH_SHIFT;
    const center = new THREE.Vector3(C[0] - 12, PLATFORM_Y, z);
    const res = buildTransformer(materials, registry, i, center);
    root.add(registry.get(`tx.${String(i).padStart(2, "0")}`)!.group);
    transformerAnchors.push(new THREE.Vector3(center.x, PLATFORM_Y + 8.2, center.z));
    zoneBox.union(res.box);
    void zone;
  }

  // 户外配电装置
  const switchCenter = new THREE.Vector3(C[0] + 34, PLATFORM_Y, C[2] - 24);
  buildSwitchgear(materials, registry, switchCenter);
  root.add(registry.get("zone.switchgear")!.group);

  // 门型构架（在配电装置更外侧，出线方向）
  const gantryCenter = new THREE.Vector3(C[0] + 34, PLATFORM_Y, C[2] + 16);
  const gantry = buildGantry(materials, registry, gantryCenter);
  root.add(registry.get("zone.gantry")!.group);
  /** 母线中点：能源流动画"主变 → 构架"这一段的落点。 */
  const gantryBus = new THREE.Vector3(
    gantryCenter.x,
    PLATFORM_Y + SUBSTATION.gantry.height * 0.98 - 0.9,
    gantryCenter.z + SUBSTATION.gantry.z + 7.5,
  );

  // GIS 楼（与主变一起向北平移，躲开巡检路线）
  const gisCenter = new THREE.Vector3(C[0] - 12, PLATFORM_Y, C[2] + 42 - NORTH_SHIFT);
  buildGisBuilding(materials, registry, gisCenter);
  root.add(registry.get("zone.gis")!.group);

  // ---- 输电铁塔 ----
  const towerGroup = makeGroup("transmission-towers");
  const zoneTransmission = registry.add({
    id: "zone.transmission",
    kind: "transmission",
    label: "高压输电线路",
    subtitle: `${TOWERS.count} 基铁塔 · 110 kV 双回路架空线`,
    parentId: "station",
    childIds: [],
    group: towerGroup,
    meshes: [],
    box: new THREE.Box3(),
    pickable: false,
    revealShell: false,
    drillable: true,
  });

  const towerArms: THREE.Vector3[][][] = [];
  const towerCenters: THREE.Vector3[] = [];
  const towerBox = new THREE.Box3();
  TOWERS.positions.forEach((p, i) => {
    const center = new THREE.Vector3(p[0], PLATFORM_Y, p[2]);
    const tower = buildTower(materials, registry, i + 1, center);
    towerGroup.add(registry.get(`tower.${String(i + 1).padStart(2, "0")}`)!.group);
    towerArms.push(tower.arms);
    towerCenters.push(center);
    towerBox.union(tower.box);
  });
  // 铁塔是独立 Group，必须显式挂到变电站根节点上，否则它们只是"注册了但没进场景"的孤儿。
  root.add(towerGroup);
  zoneTransmission.box.copy(towerBox);

  // ---- 架空导线（悬链线）----
  const lineBatcher = new MeshBatcher(materials);
  const sag = (a: THREE.Vector3, b: THREE.Vector3, depth: number) => {
    const pts: [number, number, number][] = [];
    for (let k = 0; k <= 12; k++) {
      const t = k / 12;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const y = a.y + (b.y - a.y) * t - Math.sin(Math.PI * t) * depth;
      pts.push([x, y, z]);
    }
    return pts;
  };

  // 站内出线 → 首塔。
  //
  // 双回路对应关系：**一榀构架 = 一回路 = 塔的一侧**，榀内三串绝缘子 = 三个相 = 塔的三层横担。
  // 所以是 `anchors[榀][相] → towerArms[0][相][榀]`，六根线两两不交叉、各自挂到该挂的地方。
  //
  // 起点必须取构架**自己回传的挂点**（绝缘子串下端）。早先这里手算
  // `gantryCenter.z + 15`，而构架实际立在 `gantryCenter.z + {-30, -15}` —— 起点比构架
  // 偏南 30 m，六根出线全从空中起头、贴着构架顶飘过去，画面上就是"铁塔的线和下面的
  // 设备没有任何连接"。
  for (let frame = 0; frame < 2; frame++) {
    for (let level = 0; level < 3; level++) {
      const from = gantry.anchors[frame][level];
      const to = towerArms[0][level][frame];
      addCable(lineBatcher, "metal", sag(from, to, 2.6), 0.075, 0.8);
    }
  }

  // 塔间导线
  for (let t = 0; t < towerArms.length - 1; t++) {
    for (let level = 0; level < 3; level++) {
      const a = towerArms[t][level];
      const bNext = towerArms[t + 1][level];
      for (let side = 0; side < 2; side++) {
        addCable(lineBatcher, "metal", sag(a[side], bNext[side], 5.2), 0.075, 0.78);
      }
    }
    // 地线
    const aTop = towerCenters[t].clone().setY(PLATFORM_Y + TOWERS.height + 2.6);
    const bTop = towerCenters[t + 1].clone().setY(PLATFORM_Y + TOWERS.height + 2.6);
    addCable(lineBatcher, "metal", sag(aTop, bTop, 3.4), 0.06, 0.7);
  }

  // 末塔之后继续送出场景外。
  //
  // **出伸长度是被底板尺寸夹住的**，所以这里不写死数字，而是沿线路方向算到板边内 8 m 为止：
  // 底板 `EDGE.x0…x1`、末塔在 x = 438、线路方向 = 末塔 − 次末塔。早期写死 340 m 时
  // 导线会一直飞到 x ≈ 778 —— 已经在底板之外，画面上就是几根悬在空中的线；后来改成
  // 写死 130 m，底板一收（x1 从 580 收到 492）又会顶到板边，所以现在按板边反算。
  const lastArms = towerArms[towerArms.length - 1];
  const lastCenter = towerCenters[towerCenters.length - 1];
  const prevCenter = towerCenters[towerCenters.length - 2];
  const lineDir = new THREE.Vector3().subVectors(lastCenter, prevCenter).normalize();
  const exitRun = (EDGE.x1 - 8 - lastCenter.x) / Math.max(1e-3, lineDir.x);
  const exit = lastCenter.clone().addScaledVector(lineDir, exitRun).setY(PLATFORM_Y + TOWERS.height - 6);
  for (let level = 0; level < 3; level++) {
    for (let side = 0; side < 2; side++) {
      const from = lastArms[level][side];
      const to = exit.clone().add(new THREE.Vector3(0, (level - 1) * 6, side ? 5 : -5));
      addCable(lineBatcher, "metal", sag(from, to, 3), 0.075, 0.7);
    }
  }

  const lineMeshes = lineBatcher.build("transmission-line").meshes;
  const lineGroup = makeGroup("transmission-lines");
  for (const m of lineMeshes) lineGroup.add(m);
  root.add(lineGroup);
  const lineBox = measure(lineGroup);

  registry.add({
    id: "zone.transmission.lines",
    kind: "transmission",
    label: "架空导线",
    subtitle: "LGJ-300/25 · 双回路 6 相 + 2 地线",
    parentId: "zone.transmission",
    childIds: [],
    group: lineGroup,
    meshes: lineMeshes,
    // 用实测包围盒。早先这里写死了 `setFromCenterAndSize(360, +60, -60 / 760,120,300)`，
    // 底座缩小后那组数字就成了"指向板外的幽灵包围盒"——面包屑点回分区会把镜头推飞。
    box: lineBox.clone(),
    pickable: false,
    revealShell: false,
    drillable: false,
  });

  void variation;

  // 分区包围盒要真填上。留空 Box3 会让"面包屑点回分区"把镜头推到包围盒原点去。
  zoneTransmission.box.copy(lineBox);
  zone.box.copy(zoneBox);
  root.updateWorldMatrix(true, true);
  const whole = measure(root);
  if (!whole.isEmpty()) zone.box.union(whole);

  return { group: root, transformerAnchors, gantryBus, gantryAnchors: gantry.anchors, towerArms, towerCenters };
}
