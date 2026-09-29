import * as THREE from "three";
import { EDGE, FENCE, OANDM, PLATFORM, PLATFORM_Y, PV_FARM_BOUNDS, ROAD, SUBSTATION, WATER, ESS } from "../config";
import { MeshBatcher } from "../core/batcher";
import { box } from "../core/geo";
import type { MaterialSet } from "../core/materials";
import type { Terrain } from "./terrain";

/**
 * 道路网。全部由矩形板拼出，白色 / 黄色标线是**几何**而不是贴图 ——
 * 贴图在轴测视角的掠射角下会糊成一条灰带，几何标线的边缘永远是干净的。
 */

type Ribbon = { x0: number; z0: number; x1: number; z1: number; w: number };

/** 把一条直线路段按地形高度切成小段铺板，路面才能跟着外围草原起伏。
 *  `topY` 是路面**顶面**相对地形标高的抬升量；路肩故意比沥青面低一档，避免两者
 *  顶面共面（z-fighting，表现为沿路一条闪烁带——尤其湖边那段最显眼）。 */
function layRibbon(b: MeshBatcher, r: Ribbon, terrain: Terrain, surface: "asphalt" | "track", thickness = 0.36, topY = 0.06) {
  const dx = r.x1 - r.x0;
  const dz = r.z1 - r.z0;
  const len = Math.hypot(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  const step = 9;
  const count = Math.max(1, Math.ceil(len / step));
  const yaw = Math.atan2(dx, dz);
  for (let i = 0; i < count; i++) {
    const t0 = i / count;
    const t1 = (i + 1) / count;
    const mx = r.x0 + dx * ((t0 + t1) / 2);
    const mz = r.z0 + dz * ((t0 + t1) / 2);
    const y = terrain.heightAt(mx, mz);
    const segLen = (len / count) * 1.02;
    b.add(box(r.w, thickness, segLen), surface, {
      p: [mx, y + topY - thickness / 2, mz],
      r: [0, yaw, 0],
    });
  }
  void ux;
  void uz;
}

/** 标线：沿路段铺的细长条，抬高到路面之上一点点。 */
function layLine(b: MeshBatcher, x0: number, z0: number, x1: number, z1: number, w: number, surface: "roadLine" | "paintYellow", y: number) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  const yaw = Math.atan2(dx, dz);
  b.add(box(w, 0.02, len), surface, { p: [(x0 + x1) / 2, y, (z0 + z1) / 2], r: [0, yaw, 0] });
}

/** 虚线标线。 */
function layDashes(
  b: MeshBatcher,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  w: number,
  surface: "roadLine" | "paintYellow",
  y: number,
  dash = 6,
  gap = 6,
) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  const yaw = Math.atan2(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  let s = 2;
  while (s + dash < len - 2) {
    const mx = x0 + ux * (s + dash / 2);
    const mz = z0 + uz * (s + dash / 2);
    b.add(box(w, 0.02, dash), surface, { p: [mx, y, mz], r: [0, yaw, 0] });
    s += dash + gap;
  }
}

export type RoadBuild = {
  meshes: THREE.Mesh[];
  /** 车辆巡航路径（世界坐标，高度已贴地）。 */
  routes: { id: string; name: string; points: THREE.Vector3[]; loop: boolean; speed: number }[];
};

export function buildRoads(materials: MaterialSet, terrain: Terrain): RoadBuild {
  const b = new MeshBatcher(materials);

  const ring = ROAD.ring;
  const highway = ROAD.highway;

  // ---------------- 对外主干道 ----------------
  // 铺装范围跟着底板走（`EDGE ± 6`），留 6 m 免得路基从板边悬空。
  const hw = { x0: EDGE.x0 + 6, x1: EDGE.x1 - 6 };
  layRibbon(b, { x0: hw.x0, z0: highway.z, x1: hw.x1, z1: highway.z, w: highway.w }, terrain, "asphalt", 0.5);
  // 路肩（比路面略宽、略低、颜色也更深，让路缘读得出来）
  // 顶面比沥青面低 0.02 m，杜绝两者共面 z-fighting
  layRibbon(b, { x0: hw.x0, z0: highway.z, x1: hw.x1, z1: highway.z, w: highway.w + 1.6 }, terrain, "track", 0.42, 0.04);
  // 中央双黄线 + 两侧白边线（只铺在**平台**范围内，起伏段不铺，省几何也避免浮空）
  const yH = PLATFORM_Y + 0.09;
  for (const off of [-0.42, 0.42]) {
    layLine(b, PLATFORM.x0, highway.z + off, PLATFORM.x1, highway.z + off, 0.34, "paintYellow", yH);
  }
  layLine(b, PLATFORM.x0, highway.z - highway.w / 2 + 0.9, PLATFORM.x1, highway.z - highway.w / 2 + 0.9, 0.3, "roadLine", yH);
  layLine(b, PLATFORM.x0, highway.z + highway.w / 2 - 0.9, PLATFORM.x1, highway.z + highway.w / 2 - 0.9, 0.3, "roadLine", yH);

  // ---------------- 园区环路 ----------------
  const ringY = PLATFORM_Y + 0.06;
  const ringW = ring.w;
  const legs: Ribbon[] = [
    { x0: ring.x0, z0: ring.z0, x1: ring.x1, z1: ring.z0, w: ringW },
    { x0: ring.x1, z0: ring.z0, x1: ring.x1, z1: ring.z1, w: ringW },
    { x0: ring.x1, z0: ring.z1, x1: ring.x0, z1: ring.z1, w: ringW },
    { x0: ring.x0, z0: ring.z1, x1: ring.x0, z1: ring.z0, w: ringW },
  ];
  for (const leg of legs) layRibbon(b, leg, terrain, "asphalt");
  // 环路中心虚线
  layDashes(b, ring.x0, ring.z0, ring.x1, ring.z0, 0.24, "roadLine", ringY + 0.03);
  layDashes(b, ring.x1, ring.z0, ring.x1, ring.z1, 0.24, "roadLine", ringY + 0.03);
  layDashes(b, ring.x1, ring.z1, ring.x0, ring.z1, 0.24, "roadLine", ringY + 0.03);
  layDashes(b, ring.x0, ring.z1, ring.x0, ring.z0, 0.24, "roadLine", ringY + 0.03);

  // ---------------- 进站支路（主干道 → 园区大门） ----------------
  layRibbon(b, { x0: 148, z0: highway.z, x1: 148, z1: ring.z1, w: 9 }, terrain, "asphalt");
  layLine(b, 148 - 4.5 + 0.8, highway.z, 148 - 4.5 + 0.8, ring.z1, 0.28, "roadLine", PLATFORM_Y + 0.09);
  layLine(b, 148 + 4.5 - 0.8, highway.z, 148 + 4.5 - 0.8, ring.z1, 0.28, "roadLine", PLATFORM_Y + 0.09);

  // ---------------- 光伏区 ↔ 储能区 的东西向主通道 ----------------
  const spineZ = 34;
  layRibbon(b, { x0: -300, z0: spineZ, x1: 190, z1: spineZ, w: ROAD.spine.w }, terrain, "asphalt");
  layDashes(b, -300, spineZ, 190, spineZ, 0.22, "roadLine", PLATFORM_Y + 0.09);

  // 储能区南侧联络道
  layRibbon(b, { x0: -70, z0: 132, x1: 120, z1: 132, w: 6.4 }, terrain, "asphalt");
  layRibbon(b, { x0: 8, z0: spineZ, x1: 8, z1: 132, w: 6.4 }, terrain, "asphalt");

  // ---------------- 光伏区检修通道（碎石 / 泥结石） ----------------
  // pad 从 7 减到 5：阵列组宽度缩短后西缘仍有 >2 m 净距，同时减少农场四周空白草地。
  const pad = 5;
  // 农场外圈
  layRibbon(b, { x0: PV_FARM_BOUNDS.x0 - pad, z0: PV_FARM_BOUNDS.z0 - pad, x1: PV_FARM_BOUNDS.x1 + pad, z1: PV_FARM_BOUNDS.z0 - pad, w: 4.4 }, terrain, "track", 0.28);
  layRibbon(b, { x0: PV_FARM_BOUNDS.x0 - pad, z0: PV_FARM_BOUNDS.z1 + pad, x1: PV_FARM_BOUNDS.x1 + pad, z1: PV_FARM_BOUNDS.z1 + pad, w: 4.4 }, terrain, "track", 0.28);
  layRibbon(b, { x0: PV_FARM_BOUNDS.x0 - pad, z0: PV_FARM_BOUNDS.z0, x1: PV_FARM_BOUNDS.x0 - pad, z1: PV_FARM_BOUNDS.z1, w: 4.4 }, terrain, "track", 0.28);
  layRibbon(b, { x0: PV_FARM_BOUNDS.x1 + pad, z0: PV_FARM_BOUNDS.z0, x1: PV_FARM_BOUNDS.x1 + pad, z1: PV_FARM_BOUNDS.z1, w: 4.4 }, terrain, "track", 0.28);

  // ---------------- 储能区碎石场地 ----------------
  const essW = ESS.cols * ESS.size[0] + (ESS.cols - 1) * ESS.gapX;
  const essD = ESS.rows * ESS.size[2] + (ESS.rows - 1) * ESS.gapZ;
  b.add(box(essW + 26, 0.3, essD + 24), "gravelYard", {
    p: [ESS.center[0], PLATFORM_Y + 0.02, ESS.center[2]],
  });
  // 储能区与围墙
  b.add(box(essW + 26 + 1.2, 0.7, 0.7), "concrete", { p: [ESS.center[0], PLATFORM_Y + 0.35, ESS.center[2] - (essD + 24) / 2] });
  b.add(box(essW + 26 + 1.2, 0.7, 0.7), "concrete", { p: [ESS.center[0], PLATFORM_Y + 0.35, ESS.center[2] + (essD + 24) / 2] });

  // ---------------- 变电站碎石场地 ----------------
  b.add(box(190, 0.3, 150), "gravelYard", { p: [SUBSTATION.center[0], PLATFORM_Y + 0.02, SUBSTATION.center[2] - 6] });

  // ---------------- 运维楼停车坪 ----------------
  const pk = OANDM.parking;
  b.add(box(pk.w, 0.34, pk.d), "asphalt", { p: [OANDM.center[0] - 34, PLATFORM_Y + 0.04, OANDM.center[2] + 20] });
  for (let i = 0; i < 9; i++) {
    b.add(box(0.22, 0.02, pk.d - 3), "roadLine", {
      p: [OANDM.center[0] - 34 - pk.w / 2 + 3 + i * 4.3, PLATFORM_Y + 0.23, OANDM.center[2] + 20],
    });
  }

  // ---------------- 湖岸小径 ----------------
  // 池子在主干道以南，中间只有 3 m 的净空，放不下 3.4 m 的路面；
  // 而且砾石压顶本身就读作环形步道。这里刻意不铺小径 ——
  // 若日后挪池子，记得回来看这条带子够不够（见 config.ts 的 WATER 注释）。

  const built = b.build("road");

  // ---------------- 车辆巡航路径 ----------------
  const H = (x: number, z: number) => terrain.heightAt(x, z) + 0.35;
  // 主干道上的车在板边内 70 m 掉头，免得车身跑出底板之外悬空。
  // 底板是矩形且中心不在原点，所以两端要**各算各的**，不能再用 ±EDGE。
  const truckW = EDGE.x0 + 70;
  const truckE = EDGE.x1 - 70;
  const routes: RoadBuild["routes"] = [
    {
      id: "route.highway",
      name: "对外主干道",
      speed: 9,
      loop: true,
      points: [
        new THREE.Vector3(truckW, H(truckW, highway.z - 3.2), highway.z - 3.2),
        new THREE.Vector3(-120, H(-120, highway.z - 3.2), highway.z - 3.2),
        new THREE.Vector3(300, H(300, highway.z - 3.2), highway.z - 3.2),
        new THREE.Vector3(truckE, H(truckE, highway.z - 3.2), highway.z - 3.2),
      ],
    },
    {
      id: "route.highwayBack",
      name: "对外主干道（返程）",
      speed: 7.5,
      loop: true,
      points: [
        new THREE.Vector3(truckE, H(truckE, highway.z + 3.2), highway.z + 3.2),
        new THREE.Vector3(240, H(240, highway.z + 3.2), highway.z + 3.2),
        new THREE.Vector3(-200, H(-200, highway.z + 3.2), highway.z + 3.2),
        new THREE.Vector3(truckW, H(truckW, highway.z + 3.2), highway.z + 3.2),
      ],
    },
    {
      id: "route.ring",
      name: "园区环路",
      speed: 6.5,
      loop: true,
      points: [
        new THREE.Vector3(ring.x0 + 2.6, PLATFORM_Y + 0.35, ring.z0 + 2.0),
        new THREE.Vector3(ring.x1 - 2.6, PLATFORM_Y + 0.35, ring.z0 + 2.0),
        new THREE.Vector3(ring.x1 - 2.0, PLATFORM_Y + 0.35, ring.z1 - 2.6),
        new THREE.Vector3(ring.x0 + 2.0, PLATFORM_Y + 0.35, ring.z1 - 2.6),
      ],
    },
    {
      id: "route.spine",
      name: "光伏—储能联络道",
      speed: 5.2,
      loop: false,
      points: [
        new THREE.Vector3(-286, PLATFORM_Y + 0.35, spineZ - 2.0),
        new THREE.Vector3(-120, PLATFORM_Y + 0.35, spineZ - 2.0),
        new THREE.Vector3(60, PLATFORM_Y + 0.35, spineZ - 2.0),
        new THREE.Vector3(186, PLATFORM_Y + 0.35, spineZ - 2.0),
      ],
    },
    {
      id: "route.substation",
      name: "变电站巡检道",
      speed: 4.4,
      loop: true,
      // 北边从 -58 退到 -66：主变北移后，巡检车沿北边行驶与 tx.01 之间留出 >10 m 净距。
      points: [
        new THREE.Vector3(SUBSTATION.center[0] - 62, PLATFORM_Y + 0.35, SUBSTATION.center[2] - 66),
        new THREE.Vector3(SUBSTATION.center[0] + 62, PLATFORM_Y + 0.35, SUBSTATION.center[2] - 66),
        new THREE.Vector3(SUBSTATION.center[0] + 62, PLATFORM_Y + 0.35, SUBSTATION.center[2] + 46),
        new THREE.Vector3(SUBSTATION.center[0] - 62, PLATFORM_Y + 0.35, SUBSTATION.center[2] + 46),
      ],
    },
  ];

  return { meshes: built.meshes, routes };
}
