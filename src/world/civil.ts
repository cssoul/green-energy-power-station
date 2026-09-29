import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { OANDM, PLATFORM_Y } from "../config";
import { MeshBatcher } from "../core/batcher";
import type { MaterialSet } from "../core/materials";
import type { TwinRegistry } from "../core/registry";
import { finalizeNode, makeGroup } from "./util";

/**
 * 站区土建：运维综合楼、户外堆场、站区照明。
 *
 * 这些不是"装饰"，它们承担的是**尺度参照**：一栋 34 m 长、9.6 m 高的运维楼摆在
 * 12.2 m 长的储能柜旁边，观看者立刻就能把整个园区的尺寸锚定下来。少了它们，
 * 储能柜会看起来像火柴盒。
 */

/* ------------------------------------------------------------------ *
 * 运维综合楼
 * ------------------------------------------------------------------ */

function buildOffice(materials: MaterialSet, registry: TwinRegistry) {
  const id = "building.om";
  const group = makeGroup(id);
  group.position.set(OANDM.center[0], PLATFORM_Y, OANDM.center[2]);
  const b = new MeshBatcher(materials);
  const [w, h, d] = OANDM.main.size;

  b.add(new THREE.BoxGeometry(w + 3, 0.55, d + 3), "concrete", { p: [0, 0.27, 0] }, { shade: 0.9 });
  b.add(new THREE.BoxGeometry(w, h, d), "panelWall", { p: [0, 0.55 + h / 2, 0] });
  b.add(new THREE.BoxGeometry(w + 0.8, 0.55, d + 0.8), "metalRoof", { p: [0, 0.55 + h + 0.27, 0] });

  // 北侧长条窗 + 南侧竖向分格窗
  b.add(new THREE.BoxGeometry(w * 0.9, 2.2, 0.1), "glass", { p: [0, 0.55 + h * 0.66, -d / 2 - 0.05] });
  b.add(new THREE.BoxGeometry(w * 0.9, 1.5, 0.1), "glass", { p: [0, 0.55 + h * 0.3, -d / 2 - 0.05] });
  for (let i = 0; i < 8; i++) {
    b.add(new THREE.BoxGeometry(1.9, 2.6, 0.1), "glass", {
      p: [-w * 0.4 + i * (w * 0.8) / 7, 0.55 + h * 0.58, d / 2 + 0.05],
    });
  }
  // 主入口雨篷与幕墙
  b.add(new THREE.BoxGeometry(11, 0.4, 4.2), "metalRoof", { p: [0, 0.55 + h * 0.42, d / 2 + 2.2] });
  for (const dx of [-5, 5]) {
    b.add(new THREE.BoxGeometry(0.3, h * 0.42, 0.3), "metal", { p: [dx, 0.55 + h * 0.21, d / 2 + 4.1] });
  }
  b.add(new THREE.BoxGeometry(9, 4.2, 0.16), "glassClear", { p: [0, 0.55 + 2.3, d / 2 + 0.07] });
  b.add(new THREE.BoxGeometry(9.4, 0.9, 0.14), "sign", { p: [0, 0.55 + h * 0.88, d / 2 + 0.07] });

  // 屋面设备与楼梯间
  b.add(new THREE.BoxGeometry(6, 2.4, 5), "panelWall", { p: [-w * 0.28, 0.55 + h + 0.55 + 1.2, -1] });
  for (let i = 0; i < 4; i++) {
    b.add(new THREE.BoxGeometry(2.4, 0.8, 1.8), "metalDark", { p: [w * 0.16 + i * 3.2, 0.55 + h + 1.0, 2] }, { shade: 0.9 });
  }
  // 楼顶光伏（自用）
  for (let i = 0; i < 6; i++) {
    b.add(new THREE.BoxGeometry(6.2, 0.14, 2.6), "pv", {
      p: [-w * 0.42 + i * 0, 0.55 + h + 2.55, -2 + i * 3.2],
      r: [-0.38, 0, 0],
    }, { shade: 0.98 });
  }

  // 附属单层食堂/库房
  const [aw, ah, ad] = OANDM.annex.size;
  b.add(new THREE.BoxGeometry(aw, ah, ad), "panelWall", { p: [w * 0.5 + aw * 0.6 + 4, 0.55 + ah / 2, d * 0.2] });
  b.add(new THREE.BoxGeometry(aw + 0.6, 0.4, ad + 0.6), "metalRoof", { p: [w * 0.5 + aw * 0.6 + 4, 0.55 + ah + 0.2, d * 0.2] });
  for (let i = 0; i < 4; i++) {
    b.add(new THREE.BoxGeometry(1.6, 1.8, 0.1), "glass", { p: [w * 0.5 + 1.5 + i * 2.6, 0.55 + 2.0, d * 0.2 + ad / 2 + 0.05] });
  }

  finalizeNode({
    registry,
    id,
    kind: "building",
    label: "运维综合楼",
    subtitle: "集控室 · 备品备件库 · 值休 · 屋面自用光伏",
    parentId: "zone.om",
    group,
    batcher: b,
    dataKey: id,
    drillable: false,
    boxPadding: 1,
  });
}

/* ------------------------------------------------------------------ *
 * 户外堆场 + 站区照明
 * ------------------------------------------------------------------ */

function buildYardAndLighting(materials: MaterialSet, registry: TwinRegistry): THREE.MeshBasicMaterial | undefined {
  const group = makeGroup("yard");
  const b = new MeshBatcher(materials);

  // 堆场（备品备件集装箱 + 消防水池）
  // 原 yz=168 时堆场北沿(z≈183)压在园区环路北腿(z=176)上 → 整体南退到 yz=154，
  // 使堆场落在 z∈[139,169]，与环路北腿(带 172.2–179.8)和储能南侧联络道(带 128.8–135.2)都留出余量。
  const yx = -190;
  const yz = 154;
  b.add(new THREE.BoxGeometry(46, 0.3, 30), "gravelYard", { p: [yx, PLATFORM_Y + 0.02, yz] });
  for (let i = 0; i < 4; i++) {
    b.add(new THREE.BoxGeometry(6.1, 2.6, 2.44), "containerDark", {
      p: [yx - 18 + i * 7.4, PLATFORM_Y + 1.3, yz - 9],
    });
  }
  b.add(new THREE.BoxGeometry(6.1, 2.6, 2.44), "container", { p: [yx - 14, PLATFORM_Y + 1.3, yz + 6] });
  b.add(new THREE.BoxGeometry(6.1, 2.6, 2.44), "container", { p: [yx - 7.5, PLATFORM_Y + 1.3, yz + 6] });
  // 消防水池
  b.add(new THREE.CylinderGeometry(7.5, 7.5, 6.2, 20), "panelWall", { p: [yx + 24, PLATFORM_Y + 3.1, yz + 2] });
  b.add(new THREE.CylinderGeometry(7.9, 7.9, 0.4, 20), "metalRoof", { p: [yx + 24, PLATFORM_Y + 6.35, yz + 2] });
  b.add(new THREE.BoxGeometry(0.3, 8, 0.3), "metal", { p: [yx + 24, PLATFORM_Y + 7.5, yz + 2] });
  b.add(new THREE.BoxGeometry(0.5, 0.5, 0.5), "glowRed", { p: [yx + 24, PLATFORM_Y + 11.6, yz + 2] });

  // 站区照明：环路沿线布灯
  const lampSpots: [number, number][] = [];
  const ring = { x0: -290, x1: 278, z0: -206, z1: 200 };
  for (let i = 0; i < 12; i++) lampSpots.push([ring.x0 + 6 + (i * (ring.x1 - ring.x0 - 12)) / 11, ring.z0 - 6]);
  for (let i = 0; i < 10; i++) lampSpots.push([ring.x0 + 6 + (i * (ring.x1 - ring.x0 - 12)) / 9, ring.z1 + 6]);
  for (let i = 0; i < 7; i++) lampSpots.push([ring.x1 + 6, ring.z0 + 12 + (i * (ring.z1 - ring.z0 - 24)) / 6]);
  // 以下两排原 z=137 / z=130，压在储能区南侧联络道(z=132, 带宽 128.8–135.2)上；
  // 改为 z=142 / z=120，向联络道两侧各退约 7 m，离开路面。
  for (let i = 0; i < 6; i++) lampSpots.push([-140 + i * 46, 142]);
  // Row B 整体西移 2 m，使原本落在 x=4（贴着 x=8 纵向巡检道边）的那盏退到 x=2，离开路面。
  for (let i = 0; i < 6; i++) lampSpots.push([-42 + i * 22, 120]);

  lampSpots.forEach(([x, z], i) => {
    const shade = 0.94 + (i % 4) * 0.02;
    b.add(new THREE.CylinderGeometry(0.16, 0.22, 9, 10), "metal", { p: [x, PLATFORM_Y + 4.5, z] }, { shade });
    b.add(new THREE.BoxGeometry(2.6, 0.16, 0.16), "metal", { p: [x + 1.2, PLATFORM_Y + 8.9, z] }, { shade: shade * 0.95 });
    b.add(new THREE.BoxGeometry(1.1, 0.24, 0.5), "metalDark", { p: [x + 2.4, PLATFORM_Y + 8.78, z] }, { shade: 0.85 });
    b.add(new THREE.BoxGeometry(0.9, 0.1, 0.42), "glowWarm", { p: [x + 2.4, PLATFORM_Y + 8.62, z] });
    b.add(new THREE.BoxGeometry(0.9, 0.7, 0.9), "concrete", { p: [x, PLATFORM_Y + 0.35, z] }, { shade: 0.88 });
  });

  // ---- 路灯地面光池（黄昏/夜晚亮起）----
  // 41 套路灯的真实点光源太贵（shadow/光照 pass 会爆炸），所以用 additive 透明圆片
  // 模拟地面光斑：白天 opacity=0，黄昏/夜晚跟随 interior 系数亮起。所有圆片合批成 1 个 mesh。
  const lampPoolMap = createLampPoolMap();
  const lampPoolMat = new THREE.MeshBasicMaterial({
    name: "lamp-pool",
    map: lampPoolMap,
    color: 0xffd28a,
    transparent: true,
    opacity: 0, // 白天熄灭；PowerStationScene.applyTime 里按 interior 重新赋值
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    premultipliedAlpha: true,
  });
  materials.register(lampPoolMat);

  const poolGeos: THREE.BufferGeometry[] = [];
  for (const [x, z] of lampSpots) {
    const g = new THREE.CircleGeometry(6.5, 24);
    g.rotateX(-Math.PI / 2);
    g.translate(x, PLATFORM_Y + 0.05, z);
    poolGeos.push(g);
  }
  if (poolGeos.length) {
    const poolGeo = mergeGeometries(poolGeos, false)!;
    const poolMesh = new THREE.Mesh(poolGeo, lampPoolMat);
    poolMesh.name = "lamp-pools";
    poolMesh.renderOrder = 10;
    group.add(poolMesh);
    for (const g of poolGeos) g.dispose();
  }

  // 站区标识牌
  const signSpots: [number, number, number][] = [
    [-300, 60, 0],
    [-300, -60, 0],
    [120, 216, 0],
    [176, -60, 0],
  ];
  for (const [x, z] of signSpots) {
    b.add(new THREE.BoxGeometry(0.2, 3.2, 0.2), "metal", { p: [x, PLATFORM_Y + 1.6, z] });
    b.add(new THREE.BoxGeometry(3.4, 1.6, 0.1), "sign", { p: [x, PLATFORM_Y + 3.4, z] });
  }

  // 光伏区警示旗杆（阵列组之间的通道口）
  for (let i = 0; i < 5; i++) {
    b.add(new THREE.CylinderGeometry(0.08, 0.08, 4.4, 8), "metal", { p: [-268 + i * 68, PLATFORM_Y + 2.2, -196] });
    b.add(new THREE.BoxGeometry(0.9, 0.6, 0.04), "glowWarm", { p: [-268 + i * 68 + 0.46, PLATFORM_Y + 4.1, -196] });
  }

  const built = b.build("yard");
  built.meshes.forEach((m) => group.add(m));

  registry.add({
    id: "zone.yard",
    kind: "zone",
    label: "户外堆场与站区照明",
    subtitle: "备品备件 · 消防水池 · 41 套站区照明",
    parentId: "station",
    childIds: [],
    group,
    meshes: built.meshes,
    box: new THREE.Box3(
      new THREE.Vector3(yx - 28, PLATFORM_Y, yz - 22),
      new THREE.Vector3(yx + 34, PLATFORM_Y + 12, yz + 22),
    ),
    pickable: true,
    revealShell: false,
    drillable: false,
  });
  group.traverse((o) => {
    o.userData.nodeId = "zone.yard";
  });

  return lampPoolMat;
}

/** 路灯地面光池的径向渐变贴图：中心亮、边缘柔和淡出。 */
function createLampPoolMap(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255, 220, 160, 0.88)");
  grad.addColorStop(0.35, "rgba(255, 190, 110, 0.42)");
  grad.addColorStop(1, "rgba(255, 160, 90, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 运维建筑区 + 围墙 + 堆场的总装。 */
export type CivilBuild = { group: THREE.Group; lampPool?: THREE.MeshBasicMaterial };

export function buildCivil(materials: MaterialSet, registry: TwinRegistry): CivilBuild {
  const root = makeGroup("civil");

  registry.add({
    id: "zone.om",
    kind: "zone",
    label: "运维管理区",
    subtitle: "运维综合楼 · 停车坪 · 备品备件",
    parentId: "station",
    childIds: [],
    group: root,
    meshes: [],
    box: new THREE.Box3(
      new THREE.Vector3(OANDM.center[0] - 62, PLATFORM_Y, OANDM.center[2] - 42),
      new THREE.Vector3(OANDM.center[0] + 62, PLATFORM_Y + 14, OANDM.center[2] + 42),
    ),
    pickable: false,
    revealShell: false,
    drillable: true,
  });

  buildOffice(materials, registry);
  root.add(registry.get("building.om")!.group);

  const lampPool = buildYardAndLighting(materials, registry);
  root.add(registry.get("zone.yard")!.group);

  return { group: root, lampPool };
}
