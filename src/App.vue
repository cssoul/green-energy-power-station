<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import type { TwinNode } from "./core/registry";
import type { StationTelemetry } from "./data/mock";
import type { TimeId } from "./core/sky";
import { VIEW_PRESETS } from "./config";
import type { ViewPreset } from "./core/cameraRig";
import { PowerStationScene, type SceneStats } from "./scene/PowerStationScene";
import DataPanel from "./ui/DataPanel.vue";

const canvasRef = ref<HTMLCanvasElement | null>(null);
const hostRef = ref<HTMLDivElement | null>(null);

const scene = shallowRef<PowerStationScene | null>(null);
const ready = ref(false);
const selected = ref<TwinNode | null>(null);
const hovered = ref<TwinNode | null>(null);
const hoverPos = ref({ x: 0, y: 0 });
const stats = ref<SceneStats>({ fps: 60, drawCalls: 0, triangles: 0, programs: 0, pixelRatio: 1 });
const telemetry = shallowRef<StationTelemetry | null>(null);
const history = ref<number[]>([]);
const timeId = ref<TimeId>("day");
const viewId = ref("overview");
const flowOn = ref(true);
const cameraMoving = ref(false);
const showHelp = ref(false);

/* ---------------- 机位预设 ---------------- */
// 预设值放在 config.ts（`resetView` 也要用同一个全景，避免两处数字打架）
const VIEWS = VIEW_PRESETS;

const TIMES: { id: TimeId; label: string }[] = [
  { id: "day", label: "白天" },
  { id: "dusk", label: "黄昏" },
  { id: "night", label: "夜晚" },
];

const FLOW_LEGEND = [
  { cls: "dc", color: "#2f6fd0", label: "直流 DC", desc: "组件 → 汇流箱 → 逆变舱" },
  { cls: "ac", color: "#e08a2e", label: "交流 AC", desc: "逆变舱 → 主变低压侧" },
  { cls: "store", color: "#12a07c", label: "储能", desc: "交流母线 ↔ 储能柜（双向）" },
  { cls: "grid", color: "#d94a4a", label: "高压", desc: "主变 → 构架 → 铁塔 → 电网" },
];

/* ---------------- 生命周期 ---------------- */
onMounted(() => {
  const canvas = canvasRef.value!;
  const host = hostRef.value!;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = host.clientWidth * ratio;
  canvas.height = host.clientHeight * ratio;

  const instance = new PowerStationScene(canvas, {
    onHover: (node) => {
      hovered.value = node;
    },
    onSelect: (node) => {
      selected.value = node;
      history.value = node ? [] : [];
      viewId.value = "";
    },
    onStats: (s) => {
      stats.value = s;
    },
    onTelemetry: (t) => {
      telemetry.value = { ...t };
      pushHistory();
    },
    onCameraLock: (locked) => {
      cameraMoving.value = locked;
    },
  });
  scene.value = instance;

  // 把 ResizeObserver 的突发（初始布局抖动、字体加载、DevTools 切换等）合并到下一帧，
  // 避免短时间内多次 setSize 反复重建 drawing buffer 造成整屏闪。重复尺寸由
  // PowerStationScene.resize 内部的 no-op 守卫再拦一道。
  let resizeRaf = 0;
  const ro = new ResizeObserver(() => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      instance.resize(host.clientWidth, host.clientHeight);
    });
  });
  ro.observe(host);
  instance.resize(host.clientWidth, host.clientHeight);
  instance.start();
  ready.value = true;

  // 把实例挂到 window，方便自动化脚本驱动下钻链路做验收截图。
  // 除开发期外，额外放行 `?capture=1` —— 生产包同样要能被脚本驱动（见
  // `PowerStationScene` 构造函数里关于 capture 开关的说明）。
  if (import.meta.env.DEV || new URLSearchParams(window.location.search).has("capture")) {
    (window as unknown as { __twin?: PowerStationScene }).__twin = instance;
  }

  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    hoverPos.value = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  });

  onBeforeUnmount(() => {
    ro.disconnect();
    instance.dispose();
    scene.value = null;
  });
});

/* ---------------- 趋势采样 ---------------- */
function primaryValue(node: TwinNode | null): number | null {
  const t = telemetry.value;
  if (!node || !t) return null;
  const key = node.dataKey ?? node.id;
  if (node.kind === "pvBlock") return t.pv.find((p) => p.id === key)?.power ?? null;
  if (node.kind === "inverter") return t.inverters.find((p) => p.id === key)?.acPower ?? null;
  if (/^ess\.\d+/.test(key)) {
    const cab = t.ess.find((e) => e.id === key.split(".").slice(0, 2).join("."));
    if (!cab) return null;
    const parts = key.split(".");
    if (parts[2] === "stack") {
      const st = cab.stacks[Number(parts[3]) - 1];
      return st ? st.power * 1000 : null;
    }
    if (parts[4] === "cluster") return cab.stacks[Number(parts[3]) - 1]?.clusters[Number(parts[5]) - 1]?.current ?? null;
    return cab.power * 1000;
  }
  if (node.kind === "transformer") return t.transformers.find((p) => p.id === key)?.loadMw ?? null;
  return t.total.pvPower;
}

function pushHistory() {
  const v = primaryValue(selected.value);
  if (v === null || !Number.isFinite(v)) return;
  const next = history.value.concat(v);
  history.value = next.length > 64 ? next.slice(next.length - 64) : next;
}

/* ---------------- 操作 ---------------- */
function pick(id: string) {
  scene.value?.drillInto(id);
}
function clearSelection() {
  scene.value?.selectNode(null);
  selected.value = null;
}
function setTime(id: TimeId) {
  timeId.value = id;
  scene.value?.applyTime(id);
}
function setView(preset: ViewPreset) {
  viewId.value = preset.id;
  scene.value?.setView(preset);
}
function toggleFlow() {
  flowOn.value = !flowOn.value;
  scene.value?.setFlowVisible(flowOn.value);
}
function resetView() {
  viewId.value = "overview";
  scene.value?.resetView();
}

const crumbs = computed(() => (selected.value ? scene.value?.registry.path(selected.value.id) ?? [] : []));
const children = computed(() => {
  const s = scene.value;
  if (!s || !selected.value) return [];
  return s.registry.children(selected.value.id);
});
const drilledId = computed(() => {
  const d = scene.value?.drillState;
  if (!d) return null;
  if (d.packId) return d.packId;
  if (d.cluster !== null && d.stack !== null)
    return `${d.cabinetId}.stack.${String(d.stack + 1).padStart(2, "0")}.cluster.${String(d.cluster + 1).padStart(2, "0")}`;
  if (d.stack !== null) return `${d.cabinetId}.stack.${String(d.stack + 1).padStart(2, "0")}`;
  return d.cabinetId;
});

const fpsTone = computed(() => (stats.value.fps >= 55 ? "ok" : stats.value.fps >= 40 ? "warn" : "bad"));
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
</script>

<template>
  <div ref="hostRef" class="stage">
    <canvas ref="canvasRef" class="scene-canvas" />

    <!-- 顶部标题 -->
    <div class="topbar">
      <div class="brand">
        <svg class="mark" viewBox="0 0 26 26" width="26" height="26" role="img" aria-label="绿能光伏电站">
          <defs>
            <linearGradient id="markBg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#0f8fb0" />
              <stop offset="0.55" stop-color="#2f6fd0" />
              <stop offset="1" stop-color="#e08a2e" />
            </linearGradient>
          </defs>
          <rect width="26" height="26" rx="8" fill="url(#markBg)" />
          <!-- 太阳 -->
          <circle cx="13" cy="8.2" r="3.1" fill="#ffffff" />
          <g stroke="#ffffff" stroke-width="1.5" stroke-linecap="round">
            <path d="M13 3.2v1.5" />
            <path d="M17.4 8.2h1.5" />
            <path d="M8.6 8.2H7.1" />
            <path d="M16.3 4.9l1.1 1.1" />
            <path d="M9.7 4.9l-1.1 1.1" />
          </g>
          <!-- 山峦剪影，呼应光伏电站坐落于山野之间 -->
          <path d="M2 23 Q13 16 24 22 L24 26 L2 26 Z" fill="#ffffff" opacity="0.95" />
        </svg>
        <div class="brand-text">
          <strong>绿能光伏电站</strong>
        </div>
      </div>

      <div class="tools">
        <div class="seg glass">
          <button
            v-for="t in TIMES"
            :key="t.id"
            :class="{ on: timeId === t.id }"
            @click="setTime(t.id)"
          >
            {{ t.label }}
          </button>
        </div>
        <button class="icon-btn glass" :class="{ on: flowOn }" title="能源流显隐" @click="toggleFlow">
          <span class="flow-ico">⇄</span>
        </button>
      </div>
    </div>

    <!-- 机位切换 -->
    <div class="views glass">
      <div class="view-title">机位切换</div>
      <div class="view-list">
        <button
          v-for="v in VIEWS"
          :key="v.id"
          :class="{ on: viewId === v.id }"
          @click="setView(v)"
        >
          {{ v.label }}
        </button>
      </div>

      <div class="view-title">全局数据</div>
      <div class="readouts">
        <div class="ro">
          <label>光伏出力</label>
          <b class="mono">{{ telemetry ? telemetry.total.pvPower.toFixed(0) : "—" }}<i>kW</i></b>
        </div>
        <div class="ro">
          <label>并网功率</label>
          <b class="mono">{{ telemetry ? telemetry.total.gridPower.toFixed(2) : "—" }}<i>MW</i></b>
        </div>
        <div class="ro">
          <label>储能功率</label>
          <b class="mono" :class="telemetry && telemetry.total.essPower >= 0 ? 'pos' : 'neg'">
            {{ telemetry ? (telemetry.total.essPower >= 0 ? "+" : "") + telemetry.total.essPower.toFixed(2) : "—" }}<i>MW</i>
          </b>
        </div>
        <div class="ro">
          <label>辐照度</label>
          <b class="mono">{{ telemetry ? telemetry.weather.irradiance.toFixed(0) : "—" }}<i>W/m²</i></b>
        </div>
      </div>
    </div>

    <!-- 能源流图例 -->
    <div class="legend glass">
      <div class="legend-title">能源流</div>
      <ul>
        <li v-for="f in FLOW_LEGEND" :key="f.cls">
          <i :style="{ background: f.color, boxShadow: `0 0 8px ${f.color}88` }" />
          <div>
            <b>{{ f.label }}</b>
            <em>{{ f.desc }}</em>
          </div>
        </li>
      </ul>
    </div>

    <!-- 面包屑 -->
    <div v-if="crumbs.length > 1" class="crumbs glass">
      <template v-for="(c, i) in crumbs" :key="c.id">
        <button class="crumb" :class="{ on: i === crumbs.length - 1 }" @click="pick(c.id)">
          {{ c.label }}
        </button>
        <span v-if="i < crumbs.length - 1" class="sep">/</span>
      </template>
      <button class="crumb clear" @click="clearSelection">返回总览</button>
    </div>

    <!-- 悬停标签 -->
    <div
      v-if="hovered"
      class="tip"
      :style="{ left: hoverPos.x + 16 + 'px', top: hoverPos.y + 12 + 'px' }"
    >
      <b>{{ hovered.label }}</b>
      <em>{{ hovered.subtitle }}</em>
    </div>

    <!-- 数据面板：未选择设备时隐藏 -->
    <DataPanel
      v-if="selected"
      :node="selected"
      :telemetry="telemetry ?? ({} as StationTelemetry)"
      :history="history"
      :children="children"
      :drilled-id="drilledId"
      @drill="pick"
      @close="clearSelection"
    />

    <!-- 性能读数 -->
    <div class="perf glass">
      <span :class="fpsTone"><b class="mono">{{ stats.fps }}</b> FPS</span>
      <span class="div" />
      <span>Draw <b class="mono">{{ stats.drawCalls }}</b></span>
      <span>Tri <b class="mono">{{ fmt(stats.triangles) }}</b></span>
      <span>DPR <b class="mono">{{ stats.pixelRatio.toFixed(2) }}</b></span>
    </div>

    <!-- 操作提示 -->
    <div class="hint glass">
      <span>左键拖拽旋转</span>
      <span class="div" />
      <span>滚轮缩放</span>
      <span class="div" />
      <span>右键平移</span>
      <span class="div" />
      <span>单击设备查看数据 · 再次点击下级可逐层下钻</span>
    </div>

    <div v-if="!ready" class="loading glass">
      <span class="spin" />
      <b>正在生成三维场景…</b>
    </div>
  </div>
</template>

<style scoped>
.stage {
  position: fixed;
  inset: 0;
  overflow: hidden;
}
.scene-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
  cursor: grab;
}
.scene-canvas:active {
  cursor: grabbing;
}

/* ---- 顶部 ---- */
.topbar {
  position: absolute;
  top: 20px;
  left: 20px;
  right: 20px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  pointer-events: none;
}
.topbar > * {
  pointer-events: auto;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px 10px 12px;
}
.mark {
  width: 26px;
  height: 26px;
  display: block;
  filter: drop-shadow(0 4px 12px rgba(15, 143, 176, 0.45));
}
.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  color: #FFF;
}

.readouts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 6px;
  margin-left: 2px;
}
.ro {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 45%;
  padding: 2px 14px;
}
.ro:last-child {
  border-right: none;
}
.ro label {
  font-size: 10px;
  color: var(--ink-3);
  letter-spacing: 0.04em;
  white-space: nowrap;
}
.ro b {
  font-size: 16px;
  font-weight: 620;
  letter-spacing: -0.02em;
}
.ro b i {
  font-style: normal;
  font-size: 10px;
  font-weight: 500;
  color: var(--ink-3);
  margin-left: 3px;
}
.ro b.pos {
  color: var(--ok);
}
.ro b.neg {
  color: #c8720c;
}

.tools {
  margin-left: auto;
  display: flex;
  gap: 8px;
  align-items: center;
}
.seg {
  display: flex;
  padding: 4px;
  gap: 2px;
}
.seg button {
  padding: 6px 14px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 550;
  color: var(--ink-2);
  transition: all 0.18s;
}
.seg button:hover {
  background: rgba(16, 32, 43, 0.06);
}
.seg button.on {
  background: #12252f;
  color: #eaf6fa;
  box-shadow: 0 6px 16px -8px rgba(18, 37, 47, 0.9);
}
.icon-btn {
  width: 38px;
  height: 38px;
  border-radius: 11px;
  font-size: 15px;
  color: var(--ink-2);
  display: grid;
  place-items: center;
  transition: all 0.18s;
}
.icon-btn:hover {
  background: rgba(255, 255, 255, 0.9);
}
.icon-btn.on {
  background: #12252f;
  color: #6fe3ff;
}
.flow-ico {
  font-size: 16px;
  line-height: 1;
}

/* ---- 机位 ---- */
.views {
  position: absolute;
  top: 84px;
  left: 20px;
  width: 280px;
  display: flex;
  flex-direction: column;
  padding: 12px;
  gap: 8px;
}
.view-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--ink-1);
  text-transform: uppercase;
  margin-bottom: 8px;
}
.view-list {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 24px;
}
.view-list button {
  width: 80px;
  padding: 7px 16px;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 400;
  color: var(--ink-2);
  background: rgba(16, 32, 43, 0.06);
  text-align: center;
  transition: all 0.18s;
  white-space: nowrap;
}
.views button:hover {
  background: rgba(16, 32, 43, 0.10);
}
.views button.on {
  background: rgba(15, 143, 176, 0.24);
  color: #1e6ec4;
}

/* ---- 图例 ---- */
.legend {
  position: absolute;
  left: 20px;
  bottom: 92px;
  width: 280px;
  padding: 12px;
}
.legend-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--ink-1);
  text-transform: uppercase;
  margin-bottom: 8px;
}
.legend ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.legend li {
  display: flex;
  align-items: flex-start;
  gap: 9px;
}
.legend i {
  width: 16px;
  height: 3px;
  border-radius: 2px;
  margin-top: 6px;
  flex: none;
}
.legend b {
  display: block;
  font-size: 11.5px;
  font-weight: 600;
}
.legend em {
  display: block;
  font-style: normal;
  font-size: 10px;
  color: var(--ink-3);
  line-height: 1.45;
}

/* ---- 面包屑 ---- */
.crumbs {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: 92px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  max-width: min(760px, 60vw);
  overflow-x: auto;
}
.crumb {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--ink-2);
  padding: 5px 10px;
  border-radius: 8px;
  white-space: nowrap;
  transition: all 0.16s;
}
.crumb:hover {
  background: rgba(15, 143, 176, 0.1);
  color: var(--accent);
}
.crumb.on {
  color: var(--ink);
  font-weight: 620;
  background: rgba(15, 143, 176, 0.12);
}
.crumb.clear {
  margin-left: 6px;
  color: var(--ink-3);
}
.sep {
  color: var(--ink-3);
  font-size: 11px;
  opacity: 0.6;
}

/* ---- 悬停标签 ---- */
.tip {
  position: absolute;
  pointer-events: none;
  background: rgba(18, 37, 47, 0.92);
  color: #eaf6fa;
  padding: 7px 11px;
  border-radius: 9px;
  max-width: 260px;
  box-shadow: 0 12px 28px -12px rgba(0, 0, 0, 0.6);
  z-index: 30;
}
.tip b {
  display: block;
  font-size: 12px;
  font-weight: 600;
}
.tip em {
  display: block;
  font-style: normal;
  font-size: 10px;
  opacity: 0.72;
  margin-top: 2px;
}

/* ---- 性能与提示 ---- */
.perf {
  position: absolute;
  right: 20px;
  bottom: 24px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  font-size: 11px;
  color: var(--ink-3);
}
.perf b {
  color: var(--ink);
  font-weight: 600;
}
.perf .ok b {
  color: var(--ok);
}
.perf .warn b {
  color: var(--warn);
}
.perf .bad b {
  color: var(--bad);
}
.div {
  width: 1px;
  height: 11px;
  background: var(--line);
}

.hint {
  position: absolute;
  left: 50%;
  bottom: 24px;
  display: flex;
  align-items: center;
  gap: 10px;
  transform: translateX(-50%);
  padding: 8px 14px;
  font-size: 11px;
  color: var(--ink-3);
  max-width: calc(100vw - 520px);
  flex-wrap: wrap;
}

.loading {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 24px;
  font-size: 13px;
}
.spin {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid rgba(15, 143, 176, 0.25);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 1500px) {
  .hint {
    display: none;
  }
  .legend {
    bottom: 24px;
  }
  .crumbs {
    bottom: 24px;
  }
}
@media (max-width: 1100px) {
  .views {
    display: none;
  }
  .legend {
    display: none;
  }
}
</style>
