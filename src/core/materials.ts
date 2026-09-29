import * as THREE from "three";
import { createSurfaceTextures, type SurfaceTextures, type SurfaceTextureSet } from "./textures";

/**
 * 表面清单与色板。
 *
 * 两条纪律：
 *  1. **新增一种表面 = 新增一个 draw call。** 想控 draw call 就收窄这张表，别随手加。
 *  2. **高亮不靠 clone 材质。** 每个可选单元如果各克隆一套材质，20 个光伏阵列就是
 *     60 份材质。这里改成在每个表面上预建一份 `hot`（自发光）变体，选中时只是把
 *     Mesh 的 `material` 引用换过去 —— 材质总数仍是常数级，代价是零。
 */

export type SurfaceName =
  // 地形与铺装
  | "grass"
  | "lawn"
  | "track"
  | "asphalt"
  | "roadLine"
  | "gravelYard"
  | "concrete"
  // 金属与建筑
  | "metal"
  | "metalDark"
  | "panelWall"
  | "metalRoof"
  | "glass"
  | "glassClear"
  // 光伏
  | "pv"
  | "pvBack"
  // 储能 / 逆变舱
  | "container"
  | "containerDark"
  | "louver"
  // 电池层级
  | "battery"
  | "cluster"
  | "cellShell"
  // 高压电气
  | "porcelain"
  | "copper"
  // 自然
  | "water"
  | "bark"
  | "foliage"
  | "shrub"
  // 发光
  | "glowCool"
  | "glowWarm"
  | "glowRed"
  // 车辆涂装
  | "paintWhite"
  | "paintYellow"
  | "paintOrange"
  | "paintBlue"
  | "tire"
  // 附属
  | "fence"
  | "sign";

type Spec = {
  color: string;
  /** 与 textures.ts 的 PAINTERS 键对应；省略则用纯色（无贴图）。 */
  tex?: keyof SurfaceTextures;
  /** 世界 UV 下"一张 tile 覆盖多少米"。省略 = 保留几何自带 0..1 UV。 */
  tile?: number;
  roughness: number;
  metalness: number;
  env: number;
  bumpScale?: number;
  emissive?: { color: string; intensity: number };
  opacity?: number;
  /** 物理材质（清漆 / 玻璃）分支。 */
  physical?: { clearcoat?: number; clearcoatRoughness?: number };
  doubleSide?: boolean;
  /** 需要预建 hot 变体（可被选中的单元用到的表面）。 */
  hot?: boolean;
};

const SPECS: Record<SurfaceName, Spec> = {
  grass: { color: "#6d9440", tex: "grass", tile: 7, roughness: 1.0, metalness: 0, env: 0.3, bumpScale: 0.5 },
  lawn: { color: "#7ba64a", tex: "grass", tile: 4.5, roughness: 1.0, metalness: 0, env: 0.28, bumpScale: 0.28 },
  track: { color: "#a89a7c", tex: "track", tile: 3, roughness: 0.96, metalness: 0, env: 0.22, bumpScale: 0.05 },
  asphalt: { color: "#565a5e", tex: "asphalt", tile: 4, roughness: 0.92, metalness: 0, env: 0.3, bumpScale: 0.03 },
  roadLine: { color: "#f0f0e8", roughness: 0.72, metalness: 0, env: 0.35 },
  gravelYard: { color: "#b9b4a2", tex: "gravelYard", tile: 5, roughness: 0.95, metalness: 0, env: 0.24, bumpScale: 0.09 },
  concrete: { color: "#c6c3ba", tex: "concrete", tile: 1, roughness: 0.94, metalness: 0, env: 0.32, bumpScale: 0.012, hot: true },

  metal: { color: "#aab0b6", tex: "metal", tile: 0.6, roughness: 0.32, metalness: 0.92, env: 1.0, bumpScale: 0.006, hot: true },
  metalDark: { color: "#6e747a", tex: "metal", tile: 0.6, roughness: 0.5, metalness: 0.8, env: 0.8, bumpScale: 0.006, hot: true },
  panelWall: { color: "#e6e7e3", tex: "panelWall", tile: 1.6, roughness: 0.86, metalness: 0.02, env: 0.42, bumpScale: 0.006, hot: true },
  metalRoof: { color: "#c3c7c9", tex: "metalRoof", tile: 1.2, roughness: 0.58, metalness: 0.55, env: 0.7, bumpScale: 0.02, hot: true },
  glass: {
    color: "#9dbcd2", roughness: 0.055, metalness: 0.86, env: 1.5,
    physical: { clearcoat: 1, clearcoatRoughness: 0.04 }, hot: true,
  },
  glassClear: {
    color: "#c4d6e0", roughness: 0.05, metalness: 0.06, env: 1.4, opacity: 0.36,
    physical: { clearcoat: 1, clearcoatRoughness: 0.03 },
  },

  // 光伏组件受光面：镀膜钢化玻璃。
  // `env` 不能给高 —— 组件法线朝南、倾角 22°，相机一俯视就正好看到它镜面反射
  // 地平线附近那片最亮的天空，整片光伏场会白成一张纸。压住 env 让纹理里的
  // 深蓝主导，只留一点点清漆的高光。
  pv: { color: "#16305c", tex: "pv", roughness: 0.16, metalness: 0.2, env: 0.4, physical: { clearcoat: 0.7, clearcoatRoughness: 0.12 }, hot: true },
  pvBack: { color: "#cfd3d6", tex: "pvBack", roughness: 0.72, metalness: 0.05, env: 0.3, hot: true },

  container: { color: "#e4e6e3", tex: "container", roughness: 0.6, metalness: 0.08, env: 0.55, bumpScale: 0.02, hot: true },
  containerDark: { color: "#c3c9c7", tex: "containerDark", roughness: 0.5, metalness: 0.35, env: 0.7, bumpScale: 0.02, hot: true },
  louver: { color: "#b9bdba", tex: "louver", roughness: 0.7, metalness: 0.3, env: 0.6, bumpScale: 0.03, hot: true },

  // 电池层级：保留几何自带 0..1 UV（一个面正好贴一次栅格）。
  //
  // 这三张的基色一律接近中性 —— 贴图本身已经是"深色底 + 亮构件"的完整画面，
  // 再乘一遍深色基色会把整块压成纯黑：电池簇的把手、绿色状态灯带、Pack 的
  // 13 × 4 芯栅格全部消失。基色的职责只是给贴图定一个色温，不是定明度。
  battery: { color: "#dbe4ef", tex: "battery", roughness: 0.52, metalness: 0.4, env: 0.75, bumpScale: 0.02, hot: true },
  cluster: { color: "#b6c1cd", tex: "cluster", roughness: 0.48, metalness: 0.45, env: 0.8, bumpScale: 0.02, hot: true },
  cellShell: { color: "#c8d0d8", tex: "cell", roughness: 0.34, metalness: 0.55, env: 0.9, bumpScale: 0.008, hot: true },

  porcelain: { color: "#dcdad2", roughness: 0.35, metalness: 0.02, env: 0.6 },
  copper: { color: "#b07340", roughness: 0.42, metalness: 0.9, env: 0.9 },

  water: {
    color: "#2c5f66", roughness: 0.07, metalness: 0.14, env: 0.78,
    physical: { clearcoat: 1, clearcoatRoughness: 0.06 },
  },
  bark: { color: "#8d7f6b", roughness: 0.94, metalness: 0, env: 0.24 },
  foliage: { color: "#55803c", roughness: 0.9, metalness: 0, env: 0.3, hot: true },
  shrub: { color: "#4a6f3c", roughness: 0.92, metalness: 0, env: 0.28 },

  glowCool: { color: "#0b2630", roughness: 0.4, metalness: 0, env: 0.4, emissive: { color: "#57e6ff", intensity: 1.1 } },
  glowWarm: { color: "#2e2410", roughness: 0.4, metalness: 0, env: 0.4, emissive: { color: "#ffc46b", intensity: 1.0 } },
  glowRed: { color: "#301012", roughness: 0.4, metalness: 0, env: 0.4, emissive: { color: "#ff5c48", intensity: 1.0 } },

  paintWhite: { color: "#eef1f1", roughness: 0.36, metalness: 0.25, env: 0.9, physical: { clearcoat: 1, clearcoatRoughness: 0.1 }, hot: true },
  paintYellow: { color: "#e5b323", roughness: 0.38, metalness: 0.2, env: 0.85, physical: { clearcoat: 1, clearcoatRoughness: 0.12 }, hot: true },
  paintOrange: { color: "#dd7a1f", roughness: 0.4, metalness: 0.2, env: 0.85, physical: { clearcoat: 1, clearcoatRoughness: 0.12 } },
  paintBlue: { color: "#2f5f96", roughness: 0.36, metalness: 0.28, env: 0.9, physical: { clearcoat: 1, clearcoatRoughness: 0.1 } },
  tire: { color: "#232629", roughness: 0.9, metalness: 0, env: 0.2 },

  fence: { color: "#d3d7d5", roughness: 0.5, metalness: 0.7, env: 0.8, doubleSide: true },
  sign: { color: "#eaeaea", roughness: 0.6, metalness: 0.1, env: 0.4 },
};

/** 不投影的表面。（薄件与自发光件投影只会产生噪点。） */
export const NO_CAST: SurfaceName[] = [
  "glass", "glassClear", "water", "glowCool", "glowWarm", "glowRed", "roadLine", "fence",
];
/** 不接收阴影的表面。 */
export const NO_RECEIVE: SurfaceName[] = ["glass", "glassClear", "water", "glowCool", "glowWarm", "glowRed", "roadLine"];

export type MaterialSet = {
  base: Record<SurfaceName, THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial>;
  hot: Partial<Record<SurfaceName, THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial>>;
  get(name: SurfaceName): THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
  hotOf(name: SurfaceName): THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial | undefined;
  /** 半透明的"被冷落"变体：选中某个电池堆时，其余堆降透明度。 */
  dimOf(name: SurfaceName): THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
  /** 极淡的"外壳"变体：储能柜下钻时外壳淡出，露出内部结构。 */
  ghostOf(name: SurfaceName): THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
  /** 按需注册的材质（inner 层级展开时临时生成），dispose 时统一回收。 */
  register<T extends THREE.Material>(material: T): T;
  /** 昼夜切换时的设备指示灯系数。 */
  setInterior(f: number): void;
  /** 选中呼吸的驱动量（0..1），写进所有 hot 材质。 */
  setHotPulse(v: number): void;
  /** 水面波纹缓慢漂移。 */
  tick(elapsed: number): void;
  dispose(): void;
};

const HOT_BASE = 0x1fb6d6;

export function createMaterials(renderer: THREE.WebGLRenderer): MaterialSet {
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const textures = createSurfaceTextures(maxAniso);
  const created: THREE.Material[] = [];
  const disposables: { dispose(): void }[] = [];

  const base = {} as Record<SurfaceName, THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial>;
  const hot: Partial<Record<SurfaceName, THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial>> = {};
  const emissiveSurfaces: SurfaceName[] = [];

  const applySprite = (mat: THREE.MeshStandardMaterial, set: SurfaceTextureSet) => {
    if (set.map) mat.map = set.map;
    if (set.bumpMap) mat.bumpMap = set.bumpMap;
    if (set.roughnessMap) mat.roughnessMap = set.roughnessMap;
  };

  for (const name of Object.keys(SPECS) as SurfaceName[]) {
    const spec = SPECS[name];
    const set = spec.tex ? textures[spec.tex] : undefined;
    const params: THREE.MeshStandardMaterialParameters = {
      color: new THREE.Color(spec.color),
      roughness: spec.roughness,
      metalness: spec.metalness,
      envMapIntensity: spec.env,
      vertexColors: true,
    };
    if (spec.bumpScale !== undefined) params.bumpScale = spec.bumpScale;
    if (spec.opacity !== undefined) {
      params.transparent = true;
      params.opacity = spec.opacity;
    }
    if (spec.doubleSide) params.side = THREE.DoubleSide;
    if (spec.emissive) {
      params.emissive = new THREE.Color(spec.emissive.color);
      params.emissiveIntensity = spec.emissive.intensity;
      emissiveSurfaces.push(name);
    }

    let mat: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
    if (spec.physical) {
      mat = new THREE.MeshPhysicalMaterial({
        ...params,
        clearcoat: spec.physical.clearcoat ?? 0,
        clearcoatRoughness: spec.physical.clearcoatRoughness ?? 0.1,
      });
    } else {
      mat = new THREE.MeshStandardMaterial(params);
    }
    if (set) applySprite(mat, set);
    mat.name = name;
    base[name] = mat;
    created.push(mat);

    if (spec.hot) {
      const hotParams = { ...params } as THREE.MeshStandardMaterialParameters;
      hotParams.emissive = new THREE.Color(HOT_BASE);
      hotParams.emissiveIntensity = 0;
      // hot 变体不参与"未建成不投影"之类的花样，只为高亮服务。
      const hotMat = spec.physical
        ? new THREE.MeshPhysicalMaterial({
            ...hotParams,
            clearcoat: spec.physical.clearcoat ?? 0,
            clearcoatRoughness: spec.physical.clearcoatRoughness ?? 0.1,
          })
        : new THREE.MeshStandardMaterial(hotParams);
      if (set) applySprite(hotMat, set);
      hotMat.name = `${name}-hot`;
      hot[name] = hotMat;
      created.push(hotMat);
    }
  }

  // 水面法线扰动的缓慢漂移，让池面有微弱的活气。
  const waterSpec = textures.water;
  const bumpRefs: THREE.Texture[] = [];
  if (waterSpec?.bumpMap) bumpRefs.push(waterSpec.bumpMap);

  for (const key of Object.keys(textures) as (keyof SurfaceTextures)[]) {
    const set = textures[key];
    for (const t of [set.map, set.bumpMap, set.roughnessMap]) if (t) disposables.push(t);
  }

  let interior = 1;
  const emissiveBase = new Map<SurfaceName, number>();
  for (const name of emissiveSurfaces) emissiveBase.set(name, SPECS[name].emissive!.intensity);

  let hotPulse = 0;

  const dimCache = new Map<SurfaceName, THREE.Material>();
  const ghostCache = new Map<SurfaceName, THREE.Material>();

  const variant = (
    cache: Map<SurfaceName, THREE.Material>,
    name: SurfaceName,
    mutate: (m: THREE.Material) => void,
  ) => {
    const existing = cache.get(name);
    if (existing) return existing as THREE.MeshStandardMaterial;
    const src = base[name];
    const copy = src.clone() as THREE.MeshStandardMaterial;
    copy.vertexColors = true;
    copy.name = `${name}-variant`;
    mutate(copy);
    created.push(copy);
    cache.set(name, copy);
    return copy;
  };

  return {
    base,
    hot,
    get(name) {
      return base[name];
    },
    hotOf(name) {
      return hot[name];
    },
    /** 半透明"冷落"变体。保持一点点轮廓，但明显退到背景里。 */
    dimOf(name) {
      return variant(dimCache, name, (m) => {
        const s = m as THREE.MeshStandardMaterial;
        s.transparent = true;
        s.opacity = 0.14;
        s.depthWrite = false;
        s.emissiveIntensity = 0;
      });
    },
    /** 外壳淡出变体。玻璃类的柜体淡出后仍要能看出体积，所以保留 0.18 的底色。 */
    ghostOf(name) {
      return variant(ghostCache, name, (m) => {
        const s = m as THREE.MeshStandardMaterial;
        s.transparent = true;
        s.opacity = 0.15;
        s.depthWrite = false;
        s.side = THREE.DoubleSide;
        s.emissiveIntensity = 0;
      });
    },
    register(material) {
      created.push(material);
      return material;
    },
    setInterior(f) {
      interior = f;
      for (const [name, intensity] of emissiveBase) {
        const m = base[name];
        if (m) (m as THREE.MeshStandardMaterial).emissiveIntensity = intensity * (0.18 + 0.82 * f);
      }
    },
    setHotPulse(v) {
      hotPulse = v;
      const glow = 0.22 + 0.3 * v;
      for (const key of Object.keys(hot) as SurfaceName[]) {
        const m = hot[key]!;
        (m as THREE.MeshStandardMaterial).emissiveIntensity = glow;
      }
    },
    tick(elapsed) {
      for (const t of bumpRefs) t.offset.set(elapsed * 0.006, elapsed * 0.0042);
      void interior;
      void hotPulse;
    },
    dispose() {
      created.forEach((m) => m.dispose());
      disposables.forEach((d) => d.dispose());
    },
  };
}

/** 世界 UV 的 tile 尺寸，供 batcher 查询（1 tile = N 米）。 */
export const SURFACE_TILE: Partial<Record<SurfaceName, number>> = Object.fromEntries(
  (Object.keys(SPECS) as SurfaceName[])
    .filter((n) => SPECS[n].tile !== undefined)
    .map((n) => [n, SPECS[n].tile!]),
);
