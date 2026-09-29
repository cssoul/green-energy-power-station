import * as THREE from "three";
import { PLATFORM_Y, THEME } from "../config";
import type { MaterialSet } from "./materials";

/**
 * 选中 / 悬停的视觉语言。
 *
 * 刻意**不用 OutlinePass**：一个全屏后处理 pass 换来的只是"描边"，
 * 而数字孪生真正需要的是三件事同时发生，这里用三个廉价几何一次给全：
 *   1. **选取框**（角括号 + 12 条棱）—— 告诉用户"选中了哪个体量"，且有三维感；
 *   2. **地面光框** —— 在轴测俯视里，脚下那一圈比包围盒更能定位；
 *   3. **材质热替换** —— 设备本身发光，见 MaterialSet.hot。
 *
 * 悬停只给第 1 项的暗色版本，选中才点亮第 2、3 项，两者可以同时存在而不打架。
 */

const CAGE_COLOR = THEME.select;
const HOVER_COLOR = THEME.hover;

export class SelectionOverlay {
  readonly group: THREE.Group;

  private hoverCage: THREE.LineSegments;
  private selectCage: THREE.LineSegments;
  private groundRing: THREE.LineLoop;
  private groundFill: THREE.Mesh;
  private cornerMat: THREE.LineBasicMaterial;
  private ringMat: THREE.LineBasicMaterial;
  private fillMat: THREE.MeshBasicMaterial;
  private selected: THREE.Box3 | null = null;
  private hovered: THREE.Box3 | null = null;

  constructor(materials: MaterialSet) {
    this.group = new THREE.Group();
    this.group.name = "selection-overlay";
    this.group.renderOrder = 20;

    this.cornerMat = new THREE.LineBasicMaterial({
      color: CAGE_COLOR,
      transparent: true,
      opacity: 0.95,
      depthTest: true,
    });
    this.ringMat = new THREE.LineBasicMaterial({
      color: CAGE_COLOR,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.fillMat = new THREE.MeshBasicMaterial({
      color: CAGE_COLOR,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    materials.register(this.cornerMat);
    materials.register(this.ringMat);
    materials.register(this.fillMat);

    const hoverMat = new THREE.LineBasicMaterial({
      color: HOVER_COLOR,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    materials.register(hoverMat);

    this.hoverCage = new THREE.LineSegments(new THREE.BufferGeometry(), hoverMat);
    this.hoverCage.visible = false;
    this.hoverCage.frustumCulled = false;

    this.selectCage = new THREE.LineSegments(new THREE.BufferGeometry(), this.cornerMat);
    this.selectCage.visible = false;
    this.selectCage.frustumCulled = false;

    this.groundRing = new THREE.LineLoop(new THREE.BufferGeometry(), this.ringMat);
    this.groundRing.visible = false;
    this.groundRing.frustumCulled = false;

    this.groundFill = new THREE.Mesh(new THREE.BufferGeometry(), this.fillMat);
    this.groundFill.visible = false;
    this.groundFill.frustumCulled = false;

    this.group.add(this.hoverCage, this.selectCage, this.groundFill, this.groundRing);
  }

  setHover(box: THREE.Box3 | null) {
    if (!box || box.isEmpty()) {
      this.hovered = null;
      this.hoverCage.visible = false;
      return;
    }
    this.hovered = box;
    this.hoverCage.geometry.dispose();
    this.hoverCage.geometry = cageGeometry(box, 0.5);
    this.hoverCage.visible = true;
  }

  setSelect(box: THREE.Box3 | null) {
    if (!box || box.isEmpty()) {
      this.selected = null;
      this.selectCage.visible = false;
      this.groundRing.visible = false;
      this.groundFill.visible = false;
      return;
    }
    this.selected = box;
    this.selectCage.geometry.dispose();
    this.selectCage.geometry = cageGeometry(box, 1);
    this.selectCage.visible = true;

    // 光框贴在被选对象脚下的地面上（轴测俯视里，脚下那一圈比包围盒更好认）
    const groundY = Math.max(PLATFORM_Y, box.min.y) + 0.42;
    const pad = Math.max(1.6, Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.06);
    const outer = ringOutline(box, pad);
    this.groundRing.geometry.dispose();
    this.groundRing.geometry = outlineGeometry(outer, groundY);
    this.groundRing.visible = true;

    this.groundFill.geometry.dispose();
    this.groundFill.geometry = outlineMathToShape(outer, groundY);
    this.groundFill.visible = true;
  }

  /** 呼吸、扫描线：让"被选中"这件事在静止画面里也活着。 */
  update(elapsed: number, pulse: number) {
    this.cornerMat.opacity = 0.6 + 0.4 * pulse;
    this.ringMat.opacity = 0.45 + 0.4 * pulse;
    this.fillMat.opacity = 0.05 + 0.06 * pulse;
    if (this.groundRing.visible && this.selected) {
      const s = 1 + 0.012 * Math.sin(elapsed * 1.6);
      this.groundRing.scale.set(s, 1, s);
      this.groundFill.scale.set(s, 1, s);
    }
    void this.hovered;
  }
}

/** 12 条棱 + 8 组角括号。`weight` 只影响角括号的长度。 */
function cageGeometry(box: THREE.Box3, weight: number): THREE.BufferGeometry {
  const { min, max } = box;
  const size = box.getSize(new THREE.Vector3());
  const arm = Math.min(Math.max(0.8, Math.min(size.x, size.y, size.z) * 0.24), 4.5) * weight;
  const pts: number[] = [];

  const line = (a: THREE.Vector3, b: THREE.Vector3) => {
    pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  };

  // 12 条棱（弱化，只留中段，让角括号成为视觉重点）
  const inset = 0.18;
  for (const y of [min.y, max.y]) {
    for (const z of [min.z, max.z]) {
      line(new THREE.Vector3(min.x + (max.x - min.x) * inset, y, z), new THREE.Vector3(max.x - (max.x - min.x) * inset, y, z));
    }
    for (const x of [min.x, max.x]) {
      line(new THREE.Vector3(x, y, min.z + (max.z - min.z) * inset), new THREE.Vector3(x, y, max.z - (max.z - min.z) * inset));
    }
  }
  for (const x of [min.x, max.x]) {
    for (const z of [min.z, max.z]) {
      line(new THREE.Vector3(x, min.y + (max.y - min.y) * inset, z), new THREE.Vector3(x, max.y - (max.y - min.y) * inset, z));
    }
  }

  // 角括号
  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      for (const z of [min.z, max.z]) {
        const sx = x === min.x ? 1 : -1;
        const sy = y === min.y ? 1 : -1;
        const sz = z === min.z ? 1 : -1;
        const c = new THREE.Vector3(x, y, z);
        line(c, new THREE.Vector3(x + sx * arm, y, z));
        line(c, new THREE.Vector3(x, y + sy * arm, z));
        line(c, new THREE.Vector3(x, y, z + sz * arm));
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

/** 地面光框的圆角矩形轮廓（给定圆角半径）。 */
function ringOutline(box: THREE.Box3, pad: number) {
  const x0 = box.min.x - pad;
  const x1 = box.max.x + pad;
  const z0 = box.min.z - pad;
  const z1 = box.max.z + pad;
  const r = Math.min(3.2, (x1 - x0) * 0.18, (z1 - z0) * 0.18);
  const pts: THREE.Vector2[] = [];
  const arc = (cx: number, cz: number, from: number, to: number) => {
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const a = from + (to - from) * (i / steps);
      pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cz + Math.sin(a) * r));
    }
  };
  arc(x1 - r, z1 - r, 0, Math.PI / 2);
  arc(x0 + r, z1 - r, Math.PI / 2, Math.PI);
  arc(x0 + r, z0 + r, Math.PI, Math.PI * 1.5);
  arc(x1 - r, z0 + r, Math.PI * 1.5, Math.PI * 2);
  return pts;
}

/** 把 2D 轮廓转成贴地的 LineLoop。 */
function outlineGeometry(pts: THREE.Vector2[], y: number) {
  const arr = new Float32Array((pts.length + 1) * 3);
  pts.forEach((p, i) => {
    arr[i * 3] = p.x;
    arr[i * 3 + 1] = y;
    arr[i * 3 + 2] = p.y;
  });
  arr[pts.length * 3] = pts[0].x;
  arr[pts.length * 3 + 1] = y;
  arr[pts.length * 3 + 2] = pts[0].y;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** 贴地的填充面（略微抬高，避免和地形 z-fighting）。 */
function outlineMathToShape(pts: THREE.Vector2[], y: number) {
  const positions: number[] = [];
  // 三角扇即可：轮廓是凸的（圆角矩形）
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    positions.push(0, y, 0, a.x, y, a.y, b.x, y, b.y);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

export const RING_Y = PLATFORM_Y + 0.42;
