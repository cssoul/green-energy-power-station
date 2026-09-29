import * as THREE from "three";
import { makeRandom } from "./rng";

/**
 * 全过程序化的纹理工厂：一块画布一块表面，没有任何图片文件、没有网络请求。
 *
 * **尺度契约**：绝大多数表面走"世界单位 UV"（在 `batcher.ts` 里按世界坐标重投影），
 * 所以一张 tile 覆盖多少米由 `SURFACE_TILE` 决定（见 materials.ts）。画布上 1024 px
 * 对应一个 tile，因此"每 256 px 一道缝"就等于"每 tile/4 米一道缝"。这条契约不成立时，
 * 大构件和小构件上的缝距会不一样（大字报配蚊蝇腿）。
 *
 * 例外：光伏组件（`pv`）与储能柜外壳（`container`）需要逐块对齐的电池片分格 /
 * 波纹板，所以它们保留几何自带的 0..1 UV，不进世界 UV 重投影。
 */

const isBrowser = typeof document !== "undefined";

function canvas(size: number) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return c;
}

/** 通用灰噪声，用作 bumpMap。`contrast` 越大越"粗糙"。 */
function noiseCanvas(size: number, contrast: number, seed: number) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const rand = makeRandom(seed);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = 128 + (rand() - 0.5) * contrast;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** 粗糙度贴图：底色 + 若干方形斑块。 */
function roughnessCanvas(size: number, base: string, seed: number, blotches = 80) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const rand = makeRandom(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < blotches; i++) {
    ctx.fillStyle = `rgba(58,58,58,${0.02 + rand() * 0.05})`;
    ctx.fillRect(rand() * size, rand() * size, size * (0.03 + rand() * 0.14), size * (0.03 + rand() * 0.14));
  }
  return c;
}

/** 矿物风化：颜料是成片老化的，不是逐像素的。加在几乎所有涂料表面之上。 */
function mineralClouding(ctx: CanvasRenderingContext2D, size: number, seed: number, count = 160) {
  const rand = makeRandom(seed);
  for (let i = 0; i < count; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = size * (0.02 + rand() * 0.13);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, i % 3 ? "rgba(44,42,36,.045)" : "rgba(252,250,240,.055)");
    g.addColorStop(1, "rgba(120,116,104,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

/** 细颗粒。石头/沥青这类"沙感"表面靠它。 */
function grain(ctx: CanvasRenderingContext2D, size: number, count: number, seed: number, strength = 1) {
  const rand = makeRandom(seed);
  for (let i = 0; i < count; i++) {
    ctx.fillStyle =
      rand() > 0.45
        ? `rgba(255,252,244,${(0.03 + rand() * 0.12) * strength})`
        : `rgba(34,32,28,${(0.025 + rand() * 0.09) * strength})`;
    const s = 0.5 + rand() * 1.6;
    ctx.fillRect(rand() * size, rand() * size, s, s);
  }
}

/* ================================================================== *
 * 各表面画法
 * ================================================================== */

/** 草原：黄绿斑驳 + 细草叶。tile 覆盖 6 m（见 SURFACE_TILE），所以叶长按画布比例来。 */
function paintGrass(size: number) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const rand = makeRandom(20117);
  ctx.fillStyle = "#6d9440";
  ctx.fillRect(0, 0, size, size);

  // 大块色斑：受光坡面偏黄，背阴处偏青
  for (let i = 0; i < 90; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = size * (0.05 + rand() * 0.16);
    const warm = rand() > 0.5;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, warm ? "rgba(178,196,96,.30)" : "rgba(58,96,44,.26)");
    g.addColorStop(1, "rgba(120,150,80,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // 草叶：短线，方向带 ±25° 抖动
  for (let i = 0; i < 9000; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const len = size * (0.006 + rand() * 0.018);
    const a = -Math.PI / 2 + (rand() - 0.5) * 0.9;
    const shade = rand();
    ctx.strokeStyle =
      shade > 0.72
        ? `rgba(206,224,140,${0.16 + rand() * 0.24})`
        : shade > 0.32
          ? `rgba(112,150,66,${0.16 + rand() * 0.22})`
          : `rgba(42,74,34,${0.14 + rand() * 0.2})`;
    ctx.lineWidth = 0.5 + rand() * 0.9;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }

  // 零星野花点
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = rand() > 0.5 ? "rgba(244,246,214,.5)" : "rgba(240,214,132,.42)";
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, size * (0.0015 + rand() * 0.003), 0, Math.PI * 2);
    ctx.fill();
  }
  mineralClouding(ctx, size, 771, 90);
  return c;
}

/** 沥青：深灰 + 骨料颗粒 + 少量补丁。 */
function paintAsphalt(size: number) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const rand = makeRandom(3301);
  ctx.fillStyle = "#565a5e";
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 40; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = size * (0.06 + rand() * 0.2);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rand() > 0.5 ? "rgba(96,100,104,.28)" : "rgba(38,40,44,.30)");
    g.addColorStop(1, "rgba(80,84,88,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // 骨料：亮暗小颗粒
  for (let i = 0; i < 24000; i++) {
    const v = rand();
    ctx.fillStyle =
      v > 0.62
        ? `rgba(186,190,194,${0.10 + rand() * 0.3})`
        : `rgba(26,28,32,${0.12 + rand() * 0.32})`;
    const s = 0.6 + rand() * 1.8;
    ctx.fillRect(rand() * size, rand() * size, s, s);
  }
  return c;
}

/** 碎石场地（变电站/储能区的碎石面）：浅米灰 + 圆石。 */
function paintGravelYard(size: number) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const rand = makeRandom(9119);
  ctx.fillStyle = "#b9b4a2";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 2600; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = size * (0.003 + rand() * 0.011);
    const v = 0.62 + rand() * 0.5;
    ctx.fillStyle = `rgba(${(196 * v) | 0},${(190 * v) | 0},${(176 * v) | 0},${0.5 + rand() * 0.45})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(84,80,70,${0.06 + rand() * 0.1})`;
    ctx.beginPath();
    ctx.arc(x + r * 0.35, y + r * 0.35, r * 0.8, 0, Math.PI * 2);
    ctx.fill();
  }
  mineralClouding(ctx, size, 313, 120);
  grain(ctx, size, 9000, 55);
  return c;
}

/** 清水混凝土：板缝 + 拉杆孔 + 竖向雨痕。 */
function paintConcrete(size: number) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const rand = makeRandom(8321);
  ctx.fillStyle = "#c6c3ba";
  ctx.fillRect(0, 0, size, size);

  const board = size / 4;
  for (let y = 0; y < size; y += board) {
    ctx.fillStyle = "rgba(58,55,50,.20)";
    ctx.fillRect(0, y, size, 2);
    ctx.fillStyle = "rgba(255,252,244,.12)";
    ctx.fillRect(0, y + 2, size, 1.5);
  }
  for (let y = board / 2; y < size; y += board) {
    for (let x = board / 2; x < size; x += board) {
      const r = size * 0.006;
      ctx.fillStyle = "rgba(48,45,40,.42)";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,250,240,.20)";
      ctx.beginPath();
      ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (let i = 0; i < 34; i++) {
    const x = rand() * size;
    const w = size * (0.004 + rand() * 0.02);
    const h = size * (0.1 + rand() * 0.5);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "rgba(74,78,70,.13)");
    g.addColorStop(1, "rgba(74,78,70,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x, rand() * size * 0.4, w, h);
  }
  mineralClouding(ctx, size, 221, 140);
  grain(ctx, size, 22000, 991);
  return c;
}

/** 拉丝金属（铝型材 / 铁塔角钢 / 构架）。 */
function paintBrushed(size: number) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const rand = makeRandom(5507);
  ctx.fillStyle = "#aab0b6";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 2200; i++) {
    const x = rand() * size;
    ctx.strokeStyle =
      rand() > 0.5 ? `rgba(255,255,255,${0.02 + rand() * 0.1})` : `rgba(40,44,48,${0.02 + rand() * 0.09})`;
    ctx.lineWidth = 0.5 + rand() * 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + (rand() - 0.5) * 7, size);
    ctx.stroke();
  }
  mineralClouding(ctx, size, 77, 60);
  return c;
}

/** 建筑外墙板：浅灰竖向分缝 + 淡雨痕。 */
function paintPanelWall(size: number) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const rand = makeRandom(6607);
  ctx.fillStyle = "#e6e7e3";
  ctx.fillRect(0, 0, size, size);
  for (let x = 0; x < size; x += size / 4) {
    ctx.fillStyle = "rgba(150,152,148,.34)";
    ctx.fillRect(x, 0, 2.4, size);
    ctx.fillStyle = "rgba(255,255,255,.62)";
    ctx.fillRect(x + 2.4, 0, 1.4, size);
  }
  ctx.fillStyle = "rgba(150,152,148,.16)";
  ctx.fillRect(0, size * 0.5, size, 2);
  for (let i = 0; i < 26; i++) {
    const x = rand() * size;
    const h = size * (0.2 + rand() * 0.6);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "rgba(122,126,120,.10)");
    g.addColorStop(1, "rgba(122,126,120,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, size * (0.004 + rand() * 0.012), h);
  }
  grain(ctx, size, 12000, 411);
  return c;
}

/** 屋面：浅灰压型钢板，横向肋。 */
function paintMetalRoof(size: number) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const rand = makeRandom(4009);
  ctx.fillStyle = "#c3c7c9";
  ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < size; y += size / 16) {
    ctx.fillStyle = "rgba(255,255,255,.30)";
    ctx.fillRect(0, y, size, 2);
    ctx.fillStyle = "rgba(96,102,106,.22)";
    ctx.fillRect(0, y + 2, size, 3);
  }
  for (let i = 0; i < 120; i++) {
    ctx.fillStyle = `rgba(140,146,150,${0.03 + rand() * 0.06})`;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, size * (0.01 + rand() * 0.05), 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

/**
 * 光伏组件受光面：6 列 × 12 行电池片 + 细栅线 + 银色汇流带 + 阳极氧化铝边框。
 * 保留几何自带的 0..1 UV —— 一块 2.3 m 组件正好一次贴图，分格才对得上。
 */
function paintPvModule(size: number) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const rand = makeRandom(2101);

  // 边框（阳极氧化铝）
  ctx.fillStyle = "#b9c0c6";
  ctx.fillRect(0, 0, size, size);
  const frame = size * 0.026;
  // 电池阵列区（含背板）
  ctx.fillStyle = "#0d1c38";
  ctx.fillRect(frame, frame, size - frame * 2, size - frame * 2);

  const cols = 6;
  const rows = 12;
  const inner = size - frame * 2;
  const cw = inner / cols;
  const ch = inner / rows;
  const gapX = inner * 0.012;
  const gapY = inner * 0.010;

  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const x = frame + k * cw + gapX / 2;
      const y = frame + r * ch + gapY / 2;
      const w = cw - gapX;
      const h = ch - gapY;
      // 电池片本体：深蓝黑，四角略亮（单晶片的倒角高光）
      ctx.fillStyle = "#16305c";
      ctx.fillRect(x, y, w, h);
      const g = ctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, "rgba(58,102,178,.55)");
      g.addColorStop(0.45, "rgba(20,42,84,.10)");
      g.addColorStop(1, "rgba(12,26,54,.35)");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);

      // 细栅线：每片 4 条竖银线
      ctx.strokeStyle = "rgba(198,208,220,.42)";
      ctx.lineWidth = Math.max(0.6, size * 0.0011);
      for (let f = 1; f <= 4; f++) {
        const fx = x + (w * f) / 5;
        ctx.beginPath();
        ctx.moveTo(fx, y + h * 0.04);
        ctx.lineTo(fx, y + h * 0.96);
        ctx.stroke();
      }
      // 汇流带：2 条横银带
      ctx.strokeStyle = "rgba(214,222,232,.60)";
      ctx.lineWidth = Math.max(1, size * 0.0022);
      for (const by of [0.31, 0.69]) {
        ctx.beginPath();
        ctx.moveTo(x + w * 0.03, y + h * by);
        ctx.lineTo(x + w * 0.97, y + h * by);
        ctx.stroke();
      }
      // 单晶硅的细微色差，避免整片死板
      ctx.fillStyle = `rgba(${rand() > 0.5 ? "90,130,200" : "20,40,80"},${0.03 + rand() * 0.05})`;
      ctx.fillRect(x, y, w, h);
    }
  }

  // 边框内阴影
  ctx.strokeStyle = "rgba(30,36,44,.55)";
  ctx.lineWidth = size * 0.006;
  ctx.strokeRect(frame, frame, inner, inner);
  return c;
}

/** 光伏组件背面（含支架一侧）：浅灰背板 + 接线盒。 */
function paintPvBack(size: number) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const rand = makeRandom(2207);
  ctx.fillStyle = "#cfd3d6";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "rgba(160,166,170,.5)";
  ctx.fillRect(0, size * 0.44, size, size * 0.12);
  // 接线盒
  ctx.fillStyle = "#2b2f34";
  ctx.fillRect(size * 0.38, size * 0.30, size * 0.24, size * 0.16);
  ctx.fillStyle = "rgba(255,255,255,.12)";
  ctx.fillRect(size * 0.38, size * 0.30, size * 0.24, size * 0.03);
  for (let i = 0; i < 700; i++) {
    ctx.fillStyle = `rgba(120,126,130,${0.03 + rand() * 0.06})`;
    ctx.fillRect(rand() * size, rand() * size, 2, 2);
  }
  return c;
}

/** 储能/逆变舱的外壳波纹板（竖直波纹）。保留 0..1 UV。 */
function paintCorrugated(size: number, base = "#e2e4e1") {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const rand = makeRandom(7703);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const pitch = size / 26;
  for (let x = 0; x < size; x += pitch) {
    const g = ctx.createLinearGradient(x, 0, x + pitch, 0);
    g.addColorStop(0, "rgba(120,126,124,.30)");
    g.addColorStop(0.35, "rgba(255,255,255,.42)");
    g.addColorStop(0.62, "rgba(255,255,255,.10)");
    g.addColorStop(1, "rgba(120,126,124,.30)");
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, pitch, size);
  }
  for (let i = 0; i < 20; i++) {
    const x = rand() * size;
    const h = size * (0.2 + rand() * 0.6);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "rgba(110,116,112,.10)");
    g.addColorStop(1, "rgba(110,116,112,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, size * 0.006, h);
  }
  grain(ctx, size, 9000, 611);
  return c;
}

/** 百叶格栅门（储能柜/逆变舱的检修面）。 */
function paintLouver(size: number) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#b9bdba";
  ctx.fillRect(0, 0, size, size);
  const slats = 18;
  const h = size / slats;
  for (let i = 0; i < slats; i++) {
    const y = i * h;
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, "rgba(255,255,255,.55)");
    g.addColorStop(0.42, "rgba(214,218,214,.9)");
    g.addColorStop(0.68, "rgba(92,98,96,.85)");
    g.addColorStop(1, "rgba(46,50,50,.9)");
    ctx.fillStyle = g;
    ctx.fillRect(0, y, size, h);
  }
  // 门缝
  ctx.fillStyle = "rgba(70,76,74,.7)";
  ctx.fillRect(size * 0.5 - 2, 0, 4, size);
  return c;
}

/** 草地上的检修通道 / 泥结石路：土黄 + 车辙。 */
function paintTrack(size: number) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const rand = makeRandom(1213);
  ctx.fillStyle = "#a89a7c";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 1600; i++) {
    const v = 0.7 + rand() * 0.5;
    ctx.fillStyle = `rgba(${(168 * v) | 0},${(154 * v) | 0},${(124 * v) | 0},${0.3 + rand() * 0.5})`;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, size * (0.004 + rand() * 0.016), 0, Math.PI * 2);
    ctx.fill();
  }
  mineralClouding(ctx, size, 913, 90);
  grain(ctx, size, 7000, 33);
  return c;
}

/** 电池簇抽屉的受检面：4 × 2 = 8 个 Pack 插槽（含把手与卡扣）。 */
function paintClusterFace(size: number) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#39434e";
  ctx.fillRect(0, 0, size, size);
  const cols = 4;
  const rows = 2;
  const padX = size * 0.045;
  const padY = size * 0.07;
  const cw = (size - padX * 2) / cols;
  const ch = (size - padY * 2) / rows;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const px = padX + x * cw + cw * 0.08;
      const py = padY + y * ch + ch * 0.12;
      const w = cw * 0.84;
      const h = ch * 0.76;
      ctx.fillStyle = "#1b2530";
      ctx.fillRect(px, py, w, h);
      const g = ctx.createLinearGradient(px, py, px, py + h);
      g.addColorStop(0, "rgba(150,178,204,.42)");
      g.addColorStop(0.35, "rgba(40,58,76,.05)");
      g.addColorStop(1, "rgba(12,20,30,.5)");
      ctx.fillStyle = g;
      ctx.fillRect(px, py, w, h);
      // 把手
      ctx.fillStyle = "rgba(206,214,222,.75)";
      ctx.fillRect(px + w * 0.32, py + h * 0.12, w * 0.36, h * 0.09);
      // 状态灯带
      ctx.fillStyle = "rgba(90,226,180,.85)";
      ctx.fillRect(px + w * 0.06, py + h * 0.84, w * 0.16, h * 0.06);
    }
  }
  return c;
}

/** 电池 Pack 的受检面：13 × 4 = 52 个方形电芯 + 汇流铜排 + 采样线束。 */
function paintBatteryPack(size: number) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const rand = makeRandom(6161);
  ctx.fillStyle = "#1d2733";
  ctx.fillRect(0, 0, size, size);

  const cols = 13;
  const rows = 4;
  const padX = size * 0.035;
  const padY = size * 0.06;
  const cw = (size - padX * 2) / cols;
  const ch = (size - padY * 2) / rows;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const px = padX + x * cw + cw * 0.06;
      const py = padY + y * ch + ch * 0.1;
      const w = cw * 0.88;
      const h = ch * 0.8;
      ctx.fillStyle = "#2f4152";
      ctx.fillRect(px, py, w, h);
      const g = ctx.createLinearGradient(px, py, px + w, py + h);
      g.addColorStop(0, "rgba(126,170,206,.55)");
      g.addColorStop(0.5, "rgba(40,62,84,.12)");
      g.addColorStop(1, "rgba(16,26,38,.45)");
      ctx.fillStyle = g;
      ctx.fillRect(px, py, w, h);
      // 极柱
      ctx.fillStyle = "rgba(220,226,232,.55)";
      ctx.beginPath();
      ctx.arc(px + w * 0.22, py + h * 0.16, Math.max(1, size * 0.004), 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px + w * 0.78, py + h * 0.16, Math.max(1, size * 0.004), 0, Math.PI * 2);
      ctx.fill();
      void rand;
    }
  }

  // 汇流铜排
  ctx.fillStyle = "rgba(184,118,60,.85)";
  ctx.fillRect(padX * 0.4, padY * 0.35, size - padX * 0.8, size * 0.018);
  ctx.fillRect(padX * 0.4, size - padY * 0.35 - size * 0.018, size - padX * 0.8, size * 0.018);
  // 采样线束
  ctx.strokeStyle = "rgba(212,180,110,.5)";
  ctx.lineWidth = Math.max(1, size * 0.004);
  for (let i = 1; i < cols; i++) {
    ctx.beginPath();
    ctx.moveTo(padX + i * cw, padY * 0.5);
    ctx.lineTo(padX + i * cw, size - padY * 0.5);
    ctx.stroke();
  }
  // 顶部标签条
  ctx.fillStyle = "rgba(20,28,38,.85)";
  ctx.fillRect(0, 0, size, size * 0.045);
  return c;
}

/** 单节方形电芯的铝壳 + 蓝色绝缘包膜。 */
function paintCell(size: number) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#2f5fa8";
  ctx.fillRect(0, 0, size, size);
  const g = ctx.createLinearGradient(0, 0, size, 0);
  g.addColorStop(0, "rgba(255,255,255,.34)");
  g.addColorStop(0.35, "rgba(255,255,255,.06)");
  g.addColorStop(1, "rgba(12,32,64,.42)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // 顶部铝盖与极柱
  ctx.fillStyle = "#b9c2cb";
  ctx.fillRect(0, 0, size, size * 0.14);
  ctx.fillStyle = "#e6ebf0";
  ctx.fillRect(size * 0.22, size * 0.03, size * 0.14, size * 0.08);
  ctx.fillRect(size * 0.64, size * 0.03, size * 0.14, size * 0.08);
  // 侧面铭牌
  ctx.fillStyle = "rgba(240,244,248,.72)";
  ctx.fillRect(size * 0.12, size * 0.42, size * 0.76, size * 0.2);
  ctx.fillStyle = "#2f5fa8";
  ctx.fillRect(size * 0.16, size * 0.46, size * 0.3, size * 0.04);
  ctx.fillRect(size * 0.16, size * 0.53, size * 0.5, size * 0.03);
  return c;
}

/** 水面法线扰动用的波纹高度图。 */
function paintWaterRipple(size: number) {
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const rand = makeRandom(7331);
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) {
    const y = rand() * size;
    const v = 108 + rand() * 40;
    ctx.strokeStyle = `rgba(${v},${v},${v},.5)`;
    ctx.lineWidth = 0.6 + rand() * 1.6;
    ctx.beginPath();
    ctx.moveTo(-10, y);
    ctx.bezierCurveTo(size * 0.31, y + (rand() - 0.5) * 14, size * 0.66, y + (rand() - 0.5) * 14, size + 10, y);
    ctx.stroke();
  }
  return c;
}

/* ================================================================== *
 * 统一出口
 * ================================================================== */

/**
 * 发光点精灵：中心实、边缘软掉的圆形。
 *
 * 不给 `PointsMaterial` 贴 map 的话，粒子会渲染成**方块**；再叠上
 * AdditiveBlending 打在浅色路面上，方块还会被加色推到纯白 —— 看起来像
 * 场景里飘着几张白纸。这张软边圆点是最便宜的解法。
 */
export function createGlowSprite(size = 64): THREE.CanvasTexture | null {
  if (!isBrowser) return null;
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.32, "rgba(255,255,255,0.72)");
  g.addColorStop(0.68, "rgba(255,255,255,0.16)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export type SurfaceTextureSet = {
  map?: THREE.CanvasTexture;
  bumpMap?: THREE.CanvasTexture;
  roughnessMap?: THREE.CanvasTexture;
};

type SurfaceName =
  | "grass"
  | "asphalt"
  | "track"
  | "gravelYard"
  | "concrete"
  | "metal"
  | "panelWall"
  | "metalRoof"
  | "pv"
  | "pvBack"
  | "container"
  | "containerDark"
  | "louver"
  | "battery"
  | "cluster"
  | "cell"
  | "water";

type Painter = { paint: (size: number) => HTMLCanvasElement; size: number; bump: number; rough: string; seed: number };

const PAINTERS: Record<SurfaceName, Painter> = {
  grass: { paint: paintGrass, size: 1024, bump: 22, rough: "#e8e8e8", seed: 11 },
  asphalt: { paint: paintAsphalt, size: 512, bump: 16, rough: "#d2d2d2", seed: 22 },
  track: { paint: paintTrack, size: 512, bump: 30, rough: "#e0e0e0", seed: 33 },
  gravelYard: { paint: paintGravelYard, size: 512, bump: 46, rough: "#dedede", seed: 44 },
  concrete: { paint: paintConcrete, size: 1024, bump: 12, rough: "#eeeeee", seed: 55 },
  metal: { paint: paintBrushed, size: 512, bump: 8, rough: "#5a5a5a", seed: 66 },
  panelWall: { paint: paintPanelWall, size: 1024, bump: 6, rough: "#f0f0f0", seed: 77 },
  metalRoof: { paint: paintMetalRoof, size: 512, bump: 18, rough: "#c8c8c8", seed: 88 },
  pv: { paint: paintPvModule, size: 512, bump: 4, rough: "#2e2e2e", seed: 99 },
  pvBack: { paint: paintPvBack, size: 512, bump: 10, rough: "#d8d8d8", seed: 101 },
  container: { paint: (s) => paintCorrugated(s, "#e4e6e3"), size: 512, bump: 26, rough: "#d0d0d0", seed: 111 },
  containerDark: { paint: (s) => paintCorrugated(s, "#c3c9c7"), size: 512, bump: 26, rough: "#c4c4c4", seed: 121 },
  louver: { paint: paintLouver, size: 512, bump: 40, rough: "#bbbbbb", seed: 131 },
  battery: { paint: paintBatteryPack, size: 512, bump: 24, rough: "#8a8a8a", seed: 151 },
  cluster: { paint: paintClusterFace, size: 512, bump: 22, rough: "#7a7a7a", seed: 171 },
  cell: { paint: paintCell, size: 256, bump: 10, rough: "#5c5c5c", seed: 161 },
  water: { paint: paintWaterRipple, size: 256, bump: 0, rough: "#2a2a2a", seed: 141 },
};

export type SurfaceTextures = Record<SurfaceName, SurfaceTextureSet>;

/**
 * 一次性把整套纹理画出来。`maxAnisotropy` 由调用方从 renderer 取，
 * 各向异性对草地和沥青的掠射角观感影响很大，别省。
 */
export function createSurfaceTextures(maxAnisotropy: number): SurfaceTextures {
  if (!isBrowser) return {} as SurfaceTextures;
  const out = {} as SurfaceTextures;

  for (const key of Object.keys(PAINTERS) as SurfaceName[]) {
    const spec = PAINTERS[key];
    // 水面只提供 bump（波纹），基色由材质本身给，省一张 1024 画布。
    const result: SurfaceTextureSet = {};
    if (key !== "water") {
      const map = new THREE.CanvasTexture(spec.paint(spec.size));
      map.colorSpace = THREE.SRGBColorSpace;
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.anisotropy = maxAnisotropy;
      out[key] = result;
      result.map = map;
    }
    if (spec.bump > 0) {
      const bump = new THREE.CanvasTexture(noiseCanvas(256, spec.bump, spec.seed));
      bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
      bump.anisotropy = maxAnisotropy;
      result.bumpMap = bump;
    }
    const rough = new THREE.CanvasTexture(roughnessCanvas(256, spec.rough, spec.seed + 7));
    rough.wrapS = rough.wrapT = THREE.RepeatWrapping;
    rough.anisotropy = maxAnisotropy;
    result.roughnessMap = rough;

    if (key === "water") {
      const ripple = new THREE.CanvasTexture(paintWaterRipple(256));
      ripple.wrapS = ripple.wrapT = THREE.RepeatWrapping;
      ripple.anisotropy = maxAnisotropy;
      result.bumpMap = ripple;
    }
    out[key] = result;
  }

  return out;
}
