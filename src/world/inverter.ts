import * as THREE from "three";
import { INVERTER, PLATFORM_Y } from "../config";
import { MeshBatcher } from "../core/batcher";
import type { MaterialSet } from "../core/materials";
import type { TwinRegistry } from "../core/registry";
import { finalizeNode, makeGroup } from "./util";

/**
 * 集装箱式逆变升压一体舱：直流侧 1500 V 进、交流侧 0.69 kV 出。
 * 每台舱是独立的可选单元 —— 用户能单独看到它的直流功率、交流功率、转换效率与舱温。
 */

export type InverterBuild = {
  group: THREE.Group;
  anchors: { id: string; center: THREE.Vector3 }[];
};

export function buildInverters(materials: MaterialSet, registry: TwinRegistry): InverterBuild {
  const root = makeGroup("inverter-row");
  const anchors: InverterBuild["anchors"] = [];

  const zone = registry.add({
    id: "zone.inverter",
    kind: "zone",
    label: "逆变升压区",
    subtitle: `${INVERTER.count} 台 × 400 kW 集装箱式逆变升压一体舱`,
    parentId: "station",
    childIds: [],
    group: root,
    meshes: [],
    box: new THREE.Box3(
      new THREE.Vector3(INVERTER.x - 8, PLATFORM_Y, INVERTER.z0 - 6),
      new THREE.Vector3(INVERTER.x + 14, PLATFORM_Y + 5, INVERTER.z0 + INVERTER.count * INVERTER.pitch),
    ),
    pickable: false,
    revealShell: false,
    drillable: true,
  });

  const [L, H, D] = INVERTER.size;

  for (let i = 1; i <= INVERTER.count; i++) {
    const id = `inv.${String(i).padStart(2, "0")}`;
    const g = makeGroup(id);
    const z = INVERTER.z0 + (i - 1) * INVERTER.pitch;
    g.position.set(INVERTER.x, PLATFORM_Y, z);
    const b = new MeshBatcher(materials);

    // 基础墩
    b.add(new THREE.BoxGeometry(L + 1.0, 0.5, D + 1.0), "concrete", { p: [0, 0.25, 0] }, { shade: 0.9 });
    // 舱体
    b.add(new THREE.BoxGeometry(L, H - 0.5, D), "containerDark", { p: [0, 0.5 + (H - 0.5) / 2, 0] });
    // 顶盖
    b.add(new THREE.BoxGeometry(L + 0.4, 0.16, D + 0.35), "metalRoof", { p: [0, H + 0.08, 0] });
    // 正面百叶门（逆变器散热）
    for (const dx of [-L * 0.26, L * 0.26]) {
      b.add(new THREE.BoxGeometry(L * 0.42, H * 0.66, 0.1), "louver", { p: [dx, 0.5 + (H - 0.5) * 0.5, D / 2 + 0.04] });
    }
    // 侧面直流进线箱
    b.add(new THREE.BoxGeometry(0.7, 1.1, 1.2), "metalDark", { p: [-L / 2 - 0.35, 1.4, -0.4] }, { shade: 0.9 });
    // 交流出线套管
    for (let k = 0; k < 3; k++) {
      b.add(new THREE.CylinderGeometry(0.13, 0.16, 1.5, 8), "porcelain", { p: [L / 2 - 0.9, H + 0.85, -0.7 + k * 0.7] });
    }
    // 顶部散热风机
    for (let k = 0; k < 3; k++) {
      b.add(new THREE.CylinderGeometry(0.42, 0.42, 0.22, 10), "metalDark", { p: [-L * 0.28 + k * (L * 0.28), H + 0.25, 0] }, { shade: 0.92 });
    }
    // 铭牌 + 运行指示灯
    b.add(new THREE.BoxGeometry(1.8, 0.4, 0.06), "sign", { p: [-L * 0.32, H - 0.55, D / 2 + 0.06] });
    b.add(new THREE.BoxGeometry(0.2, 0.2, 0.08), "glowCool", { p: [-L * 0.32, H - 1.05, D / 2 + 0.06] });
    b.add(new THREE.BoxGeometry(0.2, 0.2, 0.08), "glowWarm", { p: [-L * 0.32 + 0.42, H - 1.05, D / 2 + 0.06] });
    // 支撑腿
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.add(new THREE.BoxGeometry(0.16, 0.5, 0.16), "metalDark", { p: [sx * (L / 2 - 0.5), 0.25, sz * (D / 2 - 0.4)] }, { shade: 0.88 });
      }
    }

    const { box } = finalizeNode({
      registry,
      id,
      kind: "inverter",
      label: `INV-${String(i).padStart(2, "0")} 逆变升压一体舱`,
      subtitle: "1500 V DC / 690 V AC · 400 kW · 三电平拓扑",
      parentId: "zone.inverter",
      group: g,
      batcher: b,
      dataKey: id,
      drillable: false,
      boxPadding: 0.6,
    });

    root.add(g);
    zone.box.union(box);
    anchors.push({ id, center: new THREE.Vector3(INVERTER.x, PLATFORM_Y + H / 2, z) });
  }

  return { group: root, anchors };
}
