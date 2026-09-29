import * as THREE from "three";
import { PLATFORM_Y } from "../config";
import { MeshBatcher } from "../core/batcher";
import type { MaterialSet, SurfaceName } from "../core/materials";
import type { TwinRegistry } from "../core/registry";
import { makeGroup } from "./util";

/**
 * 运维车辆：沿道路缓慢巡航。
 *
 * 不做寻路、不做避让 —— 每辆车就是"按固定路线匀速跑 + 车头朝切线"。
 * 这个量级的运动在俯视轴测里已经足够可信，而代价是零。
 *
 * ------------------------------------------------------------------ *
 * **朝向契约：本文件所有车辆一律"车头朝 +X"。**
 *
 * 这条契约必须与 `PowerStationScene.updateVehicles` 里那行朝向公式同时成立：
 *   `rotation.y = atan2(dx, dz) - π/2`
 * 把 `+X` 转到 `(dx, dz)` 方向时（`R_y(θ)·X̂ = (cosθ, -sinθ)`，取 `θ = φ - π/2`
 * 恰有 `(sinφ, cosφ)`），所以那行公式**只对"+X 是车头"的模型成立**。
 *
 * 这里栽过一次：卡车原来把驾驶室放在 `-L*0.34`（车头朝 -X），却把前照灯放在
 * `+L/2`（车头朝 +X），两套基准自相矛盾；加上朝向公式认的是 +X，于是整队卡车
 * 都是**倒着开**——货箱在前、驾驶室在后。而且 6×4 卡车的转向轴本来就在驾驶室
 * 下方，也跟着跑到了车尾。
 *
 * 于是统一成 +X 车头，并且**每个部件都按这条契约自查**：
 *   驾驶室 / 风挡 / 前照灯 / 铲斗 / 翻斗臂 → +X 侧；
 *   货箱 / 尾灯 / 后轮组 → -X 侧。
 * ------------------------------------------------------------------ */

export type VehicleKind = "patrol" | "pickup" | "truck" | "utility" | "excavator";

/** 车轮在车体局部坐标下的 (x, z) 位置；y 恒为轮半径。 */
type Wheel = [number, number];

type VehicleSpec = {
  kind: VehicleKind;
  label: string;
  paint: SurfaceName;
  length: number;
  width: number;
  height: number;
  wheels: Wheel[];
  wheelRadius: number;
  boom?: boolean;
  beacon?: boolean;
};

const SPECS: Record<VehicleKind, VehicleSpec> = {
  patrol: {
    kind: "patrol",
    label: "电力巡检车",
    paint: "paintWhite",
    length: 4.8,
    width: 1.95,
    height: 1.5,
    wheelRadius: 0.36,
    wheels: [[-1.5, 0.85], [-1.5, -0.85], [1.55, 0.85], [1.55, -0.85]],
    beacon: true,
  },
  pickup: {
    kind: "pickup",
    label: "工程皮卡",
    paint: "paintBlue",
    length: 5.4,
    width: 2.0,
    height: 1.55,
    wheelRadius: 0.4,
    wheels: [[-1.8, 0.9], [-1.8, -0.9], [1.8, 0.9], [1.8, -0.9]],
    beacon: true,
  },
  truck: {
    kind: "truck",
    label: "运维卡车",
    paint: "paintWhite",
    length: 8.4,
    width: 2.45,
    height: 2.2,
    wheelRadius: 0.5,
    // 6×4：转向轴在驾驶室下方（+X 侧），驱动双联轴在货箱下方（-X 侧）。
    wheels: [[3.1, 1.05], [3.1, -1.05], [-0.6, 1.05], [-0.6, -1.05], [-1.8, 1.05], [-1.8, -1.05]],
  },
  utility: {
    kind: "utility",
    label: "电力检修车",
    paint: "paintYellow",
    length: 7.6,
    width: 2.4,
    height: 2.0,
    wheelRadius: 0.46,
    wheels: [[-2.8, 1.0], [-2.8, -1.0], [0.8, 1.0], [0.8, -1.0], [2.0, 1.0], [2.0, -1.0]],
    boom: true,
    beacon: true,
  },
  excavator: {
    kind: "excavator",
    label: "装载机",
    paint: "paintYellow",
    length: 6.2,
    width: 2.6,
    height: 2.4,
    wheelRadius: 0.55,
    wheels: [[-1.9, 1.15], [-1.9, -1.15], [1.7, 1.15], [1.7, -1.15]],
    beacon: true,
  },
};

export type VehicleHandle = {
  id: string;
  kind: VehicleKind;
  group: THREE.Group;
  routeId: string;
  /** 0..1 的路径参数 */
  t: number;
  speed: number;
  label: string;
};

export type VehicleBuild = {
  group: THREE.Group;
  vehicles: VehicleHandle[];
};

export function buildVehicles(
  materials: MaterialSet,
  registry: TwinRegistry,
  routes: { id: string; points: THREE.Vector3[]; loop: boolean; speed: number }[],
): VehicleBuild {
  const group = makeGroup("vehicles");

  const zone = registry.add({
    id: "zone.vehicles",
    kind: "zone",
    label: "运维车辆",
    subtitle: "巡检车 ×2 · 工程皮卡 · 运维卡车 · 电力检修车",
    parentId: "station",
    childIds: [],
    group,
    meshes: [],
    box: new THREE.Box3(
      new THREE.Vector3(-460, PLATFORM_Y, 120),
      new THREE.Vector3(320, PLATFORM_Y + 4, 300),
    ),
    pickable: false,
    revealShell: false,
    drillable: false,
  });

  const plan: { kind: VehicleKind; routeId: string; t: number; speed: number }[] = [
    { kind: "patrol", routeId: "route.highway", t: 0.06, speed: 1.0 },
    { kind: "pickup", routeId: "route.highwayBack", t: 0.42, speed: 0.92 },
    { kind: "truck", routeId: "route.highway", t: 0.63, speed: 0.78 },
    { kind: "patrol", routeId: "route.ring", t: 0.18, speed: 0.7 },
    { kind: "utility", routeId: "route.ring", t: 0.62, speed: 0.62 },
    { kind: "pickup", routeId: "route.spine", t: 0.2, speed: 0.55 },
    { kind: "truck", routeId: "route.substation", t: 0.3, speed: 0.5 },
    { kind: "excavator", routeId: "route.substation", t: 0.72, speed: 0.42 },
  ];

  const vehicles: VehicleHandle[] = [];
  let index = 0;

  for (const item of plan) {
    const route = routes.find((r) => r.id === item.routeId);
    if (!route) continue;
    const spec = SPECS[item.kind];
    const id = `veh.${String(++index).padStart(2, "0")}`;
    const g = makeGroup(id);
    g.position.copy(route.points[0]);

    const b = new MeshBatcher(materials);
    buildVehicleGeometry(b, spec);
    const { meshes } = b.build(id);
    meshes.forEach((m) => g.add(m));
    group.add(g);

    vehicles.push({
      id,
      kind: item.kind,
      group: g,
      routeId: item.routeId,
      t: item.t,
      speed: item.speed * route.speed,
      label: spec.label,
    });

    registry.add({
      id,
      kind: "vehicle",
      label: `${spec.label} ${String(index).padStart(2, "0")}`,
      subtitle: route.loop ? "沿线循环巡检" : "往返巡检",
      parentId: "zone.vehicles",
      childIds: [],
      group: g,
      meshes,
      box: new THREE.Box3().setFromCenterAndSize(g.position.clone(), new THREE.Vector3(5, 3, 3)),
      pickable: true,
      revealShell: false,
      drillable: false,
      dataKey: id,
    });
    g.traverse((o) => {
      o.userData.nodeId = id;
    });
  }

  void zone;
  return { group, vehicles };
}

function buildVehicleGeometry(b: MeshBatcher, spec: VehicleSpec) {
  const L = spec.length;
  const W = spec.width;
  const H = spec.height;
  const wheelR = spec.wheelRadius;

  // 底盘
  const chassis = new THREE.BoxGeometry(L * 0.94, 0.28, W * 0.86);
  chassis.translate(0, wheelR + 0.2, 0);
  b.add(chassis, "tire", {});
  chassis.dispose();

  // 车身
  const body = new THREE.BoxGeometry(L, H * 0.5, W);
  body.translate(spec.boom ? -L * 0.06 : 0, wheelR + 0.34 + H * 0.25, 0);
  b.add(body, spec.paint, {});
  body.dispose();

  // 驾驶室 —— **在 +X 侧**（车头）。卡车是长头/平头各有各的算法，这里统一：
  // 卡车驾驶室压在最前面（0.34L），其余车型只从中心往前挪一点点（0.08L）；
  // 装载机反过来 —— 它的车头是铲斗，驾驶室照真车往后坐（-0.12L）。
  const cabinH = spec.kind === "excavator" ? 1.1 : H * 0.62;
  const cabW = L * (spec.kind === "truck" ? 0.24 : 0.42);
  const cabin = new THREE.BoxGeometry(cabW, cabinH, W * 0.94);
  const cabinX = spec.kind === "truck" ? L * 0.34 : spec.kind === "excavator" ? -L * 0.12 : L * 0.08;
  cabin.translate(cabinX, wheelR + 0.34 + H * 0.5 + cabinH * 0.42, 0);
  b.add(cabin, spec.paint, {});
  cabin.dispose();

  // 风挡与侧窗：风挡贴在驾驶室的**前脸**（+X 那一面），所以是 `cabinX + cabW/2`
  const winY = wheelR + 0.34 + H * 0.5 + cabinH * 0.42;
  const front = new THREE.BoxGeometry(0.12, cabinH * 0.66, W * 0.86);
  front.translate(cabinX + cabW / 2 + 0.04, winY + cabinH * 0.1, 0);
  b.add(front, "glass", {});
  front.dispose();
  for (const sz of [-1, 1]) {
    const side = new THREE.BoxGeometry(L * (spec.kind === "truck" ? 0.2 : 0.34), cabinH * 0.6, 0.1);
    side.translate(cabinX, winY + cabinH * 0.1, sz * (W * 0.94) / 2);
    b.add(side, "glass", {});
    side.dispose();
  }

  // 货箱 / 罐体 —— 在 -X 侧（车尾），紧贴驾驶室身后
  if (spec.kind === "truck" || spec.kind === "pickup") {
    const bedLen = spec.kind === "truck" ? L * 0.6 : L * 0.42;
    const bedH = H * (spec.kind === "truck" ? 1.5 : 0.55);
    const box = new THREE.BoxGeometry(bedLen, bedH, W * 0.96);
    box.translate(-L / 2 + bedLen / 2, wheelR + 0.4 + bedH / 2, 0);
    b.add(box, spec.kind === "truck" ? "paintWhite" : "metalDark", {});
    box.dispose();
  }
  if (spec.kind === "pickup") {
    const rail = new THREE.BoxGeometry(L * 0.42, 0.12, W * 0.96);
    rail.translate(-L / 2 + L * 0.21, wheelR + 0.4 + H * 0.55, 0);
    b.add(rail, "metalDark", {});
    rail.dispose();
  }

  // 检修车的折叠臂 —— 装在**车尾**（-X），照真车是"驾驶室在前、作业臂在后"。
  // 镜像时两样都要跟着翻：x 取负，绕 Z 的倾角取负。
  if (spec.boom) {
    // -0.26L 而不是 -0.1L：驾驶室移到 +X 之后，-0.1L 那个位置正好落在驾驶室的
    // x 区间里，立杆会从驾驶室顶棚穿出去。退到货箱上就干净了。
    const boomX = -L * 0.26;
    const mast = new THREE.BoxGeometry(0.34, 1.5, 0.34);
    mast.translate(boomX, wheelR + 0.34 + H * 0.5 + 1.1, 0);
    b.add(mast, "metal", {});
    mast.dispose();
    const arm = new THREE.BoxGeometry(3.6, 0.28, 0.3);
    arm.rotateZ(-0.34);
    arm.translate(boomX - 1.6, wheelR + 0.34 + H * 0.5 + 2.1, 0);
    b.add(arm, "paintYellow", {});
    arm.dispose();
    const arm2 = new THREE.BoxGeometry(2.2, 0.22, 0.24);
    arm2.rotateZ(0.42);
    arm2.translate(boomX - 3.4, wheelR + 0.34 + H * 0.5 + 2.65, 0);
    b.add(arm2, "paintYellow", {});
    arm2.dispose();
  }

  // 装载机铲斗
  if (spec.kind === "excavator") {
    const arm = new THREE.BoxGeometry(2.4, 0.26, 0.3);
    arm.rotateZ(-0.36);
    arm.translate(L * 0.34, wheelR + 0.34 + H * 0.5 + 0.7, 0);
    b.add(arm, "paintYellow", {});
    arm.dispose();
    const bucket = new THREE.BoxGeometry(1.1, 0.9, W * 1.05);
    bucket.translate(L * 0.55, wheelR + 0.1, 0);
    b.add(bucket, "metalDark", {});
    bucket.dispose();
  }

  // 车轮
  for (const [wx, wz] of spec.wheels) {
    const tire = new THREE.CylinderGeometry(wheelR, wheelR, 0.3, 12);
    tire.rotateX(Math.PI / 2);
    tire.translate(wx, wheelR, wz);
    b.add(tire, "tire", {});
    tire.dispose();
    const rim = new THREE.CylinderGeometry(wheelR * 0.52, wheelR * 0.52, 0.34, 10);
    rim.rotateX(Math.PI / 2);
    rim.translate(wx, wheelR, wz);
    b.add(rim, "metal", {});
    rim.dispose();
  }

  // 车灯
  const lightY = wheelR + 0.34 + H * 0.3;
  for (const sz of [-1, 1]) {
    const head = new THREE.BoxGeometry(0.12, 0.18, 0.34);
    head.translate(L / 2 - 0.02, lightY, sz * W * 0.32);
    b.add(head, "glowWarm", {});
    head.dispose();
    const tail = new THREE.BoxGeometry(0.1, 0.16, 0.3);
    tail.translate(-L / 2 + 0.02, lightY, sz * W * 0.32);
    b.add(tail, "glowRed", {});
    tail.dispose();
  }

  // 顶部作业警示灯
  if (spec.beacon) {
    const bar = new THREE.BoxGeometry(1.1, 0.16, 0.32);
    bar.translate(cabinX, winY + cabinH * 0.42 + 0.2, 0);
    b.add(bar, "glowWarm", {});
    bar.dispose();
  }
}
