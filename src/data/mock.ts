import { variation } from "../core/rng";
import { ESS, PV, PV_BLOCK } from "../config";

/**
 * 全部遥测都是 mock —— 但 mock 得**自洽**：容量、串并联拓扑、电压电流之间的
 * 换算关系必须能对上，不然面板上会出现"166 V 的电池簇输出 1.3 kV"这类一眼假的数。
 *
 * 电气拓扑（整站统一）：
 *   Cell  3.2 V / 75 Ah  →  0.24 kWh
 *   Pack  52 串 → 166.4 V / 75 Ah  → 12.48 kWh
 *   Cluster 8 包串联 → 1331.2 V / 75 Ah  → 99.84 kWh
 *   Stack 10 簇并联 → 1331.2 V / 750 Ah  → 998.4 kWh ≈ 1 MWh
 *   Cabinet 5 堆并联 → 1331.2 V / 3750 Ah → 4.99 MWh
 *   10 柜 → 49.9 MWh
 *
 * 换真实 API 时，只要保持这些字段名与量纲，`DataPanel` 不用改。
 */

export const ELECTRICAL = {
  cell: { voltage: 3.2, capacityAh: 75, kwh: 0.24 },
  pack: { series: 52, voltage: 166.4, kwh: 12.48 },
  cluster: { series: 8, voltage: 1331.2, kwh: 99.84 },
  stack: { parallel: 10, voltage: 1331.2, capacityAh: 750, kwh: 998.4 },
  cabinet: { parallel: 5, voltage: 1331.2, capacityAh: 3750, kwh: 4992 },
  module: { wp: 585, vmp: 41.6, imp: 14.06 },
} as const;

export const STATION_META = {
  name: "绿能光伏电站",
  code: "PV-STATION-01",
  capacityDc: "4.68 MWp",
  capacityAc: "4.0 MW",
  essCapacity: "49.9 MWh / 25 MW",
  gridVoltage: "110 kV",
  commission: "2024-06",
  location: "东经 118.42° · 北纬 34.71°",
  area: "18.4 万 m²",
} as const;

export type PvBlockData = {
  id: string;
  name: string;
  /** 实时直流功率 kW */
  power: number;
  voltage: number;
  current: number;
  /** 当日发电量 kWh */
  dailyYield: number;
  /** 累计发电量 MWh */
  totalYield: number;
  irradiance: number;
  moduleTemp: number;
  efficiency: number;
  strings: number;
  modules: number;
  rowCount: number;
};

export type InverterData = {
  id: string;
  name: string;
  status: "运行" | "待机" | "限功率";
  acPower: number;
  dcPower: number;
  dcVoltage: number;
  acVoltage: number;
  frequency: number;
  efficiency: number;
  temperature: number;
  powerFactor: number;
};

export type CellGroup = { packId: string; cells: number; voltage: number; temperature: number };

export type PackData = {
  id: string;
  name: string;
  voltage: number;
  current: number;
  temperature: number;
  soc: number;
  cells: number;
};

export type ClusterData = {
  id: string;
  name: string;
  voltage: number;
  current: number;
  temperature: number;
  soc: number;
  soh: number;
  packs: PackData[];
};

export type StackData = {
  id: string;
  name: string;
  soc: number;
  soh: number;
  voltage: number;
  current: number;
  temperature: number;
  power: number;
  clusters: ClusterData[];
};

export type EssCabinetData = {
  id: string;
  name: string;
  soc: number;
  soh: number;
  voltage: number;
  current: number;
  temperature: number;
  power: number;
  status: "充电" | "放电" | "待机";
  cycles: number;
  capacity: number;
  stacks: StackData[];
  /** 柜内辅助系统读数 */
  aux: {
    pcsPower: number;
    pcsEfficiency: number;
    emsMode: string;
    hvacSetpoint: number;
    hvacInlet: number;
    fireStatus: string;
    commLatency: number;
  };
};

export type TransformerData = {
  id: string;
  name: string;
  ratio: string;
  loadMw: number;
  loadRate: number;
  oilTemp: number;
  windingTemp: number;
  tapPosition: number;
  status: string;
};

export type GridData = {
  voltageKv: number;
  frequency: number;
  activePower: number;
  reactivePower: number;
  powerFactor: number;
  todayExport: number;
  totalExport: number;
  lines: { id: string; name: string; load: number; current: number; status: string }[];
};

export type StationTelemetry = {
  meta: typeof STATION_META;
  weather: { irradiance: number; ambient: number; windSpeed: number; moduleTemp: number; cloud: number };
  pv: PvBlockData[];
  inverters: InverterData[];
  ess: EssCabinetData[];
  transformers: TransformerData[];
  grid: GridData;
  /** 全站实时汇总 */
  total: { pvPower: number; acPower: number; essPower: number; gridPower: number; dailyYield: number; totalYield: number };
};

/** 每个阵列组的组件数 = 20 列 × 20 排。 */
const MODULES_PER_BLOCK = PV.cols * PV.rows;
const STRINGS_PER_BLOCK = 20;

function buildStack(cabinetIdx: number, stackIdx: number, socSeed: number, share: number): StackData {
  const stacks: StackData = {
    id: `ess.${pad(cabinetIdx)}.stack.${pad(stackIdx)}`,
    name: `Battery Stack ${pad(stackIdx)}`,
    soc: socSeed,
    soh: 97.6 - stackIdx * 0.22 - variation(cabinetIdx * 13 + stackIdx) * 0.4,
    voltage: ELECTRICAL.stack.voltage - 8 + variation(stackIdx * 3 + cabinetIdx) * 16,
    current: 0,
    temperature: 27 + variation(cabinetIdx * 5 + stackIdx * 7) * 4,
    power: 0,
    clusters: [],
  };
  for (let c = 1; c <= ESS.clustersPerStack; c++) {
    const cluster: ClusterData = {
      id: `ess.${pad(cabinetIdx)}.stack.${pad(stackIdx)}.cluster.${pad(c)}`,
      name: `Cluster ${pad(c)}`,
      voltage: ELECTRICAL.cluster.voltage - 4 + variation(c * 3.1 + stackIdx) * 9,
      current: 0,
      temperature: stacks.temperature + (variation(c * 7.7) - 0.4) * 3.2,
      soc: stacks.soc + (variation(c * 2.3 + stackIdx * 5) - 0.5) * 2.4,
      soh: stacks.soh - variation(c * 1.7) * 0.7,
      packs: [],
    };
    for (let p = 1; p <= ESS.packsPerCluster; p++) {
      cluster.packs.push({
        id: `${cluster.id}.pack.${pad(p)}`,
        name: `Pack ${pad(p)}`,
        voltage: ELECTRICAL.pack.voltage - 1.2 + variation(p * 5.3 + c) * 2.6,
        current: 0,
        temperature: cluster.temperature + (variation(p * 3.9 + c * 2) - 0.45) * 2.4,
        soc: cluster.soc + (variation(p * 4.1) - 0.5) * 1.3,
        cells: ESS.cellsPerPack,
      });
    }
    stacks.clusters.push(cluster);
  }
  void share;
  return stacks;
}

function buildCabinet(index: number, soc0: number): EssCabinetData {
  const cabinet: EssCabinetData = {
    id: `ess.${pad(index)}`,
    name: `ESS-${pad(index)}`,
    soc: soc0,
    soh: 97.4 - variation(index * 9) * 0.8,
    voltage: ELECTRICAL.cabinet.voltage,
    current: 0,
    temperature: 26.5 + variation(index * 4.4) * 3.5,
    power: 0,
    status: "待机",
    cycles: 412 + Math.round(variation(index * 6.1) * 90),
    capacity: ELECTRICAL.cabinet.kwh / 1000,
    stacks: [],
    aux: {
      pcsPower: 0,
      pcsEfficiency: 98.4 - variation(index * 3.3) * 0.7,
      emsMode: "峰谷套利",
      hvacSetpoint: 25,
      hvacInlet: 24 + variation(index * 2.2) * 2,
      fireStatus: "正常监视",
      commLatency: 12 + Math.round(variation(index * 8.8) * 18),
    },
  };
  for (let s = 1; s <= ESS.stacksPerCabinet; s++) {
    cabinet.stacks.push(buildStack(index, s, soc0 + (variation(s * 6.7 + index) - 0.5) * 1.8, 1 / ESS.stacksPerCabinet));
  }
  return cabinet;
}

function pad(n: number, width = 2) {
  return String(n).padStart(width, "0");
}

export function createTelemetry(): StationTelemetry {
  const pv: PvBlockData[] = [];
  const totalModules = MODULES_PER_BLOCK;
  const blockKwp = (totalModules * ELECTRICAL.module.wp) / 1000;
  for (let i = 1; i <= PV.grid.cols * PV.grid.rows; i++) {
    const derate = 0.955 + variation(i * 11) * 0.04;
    pv.push({
      id: `pv.${pad(i)}`,
      name: `PV-${pad(i)} 阵列组`,
      power: blockKwp * derate,
      voltage: 1480 + variation(i * 3.7) * 60,
      current: 0,
      dailyYield: (blockKwp * 5.4 * derate) / 1,
      totalYield: 1840 + i * 37.6 + variation(i * 5) * 90,
      irradiance: 820,
      moduleTemp: 38,
      efficiency: 21.3 * (0.985 + variation(i * 2.9) * 0.02),
      strings: STRINGS_PER_BLOCK,
      modules: totalModules,
      rowCount: PV.rows,
    });
  }

  const inverters: InverterData[] = [];
  for (let i = 1; i <= 10; i++) {
    inverters.push({
      id: `inv.${pad(i)}`,
      name: `INV-${pad(i)} 升压一体舱`,
      status: "运行",
      acPower: 400,
      dcPower: 415,
      dcVoltage: 1500,
      acVoltage: 690,
      frequency: 50,
      efficiency: 98.6,
      temperature: 41 + variation(i * 3.1) * 5,
      powerFactor: 0.998,
    });
  }

  const ess: EssCabinetData[] = [];
  for (let i = 1; i <= ESS.cols * ESS.rows; i++) {
    ess.push(buildCabinet(i, 52 + variation(i * 7.3) * 26));
  }

  const transformers: TransformerData[] = [
    { id: "tx.01", name: "主变 #1", ratio: "0.69/110 kV", loadMw: 1.36, loadRate: 68, oilTemp: 52, windingTemp: 71, tapPosition: 9, status: "运行" },
    { id: "tx.02", name: "主变 #2", ratio: "0.69/110 kV", loadMw: 1.34, loadRate: 67, oilTemp: 51, windingTemp: 70, tapPosition: 9, status: "运行" },
    { id: "tx.03", name: "主变 #3", ratio: "0.69/110 kV", loadMw: 1.29, loadRate: 64, oilTemp: 49, windingTemp: 68, tapPosition: 10, status: "运行" },
  ];

  const grid: GridData = {
    voltageKv: 110.4,
    frequency: 50.0,
    activePower: 3.99,
    reactivePower: 0.42,
    powerFactor: 0.994,
    todayExport: 21840,
    totalExport: 6937.4,
    lines: [
      { id: "ln.01", name: "110kV 绿电线", load: 34, current: 108, status: "运行" },
      { id: "ln.02", name: "110kV 环网 II 回", load: 31, current: 99, status: "运行" },
      { id: "ln.03", name: "110kV 备用线", load: 0, current: 0, status: "热备用" },
    ],
  };

  const telemetry: StationTelemetry = {
    meta: STATION_META,
    weather: { irradiance: 820, ambient: 24, windSpeed: 3.2, moduleTemp: 38, cloud: 0.25 },
    pv,
    inverters,
    ess,
    transformers,
    grid,
    total: { pvPower: 0, acPower: 0, essPower: 0, gridPower: 3.99, dailyYield: 21840, totalYield: 6937.4 },
  };

  applyTelemetry(telemetry, 0, 1);
  return telemetry;
}

const smooth = (t: number, period: number, phase: number) => Math.sin((t / period) * Math.PI * 2 + phase);

/**
 * 推进一帧遥测。
 *
 * @param t 秒（场景运行时间）
 * @param sun 日照系数 0..1 —— 由"一天三时"驱动：白天 1、黄昏 0.35、夜晚 0。
 *            夜间的功率不是"随机变小"，而是**因为没太阳**而变小，两处必须一起动。
 */
export function applyTelemetry(data: StationTelemetry, t: number, sun: number) {
  const cloud = 0.86 + 0.14 * smooth(t, 47, 1.1) * 0.5 + 0.14 * smooth(t, 17, 2.7) * 0.5;
  const irradiance = Math.max(0, 940 * sun * cloud);
  const ambient = 12 + 16 * sun;
  const moduleTemp = ambient + (irradiance / 1000) * 26;

  data.weather.irradiance = irradiance;
  data.weather.ambient = ambient;
  data.weather.moduleTemp = moduleTemp;
  data.weather.windSpeed = 2.4 + 1.8 * (0.5 + 0.5 * smooth(t, 61, 0.4));
  data.weather.cloud = 1 - cloud;

  let pvPower = 0;
  let pvEnergy = 0;
  for (let i = 0; i < data.pv.length; i++) {
    const block = data.pv[i];
    const derate = 1 - Math.max(0, moduleTemp - 25) * 0.0038;
    const ripple = 1 + 0.018 * smooth(t, 23 + (i % 7), i * 1.7);
    block.irradiance = irradiance * (0.985 + variation(i * 3.3) * 0.03);
    block.moduleTemp = moduleTemp + (variation(i * 2.1) - 0.5) * 3;
    block.power = (block.modules * ELECTRICAL.module.wp * (block.irradiance / 1000) * derate * ripple) / 1000;
    const kwp = (block.modules * ELECTRICAL.module.wp) / 1000;
    block.voltage = 1200 + 320 * (block.irradiance / 1000) + (variation(i * 4.4) - 0.5) * 30;
    block.current = block.voltage > 1 ? (block.power * 1000) / block.voltage : 0;
    // 当日发电量按 1 分钟 = 1 小时的仿真比例累积，读起来才像真的在涨。
    block.dailyYield += (block.power / 60) * 0.02;
    block.totalYield += (block.power / 60) * 0.02 / 1000;
    block.efficiency = 21.3 * (0.985 + variation(i * 2.9) * 0.02) * derate;
    pvPower += block.power;
    pvEnergy += block.dailyYield;
  }

  // 逆变器：把直流侧功率均摊，再叠加各自的转换效率
  let acPower = 0;
  const perInverterDc = (pvPower * 1000) / data.inverters.length;
  for (let i = 0; i < data.inverters.length; i++) {
    const inv = data.inverters[i];
    const cap = 440;
    const dc = Math.min(cap, perInverterDc * (0.99 + 0.02 * smooth(t, 29, i)));
    inv.dcPower = dc / 1000;
    inv.efficiency = 96.8 + 2.0 * (dc / cap) - 0.4 * (1 - dc / cap);
    inv.acPower = (dc * inv.efficiency) / 100 / 1000;
    inv.dcVoltage = 1180 + 300 * (irradiance / 1000);
    inv.acVoltage = 690 + 4 * smooth(t, 31, i * 0.7);
    inv.frequency = 50 + 0.02 * smooth(t, 13, i);
    inv.temperature = 34 + (inv.acPower / 420) * 16 + 1.2 * smooth(t, 41, i * 2.1);
    inv.powerFactor = 0.998;
    inv.status = dc < 6 ? "待机" : dc >= cap * 0.995 ? "限功率" : "运行";
    acPower += inv.acPower;
  }

  // 储能：日照充裕时充电，日照衰减后放电。SOC 曲线因此天然是"太阳能的一天"。
  const charging = sun > 0.42;
  const essPowerTarget = charging ? 8.5 : -11.5;
  let essPower = 0;
  for (let i = 0; i < data.ess.length; i++) {
    const cab = data.ess[i];
    const share = 1 / data.ess.length;
    const target = essPowerTarget * share * (0.9 + 0.2 * variation(i * 6.1));
    cab.power = target * (0.96 + 0.08 * smooth(t, 37, i * 1.3));
    cab.status = Math.abs(cab.power) < 0.05 ? "待机" : cab.power > 0 ? "充电" : "放电";
    cab.current = (cab.power * 1000) / cab.voltage;
    cab.soc = clamp(cab.soc + (cab.power / cab.capacity) * 0.0022, 6, 98);
    cab.temperature = 26 + Math.abs(cab.power) * 1.1 + 1.6 * smooth(t, 53, i);
    cab.aux.pcsPower = cab.power;
    cab.aux.hvacInlet = cab.temperature - 2.4;
    for (const stack of cab.stacks) {
      stack.power = cab.power / cab.stacks.length;
      stack.soc = clamp(cab.soc + (variation(Number(stack.id.slice(-2)) * 3.3) - 0.5) * 1.6, 5, 99);
      stack.current = (stack.power * 1000) / Math.max(1, stack.voltage);
      stack.temperature = cab.temperature + 1.4;
      for (const cluster of stack.clusters) {
        cluster.current = stack.current / stack.clusters.length;
        cluster.soc = clamp(stack.soc + (variation(Number(cluster.id.slice(-2)) * 4.1) - 0.5) * 2.2, 4, 100);
        cluster.temperature = stack.temperature + 0.9;
        for (const pack of cluster.packs) {
          pack.current = cluster.current;
          pack.soc = clamp(cluster.soc + (variation(Number(pack.id.slice(-2)) * 5.9) - 0.5) * 1.5, 3, 100);
          pack.temperature = cluster.temperature + 0.5;
        }
      }
    }
  }
  essPower += data.ess.reduce((sum, c) => sum + c.power, 0);

  // 主变与并网
  const gridExport = acPower + (essPower < 0 ? -essPower : -essPower);
  for (let i = 0; i < data.transformers.length; i++) {
    const tx = data.transformers[i];
    tx.loadMw = Math.max(0.1, (gridExport / data.transformers.length) * (0.98 + 0.04 * variation(i * 2.3)));
    tx.loadRate = (tx.loadMw / 2) * 100;
    tx.oilTemp = 34 + tx.loadRate * 0.28 + 1.4 * smooth(t, 67, i);
    tx.windingTemp = tx.oilTemp + 17 + tx.loadRate * 0.06;
    tx.status = tx.loadRate > 92 ? "过载预警" : "运行";
  }

  data.grid.activePower = gridExport;
  data.grid.reactivePower = gridExport * 0.1;
  data.grid.voltageKv = 110 + 0.5 * smooth(t, 43, 0.8);
  data.grid.frequency = 50 + 0.015 * smooth(t, 19, 2.2);
  data.grid.powerFactor = 0.994;
  data.grid.todayExport += (gridExport * 1000) / 60 / 60 * 0.02 * 1000 * 0.001;
  data.grid.totalExport += (gridExport * 1000) / 60 / 60 * 0.02;

  data.total.pvPower = pvPower;
  data.total.acPower = acPower;
  data.total.essPower = essPower;
  data.total.gridPower = gridExport;
  data.total.dailyYield = pvEnergy;
  data.total.totalYield = data.pv.reduce((s, b) => s + b.totalYield, 0);
}

function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v;
}

export { PV_BLOCK };
