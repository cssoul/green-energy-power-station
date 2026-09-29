<script setup lang="ts">
import { computed } from "vue";
import type { TwinNode, NodeKind } from "../core/registry";
import { KIND_META } from "../core/registry";
import type { StationTelemetry } from "../data/mock";

const props = defineProps<{
  node: TwinNode | null;
  telemetry: StationTelemetry;
  /** 与选中节点对应的历史采样（用于迷你趋势线）。 */
  history: number[];
  children: TwinNode[];
  drilledId: string | null;
}>();

const emit = defineEmits<{
  (e: "drill", id: string): void;
  (e: "close"): void;
}>();

const meta = computed(() => (props.node ? KIND_META[props.node.kind as NodeKind] : null));

/* ---------------- 数据解析 ---------------- */

const pv = computed(() => {
  if (props.node?.kind !== "pvBlock") return null;
  return props.telemetry.pv.find((p) => p.id === props.node!.dataKey) ?? null;
});

const inverter = computed(() => {
  if (props.node?.kind !== "inverter") return null;
  return props.telemetry.inverters.find((p) => p.id === props.node!.dataKey) ?? null;
});

const transformer = computed(() => {
  if (props.node?.kind !== "transformer") return null;
  return props.telemetry.transformers.find((p) => p.id === props.node!.dataKey) ?? null;
});

const cabinet = computed(() => {
  const id = props.node?.id ?? "";
  const key = id.split(".").slice(0, 2).join(".");
  if (!/^ess\.\d+$/.test(key)) return null;
  return props.telemetry.ess.find((e) => e.id === key) ?? null;
});

const stack = computed(() => {
  const parts = (props.node?.id ?? "").split(".");
  if (parts.length < 4 || parts[2] !== "stack") return null;
  return cabinet.value?.stacks[Number(parts[3]) - 1] ?? null;
});

const cluster = computed(() => {
  const parts = (props.node?.id ?? "").split(".");
  if (parts.length < 6 || parts[4] !== "cluster") return null;
  return stack.value?.clusters[Number(parts[5]) - 1] ?? null;
});

const pack = computed(() => {
  const parts = (props.node?.id ?? "").split(".");
  if (parts.length < 8 || parts[6] !== "pack") return null;
  return cluster.value?.packs[Number(parts[7]) - 1] ?? null;
});

const aux = computed(() => {
  const id = props.node?.id ?? "";
  if (!id.includes(".aux.")) return null;
  return cabinet.value?.aux ?? null;
});

/* ---------------- 展示用指标组 ---------------- */

type Metric = { label: string; value: string; unit?: string; tone?: "ok" | "warn" | "bad" | "accent" };

const kpis = computed<Metric[]>(() => {
  const n = props.node;
  if (!n) return [];
  const t = props.telemetry;

  // 先取进局部常量再判空。直接写 `if (pv.value) { ... return }` 会让 TS 把
  // `pv.value` 在函数余下部分永久收窄成 `null`，后面 `case "combiner"` 里再用
  // 就会被推断成 `never`。
  const pvD = pv.value;
  const invD = inverter.value;
  const txD = transformer.value;
  const cabD = cabinet.value;
  const stackD = stack.value;
  const clusterD = cluster.value;
  const packD = pack.value;

  if (pvD) {
    const d = pvD;
    return [
      { label: "实时功率", value: d.power.toFixed(1), unit: "kW", tone: "accent" },
      { label: "直流电压", value: d.voltage.toFixed(0), unit: "V" },
      { label: "直流电流", value: d.current.toFixed(1), unit: "A" },
      { label: "日发电量", value: d.dailyYield.toFixed(0), unit: "kWh" },
      { label: "累计发电量", value: d.totalYield.toFixed(1), unit: "MWh" },
      { label: "组件效率", value: d.efficiency.toFixed(2), unit: "%" },
    ];
  }
  if (invD) {
    const d = invD;
    const tone = d.status === "运行" ? "ok" : d.status === "限功率" ? "warn" : "bad";
    return [
      { label: "交流功率", value: d.acPower.toFixed(1), unit: "kW", tone: "accent" },
      { label: "直流输入", value: d.dcPower.toFixed(1), unit: "kW" },
      { label: "转换效率", value: d.efficiency.toFixed(2), unit: "%", tone },
      { label: "交流电压", value: d.acVoltage.toFixed(0), unit: "V" },
      { label: "频率", value: d.frequency.toFixed(2), unit: "Hz" },
      { label: "功率因数", value: d.powerFactor.toFixed(3) },
    ];
  }
  if (cabD && !stackD && !clusterD) {
    const d = cabD;
    return [
      { label: "SOC", value: d.soc.toFixed(1), unit: "%", tone: "accent" },
      { label: "SOH", value: d.soh.toFixed(1), unit: "%", tone: d.soh > 95 ? "ok" : "warn" },
      { label: "直流电压", value: d.voltage.toFixed(0), unit: "V" },
      { label: "电流", value: Math.abs(d.current).toFixed(0), unit: "A" },
      { label: "舱温", value: d.temperature.toFixed(1), unit: "℃" },
      { label: "功率", value: d.power.toFixed(2), unit: "MW", tone: d.power >= 0 ? "ok" : "warn" },
    ];
  }
  if (stackD) {
    const d = stackD;
    return [
      { label: "SOC", value: d.soc.toFixed(1), unit: "%", tone: "accent" },
      { label: "SOH", value: d.soh.toFixed(1), unit: "%" },
      { label: "簇电压", value: d.voltage.toFixed(0), unit: "V" },
      { label: "电流", value: Math.abs(d.current).toFixed(1), unit: "A" },
      { label: "温度", value: d.temperature.toFixed(1), unit: "℃" },
      { label: "功率", value: d.power.toFixed(3), unit: "MW" },
    ];
  }
  if (clusterD) {
    const d = clusterD;
    return [
      { label: "SOC", value: d.soc.toFixed(1), unit: "%", tone: "accent" },
      { label: "SOH", value: d.soh.toFixed(1), unit: "%" },
      { label: "电压", value: d.voltage.toFixed(1), unit: "V" },
      { label: "电流", value: Math.abs(d.current).toFixed(1), unit: "A" },
      { label: "温度", value: d.temperature.toFixed(1), unit: "℃" },
      { label: "Pack 数", value: String(d.packs.length) },
    ];
  }
  if (packD) {
    const d = packD;
    return [
      { label: "SOC", value: d.soc.toFixed(1), unit: "%", tone: "accent" },
      { label: "电压", value: d.voltage.toFixed(1), unit: "V" },
      { label: "电流", value: Math.abs(d.current).toFixed(1), unit: "A" },
      { label: "温度", value: d.temperature.toFixed(1), unit: "℃" },
      { label: "Cell 数", value: String(d.cells) },
      { label: "单体电压", value: (d.voltage / d.cells).toFixed(3), unit: "V" },
    ];
  }
  if (txD) {
    const d = txD;
    return [
      { label: "负载率", value: d.loadRate.toFixed(0), unit: "%", tone: d.loadRate > 90 ? "warn" : "ok" },
      { label: "有功", value: d.loadMw.toFixed(2), unit: "MW", tone: "accent" },
      { label: "油温", value: d.oilTemp.toFixed(1), unit: "℃" },
      { label: "绕组温度", value: d.windingTemp.toFixed(1), unit: "℃" },
      { label: "分接头", value: String(d.tapPosition) },
      { label: "变比", value: d.ratio },
    ];
  }

  switch (n.kind) {
    case "station":
      return [
        { label: "光伏出力", value: t.total.pvPower.toFixed(0), unit: "kW", tone: "accent" },
        { label: "并网功率", value: t.total.gridPower.toFixed(2), unit: "MW", tone: "ok" },
        { label: "储能功率", value: t.total.essPower.toFixed(2), unit: "MW", tone: t.total.essPower >= 0 ? "ok" : "warn" },
        { label: "日发电量", value: t.total.dailyYield.toFixed(0), unit: "kWh" },
        { label: "累计发电量", value: t.total.totalYield.toFixed(1), unit: "MWh" },
        { label: "辐照度", value: t.weather.irradiance.toFixed(0), unit: "W/m²" },
      ];
    case "pvFarm":
    case "zone":
      return [
        { label: "分组数量", value: String(props.children.length) },
        { label: "辐照度", value: t.weather.irradiance.toFixed(0), unit: "W/m²", tone: "accent" },
        { label: "组件温度", value: t.weather.moduleTemp.toFixed(1), unit: "℃" },
        { label: "环境温度", value: t.weather.ambient.toFixed(1), unit: "℃" },
      ];
    case "essFarm":
      return [
        { label: "SOC 均值", value: (t.ess.reduce((s, e) => s + e.soc, 0) / t.ess.length).toFixed(1), unit: "%", tone: "accent" },
        { label: "总功率", value: t.ess.reduce((s, e) => s + e.power, 0).toFixed(2), unit: "MW" },
        { label: "最高舱温", value: Math.max(...t.ess.map((e) => e.temperature)).toFixed(1), unit: "℃" },
        { label: "柜数", value: String(t.ess.length) },
      ];
    case "substation":
      return [
        { label: "总负载", value: t.transformers.reduce((s, x) => s + x.loadMw, 0).toFixed(2), unit: "MW", tone: "accent" },
        { label: "最高油温", value: Math.max(...t.transformers.map((x) => x.oilTemp)).toFixed(1), unit: "℃" },
        { label: "母线电压", value: t.grid.voltageKv.toFixed(2), unit: "kV" },
        { label: "系统频率", value: t.grid.frequency.toFixed(3), unit: "Hz" },
      ];
    case "transmission":
      return [
        { label: "并网有功", value: t.grid.activePower.toFixed(2), unit: "MW", tone: "accent" },
        { label: "并网无功", value: t.grid.reactivePower.toFixed(2), unit: "MVar" },
        { label: "功率因数", value: t.grid.powerFactor.toFixed(3) },
        { label: "今日上网", value: t.grid.todayExport.toFixed(0), unit: "kWh" },
      ];
    case "combiner": {
      // 汇流箱挂在阵列组下面（节点 id 形如 `pv.03.cb`），数据顺着父节点取。
      const p = props.telemetry.pv.find((x) => x.id === props.node?.parentId) ?? null;
      return [
        { label: "输入路数", value: "24" },
        { label: "组串电流", value: (p ? p.current / 24 : 0).toFixed(2), unit: "A" },
        { label: "直流电压", value: (p ? p.voltage : 0).toFixed(0), unit: "V" },
        { label: "防护等级", value: "IP65" },
      ];
    }
    case "vehicle":
      return [
        { label: "状态", value: "巡检中", tone: "ok" },
        { label: "时速", value: "12", unit: "km/h" },
        { label: "定位", value: "RTK 差分", },
      ];
    default:
      return [
        { label: "并网有功", value: t.grid.activePower.toFixed(2), unit: "MW", tone: "accent" },
        { label: "系统频率", value: t.grid.frequency.toFixed(3), unit: "Hz" },
        { label: "辐照度", value: t.weather.irradiance.toFixed(0), unit: "W/m²" },
        { label: "环境温度", value: t.weather.ambient.toFixed(1), unit: "℃" },
      ];
  }
});

/** 详细行：随层级变化。 */
const rows = computed<[string, string][]>(() => {
  const n = props.node;
  if (!n) return [];
  // 同上：链式 `else if (stack.value)` 会把后续分支里的 `stack.value` 收窄成 null。
  const pvD = pv.value;
  const invD = inverter.value;
  const cabD = cabinet.value;
  const stackD = stack.value;
  const clusterD = cluster.value;
  const packD = pack.value;
  const txD = transformer.value;
  // 名字先取出来：链式 `else if` 会把后面的局部常量收窄成 null。
  const cabinetName = cabD?.name ?? "-";
  const stackName = stackD?.name ?? "-";
  const clusterName = clusterD?.name ?? "-";
  const out: [string, string][] = [];
  if (pvD) {
    out.push(
      ["阵列拓扑", `${pvD.rowCount} 排 × 20 块`],
      ["组件数量", `${pvD.modules} 块`],
      ["组串数量", `${pvD.strings} 串`],
      ["单块容量", "585 Wp"],
      ["倾角 / 方位", "22° / 正南"],
      ["辐照度", `${pvD.irradiance.toFixed(0)} W/m²`],
      ["组件温度", `${pvD.moduleTemp.toFixed(1)} ℃`],
      ["装机容量", `${((pvD.modules * 585) / 1e6).toFixed(3)} MWp`],
    );
  } else if (invD) {
    out.push(
      ["设备型号", "SG4000UD-MV"],
      ["拓扑", "三电平 IGBT"],
      ["直流输入范围", "1000 – 1500 V"],
      ["交流输出", "690 V / 50 Hz"],
      ["冷却方式", "智能风冷"],
      ["舱温", `${invD.temperature.toFixed(1)} ℃`],
      ["运行状态", invD.status],
    );
  } else if (cabD && !stackD) {
    const d = cabD;
    out.push(
      ["额定容量", `${d.capacity.toFixed(2)} MWh`],
      ["循环次数", `${d.cycles} 次`],
      ["运行状态", d.status],
      ["内部层级", "5 电池堆 × 10 簇 × 8 Pack × 52 Cells"],
      ["单体总数", "20,800 颗"],
      ["PCS 效率", `${d.aux.pcsEfficiency.toFixed(2)} %`],
      ["EMS 策略", d.aux.emsMode],
      ["温控设定", `${d.aux.hvacSetpoint} ℃（进风 ${d.aux.hvacInlet.toFixed(1)} ℃）`],
      ["消防状态", d.aux.fireStatus],
      ["通讯时延", `${d.aux.commLatency} ms`],
    );
  } else if (stackD) {
    out.push(
      ["所属柜体", cabinetName],
      ["簇数量", `${stackD.clusters.length} 簇`],
      ["Pack 总数", `${stackD.clusters.length * 8}`],
      ["Cell 总数", (stackD.clusters.length * 8 * 52).toLocaleString("en-US")],
      ["串联拓扑", "10 簇并联 · 8 Pack 串联 · 52 Cells 串联"],
    );
  } else if (clusterD) {
    out.push(
      ["所属电池堆", stackName],
      ["Pack 数量", `${clusterD.packs.length} Pack`],
      ["Cell 总数", `${clusterD.packs.length * 52}`],
      ["单体规格", "3.2 V / 75 Ah"],
      ["Pack 串联数", "52 Cells 串联"],
    );
  } else if (packD) {
    out.push(
      ["所属电池簇", clusterName],
      ["Cell 数量", `${packD.cells} 颗`],
      ["排布", "13 × 4 方形电芯"],
      ["单体规格", "3.2 V / 75 Ah / 240 Wh"],
      ["Pack 电压", `${packD.voltage.toFixed(1)} V`],
    );
  } else if (txD) {
    const d = txD;
    out.push(
      ["型号", "SZ11-2000/110"],
      ["额定容量", "2 MVA"],
      ["变比", d.ratio],
      ["联接组别", "YNd11"],
      ["冷却方式", "ONAN / ONAF"],
      ["运行状态", d.status],
    );
  } else {
    out.push(
      ["站区面积", props.telemetry.meta.area],
      ["装机容量", props.telemetry.meta.capacityDc],
      ["储能配置", props.telemetry.meta.essCapacity],
      ["并网电压", props.telemetry.meta.gridVoltage],
      ["投运时间", props.telemetry.meta.commission],
      ["地理位置", props.telemetry.meta.location],
    );
  }
  void n;
  return out;
});

/* ---------------- 迷你趋势线 ---------------- */

const sparkPath = computed(() => {
  const data = props.history;
  if (data.length < 2) return "";
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  return data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * 100;
      const y = 30 - ((v - min) / span) * 26 - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
});

const sparkRange = computed(() => {
  const d = props.history;
  if (d.length < 2) return "";
  return `${Math.min(...d).toFixed(1)} – ${Math.max(...d).toFixed(1)}`;
});

const toneClass = (t?: Metric["tone"]) => (t ? `tone-${t}` : "");
</script>

<template>
  <aside class="panel glass scroll">
    <header class="head">
      <div class="head-main">
        <span class="chip" :style="{ background: meta ? meta.color + '1f' : 'transparent', color: meta?.color }">
          {{ meta?.label ?? "未选择" }}
        </span>
        <h2>{{ node?.label ?? "点击场景中的设备" }}</h2>
        <p class="sub">{{ node?.subtitle ?? "左侧光伏阵列 · 中部储能区 · 右侧升压站与输电线路" }}</p>
      </div>
      <button v-if="node" class="close" title="取消选择" @click="emit('close')">✕</button>
    </header>

    <div v-if="node" class="kpis">
      <div v-for="m in kpis" :key="m.label" class="kpi" :class="toneClass(m.tone)">
        <span class="k-label">{{ m.label }}</span>
        <span class="k-value mono">{{ m.value }}<em v-if="m.unit">{{ m.unit }}</em></span>
      </div>
    </div>

    <section v-if="node && history.length > 2" class="block">
      <div class="block-title">
        <span>实时趋势</span>
        <span class="mono range">{{ sparkRange }}</span>
      </div>
      <svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none">
        <defs>
          <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(15,143,176,.35)" />
            <stop offset="100%" stop-color="rgba(15,143,176,0)" />
          </linearGradient>
        </defs>
        <path v-if="sparkPath" :d="`${sparkPath} L100,30 L0,30 Z`" fill="url(#sparkFill)" />
        <path v-if="sparkPath" :d="sparkPath" fill="none" stroke="var(--accent)" stroke-width="1.1" vector-effect="non-scaling-stroke" />
      </svg>
    </section>

    <section v-if="rows.length" class="block">
      <div class="block-title"><span>技术参数</span></div>
      <dl class="rows">
        <div v-for="[k, v] in rows" :key="k" class="row">
          <dt>{{ k }}</dt>
          <dd class="mono">{{ v }}</dd>
        </div>
      </dl>
    </section>

    <section v-if="children.length" class="block">
      <div class="block-title">
        <span>{{ node?.kind === "essCabinet" ? "柜内结构 · 可下钻" : "下级单元" }}</span>
        <span class="count">{{ children.length }}</span>
      </div>
      <ul class="sublist scroll">
        <li v-for="c in children" :key="c.id">
          <button
            class="subrow"
            :class="{ active: drilledId === c.id }"
            @click="emit('drill', c.id)"
          >
            <i :style="{ background: KIND_META[c.kind as NodeKind]?.color ?? '#8f9aa6' }" />
            <span class="sr-label">{{ c.label }}</span>
            <span class="sr-sub mono">{{ c.subtitle?.split('·')[0]?.trim() }}</span>
            <span class="sr-go">›</span>
          </button>
        </li>
      </ul>
    </section>
  </aside>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 88px;
  right: 20px;
  width: 356px;
  max-height: calc(100vh - 168px);
  padding: 16px 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  overflow-x: hidden;
  pointer-events: auto;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.head-main {
  flex: 1;
  min-width: 0;
}
.chip {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 3px 8px;
  border-radius: 6px;
}
h2 {
  margin: 6px 0 2px;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.25;
}
.sub {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ink-3);
}
.close {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  color: var(--ink-3);
  font-size: 13px;
  transition: all 0.16s;
}
.close:hover {
  background: rgba(16, 32, 43, 0.07);
  color: var(--ink);
}

.kpis {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}
.kpi {
  background: rgba(255, 255, 255, 0.62);
  border: 1px solid var(--line-2);
  border-radius: 10px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.k-label {
  font-size: 10.5px;
  color: var(--ink-3);
  letter-spacing: 0.02em;
}
.k-value {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--ink);
}
.k-value em {
  font-style: normal;
  font-size: 10.5px;
  font-weight: 500;
  color: var(--ink-3);
  margin-left: 3px;
}
.tone-accent .k-value {
  color: var(--accent);
}
.tone-ok .k-value {
  color: var(--ok);
}
.tone-warn .k-value {
  color: var(--warn);
}
.tone-bad .k-value {
  color: var(--bad);
}

.block {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.block-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--ink-3);
  text-transform: uppercase;
}
.block-title .count,
.block-title .range {
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  color: var(--ink-3);
}

.spark {
  width: 100%;
  height: 46px;
  display: block;
}

.rows {
  margin: 0;
  display: flex;
  flex-direction: column;
}
.row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 5px 0;
  border-bottom: 1px dashed var(--line-2);
}
.row:last-child {
  border-bottom: none;
}
.row dt {
  font-size: 11.5px;
  color: var(--ink-3);
  white-space: nowrap;
}
.row dd {
  margin: 0;
  font-size: 11.5px;
  font-weight: 500;
  text-align: right;
  color: var(--ink-2);
}

.sublist {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 220px;
  overflow-y: auto;
}
.subrow {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 9px;
  text-align: left;
  transition: background 0.15s;
}
.subrow:hover {
  background: rgba(15, 143, 176, 0.08);
}
.subrow.active {
  background: rgba(15, 143, 176, 0.14);
}
.subrow i {
  width: 6px;
  height: 6px;
  border-radius: 2px;
  flex: none;
}
.sr-label {
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
.sr-sub {
  flex: 1;
  font-size: 10px;
  color: var(--ink-3);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sr-go {
  color: var(--ink-3);
  font-size: 13px;
  flex: none;
}

.foot {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--ink-3);
  padding-top: 4px;
  border-top: 1px solid var(--line-2);
}
.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 3px rgba(26, 158, 107, 0.16);
}

@media (max-width: 1280px) {
  .panel {
    width: 316px;
  }
}
</style>
