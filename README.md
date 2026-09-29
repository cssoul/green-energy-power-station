# green-energy-power-station

交互式「绿能光伏电站」三维数字孪生：用 Vue3 + TypeScript + Three.js 把一座光伏电站的发电全链路（组件 → 汇流 → 逆变 → 储能 → 升压 → 并网）做成可环视、可点击下钻、可切换时刻的实时可视化。

## 最终效果

![绿能光伏电站三维总览](assets.png)

## 核心特性

| 特性 | 说明 |
| --- | --- |
| 三维电站总览 | 光伏组件阵列、汇流箱、逆变舱、储能柜、主变压器、升压构架、铁塔、电网全链路一屏呈现 |
| 一天四时 | 白天 / 黄昏 / 夜晚一键切换，天空、光照、曝光与室内灯随之联动 |
| 机位切换 | 预置多个机位（总览 + 各工艺段），切机位只换相机不动几何 |
| 设备下钻 | 单击任意设备弹出数据面板，可逐层下钻到储能柜 → 电池堆 → 电池簇 |
| 能源流可视化 | 直流 DC / 交流 AC / 储能 / 高压四类管路，按流向与颜色区分 |
| 实时遥测 | 光伏出力、并网功率、储能功率（充放双向）、辐照度等全局读数实时刷新 |
| 性能读数 | 右下角常驻 FPS / Draw Call / 三角面 / DPR，便于性能观察 |

## 目录结构

```
src/
  core/       引擎层：合批(batcher)、相机机位(cameraRig)、几何(geo)、材质(materials)、
              数字孪生注册表(registry)、天空(sky)、纹理(textures)、选择(selection)、随机(rng)
  data/       模拟遥测数据（mock）
  scene/      PowerStationScene —— 主场景编排与渲染循环
  ui/         DataPanel 等设备数据面板
  world/      场景构件：光伏(pv)、逆变(inverter)、储能(ess)、变电(substation)、
              道路(roads)、地形(terrain)、植被(vegetation)、车辆(vehicles)、能源流(energyFlow)、场平(civil)
  App.vue     顶层 UI 与交互编排（顶栏 / 机位 / 图例 / 面包屑 / 性能）
  config.ts   机位预设与参数配置
  main.ts     入口
  style.css   全局样式
```

## 跑起来

```sh
npm ci
npm run dev       # 127.0.0.1:5310
npm run build     # vue-tsc --noEmit && vite build
npm run preview   # 127.0.0.1:5311 预览生产构建
```

需要 Node.js 18.18+ 或 20+（Vite 6）。

## 交互说明

- 左键拖拽旋转 · 滚轮缩放 · 右键平移
- 单击设备查看数据，再次点击下级可逐层下钻
- 顶栏可切换白天 / 黄昏 / 夜晚，并开关能源流显隐

## 技术要点

- 按材质合批，尽量压低 draw call；需求渲染 + 阴影节流保证帧率
- 程序化 equirect 天空 → PMREM，作为环境反射与场景背景
- 数字孪生注册表统一管理设备节点，驱动选择、下钻与遥测联动
