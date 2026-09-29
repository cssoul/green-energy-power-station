import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * 轴测取景 + 平滑镜头。
 *
 * 两条设计约束：
 *  1. **不要跳镜头。** 下钻（电站 → 储能区 → ESS-01 → Stack-01）必须走
 *     "位置 + 注视点"同时插值，且用指数衰减而不是线性 lerp —— 线性 lerp 会让
 *     远距离移动显得"先慢后快再急停"，指数衰减才有真实镜头的质量感。
 *  2. **用户可以随时打断。** 转场期间一拖鼠标就立刻接管，不做"运镜期间锁死输入"
 *     那种惹人烦的处理。
 */

export type ViewPreset = {
  id: string;
  label: string;
  /** 目标点 */
  target: [number, number, number];
  /** 方位角（绕 Y，从 +X 轴起算）与俯仰角（自水平面起算），单位弧度 */
  azimuth: number;
  elevation: number;
  /**
   * **相机到目标点的距离（米）**。
   *
   * 这里刻意用距离而不是"需要覆盖的半径"：后者要再除一次 tan(fov/2)，
   * 写 190 实际会飞到 920 m 外 —— 机位预设值会变得完全不可读。
   */
  distance: number;
};

const DEG = Math.PI / 180;

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private desiredPos = new THREE.Vector3();
  private desiredTarget = new THREE.Vector3();
  private transitioning = false;
  private stiffness = 3.6;

  /** 取景半径：当前"可视范围"的估计值，用于把新目标框进画面。 */
  private currentRadius = 420;

  constructor(
    private domElement: HTMLElement,
    aspect: number,
    fov: number,
    near: number,
    far: number,
  ) {
    this.camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
    this.camera.position.set(520, 620, 760);

    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.rotateSpeed = 0.62;
    this.controls.zoomSpeed = 0.9;
    this.controls.panSpeed = 0.8;
    this.controls.screenSpacePanning = false;
    this.controls.enablePan = true;
    // 俯角锁定在 18°–78°：再低会穿到地面以下，再高就退化成平面图。
    this.controls.minPolarAngle = 12 * DEG;
    this.controls.maxPolarAngle = 72 * DEG;
    // 最近 4.5 m：储能下钻要一直看到 52 颗电芯（单颗 8 cm）。
    // 曾经写 9 m，结果是"Pack 级"和"Cell 级"的取景被同一个下限夹死，
    // 两颗电芯之间只剩 3 px，52 这个数字在画面上根本读不出来。
    this.controls.minDistance = 4.5;
    this.controls.maxDistance = 2400;
    this.controls.addEventListener("start", () => {
      this.transitioning = false;
    });
  }

  setAspect(aspect: number) {
    this.camera.aspect = aspect;
    // 窄屏时用一点 fov 补偿，保证全景机位仍然框得住整个园区。
    this.camera.fov = aspect < 1.3 ? 32 : 26;
    this.camera.updateProjectionMatrix();
  }

  /** 当前方向（由相机 → 目标）。 */
  private direction(azimuth: number, elevation: number) {
    return new THREE.Vector3(
      Math.cos(elevation) * Math.cos(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.sin(azimuth),
    );
  }

  /**
   * 精确取景：把包围盒的 8 个角全部投影到相机基上，求出恰好装得下所需的距离。
   * 用包围球估距会明显过远（俯视一个扁平场地时误差可达 2 倍）。
   */
  private fitDistance(box: THREE.Box3, dir: THREE.Vector3, padding: number) {
    const corners = boxCorners(box);
    const center = box.getCenter(new THREE.Vector3());
    const forward = dir.clone().negate().normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    const tanV = Math.tan((this.camera.fov * DEG) / 2);
    const tanH = tanV * this.camera.aspect;
    let dist = 0;
    const rel = new THREE.Vector3();
    for (const c of corners) {
      rel.copy(c).sub(center);
      const x = Math.abs(rel.dot(right));
      const y = Math.abs(rel.dot(up));
      const z = rel.dot(forward);
      dist = Math.max(dist, x / tanH + z, y / tanV + z);
    }
    return Math.max(this.controls.minDistance, dist * padding);
  }

  /** 立刻（不做转场）把镜头放到某个包围盒的取景位。 */
  snapToBox(box: THREE.Box3, azimuth: number, elevation: number, padding = 1.18) {
    const center = box.getCenter(new THREE.Vector3());
    const dir = this.direction(azimuth, elevation).normalize();
    const dist = this.fitDistance(box, dir, padding);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.target.copy(center);
    this.controls.update();
    this.desiredPos.copy(this.camera.position);
    this.desiredTarget.copy(center);
    this.currentRadius = dist;
    this.transitioning = false;
  }

  /** 平滑移动到某个包围盒的取景位。`keepAngle` = true 时保持当前俯仰/方位，只推距离。 */
  focusBox(
    box: THREE.Box3,
    opts: {
      padding?: number;
      stiffness?: number;
      keepAngle?: boolean;
      minRadius?: number;
      /** 指定方位角/俯仰角（弧度）。不传则沿用当前视角。 */
      azimuth?: number;
      elevation?: number;
    } = {},
  ) {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    // 小构件（一块组件 / 一个电池堆 / 一个 Pack）必须按最小可视半径撑大：
    // 否则 fitDistance 只给出几米，被 controls.minDistance 兜住后取景就完全失控。
    const half = Math.max(size.x, size.y, size.z) * 0.5;
    const minRadius = opts.minRadius ?? 3.2;
    const framed = half < minRadius ? box.clone().expandByScalar((minRadius - half) * 0.55) : box;
    void size;

    let az: number;
    let el: number;
    if (opts.azimuth !== undefined && opts.elevation !== undefined) {
      az = opts.azimuth;
      el = opts.elevation;
    } else if (opts.keepAngle === false) {
      az = 46 * DEG;
      el = 39 * DEG;
    } else {
      const offset = this.camera.position.clone().sub(this.controls.target);
      az = Math.atan2(offset.z, offset.x);
      el = Math.asin(THREE.MathUtils.clamp(offset.y / Math.max(1e-3, offset.length()), -1, 1));
    }
    const dir = this.direction(az, el).normalize();
    const dist = this.fitDistance(framed, dir, opts.padding ?? 1.24);

    this.desiredTarget.copy(center);
    this.desiredPos.copy(center).addScaledVector(dir, dist);
    this.stiffness = opts.stiffness ?? 3.4;
    this.transitioning = true;
    this.currentRadius = dist;
  }

  /** 直接给一个预设机位。`preset.distance` 就是相机到目标点的距离。 */
  goTo(preset: ViewPreset, stiffness = 3.0) {
    const dir = this.direction(preset.azimuth, preset.elevation).normalize();
    const center = new THREE.Vector3(...preset.target);
    const dist = THREE.MathUtils.clamp(preset.distance, this.controls.minDistance, this.controls.maxDistance);
    this.desiredTarget.copy(center);
    this.desiredPos.copy(center).addScaledVector(dir, dist);
    this.stiffness = stiffness;
    this.transitioning = true;
    this.currentRadius = dist;
  }

  /** 每帧推进。返回 true 表示相机本帧发生了移动（需求渲染需要重绘）。 */
  update(dt: number): boolean {
    const before = this.camera.position.clone();
    const targetBefore = this.controls.target.clone();

    if (this.transitioning) {
      // 指数衰减：与帧率无关，手感稳定。
      const k = 1 - Math.exp(-this.stiffness * Math.min(dt, 0.1));
      this.camera.position.lerp(this.desiredPos, k);
      this.controls.target.lerp(this.desiredTarget, k);
      if (
        this.camera.position.distanceToSquared(this.desiredPos) < 0.35 &&
        this.controls.target.distanceToSquared(this.desiredTarget) < 0.35
      ) {
        this.camera.position.copy(this.desiredPos);
        this.controls.target.copy(this.desiredTarget);
        this.transitioning = false;
      }
      this.controls.update();
      return true;
    }

    const moved = this.controls.update();
    return (
      moved ||
      before.distanceToSquared(this.camera.position) > 1e-6 ||
      targetBefore.distanceToSquared(this.controls.target) > 1e-6
    );
  }

  get isTransitioning() {
    return this.transitioning;
  }

  /** 当前"看得见多大范围"，用于按需降低远处细节。 */
  get visibleRadius() {
    return this.currentRadius;
  }

  dispose() {
    this.controls.dispose();
  }
}

function boxCorners(box: THREE.Box3): THREE.Vector3[] {
  const { min, max } = box;
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) {
    out.push(
      new THREE.Vector3(
        i & 1 ? max.x : min.x,
        i & 2 ? max.y : min.y,
        i & 4 ? max.z : min.z,
      ),
    );
  }
  return out;
}
