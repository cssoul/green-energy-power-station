import * as THREE from "three";
import { PLATFORM_Y, THEME } from "../config";
import type { MaterialSet } from "../core/materials";
import { makeRandom } from "../core/rng";
import { createGlowSprite } from "../core/textures";
import { makeGroup } from "./util";

/**
 * 能源流动视觉系统。
 *
 * 叙事链条：PV → DC → Combiner → Inverter → AC → PCS → Battery → Transformer → Grid。
 * 四段用四种颜色（对齐设计稿：黄 → 橙 → 蓝 → 红）：
 *
 *   dc       深蓝   光伏阵列 → 汇流箱 → 逆变舱        （直流侧，贴近地面）
 *   ac       橙黄   逆变舱 → 主变低压侧                （交流侧）
 *   storage  青绿   交流母线 ↔ 储能柜                  （双向）
 *   grid     玫红   主变 → 门型构架 → 铁塔 → 出线      （110 kV，架空）
 *
 * 三种表现手法叠加，缺一不可：
 *   1. **流光滑带** —— 管几何 + 条纹着色器，`uv.x` 就是路径参数，条纹沿路径跑。
 *      整类合并成 1 个 draw call。
 *   2. **方向箭头** —— InstancedMesh，CPU 每帧只更新实例矩阵，明确"往哪流"。
 *   3. **发光粒子** —— Points，加色混合，在暗色路面/草地上才有光点感。
 *
 * 速度与亮度由**实际功率**驱动：夜里 PV 段停流，储能段反向流动。
 */

export type FlowClass = "dc" | "ac" | "storage" | "grid";

export type FlowPath = {
  cls: FlowClass;
  points: THREE.Vector3[];
  /** 反向流动（储能放电时用） */
  reverse?: boolean;
  radius?: number;
};

const CLASS_COLOR: Record<FlowClass, number> = {
  dc: THEME.flow.dc,
  ac: THEME.flow.ac,
  storage: THEME.flow.storage,
  grid: THEME.flow.grid,
};

/**
 * 三类尺寸都按"近景也要站得住"定：
 * 下钻到储能柜（相机距 10 m 量级）时，0.6 m 的管子和 3 m 的锥体在画面里是
 * 一整块多边形，直接把设备盖住。真实输电/母线的视觉直径在 0.3–0.5 m 之间。
 */
const CLASS_RADIUS: Record<FlowClass, number> = {
  dc: 0.3,
  ac: 0.36,
  storage: 0.38,
  grid: 0.32,
};

const CLASS_LIFT: Record<FlowClass, number> = {
  dc: 1.1,
  ac: 1.6,
  storage: 2.0,
  grid: 0,
};

/* ------------------------------------------------------------------ *
 * 着色器
 * ------------------------------------------------------------------ */

const VERT = /* glsl */ `
  varying float vFlow;
  varying vec3 vNormalW;
  varying vec3 vViewW;
  varying float vFade;
  attribute float aFade;
  void main() {
    vFlow = uv.x;
    vFade = aFade;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewW = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uIntensity;
  uniform float uOpacity;
  varying float vFlow;
  varying vec3 vNormalW;
  varying vec3 vViewW;
  varying float vFade;
  void main() {
    // 三道错开的条纹，形成"能量在管里跑"的层次
    float s = fract(vFlow * 26.0 - uTime * uSpeed);
    float a = smoothstep(0.0, 0.16, s) * smoothstep(0.42, 0.16, s);
    float s2 = fract(vFlow * 26.0 - uTime * uSpeed + 0.5);
    float b = smoothstep(0.0, 0.12, s2) * smoothstep(0.3, 0.12, s2);
    float pulse = a + b * 0.55;

    // 边缘菲涅尔：贴着掠射角更亮，管子才有"发光管"的体积感
    float fres = pow(1.0 - abs(dot(normalize(vNormalW), normalize(vViewW))), 1.6);

    vec3 col = uColor * (0.62 + 0.5 * fres + pulse * 1.7 * uIntensity);
    float alpha = (0.42 + 0.5 * fres + pulse * 0.85 * uIntensity) * uOpacity * vFade;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`;

function makeRibbonMaterial(materials: MaterialSet, cls: FlowClass) {
  const uniforms = {
    uColor: { value: new THREE.Color(CLASS_COLOR[cls]) },
    uTime: { value: 0 },
    uSpeed: { value: 0.35 },
    uIntensity: { value: 1 },
    uOpacity: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  materials.register(mat);
  return { mat, uniforms };
}

/* ------------------------------------------------------------------ *
 * 主体
 * ------------------------------------------------------------------ */

export type EnergyFlowBuild = {
  group: THREE.Group;
  update(dt: number, levels: Record<FlowClass, number>): void;
  dispose(): void;
};

export function buildEnergyFlow(materials: MaterialSet, paths: FlowPath[]): EnergyFlowBuild {
  const group = makeGroup("energy-flow");
  const rng = makeRandom(20250928);
  const glowSprite = createGlowSprite();

  const byClass = new Map<FlowClass, FlowPath[]>();
  for (const p of paths) {
    if (!byClass.has(p.cls)) byClass.set(p.cls, []);
    byClass.get(p.cls)!.push(p);
  }

  const systems: {
    cls: FlowClass;
    uniforms: Record<string, { value: number | THREE.Color }>;
    arrows: THREE.InstancedMesh;
    samples: { pts: Float32Array; count: number; reverse: boolean }[];
    particles: THREE.Points;
    particleT: Float32Array;
    particlePath: Int32Array;
    particleSpeed: Float32Array;
    particlePos: THREE.BufferAttribute;
  }[] = [];

  for (const [cls, list] of byClass) {
    const { mat, uniforms } = makeRibbonMaterial(materials, cls);
    const radius = CLASS_RADIUS[cls];
    const lift = CLASS_LIFT[cls];

    // ---- 1. 流光滑带 ----
    const ribbons: THREE.BufferGeometry[] = [];
    const samples: { pts: Float32Array; count: number; reverse: boolean }[] = [];
    for (const path of list) {
      const pts = path.points.map((p) => new THREE.Vector3(p.x, p.y + lift, p.z));
      const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.35);
      const len = curve.getLength();
      const segments = Math.max(24, Math.round(len / 2.5));
      const geo = new THREE.TubeGeometry(curve, segments, path.radius ?? radius, 6, false);
      // aFade：路径两端渐隐，避免管线"凭空开始/结束"的硬边
      const uvAttr = geo.getAttribute("uv") as THREE.BufferAttribute;
      const posAttr = geo.getAttribute("position") as THREE.BufferAttribute;
      const fade = new Float32Array(posAttr.count);
      for (let i = 0; i < posAttr.count; i++) {
        const u = uvAttr.getX(i);
        fade[i] = Math.min(1, Math.min(u, 1 - u) * 9 + 0.12);
      }
      geo.setAttribute("aFade", new THREE.BufferAttribute(fade, 1));
      ribbons.push(geo);

      const dense = curve.getSpacedPoints(Math.max(24, Math.round(len / 2)));
      const flat = new Float32Array(dense.length * 3);
      dense.forEach((v, i) => {
        flat[i * 3] = v.x;
        flat[i * 3 + 1] = v.y;
        flat[i * 3 + 2] = v.z;
      });
      samples.push({ pts: flat, count: dense.length, reverse: path.reverse ?? false });
    }
    const mergedRibbon = mergeSimple(ribbons);
    const ribbonMesh = new THREE.Mesh(mergedRibbon, mat);
    ribbonMesh.renderOrder = 6;
    ribbonMesh.frustumCulled = false;
    group.add(ribbonMesh);

    // ---- 2. 方向箭头 ----
    const arrowGeo = new THREE.ConeGeometry(radius * 1.55, radius * 3.4, 6);
    arrowGeo.rotateX(-Math.PI / 2); // 默认朝 +Z，便于用 lookAt 对准切线
    const arrowsPerPath = 5;
    const arrowCount = list.length * arrowsPerPath;
    const arrowMat = new THREE.MeshBasicMaterial({
      color: CLASS_COLOR[cls],
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    materials.register(arrowMat);
    const arrows = new THREE.InstancedMesh(arrowGeo, arrowMat, arrowCount);
    arrows.frustumCulled = false;
    arrows.renderOrder = 7;
    arrows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(arrows);

    // ---- 3. 发光粒子 ----
    const particlePerPath = Math.max(4, Math.round(36 / Math.min(8, list.length)));
    const particleCount = list.length * particlePerPath;
    const particleGeo = new THREE.BufferGeometry();
    const pPos = new Float32Array(particleCount * 3);
    particleGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
    particleGeo.setAttribute("aFade", new THREE.BufferAttribute(new Float32Array(particleCount).fill(1), 1));
    const particleMat = new THREE.PointsMaterial({
      color: CLASS_COLOR[cls],
      map: glowSprite ?? undefined,
      size: radius * 3.4,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      // 软边圆点 + 加色：在草地/路面上是光点，而不是"白纸片"
      blending: THREE.AdditiveBlending,
    });
    if (glowSprite) particleMat.alphaTest = 0.02;
    materials.register(particleMat);
    const particles = new THREE.Points(particleGeo, particleMat);
    particles.frustumCulled = false;
    particles.renderOrder = 8;
    group.add(particles);

    const particleT = new Float32Array(particleCount);
    const particlePath = new Int32Array(particleCount);
    const particleSpeed = new Float32Array(particleCount);
    for (let i = 0; i < particleCount; i++) {
      particleT[i] = rng();
      particlePath[i] = Math.floor(i / particlePerPath) % list.length;
      particleSpeed[i] = 0.6 + rng() * 0.8;
    }

    systems.push({
      cls,
      uniforms: uniforms as unknown as Record<string, { value: number | THREE.Color }>,
      arrows,
      samples,
      particles,
      particleT,
      particlePath,
      particleSpeed,
      particlePos: particleGeo.getAttribute("position") as THREE.BufferAttribute,
    });
  }

  /* ---------------- 每帧推进 ---------------- */
  const dummy = new THREE.Object3D();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let time = 0;
  const levels: Record<FlowClass, number> = { dc: 1, ac: 1, storage: 1, grid: 1 };
  const current: Record<FlowClass, number> = { dc: 1, ac: 1, storage: 1, grid: 1 };

  function sample(sampleSet: { pts: Float32Array; count: number }, t: number, out: THREE.Vector3) {
    const f = Math.max(0, Math.min(0.9999, t)) * (sampleSet.count - 1);
    const i = Math.floor(f);
    const k = f - i;
    const i3 = i * 3;
    const j3 = Math.min(sampleSet.count - 1, i + 1) * 3;
    out.set(
      sampleSet.pts[i3] + (sampleSet.pts[j3] - sampleSet.pts[i3]) * k,
      sampleSet.pts[i3 + 1] + (sampleSet.pts[j3 + 1] - sampleSet.pts[i3 + 1]) * k,
      sampleSet.pts[i3 + 2] + (sampleSet.pts[j3 + 2] - sampleSet.pts[i3 + 2]) * k,
    );
  }

  function tangent(sampleSet: { pts: Float32Array; count: number }, t: number, out: THREE.Vector3) {
    sample(sampleSet, t + 0.004, out);
    sample(sampleSet, Math.max(0, t - 0.004), tmp);
    return out.sub(tmp).normalize();
  }

  return {
    group,
    update(dt: number, next: Record<FlowClass, number>) {
      time += dt;
      for (const key of Object.keys(next) as FlowClass[]) levels[key] = next[key];

      for (const sys of systems) {
        // 指数平滑，功率变化时速度不会突跳
        current[sys.cls] += (levels[sys.cls] - current[sys.cls]) * Math.min(1, dt * 1.6);
        const level = current[sys.cls];
        sys.uniforms.uTime.value = time;
        sys.uniforms.uSpeed.value = 0.16 + level * 0.5;
        sys.uniforms.uIntensity.value = 0.25 + level * 0.85;
        sys.uniforms.uOpacity.value = 0.18 + level * 0.82;

        // 箭头
        const pathCount = sys.samples.length;
        const perPath = sys.arrows.count / pathCount;
        for (let p = 0; p < pathCount; p++) {
          const s = sys.samples[p];
          for (let k = 0; k < perPath; k++) {
            const t = ((k / perPath + time * (0.05 + level * 0.11) * (s.reverse ? -1 : 1)) % 1 + 1) % 1;
            sample(s, t, a);
            tangent(s, s.reverse ? 1 - t : t, b);
            if (s.reverse) b.negate();
            dummy.position.copy(a);
            dummy.lookAt(a.x + b.x, a.y + b.y, a.z + b.z);
            dummy.scale.setScalar(0.5 + level * 0.34);
            dummy.updateMatrix();
            sys.arrows.setMatrixAt(p * perPath + k, dummy.matrix);
          }
        }
        sys.arrows.instanceMatrix.needsUpdate = true;
        sys.arrows.visible = level > 0.03;

        // 粒子
        for (let i = 0; i < sys.particleT.length; i++) {
          const s = sys.samples[sys.particlePath[i]];
          sys.particleT[i] += dt * (0.03 + level * 0.1) * sys.particleSpeed[i] * (s.reverse ? -1 : 1);
          if (sys.particleT[i] > 1) sys.particleT[i] -= 1;
          if (sys.particleT[i] < 0) sys.particleT[i] += 1;
          sample(s, sys.particleT[i], a);
          sys.particlePos.setXYZ(i, a.x, a.y + 0.12, a.z);
        }
        sys.particlePos.needsUpdate = true;
        sys.particles.visible = level > 0.03;
      }
    },
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
      glowSprite?.dispose();
      group.removeFromParent();
    },
  };
}

function mergeSimple(list: THREE.BufferGeometry[]) {
  if (list.length === 1) return list[0];
  let total = 0;
  for (const g of list) total += g.getAttribute("position").count;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const fade = new Float32Array(total);
  let offset = 0;
  for (const g of list) {
    const p = g.getAttribute("position") as THREE.BufferAttribute;
    const n = g.getAttribute("normal") as THREE.BufferAttribute;
    const t = g.getAttribute("uv") as THREE.BufferAttribute;
    const f = g.getAttribute("aFade") as THREE.BufferAttribute;
    position.set(p.array as Float32Array, offset * 3);
    normal.set(n.array as Float32Array, offset * 3);
    uv.set(t.array as Float32Array, offset * 2);
    fade.set(f.array as Float32Array, offset);
    offset += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(position, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.setAttribute("aFade", new THREE.BufferAttribute(fade, 1));
  return out;
}

/* ------------------------------------------------------------------ *
 * 路径规划
 * ------------------------------------------------------------------ */

export function planFlowPaths(input: {
  pvBlocks: { id: string; center: THREE.Vector3; combiner: THREE.Vector3 }[];
  inverters: { id: string; center: THREE.Vector3 }[];
  ess: { id: string; center: THREE.Vector3; ac: THREE.Vector3 }[];
  transformers: THREE.Vector3[];
  gantry: THREE.Vector3;
  /** 每基塔的挂线点：`[塔][横担层][左/右]`。 */
  towerArms: THREE.Vector3[][][];
  towerCenters: THREE.Vector3[];
}): FlowPath[] {
  const paths: FlowPath[] = [];
  // 母线标高不再自己按 `13.5 × 0.98 − 1.1` 反算 —— 那是构架的内部构造，
  // 直接取构架回传的母线中点高度，构架改尺寸时这里自动跟着走。
  const gantryBusY = input.gantry.y;

  // ---- 直流：阵列组汇流箱 → 逆变升压舱 ----
  const perInverter = Math.max(1, Math.round(input.pvBlocks.length / input.inverters.length));
  input.pvBlocks.forEach((block, i) => {
    const inv = input.inverters[Math.min(input.inverters.length - 1, Math.floor(i / perInverter))];
    const from = block.combiner;
    const midZ = inv.center.z;
    paths.push({
      cls: "dc",
      points: [
        new THREE.Vector3(from.x, PLATFORM_Y, from.z),
        new THREE.Vector3(from.x + 2.5, PLATFORM_Y, from.z + 5),
        new THREE.Vector3(from.x + 4, PLATFORM_Y, midZ),
        new THREE.Vector3(inv.center.x - 5.5, PLATFORM_Y, midZ),
      ],
    });
  });

  // ---- 交流：逆变升压舱 → 主变低压侧 ----
  const txZ = input.transformers.map((t) => t.z);
  input.inverters.forEach((inv, i) => {
    const target = input.transformers[i % input.transformers.length];
    paths.push({
      cls: "ac",
      points: [
        new THREE.Vector3(inv.center.x + 4.2, PLATFORM_Y, inv.center.z),
        new THREE.Vector3(inv.center.x + 12 + i * 1.4, PLATFORM_Y, inv.center.z),
        new THREE.Vector3(inv.center.x + 22 + i * 1.4, PLATFORM_Y, (inv.center.z + txZ[i % txZ.length]) / 2),
        new THREE.Vector3(target.x - 7, PLATFORM_Y, target.z),
      ],
    });
  });

  // ---- 储能：交流母线 ↔ 储能柜（双向） ----
  const essBusZ = 34;
  input.ess.forEach((cabinet, i) => {
    paths.push({
      cls: "storage",
      reverse: i % 2 === 1,
      points: [
        new THREE.Vector3(cabinet.center.x, PLATFORM_Y, essBusZ),
        new THREE.Vector3(cabinet.center.x, PLATFORM_Y, cabinet.center.z - 12),
        new THREE.Vector3(cabinet.center.x, PLATFORM_Y, cabinet.center.z - 2.5),
      ],
    });
  });
  // 储能母线汇入主变
  paths.push({
    cls: "storage",
    points: [
      new THREE.Vector3(-30, PLATFORM_Y, essBusZ),
      new THREE.Vector3(20, PLATFORM_Y, essBusZ),
      new THREE.Vector3(60, PLATFORM_Y, essBusZ + 4),
      new THREE.Vector3(120, PLATFORM_Y, 12),
      new THREE.Vector3(input.transformers[0].x - 6, PLATFORM_Y, input.transformers[0].z),
    ],
  });

  // ---- 高压：主变 → 门型构架 → 铁塔 → 出线 ----
  input.transformers.forEach((tx, i) => {
    paths.push({
      cls: "grid",
      radius: 0.34,
      points: [
        new THREE.Vector3(tx.x + 2, tx.y - 1.2, tx.z),
        new THREE.Vector3(tx.x + 14, PLATFORM_Y + 9, tx.z),
        new THREE.Vector3(input.gantry.x - 12, gantryBusY, input.gantry.z + i * 1.5),
      ],
    });
  });
  if (input.towerArms.length > 0) {
    const firstTower = input.towerArms[0];
    for (let level = 0; level < 3; level++) {
      paths.push({
        cls: "grid",
        radius: 0.3,
        points: [
          new THREE.Vector3(input.gantry.x + 8, gantryBusY, input.gantry.z),
          new THREE.Vector3((input.gantry.x + firstTower[level][0].x) / 2, gantryBusY + 4, (input.gantry.z + firstTower[level][0].z) / 2),
          firstTower[level][0],
        ],
      });
    }
  }
  for (let t = 0; t < input.towerArms.length - 1; t++) {
    const from = input.towerArms[t][1][0];
    const to = input.towerArms[t + 1][1][0];
    paths.push({ cls: "grid", radius: 0.3, points: [from, new THREE.Vector3((from.x + to.x) / 2, (from.y + to.y) / 2 - 4, (from.z + to.z) / 2), to] });
  }

  return paths;
}
