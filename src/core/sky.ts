import * as THREE from "three";
import { makeRandom } from "./rng";

/**
 * 程序化 equirect 天空 → PMREM 环境贴图，以及与之配套的灯组。
 *
 * 为什么非要画天空：光伏组件的镀膜玻璃、储能柜的拉丝铝、铁塔的角钢全是靠
 * **环境贴图的反射** 才读得出材质。给一个纯色环境，钢和玻璃都会变成一片死灰的
 * 塑料。一条硬地平线 + 太阳斑 + 云带，是"一眼看出是玻璃"的全部原因。
 *
 * 与建筑模板的差别：本项目的机位是 **轴测俯视**（俯角约 39°、竖直 fov 26°），
 * 画面里几乎看不到天空 —— 天空在这里主要不是为了"被看见"，而是为了"被反射"。
 * 所以渐变 stop 重点放在地平线以下那一半：那里是草地，决定了金属件下半部的反光。
 */

export type TimeId = "day" | "dusk" | "night";

export type SkySpec = {
  stops: readonly (readonly [number, string])[];
  /** 地平线光晕池：[xPx, 半径Px, alpha]，绘制时会沿 Y 压扁（equirect 是 2:1）。 */
  glows: readonly (readonly [number, number, number])[];
  cloud: number;
  cloudTint: string;
};

export type LightRig = {
  hemi: { sky: string; ground: string; intensity: number };
  key: { color: string; intensity: number; position: [number, number, number] };
  fill: { color: string; intensity: number };
  rim: { color: string; intensity: number };
  bounce: { color: string; intensity: number };
};

export type DayPreset = {
  id: TimeId;
  label: string;
  sky: SkySpec;
  rig: LightRig;
  exposure: number;
  environmentIntensity: number;
  /** 0 = 所有设备指示灯熄灭（白天），1 = 全部点亮（夜晚）。 */
  interior: number;
  /** 阴影相机半幅（决定阴影精细度，不是美学参数）。 */
  shadowRadius: number;
};

export const PRESETS: readonly DayPreset[] = [
  {
    id: "day",
    label: "白天",
    sky: {
      stops: [
        [0.0, "#1c5aa8"],
        [0.18, "#377cc2"],
        [0.32, "#66a1d6"],
        [0.41, "#9ac3e6"],
        [0.455, "#c3dcef"],
        [0.483, "#e2edf3"],
        [0.498, "#eef4f5"],
        [0.508, "#d5dedd"],
        [0.524, "#b2bcb2"],
        [0.56, "#8b9a7c"],
        [0.66, "#6a7f58"],
        [0.8, "#556b46"],
        [1.0, "#42573a"],
      ],
      glows: [[250, 250, 0.2]],
      cloud: 0.85,
      cloudTint: "255,255,255",
    },
    rig: {
      hemi: { sky: "#cfe2f5", ground: "#6f7d52", intensity: 0.78 },
      key: { color: "#fff4e2", intensity: 2.35, position: [-260, 520, 300] },
      fill: { color: "#bcd6ee", intensity: 0.55 },
      rim: { color: "#eaf2ff", intensity: 0.32 },
      bounce: { color: "#cbd3b4", intensity: 0.2 },
    },
    exposure: 1.0,
    environmentIntensity: 0.95,
    interior: 0.0,
    shadowRadius: 380,
  },
  {
    id: "dusk",
    label: "黄昏",
    sky: {
      stops: [
        [0.0, "#0b1836"],
        [0.18, "#173063"],
        [0.31, "#2b4f86"],
        [0.4, "#3f6ba0"],
        [0.45, "#5d84ae"],
        [0.478, "#8f97a0"],
        [0.495, "#c29672"],
        [0.505, "#e0a468"],
        [0.516, "#a06f42"],
        [0.534, "#5c4630"],
        [0.57, "#3c3326"],
        [0.68, "#2c2a1f"],
        [0.82, "#232a1c"],
        [1.0, "#1a2016"],
      ],
      glows: [[250, 260, 0.42], [860, 180, 0.22]],
      cloud: 0.5,
      cloudTint: "222,152,116",
    },
    rig: {
      hemi: { sky: "#4a6a9c", ground: "#3a3a26", intensity: 0.42 },
      key: { color: "#ffbf80", intensity: 1.0, position: [-420, 180, 260] },
      fill: { color: "#6f88b4", intensity: 0.36 },
      rim: { color: "#ffb066", intensity: 0.55 },
      bounce: { color: "#c98c50", intensity: 0.24 },
    },
    exposure: 1.08,
    environmentIntensity: 0.8,
    interior: 0.85,
    shadowRadius: 380,
  },
  {
    id: "night",
    label: "夜晚",
    sky: {
      stops: [
        [0.0, "#050b1c"],
        [0.2, "#081530"],
        [0.33, "#0d1e42"],
        [0.42, "#12274d"],
        [0.462, "#1a3159"],
        [0.486, "#2b3c5c"],
        [0.498, "#4b4a4a"],
        [0.508, "#6b563c"],
        [0.522, "#3d3527"],
        [0.55, "#232c1c"],
        [0.62, "#18220f"],
        [0.78, "#111a0c"],
        [1.0, "#0a1108"],
      ],
      glows: [[250, 270, 0.36], [860, 190, 0.22]],
      cloud: 0.12,
      cloudTint: "150,170,196",
    },
    rig: {
      // 夜间重新配平为**冷调**，不是单纯调暗：光伏板与金属在冷环境下才不会读成塑料。
      hemi: { sky: "#25395f", ground: "#16200f", intensity: 0.3 },
      key: { color: "#8ea6c4", intensity: 0.34, position: [-420, 320, 260] },
      fill: { color: "#4a6890", intensity: 0.24 },
      rim: { color: "#ffc48c", intensity: 0.24 },
      bounce: { color: "#8fa86a", intensity: 0.16 },
    },
    exposure: 1.22,
    environmentIntensity: 0.5,
    interior: 1.15,
    shadowRadius: 380,
  },
];

export const DEFAULT_TIME: TimeId = "day";

export function presetOf(id: TimeId): DayPreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

/**
 * 把 SkySpec 画成 1024×512 的 equirect 画布，再 PMREM 成环境贴图。
 *
 * 注意两个容易翻车的地方（都来自实测）：
 *  1. 半径按"宽度比例"给会出事 —— equirect 是 2:1，画布上 1 px 宽度只代表
 *     0.35° 方位角，1 px 高度却是 0.35° 仰角；一个"看着只占宽度 22%"的圆，
 *     在高度上等于 45%（≈81° 仰角），整片天会被点亮。所以要显式压扁 Y。
 *  2. 返回的 `sky` 纹理不要 dispose —— 调用方要拿它当 `scene.background`。
 */
export function createSkyEnvironment(renderer: THREE.WebGLRenderer, spec: SkySpec, interior = 0) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext("2d")!;

  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  for (const [v, color] of spec.stops) gradient.addColorStop(v, color);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1024, 512);

  const rand = makeRandom(4242);

  // 地平线光晕池（沿 Y 压扁 0.22 倍 → 约 18° 的光穹）
  for (const [cx, spread, alpha] of spec.glows) {
    const pool = ctx.createRadialGradient(cx, 258, 0, cx, 258, spread);
    pool.addColorStop(0, `rgba(255,206,146,${alpha})`);
    pool.addColorStop(0.45, `rgba(246,168,102,${alpha * 0.45})`);
    pool.addColorStop(1, "rgba(240,150,80,0)");
    ctx.save();
    ctx.translate(0, 258);
    ctx.scale(1, 0.22);
    ctx.translate(0, -258);
    ctx.fillStyle = pool;
    ctx.fillRect(0, 258 - spread * 0.22 - 4, 1024, spread * 0.44 + 8);
    ctx.restore();
  }

  // 云带：给镜面玻璃一点随视角滑动的梯度，是"湿润感"最便宜的来源
  if (spec.cloud > 0.01) {
    for (let i = 0; i < 34; i++) {
      const x = rand() * 1024;
      const y = 40 + rand() * 190;
      const w = 70 + rand() * 270;
      const h = 6 + rand() * 22;
      const a = (0.12 + rand() * 0.24) * spec.cloud;
      const cloud = ctx.createRadialGradient(x, y, 0, x, y, w);
      cloud.addColorStop(0, `rgba(${spec.cloudTint},${a})`);
      cloud.addColorStop(1, `rgba(${spec.cloudTint},0)`);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, h / w);
      ctx.translate(-x, -y);
      ctx.fillStyle = cloud;
      ctx.beginPath();
      ctx.arc(x, y, w, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // 地平线以下：远处村庄/园区的零星灯点，随时辰一起亮灭
  const windowAlpha = 0.12 + 0.88 * Math.min(1, Math.max(0, interior));
  for (let i = 0; i < 200; i++) {
    const x = rand() * 1024;
    const y = 274 + rand() * 130;
    ctx.fillStyle =
      rand() > 0.3
        ? `rgba(255,208,152,${(0.18 + rand() * 0.5) * windowAlpha})`
        : `rgba(190,220,255,${(0.14 + rand() * 0.32) * windowAlpha})`;
    ctx.fillRect(x, y, 1 + rand() * 2.4, 1 + rand() * 2.2);
  }

  // 地平线以下再叠一层远景树线，让金属件下半部的反光不是一条纯色带
  const treeLine = ctx.createLinearGradient(0, 260, 0, 300);
  treeLine.addColorStop(0, "rgba(90,110,72,.55)");
  treeLine.addColorStop(1, "rgba(90,110,72,0)");
  ctx.fillStyle = treeLine;
  ctx.fillRect(0, 258, 1024, 44);
  for (let i = 0; i < 260; i++) {
    const x = rand() * 1024;
    const h = 4 + rand() * 12;
    ctx.fillStyle = `rgba(${58 + rand() * 30},${76 + rand() * 34},${46 + rand() * 22},${0.3 + rand() * 0.4})`;
    ctx.beginPath();
    ctx.arc(x, 259 - h * 0.25, 2 + rand() * 4, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromEquirectangular(texture);
  pmrem.dispose();
  return { environment, sky: texture };
}
