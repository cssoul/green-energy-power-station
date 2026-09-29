import * as THREE from "three";
import { PLATFORM_Y, PV, PV_BLOCK, pvBlockCenter } from "../config";
import { MeshBatcher } from "../core/batcher";
import type { MaterialSet } from "../core/materials";
import type { TwinRegistry } from "../core/registry";
import { variation } from "../core/rng";
import { finalizeNode, makeGroup } from "./util";

/**
 * 光伏农场：20 个阵列组，每组 20 排 × 20 块组件。
 *
 * **不能做成"一整块蓝毯"。** 要让下面这些在画面里各自读得出来：
 *   单块组件 · 排内横缝 · 排与排之间的通道 · 金属支架的立柱与檩条 · 组件之间的检修间隙
 * 做法是：组件是逐块的真几何（共 8000 块，用合批压成每组件组 3 个 draw call），
 * 支架是按"排"造的连续檩条 + 每隔 9.3 m 一对立柱与一道斜撑 —— 这正是真实光伏支架的样子。
 *
 * 倾角 22°、组件朝 +Z（南），所以每一排的正面都朝向轴测相机，
 * 深蓝色的受光面与浅银色的背面形成交替的明暗带，阵列的行列感就出来了。
 */

const T = PV.tilt;
const FOOT_DEPTH = PV.cellH * Math.sin(T); // 组件斜面在 Z 上的投影深度
const RISE = PV.cellH * Math.cos(T); // 组件斜面带来的抬升
const Y_LOW = PV.legH; // 组件下沿离地高
const ROW_SPAN = PV.cols * (PV.cellW + PV.cellGap);
const COL_PITCH = PV.cellW + PV.cellGap;
const POST_COUNT = 6;

export type PvFarmBuild = {
  group: THREE.Group;
  /** 每个阵列组的中心，供能源流动画取端点。 */
  blockAnchors: { id: string; center: THREE.Vector3; combiner: THREE.Vector3 }[];
};

export function buildPvFarm(materials: MaterialSet, registry: TwinRegistry): PvFarmBuild {
  const farmGroup = makeGroup("pv-farm");
  const blockAnchors: PvFarmBuild["blockAnchors"] = [];

  const zone = registry.add({
    id: "zone.pv",
    kind: "pvFarm",
    label: "光伏发电区",
    subtitle: `${PV.grid.cols * PV.grid.rows} 个阵列组 · ${PV.cols * PV.rows * PV.grid.cols * PV.grid.rows} 块组件`,
    parentId: "station",
    childIds: [],
    group: farmGroup,
    meshes: [],
    box: new THREE.Box3(),
    pickable: false,
    revealShell: false,
    drillable: true,
  });

  const total = PV.grid.cols * PV.grid.rows;
  let farmBox = new THREE.Box3();

  for (let index = 0; index < total; index++) {
    const [cx, , cz] = pvBlockCenter(index);
    const id = `pv.${String(index + 1).padStart(2, "0")}`;
    const group = makeGroup(id);
    const b = new MeshBatcher(materials);

    const halfW = ROW_SPAN / 2;
    const z0 = -PV_BLOCK.d / 2 + PV.rowPitch / 2;
    // 逐组轻微色差，避免 20 个阵列组像同一张贴图平铺
    const tone = 0.94 + variation(index * 3.7) * 0.12;
    const rackTone = 0.92 + variation(index * 5.3) * 0.14;

    for (let r = 0; r < PV.rows; r++) {
      const rz = z0 + r * PV.rowPitch;
      const panelY = Y_LOW + RISE / 2;

      // ---- 组件：逐块真几何 ----
      // 正面（镀膜玻璃）与背面（背板 + 接线盒）各一块面片，沿板法线拉开一个组件厚度。
      const nx = 0;
      const ny = Math.sin(T);
      const nz = Math.cos(T);
      const halfT = PV.cellT / 2;
      for (let c = 0; c < PV.cols; c++) {
        const px = -ROW_SPAN / 2 + COL_PITCH / 2 + c * COL_PITCH;
        const jitter = variation(index * 97 + r * 17 + c * 3);
        const ox = cx + px;
        const oy = PLATFORM_Y + panelY;
        const oz = cz + rz;

        const front = new THREE.PlaneGeometry(PV.cellW, PV.cellH);
        b.add(front, "pv", {
          p: [ox + nx * halfT, oy + ny * halfT, oz + nz * halfT],
          r: [-T, 0, 0],
        }, { shade: tone, tint: [1, 1, 1 + jitter * 0.05] });
        front.dispose();

        const back = new THREE.PlaneGeometry(PV.cellW, PV.cellH);
        b.add(back, "pvBack", {
          p: [ox - nx * halfT, oy - ny * halfT, oz - nz * halfT],
          r: [-T, 0, 0],
        }, { shade: 0.9 });
        back.dispose();
      }

      // ---- 支架：沿整排的檩条（倾斜）+ 立柱（竖直）----
      const railLocal: [number, number, number][] = [
        [0, -PV.cellH / 2 - 0.04, -0.07],
        [0, PV.cellH / 2 + 0.04, -0.07],
        [0, -PV.cellH / 4, -0.19],
        [0, PV.cellH / 4, -0.19],
      ];
      const railCenter = new THREE.Vector3(cx, PLATFORM_Y + panelY, cz + rz);
      for (const [lx, ly, lz] of railLocal) {
        const rail = new THREE.BoxGeometry(ROW_SPAN + 0.4, 0.085, 0.085);
        // 把局部坐标绕 X 旋转 -T 再加到排中心
        const cosT = Math.cos(-T);
        const sinT = Math.sin(-T);
        const wy = ly * cosT - lz * sinT;
        const wz = ly * sinT + lz * cosT;
        b.add(rail, "metalDark", { p: [railCenter.x + lx, railCenter.y + wy, railCenter.z + wz], r: [-T, 0, 0] }, {
          shade: rackTone,
        });
        rail.dispose();
      }

      // 立柱 + 斜撑
      for (let p = 0; p < POST_COUNT; p++) {
        const px = -halfW + (ROW_SPAN / (POST_COUNT - 1)) * p;
        const x = cx + px;
        const zFront = cz + rz + FOOT_DEPTH / 2;
        const zRear = cz + rz - FOOT_DEPTH / 2;
        // 前立柱
        const frontPost = new THREE.BoxGeometry(0.09, Y_LOW, 0.09);
        b.add(frontPost, "metalDark", { p: [x, PLATFORM_Y + Y_LOW / 2, zFront] }, { shade: rackTone * 0.94 });
        frontPost.dispose();
        // 后立柱
        const rearH = Y_LOW + RISE;
        const rearPost = new THREE.BoxGeometry(0.09, rearH, 0.09);
        b.add(rearPost, "metalDark", { p: [x, PLATFORM_Y + rearH / 2, zRear] }, { shade: rackTone * 0.9 });
        rearPost.dispose();
        // 斜撑（前柱底 → 后柱中上）
        const braceTopY = Y_LOW + RISE * 0.72;
        const dy = braceTopY;
        const dz = -FOOT_DEPTH;
        const len = Math.hypot(dy, dz);
        const brace = new THREE.BoxGeometry(0.06, len, 0.06);
        b.add(brace, "metalDark", {
          p: [x, PLATFORM_Y + dy / 2, (zFront + zRear) / 2],
          r: [-Math.asin(dz / len), 0, 0],
        }, { shade: rackTone * 0.86 });
        brace.dispose();
      }
    }

    // ---- 基础墩：每排两端一小块混凝土，读起来像真的做过场平与基础 ----
    for (let r = 0; r < PV.rows; r++) {
      const rz = z0 + r * PV.rowPitch;
      for (const px of [-halfW - 0.6, halfW + 0.6]) {
        const pad = new THREE.BoxGeometry(0.7, 0.5, FOOT_DEPTH + 1.2);
        b.add(pad, "concrete", { p: [cx + px, PLATFORM_Y + 0.25, cz + rz] }, { shade: 0.86 });
        pad.dispose();
      }
    }

    const { box } = finalizeNode({
      registry,
      id,
      kind: "pvBlock",
      label: `PV-${String(index + 1).padStart(2, "0")} 阵列组`,
      subtitle: `${PV.rows} 排 × ${PV.cols} 块 · ${PV.rows * PV.cols} 块组件`,
      parentId: "zone.pv",
      group,
      batcher: b,
      dataKey: id,
      boxPadding: 0.6,
    });
    farmBox.union(box);

    // ---- 直流汇流箱：装在阵列组南侧通道口 ----
    const cbGroup = makeGroup(`${id}.combiner`);
    const cb = new MeshBatcher(materials);
    const cbZ = cz + PV_BLOCK.d / 2 + 4.6;
    const anchors: THREE.Vector3[] = [];
    for (let k = 0; k < 3; k++) {
      const x = cx - 14 + k * 14;
      const shell = new THREE.BoxGeometry(1.5, 1.9, 0.8);
      cb.add(shell, "container", { p: [x, PLATFORM_Y + 1.35, cbZ] });
      shell.dispose();
      const plinth = new THREE.BoxGeometry(1.9, 0.4, 1.2);
      cb.add(plinth, "concrete", { p: [x, PLATFORM_Y + 0.2, cbZ] });
      plinth.dispose();
      const door = new THREE.BoxGeometry(1.1, 1.4, 0.06);
      cb.add(door, "louver", { p: [x, PLATFORM_Y + 1.35, cbZ + 0.43] });
      door.dispose();
      const cap = new THREE.BoxGeometry(1.62, 0.14, 0.92);
      cb.add(cap, "metalRoof", { p: [x, PLATFORM_Y + 2.36, cbZ] });
      cap.dispose();
      const lamp = new THREE.BoxGeometry(0.16, 0.16, 0.1);
      cb.add(lamp, "glowCool", { p: [x + 0.55, PLATFORM_Y + 2.05, cbZ + 0.44] });
      lamp.dispose();
      anchors.push(new THREE.Vector3(x, PLATFORM_Y + 1.4, cbZ));
    }

    finalizeNode({
      registry,
      id: `${id}.cb`,
      kind: "combiner",
      label: `CB-${String(index + 1).padStart(2, "0")} 直流汇流箱`,
      subtitle: "24 路输入 · IP65 · 组串监测",
      parentId: id,
      group: cbGroup,
      batcher: cb,
      drillable: false,
      dataKey: id,
      boxPadding: 0.4,
    });

    // 关键：阵列组与汇流箱都必须挂进 farmGroup。
    // 漏了这一行，20 组、8000 块组件会"注册了但没进场景" —— 统计里一切正常，
    // 画面里却是一片空草地（而且不会有任何报错）。见 buildWorld 末尾的孤儿审计。
    farmGroup.add(group);
    farmGroup.add(cbGroup);

    blockAnchors.push({
      id,
      center: new THREE.Vector3(cx, PLATFORM_Y + Y_LOW + RISE / 2, cz),
      combiner: anchors[1].clone(),
    });
  }

  zone.box.copy(farmBox);
  return { group: farmGroup, blockAnchors };
}
