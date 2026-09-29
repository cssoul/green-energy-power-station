import * as THREE from "three";
import { CAMERA, EDGE, ESS, OVERVIEW_PRESET, PLATFORM_Y, THEME } from "../config";
import { CameraRig, type ViewPreset } from "../core/cameraRig";
import { surfaceOf } from "../core/batcher";
import { createMaterials, type MaterialSet } from "../core/materials";
import { measure, TwinRegistry, type TwinNode } from "../core/registry";
import { SelectionOverlay } from "../core/selection";
import { createSkyEnvironment, presetOf, type DayPreset, type TimeId } from "../core/sky";
import { applyTelemetry, createTelemetry, type StationTelemetry } from "../data/mock";
import { buildCivil } from "../world/civil";
import { buildEnergyFlow, planFlowPaths, type EnergyFlowBuild } from "../world/energyFlow";
import { buildEss, type EssBuild } from "../world/ess";
import { buildInverters, type InverterBuild } from "../world/inverter";
import { buildPvFarm, type PvFarmBuild } from "../world/pv";
import { buildRoads, type RoadBuild } from "../world/roads";
import { buildSubstation, type SubstationBuild } from "../world/substation";
import { buildTerrain, buildWater, type Terrain } from "../world/terrain";
import { buildVegetation, type VegetationBuild } from "../world/vegetation";
import { buildVehicles, type VehicleBuild } from "../world/vehicles";

/**
 * 自适应分辨率的**下界**。
 *
 * 0.7 是"还能看"的极限：再低，围栏、导线、组件边框这些细结构就会糊成一团，
 * 轴测分析图那种干净的边缘感就没了。宁可帧率留一点余量，也不要画面碎掉。
 */
const MIN_PIXEL_RATIO = 0.7;

/**
 * 储能深下钻（Cluster / Pack / 52 芯）专用的"检修台"视角。
 *
 * 两件事必须同时成立：
 *  1. **俯角要够陡。** 8 个 Pack 与 52 芯阵列都是平铺在检修台上的，俯角 ~53°
 *     才正对着看它们；用全景那种 28° 会看成一条斜线。
 *  2. **相机不能被后排柜挡住。** 储能区是 2 排 × 5 列，排间距只有 12.4 m。
 *     按普通俯角把机位推到 28° 那个方向，相机直接落进第二排柜体里。
 *     把俯角抬到 53° 之后，同样距离下相机 z 位移从 0.73·d 降到 0.52·d，
 *     正好停进两排之间的空当。
 */
const ESS_DRILL_VIEW = { azimuth: 1.02, elevation: 0.92, minRadius: 1.0 } as const;

/** 储能柜内"辅助模块"这一层的节点 kind（与 `AUX_SPECS` 的 key 一一对应）。 */
const AUX_KINDS = ["pcs", "ems", "comm", "hvac", "fire"] as const;

export type SceneStats = {
  fps: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  pixelRatio: number;
};

export type SceneCallbacks = {
  onHover(node: TwinNode | null): void;
  onSelect(node: TwinNode | null): void;
  onStats(stats: SceneStats): void;
  onTelemetry(data: StationTelemetry): void;
  onCameraLock(locked: boolean): void;
};

/** 下钻状态机：记录储能柜当前展开到了第几层。 */
type EssDrill = {
  cabinetId: string;
  stack: number | null;
  cluster: number | null;
  packId: string | null;
};

export class PowerStationScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly registry = new TwinRegistry();
  readonly telemetry = createTelemetry();

  private materials: MaterialSet;
  private overlay: SelectionOverlay;

  private terrain!: Terrain;
  private pv!: PvFarmBuild;
  private inverters!: InverterBuild;
  private ess!: EssBuild;
  private substation!: SubstationBuild;
  private roads!: RoadBuild;
  private vehicles!: VehicleBuild;
  private vegetation!: VegetationBuild;
  private flow!: EnergyFlowBuild;

  private hemi!: THREE.HemisphereLight;
  private keyLight!: THREE.DirectionalLight;
  private fillLight!: THREE.DirectionalLight;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(-10, -10);
  private pointerPx = { x: 0, y: 0 };

  private hovered: TwinNode | null = null;
  private selected: TwinNode | null = null;
  private interactive = new Set<string>();
  private drill: EssDrill | null = null;
  private lastFocusBox = new THREE.Box3();

  private lastTime = 0;
  private elapsed = 0;
  private frame = 0;
  private lastFpsSample = 0;
  private framesSinceSample = 0;
  private fps = 60;
  private pixelRatio = 1;
  private pixelRatioCap = 1;
  /** 上一次 resize 的 CSS 尺寸，用来跳过无变化的重复 setSize（每次 setSize 都会重建
   *  drawing buffer，连续触发会造成整屏闪一下——尤其窗口拖动 / 初始布局抖动时）。 */
  private lastW = -1;
  private lastH = -1;
  private downVotes = 0;
  private upVotes = 0;
  /** 改分辨率 = 重建 drawing buffer，每次都会让整屏闪一下。变动后冷却若干采样，
   *  配合“升档小步 + 升降阈值拉开”避免 Retina 等高分屏上 DPR 在 2.0↔1.8 间来回“呼吸”。 */
  private resCooldown = 0;
  private running = false;
  private rafId = 0;
  private lastTelemetry = 0;
  private sunFactor = 1;
  private timeId: TimeId = "day";
  /** PMREM 输出的是 render target，取 `.texture` 挂到 scene.environment；dispose 要用 target。 */
  private environment: THREE.WebGLRenderTarget | null = null;
  private skyTexture: THREE.Texture | null = null;
  private disposed = false;
  private currentPreset: DayPreset;
  private lampPool?: THREE.MeshBasicMaterial;

  constructor(
    private canvas: HTMLCanvasElement,
    private callbacks: SceneCallbacks,
  ) {
    // 取证开关：`?capture=1` 时保留绘制缓冲。
    //
    // 默认的 `preserveDrawingBuffer: false` 会在合成后清掉缓冲，自动化截图
    // （Playwright / CI 视觉回归）会随机抓到一张空白画布 —— 那种"页面全白"的
    // 假故障最耗时。但它**不能常开**：Apple 芯片是 TBDR 架构，保留缓冲会打断
    // tile memory 的合并，实测在全景机位下要多花 ~6 ms/帧（见 SKILL 的性能账）。
    // 所以做成按需开关，验收脚本统一带 `?capture=1`。
    //
    // **开关只看参数、不看 `DEV`。** 早先写成 `import.meta.env.DEV && q.has(...)`，
    // 于是验收脚本只能对着 dev server 跑 —— 而 dev server 带着 HMR 客户端与未压缩的
    // 模块图，量出来的帧率偏低，还容易把"开发期开销"误算成场景开销。改成只看参数之后，
    // 同一套脚本可以对着**生产包**跑，性能读数才有可比性。
    const q = new URLSearchParams(location.search);
    const capture = q.has("capture");
    // `?aa=0` 关掉 MSAA，用来量 MSAA 这一档到底值多少帧（性能归因用）。
    const aa = q.get("aa") !== "0";

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: aa,
      powerPreference: "high-performance",
      stencil: false,
      preserveDrawingBuffer: capture,
    });
    this.pixelRatioCap = Math.min(window.devicePixelRatio || 1, 2);
    this.setPixelRatio(this.pixelRatioCap);
    this.renderer.setSize(canvas.clientWidth || 1920, canvas.clientHeight || 1080, false);
    this.lastW = canvas.clientWidth || 1920;
    this.lastH = canvas.clientHeight || 1080;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    // three 0.185 起 PCFSoftShadowMap 已废弃（会静默降级并打警告）：柔和度靠 mapSize 与 normalBias 调。
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;

    this.materials = createMaterials(this.renderer);
    this.overlay = new SelectionOverlay(this.materials);

    this.rig = new CameraRig(
      canvas,
      (canvas.clientWidth || 1920) / (canvas.clientHeight || 1080),
      CAMERA.fov,
      CAMERA.near,
      CAMERA.far,
    );

    this.currentPreset = presetOf(this.timeId);

    this.buildLights();
    this.buildWorld();
    this.applyTime(this.timeId, true);

    this.scene.add(this.overlay.group);

    // 相机初始机位：整个园区（与 UI 的"全景"预设共用同一组数字）
    this.rig.goTo(OVERVIEW_PRESET, 999);
    this.rig.controls.maxDistance = 2600;

    this.refreshInteractive();
    this.attachEvents();
    this.applyTelemetryNow(0);
  }

  /* ================================================================ *
   * 搭建
   * ================================================================ */

  /**
   * 灯光：**只有 3 盏**（key 带阴影 + fill + hemi）。
   *
   * 原本是 4 盏平行光 + 1 盏半球光。实测（M1 / 1080p / 全景机位）每多一盏平行光
   * 就要多付一趟逐像素 GGX + 阴影采样，地形铺满全屏时 5 盏灯合计约 1.3 ms/帧 ——
   * 而 rim / bounce 两盏的贡献其实可以折进 hemi 与 fill（见 `applyTime`），
   * 亮度与色调几乎不变。这是本项目性价比最高的一次瘦身。
   */
  private buildLights() {
    this.hemi = new THREE.HemisphereLight(0xcfe2f5, 0x6f7d52, 1.06);
    this.scene.add(this.hemi);

    this.keyLight = new THREE.DirectionalLight(0xfff4e2, 2.35);
    this.keyLight.castShadow = true;
    // 3072² 是在"阴影够细"和"阴影 pass 的填充成本"之间试出来的：4096² 要多花
    // ~1 ms/帧，1024² 的锯齿在白色幕墙上肉眼可见。
    this.keyLight.shadow.mapSize.set(3072, 3072);
    this.keyLight.shadow.camera.near = 40;
    this.keyLight.shadow.camera.far = 2200;
    this.keyLight.shadow.normalBias = 0.22;
    this.keyLight.shadow.bias = -0.0006;
    // r = 380 / target.x = 40 是**量出来的**，不要"顺手扩大"。
    //
    // 底板收窄之后，内容东侧的铁塔（x=450）与水池（x=449）落在了阴影正交框之外，
    // 看着像疏漏，于是试着把框扩到 r=395、中心移到内容中心 (69, 40)。结果：
    // 三座格构铁塔被卷进阴影 pass，自适应分辨率从 **DPR 1.00 掉到 0.70**
    // （A/B 实测：宽框+铁塔投影 ON → 0.70；宽框+铁塔 castShadow OFF → 1.00；
    //  窄框 → 1.00）。而铁塔即使投了影，草皮上**几乎看不到影子** —— 纯细杆件，
    // 阴影贴图里 rasterize 一遍很贵，可见收益接近零。**代价有、收益无，所以维持原值。**
    const r = 380;
    const cam = this.keyLight.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.updateProjectionMatrix();
    this.keyLight.target.position.set(40, PLATFORM_Y, -20);
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    this.fillLight = new THREE.DirectionalLight(0xbcd6ee, 0.70);
    this.fillLight.position.set(420, 260, -520);
    this.scene.add(this.fillLight);
  }

  private buildWorld() {
    this.terrain = buildTerrain(this.materials);
    this.scene.add(this.terrain.mesh);

    const water = buildWater(this.materials);
    this.scene.add(water.group);
    this.registry.add({
      id: "zone.water",
      kind: "water",
      label: "生态水体",
      subtitle: "雨水调蓄 · 场区生态修复",
      parentId: "station",
      childIds: [],
      group: water.group,
      meshes: [water.surface, water.bank],
      box: measure(water.group),
      pickable: true,
      revealShell: false,
      drillable: false,
    });
    water.group.traverse((o) => {
      o.userData.nodeId = "zone.water";
    });

    this.roads = buildRoads(this.materials, this.terrain);
    const roadGroup = new THREE.Group();
    roadGroup.name = "roads";
    this.roads.meshes.forEach((m) => roadGroup.add(m));
    this.scene.add(roadGroup);
    this.registry.add({
      id: "zone.roads",
      kind: "road",
      label: "运维道路网",
      subtitle: "对外主干道 · 园区环路 · 光伏区检修通道",
      parentId: "station",
      childIds: [],
      group: roadGroup,
      meshes: this.roads.meshes,
      box: new THREE.Box3(
        new THREE.Vector3(EDGE.x0, PLATFORM_Y, EDGE.z0),
        new THREE.Vector3(EDGE.x1, PLATFORM_Y + 0.5, EDGE.z1),
      ),
      pickable: true,
      revealShell: false,
      drillable: false,
    });
    roadGroup.traverse((o) => {
      o.userData.nodeId = "zone.roads";
    });

    this.pv = buildPvFarm(this.materials, this.registry);
    this.scene.add(this.pv.group);

    this.inverters = buildInverters(this.materials, this.registry);
    this.scene.add(this.inverters.group);

    this.ess = buildEss(this.materials, this.registry, ESS.cols * ESS.rows);
    this.scene.add(this.ess.group);

    this.substation = buildSubstation(this.materials, this.registry);
    this.scene.add(this.substation.group);

    const civil = buildCivil(this.materials, this.registry);
    this.lampPool = civil.lampPool;
    this.scene.add(civil.group);

    this.vegetation = buildVegetation(this.materials, this.terrain, this.registry);
    this.scene.add(this.vegetation.group);

    this.vehicles = buildVehicles(this.materials, this.registry, this.roads.routes);
    this.scene.add(this.vehicles.group);

    // ---- 能源流 ----
    const pathPlan = planFlowPaths({
      pvBlocks: this.pv.blockAnchors.map((b) => ({ id: b.id, center: b.center, combiner: b.combiner })),
      inverters: this.inverters.anchors,
      ess: this.ess.anchors,
      transformers: this.substation.transformerAnchors,
      gantry: this.substation.gantryBus,
      towerArms: this.substation.towerArms,
      towerCenters: this.substation.towerCenters,
    });
    this.flow = buildEnergyFlow(this.materials, pathPlan);
    this.scene.add(this.flow.group);

    if (import.meta.env.DEV) this.auditOrphans();
  }

  /**
   * 孤儿审计（仅开发期）。
   *
   * 每个节点都持有自己的 Group，但"把 Group 挂进场景"这一步是各 builder 自己做的 ——
   * 漏掉一行不会报错：`registry` 里统计正常、包围盒正常、面板数据正常，
   * 只是屏幕上什么都没有。这个坑在本项目里已经踩过两次（输电铁塔、整个光伏农场）。
   *
   * 判据：从节点 Group 沿 parent 往上走，走不到 `scene` 就是孤儿。
   */
  private auditOrphans() {
    const orphans: string[] = [];
    this.registry.nodes.forEach((node) => {
      if (node.id === "station") return;
      let cursor: THREE.Object3D | null = node.group;
      while (cursor && cursor !== this.scene) cursor = cursor.parent;
      if (cursor !== this.scene) orphans.push(`${node.id}(${node.kind})`);
    });
    if (orphans.length) {
      console.warn(
        `[twin] ${orphans.length} 个节点没挂进场景（它们不会出现在画面里）：\n  ${orphans.join("\n  ")}`,
      );
    }

    // 顺带做一次"设备区里到底有几个可渲染 Mesh"的自检：
    // 顶层 Group 的 children 为 0 基本等于这一整块没接上。
    for (const child of this.scene.children) {
      if (child.type !== "Group") continue;
      if (child.name === "twin-root" || child.name === "selection-overlay") continue;
      if (child.children.length === 0) console.warn(`[twin] 顶层分组 "${child.name}" 没有任何子节点`);
    }
  }

  /* ================================================================ *
   * 一天三时
   * ================================================================ */

  applyTime(id: TimeId, immediate = false) {
    this.timeId = id;
    const preset = presetOf(id);
    this.currentPreset = preset;

    const { environment, sky } = createSkyEnvironment(this.renderer, preset.sky, preset.interior);
    const oldEnv = this.environment;
    const oldSky = this.skyTexture;
    this.scene.environment = environment.texture;
    this.scene.background = sky;
    this.environment = environment;
    this.skyTexture = sky;
    this.scene.environmentIntensity = preset.environmentIntensity;
    if (oldEnv) oldEnv.dispose();
    if (oldSky) oldSky.dispose();

    this.hemi.color.set(preset.rig.hemi.sky);
    this.hemi.groundColor.set(preset.rig.hemi.ground);

    this.keyLight.color.set(preset.rig.key.color);
    this.keyLight.intensity = preset.rig.key.intensity;
    const dir = new THREE.Vector3(...preset.rig.key.position).normalize().multiplyScalar(1200);
    this.keyLight.position.copy(this.keyLight.target.position).add(dir);
    this.keyLight.shadow.camera.updateProjectionMatrix();

    // rim / bounce 的强度折算进 hemi / fill —— 不是丢掉。
    // 折算系数 0.55 / 0.45 是按"白天全景机位的地面平均亮度与色温保持不变"试出来的：
    // rim 是冷调天光（与 hemi 的 sky 色同族），bounce 是地面反弹（hemi 的 ground 色
    // 已经在做同一件事），所以合进半球光是物理上最自然的去处。
    const fold = preset.rig.rim.intensity * 0.55 + preset.rig.bounce.intensity * 0.55;
    this.hemi.intensity = preset.rig.hemi.intensity + fold;
    this.fillLight.color.set(preset.rig.fill.color);
    this.fillLight.intensity = preset.rig.fill.intensity + preset.rig.rim.intensity * 0.45;

    this.renderer.toneMappingExposure = preset.exposure;
    this.materials.setInterior(preset.interior);
    // 路灯地面光池：白天熄灭，黄昏/夜晚随 interior 系数亮起
    if (this.lampPool) {
      this.lampPool.opacity = Math.max(0, Math.min(1, preset.interior * 0.65));
    }
    this.sunFactor = id === "day" ? 1 : id === "dusk" ? 0.34 : 0;
    this.renderer.shadowMap.needsUpdate = true;
    if (immediate) this.renderer.render(this.scene, this.rig.camera);
  }

  /* ================================================================ *
   * 交互
   * ================================================================ */

  private onPointerMove = (event: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    this.pointerPx.x = event.clientX - rect.left;
    this.pointerPx.y = event.clientY - rect.top;
    this.pointer.set((this.pointerPx.x / rect.width) * 2 - 1, -(this.pointerPx.y / rect.height) * 2 + 1);
  };

  private onPointerDown = () => {
    // 记录按下位置，用于区分"点击"和"拖拽旋转"
    this.downAt = { x: this.pointerPx.x, y: this.pointerPx.y, t: performance.now() };
  };

  private onPointerUp = (event: PointerEvent) => {
    if (!this.downAt) return;
    const dx = this.pointerPx.x - this.downAt.x;
    const dy = this.pointerPx.y - this.downAt.y;
    const moved = Math.hypot(dx, dy);
    const dt = performance.now() - this.downAt.t;
    this.downAt = null;
    if (event.button !== 0) return;
    if (moved > 6 || dt > 900) return; // 判定为拖拽 / 长按

    const hit = this.pickNode();
    if (!hit) {
      this.selectNode(null);
      return;
    }
    this.handleClick(hit);
  };

  private downAt: { x: number; y: number; t: number } | null = null;

  private onPointerLeave = () => {
    this.pointer.set(-10, -10);
    this.setHovered(null);
  };

  private attachEvents() {
    const el = this.canvas;
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointerleave", this.onPointerLeave);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /** 沿父链检查可见性：隐藏的层级（储能柜未展开的内部）不参与拾取。 */
  private isVisible(obj: THREE.Object3D) {
    let cursor: THREE.Object3D | null = obj;
    while (cursor) {
      if (!cursor.visible) return false;
      cursor = cursor.parent;
    }
    return true;
  }

  private pickNode(): TwinNode | null {
    this.raycaster.setFromCamera(this.pointer, this.rig.camera);
    const hits = this.raycaster.intersectObject(this.scene, true);
    for (const hit of hits) {
      const id = findNodeId(hit.object);
      if (!id) continue;
      if (!this.interactive.has(id)) continue;
      if (!this.isVisible(hit.object)) continue;
      const node = this.registry.get(id);
      if (node) return node;
    }
    return null;
  }

  /** 电池簇是解析式拾取（没有独立 Mesh），需要额外的射线 / 包围盒判定。 */
  private pickCluster(): { cabinet: string; stack: number; cluster: number } | null {
    if (!this.drill) return null;
    const cabinet = this.ess.cabinets.find((c) => c.id === this.drill!.cabinetId);
    if (!cabinet) return null;
    this.raycaster.setFromCamera(this.pointer, this.rig.camera);
    const result = cabinet.pickCluster(this.raycaster.ray);
    if (!result) return null;
    return { cabinet: cabinet.id, stack: result.stack, cluster: result.cluster };
  }

  private handleClick(node: TwinNode) {
    // 储能柜内部：优先解析式拾取电池簇
    if (this.drill && node.kind === "bmsStack") {
      const cluster = this.pickCluster();
      if (cluster && cluster.cabinet === this.drill.cabinetId) {
        this.selectCluster(cluster.cabinet, cluster.stack, cluster.cluster);
        return;
      }
    }

    if (node.kind === "essCabinet") {
      this.openCabinet(node.id);
      this.selectNode(node.id);
      return;
    }

    if (node.kind === "bmsPack") {
      this.selectPack(node.id);
      return;
    }

    if (node.kind === "bmsStack") {
      const parts = node.id.split(".");
      const stackIndex = Number(parts[3]) - 1;
      this.drill = { cabinetId: parts[0] + "." + parts[1], stack: stackIndex, cluster: null, packId: null };
      const cabinet = this.cabinetOf(parts[0] + "." + parts[1]);
      cabinet?.focusStack(stackIndex);
      cabinet?.setDetail(null);
      this.selectNode(node.id);
      return;
    }

    if ((AUX_KINDS as readonly string[]).includes(node.kind)) {
      this.focusAuxModule(node.id.split(".").slice(0, 2).join("."), node.kind);
      return;
    }

    this.selectNode(node.id);
  }

  /**
   * 选中柜内辅助模块（PCS / EMS / 温控 / 消防 / 通讯）。
   *
   * 之前这里走的是 `drillInto` 的兜底分支 —— 先把整台柜子收回去（`resetDeepState`），
   * 再去选一个**已经不显示**的模块：柜子关上了，选中框套在一个看不见的对象上。
   * 现在改成：柜子保持打开，该模块高亮、其余模块与所有电池堆降透明度。
   */
  private focusAuxModule(cabinetId: string, key: string) {
    const cabinet = this.cabinetOf(cabinetId);
    if (!cabinet) return;
    cabinet.ensureInternals();
    cabinet.showInternals(true);
    cabinet.ghostShell(true);
    cabinet.focusAux(key);
    cabinet.setDetail(null);
    this.drill = { cabinetId, stack: null, cluster: null, packId: null };
    this.refreshInteractive();

    const id = `${cabinetId}.aux.${key}`;
    const node = this.registry.get(id);
    if (node) {
      // 注册时的立方体包围盒是按半径给的，偏大；取景与选中框都用实测值。
      node.box.copy(measure(node.group));
      // 辅助模块在柜**内部**，这一层的取景有个反直觉的约束：**镜头不能靠太近**。
      // 柜体淡出用的是 `opacity 0.15 + depthWrite:false` 的 ghost，近距离时
      // 顶盖/百叶门那几片叠加起来会从"能看穿的玻璃"变成"一面奶白色的墙"，
      // 靠得越近越看不见里面（14 m 时顶盖已经把模块糊掉，29 m 反而看清了机架）。
      // 所以这里只做"轻微聚焦"：保底半径给 6 m，把机位收到柜体尺度再往模块
      // 那一端偏一点 —— 对应需求里"镜头轻微聚焦"，而不是推到零件级。
      this.selectNode(id, { stiffness: 3.2, ...ESS_DRILL_VIEW, minRadius: 6, padding: 1.2 });
    }
  }

  /* ---------------- 选中与镜头 ---------------- */

  selectNode(
    id: string | null,
    opts: {
      focus?: boolean;
      stiffness?: number;
      /** 覆盖取景盒（下钻展开后的实际范围 > 节点自身的 box）。 */
      focusBox?: THREE.Box3;
      minRadius?: number;
      padding?: number;
      azimuth?: number;
      elevation?: number;
    } = {},
  ) {
    if (!id) {
      this.clearSelection();
      return;
    }
    const node = this.registry.get(id);
    if (!node) return;

    if (this.selected && this.selected.id !== id) {
      this.applyHighlight(this.selected, false);
    }
    this.selected = node;
    this.applyHighlight(node, true);
    this.overlay.setSelect(this.shouldRing(node.box) ? node.box : null);
    this.callbacks.onSelect(node);

    if (opts.focus !== false) {
      const box = opts.focusBox ?? node.box;
      this.lastFocusBox.copy(box);
      this.rig.focusBox(box, {
        stiffness: opts.stiffness ?? 3.0,
        padding: opts.padding ?? 1.22,
        minRadius: opts.minRadius,
        azimuth: opts.azimuth,
        elevation: opts.elevation,
      });
    }
  }

  /** 超大分区（道路网、绿化）不适合给脚下光框，那会变成一圈巨大的框线。 */
  private shouldRing(box: THREE.Box3) {
    return box.max.x - box.min.x < 420 && box.max.z - box.min.z < 420;
  }

  private clearSelection() {
    if (this.selected) this.applyHighlight(this.selected, false);
    this.selected = null;
    this.overlay.setSelect(null);
    this.callbacks.onSelect(null);
    this.resetDeepState();
  }

  private applyHighlight(node: TwinNode, on: boolean) {
    if (!node.meshes.length) return;
    for (const mesh of node.meshes) {
      if (!mesh.isMesh) continue;
      const surface = surfaceOf(mesh);
      const target = on ? this.materials.hotOf(surface) ?? this.materials.get(surface) : this.materials.get(surface);
      // 兜底：材质名对不上时不要赋 undefined —— 那会让 WebGLRenderer
      // 在 projectObject 里读 `material.visible` 时抛异常，整个渲染循环直接死掉。
      if (!target) continue;
      if (mesh.material !== target) mesh.material = target;
    }
  }

  private setHovered(node: TwinNode | null) {
    if (this.hovered?.id === node?.id) return;
    this.hovered = node;
    this.overlay.setHover(node ? node.box : null);
    this.canvas.style.cursor = node ? "pointer" : "grab";
    this.callbacks.onHover(node);
  }

  /* ---------------- 储能柜下钻 ---------------- */

  private cabinetOf(id: string) {
    return this.ess.cabinets.find((c) => c.id === id);
  }

  private openCabinet(id: string) {
    const cabinet = this.cabinetOf(id);
    if (!cabinet) return;
    cabinet.ensureInternals();
    cabinet.showInternals(true);
    cabinet.ghostShell(true);
    cabinet.resetFocus();
    cabinet.setDetail(null);
    this.drill = { cabinetId: id, stack: null, cluster: null, packId: null };
    const node = this.registry.get(id);
    if (node) node.box.copy(measure(cabinet.group));
    this.refreshInteractive();
  }

  private selectCluster(cabinetId: string, stack: number, cluster: number) {
    const cabinet = this.cabinetOf(cabinetId);
    if (!cabinet) return;
    cabinet.focusCluster(stack, cluster, true);
    // `explodeCluster` 现在回传整块检修台的包围盒（台板 + 8 个 Pack），
    // 取景按它来 —— 否则镜头只框住抽屉那一小块，摊开来的 8 个 Pack 全在画面外。
    const stage = cabinet.explodeCluster(stack, cluster);
    this.drill = { cabinetId, stack, cluster, packId: null };
    const clusterId = `${cabinetId}.stack.${String(stack + 1).padStart(2, "0")}.cluster.${String(cluster + 1).padStart(2, "0")}`;
    const node = this.registry.get(clusterId);
    if (node) {
      node.box.copy(cabinet.clusterBox(stack, cluster));
      this.selectNode(clusterId, { stiffness: 3.4, focusBox: stage, padding: 1.16, ...ESS_DRILL_VIEW });
    }
    this.refreshInteractive();
  }

  private selectPack(packId: string) {
    const cabinet = this.drill ? this.cabinetOf(this.drill.cabinetId) : null;
    if (!cabinet) return;
    const stage = cabinet.explodePack(packId);
    if (this.drill) this.drill.packId = packId;
    this.selectNode(packId, {
      stiffness: 3.6,
      focusBox: stage ?? undefined,
      padding: 1.12,
      ...ESS_DRILL_VIEW,
    });
    this.refreshInteractive();
  }

  private resetDeepState() {
    if (!this.drill) return;
    const cabinet = this.cabinetOf(this.drill.cabinetId);
    if (cabinet) {
      cabinet.showInternals(false);
      cabinet.ghostShell(false);
      cabinet.resetFocus();
      cabinet.setDetail(null);
    }
    this.drill = null;
    this.refreshInteractive();
  }

  /** 计算当前层级下"可以点"的节点集合。 */
  refreshInteractive() {
    this.interactive.clear();
    const base: TwinNode["kind"][] = [
      "pvBlock",
      "combiner",
      "inverter",
      "essCabinet",
      "transformer",
      "gis",
      "gantry",
      "tower",
      "building",
      "vehicle",
    ];
    const zoneIds = ["zone.yard", "zone.water", "zone.roads"];
    this.registry.nodes.forEach((node) => {
      if (base.includes(node.kind)) this.interactive.add(node.id);
    });
    zoneIds.forEach((id) => this.interactive.add(id));
    if (this.drill) {
      const cabinet = this.cabinetOf(this.drill.cabinetId);
      if (cabinet?.inner) {
        this.registry.nodes.forEach((node) => {
          if (node.id.startsWith(`${this.drill!.cabinetId}.`)) this.interactive.add(node.id);
        });
      }
    }
  }

  /* ================================================================ *
   * 数据
   * ================================================================ */

  private applyTelemetryNow(t: number) {
    applyTelemetry(this.telemetry, t, this.sunFactor);
    this.callbacks.onTelemetry(this.telemetry);
  }

  /* ================================================================ *
   * 渲染循环
   * ================================================================ */

  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = () => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      this.tick();
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private tick() {
    // 自己算 delta：`THREE.Clock` 在 r185 起已标记废弃，用它会在控制台刷警告。
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.elapsed += dt;
    this.frame++;

    // 相机
    const cameraMoved = this.rig.update(dt);
    if (this.rig.isTransitioning !== this.callbacksLocked) {
      this.callbacksLocked = this.rig.isTransitioning;
      this.callbacks.onCameraLock(this.callbacksLocked);
    }

    // 悬停（节流到每 2 帧，射线对 8000 块组件的场景不便宜）
    if (this.frame % 2 === 0 && !this.rig.isTransitioning) {
      this.setHovered(this.pickNode());
    }

    // 植被风摆 + 车辆巡航
    this.vegetation.tick(this.elapsed);
    this.updateVehicles(dt);

    // 能源流（速度与亮度由真实功率驱动）
    const lv = {
      dc: Math.min(1, this.telemetry.total.pvPower / 4200),
      ac: Math.min(1, this.telemetry.total.acPower / 4),
      storage: Math.min(1, Math.abs(this.telemetry.total.essPower) / 12),
      grid: Math.min(1, this.telemetry.grid.activePower / 4),
    };
    this.flow.update(dt, lv);

    // 遥测每 400 ms 更新一次
    if (this.elapsed - this.lastTelemetry > 0.4) {
      this.lastTelemetry = this.elapsed;
      this.applyTelemetryNow(this.elapsed);
    }

    // 选中呼吸
    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 2.4);
    this.overlay.update(this.elapsed, pulse);
    this.materials.setHotPulse(pulse);
    this.materials.tick(this.elapsed);

    // 阴影节流：只有车辆在动，30 Hz 足够，且每 3 帧一次
    if (this.frame % 3 === 0) this.renderer.shadowMap.needsUpdate = true;

    this.renderer.render(this.scene, this.rig.camera);

    this.sampleStats(cameraMoved);
  }

  private callbacksLocked = false;

  private updateVehicles(dt: number) {
    for (const v of this.vehicles.vehicles) {
      const route = this.roads.routes.find((r) => r.id === v.routeId);
      if (!route) continue;
      const total = pathLength(route.points);
      v.t += (v.speed * dt) / total;
      if (route.loop) {
        if (v.t > 1) v.t -= 1;
      } else if (v.t > 1) {
        v.t = 0;
      }
      const pos = samplePath(route.points, v.t, route.loop);
      const ahead = samplePath(route.points, Math.min(1, v.t + 0.004), route.loop);
      v.group.position.copy(pos);
      const dx = ahead.x - pos.x;
      const dz = ahead.z - pos.z;
      if (Math.abs(dx) + Math.abs(dz) > 1e-4) v.group.rotation.y = Math.atan2(dx, dz) - Math.PI / 2;
      const node = this.registry.get(v.id);
      if (node) node.box.setFromCenterAndSize(pos.clone().setY(pos.y + 1), new THREE.Vector3(6, 3, 4));
    }
  }

  /**
   * 自适应分辨率 —— **双向、变步长**，但加了“冷却 + 不对称阈值 + 升档小步”三道闸，
   * 杜绝整屏“呼吸”闪屏。
   *
   * 早期版本在 Retina 等高分屏（DPR 直接顶到 2.0）上会这样死循环：
   *   2.0 太重 → fps 掉到 54 → 降到 1.8 → fps 弹回 60 → 升回 2.0 → fps 又掉到 54 …
   * 每次升降都重建 drawing buffer，于是整屏以 ~0.4 Hz 的频率“闪”。修复思路：
   *   1. **升档只走 0.1 的小步**，且要 fps ≥ 59 才肯升 —— 这样从 1.8 升到 1.9 后
   *      fps 通常落在 58 左右，既不够触发再升、也不够触发下降，自然“刹停”在中间档，
   *      而不是一路顶回 2.0 再掉下来。
   *   2. **升降阈值拉开 7 fps**（降 <52、升 >59），中间留一条“够用带”不动作。
   *   3. **每次变动后冷却 4~5s（按采样计）**，即便边界情况也不会几秒内来回横跳。
   *
   * 仍保留的两条初衷：下降按缺口比例给步长（重载机位 1 秒落位），升档小步试探
   * （vsync 封顶后余量读不出，只能顶到墙再退）。
   */
  private adaptResolution() {
    const TARGET = 60;
    // 变动后冷却：期间不采样、不投票，避免刚降完又升、刚升完又降的来回横跳。
    if (this.resCooldown > 0) {
      this.resCooldown--;
      this.downVotes = 0;
      this.upVotes = 0;
      return;
    }
    if (this.fps < TARGET - 8) {
      // 明显扛不住：快速降档（按缺口比例给步长）
      this.upVotes = 0;
      this.downVotes++;
      if (this.downVotes >= 2 && this.pixelRatio > MIN_PIXEL_RATIO) {
        const step = THREE.MathUtils.clamp((1 - this.fps / TARGET) * 0.5, 0.12, 0.35);
        this.setPixelRatio(Math.max(MIN_PIXEL_RATIO, this.pixelRatio - step));
        this.downVotes = 0;
        this.resCooldown = 8; // ~4s
      }
    } else if (this.fps > TARGET - 1) {
      // 非常宽裕才小步试探着升（步长 0.1，确保升一档后就“刹停”而非顶回上限）
      this.downVotes = 0;
      this.upVotes++;
      if (this.upVotes >= 4 && this.pixelRatio < this.pixelRatioCap) {
        this.setPixelRatio(Math.min(this.pixelRatioCap, this.pixelRatio + 0.1));
        this.upVotes = 0;
        this.resCooldown = 5; // ~2.5s
      }
    } else {
      // 52–59 的“够用带”：保持不动，别把已经稳的画面搅乱。
      this.downVotes = 0;
      this.upVotes = 0;
    }
  }

  private sampleStats(cameraMoved: boolean) {
    this.framesSinceSample++;
    const now = performance.now();
    if (now - this.lastFpsSample >= 500) {
      this.fps = (this.framesSinceSample * 1000) / (now - this.lastFpsSample);
      this.framesSinceSample = 0;
      this.lastFpsSample = now;

      this.adaptResolution();

      this.callbacks.onStats({
        fps: Math.round(this.fps),
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        programs: this.renderer.info.programs?.length ?? 0,
        pixelRatio: this.pixelRatio,
      });
    }
    void cameraMoved;
  }

  private setPixelRatio(value: number) {
    this.pixelRatio = value;
    this.renderer.setPixelRatio(value);
  }

  /* ================================================================ *
   * 对外命令
   * ================================================================ */

  setView(preset: ViewPreset) {
    this.rig.goTo(preset, 2.6);
  }

  flyToNode(id: string, stiffness = 3.0) {
    const node = this.registry.get(id);
    if (!node) return;
    this.rig.focusBox(node.box, { stiffness, padding: 1.24 });
  }

  resetView() {
    this.rig.goTo(OVERVIEW_PRESET, 2.6);
  }

  /**
   * 统一的下钻入口。数据面板列出的下级单元、面包屑、双击都走这里。
   *
   * 储能柜内部的 Stack / Cluster / Pack 是**懒加载**的：往下钻时必须把中间层级
   * 一并展开（开柜 → 展开簇 → 弹出 Pack），否则会去选中一个还不存在的对象。
   */
  drillInto(id: string) {
    const node = this.registry.get(id);
    if (!node) return;

    if (node.kind === "essCabinet") {
      this.openCabinet(id);
      this.selectNode(id, { stiffness: 3.2 });
      return;
    }

    if (node.kind === "bmsStack" || node.kind === "bmsCluster" || node.kind === "bmsPack") {
      this.drillIntoCell(id);
      return;
    }

    // 柜内辅助模块：不能走下面的"换分区"兜底 —— 那会把柜子收回去，
    // 然后选中一个已经看不见的模块。
    if ((AUX_KINDS as readonly string[]).includes(node.kind)) {
      this.focusAuxModule(id.split(".").slice(0, 2).join("."), node.kind);
      return;
    }

    // 换到别的分区：先把之前展开的储能柜收回去，避免内部结构留在画面里。
    this.resetDeepState();
    this.selectNode(id, { stiffness: 3.2 });
  }

  private drillIntoCell(id: string) {
    const parts = id.split(".");
    const cabinetId = `${parts[0]}.${parts[1]}`;
    const cabinet = this.cabinetOf(cabinetId);
    if (!cabinet) return;

    const pad = (n: number) => String(n).padStart(2, "0");
    const stackIndex = Number(parts[3]) - 1;
    const clusterIndex = parts[4] === "cluster" ? Number(parts[5]) - 1 : null;
    const packIndex = parts[6] === "pack" ? Number(parts[7]) - 1 : null;

    this.openCabinet(cabinetId);

    if (clusterIndex === null) {
      cabinet.focusStack(stackIndex);
      cabinet.setDetail(null);
      this.drill = { cabinetId, stack: stackIndex, cluster: null, packId: null };
      this.refreshInteractive();
      this.selectNode(id, { stiffness: 3.4 });
      return;
    }

    this.selectCluster(cabinetId, stackIndex, clusterIndex);
    if (packIndex === null) return;

    this.selectPack(`${cabinetId}.stack.${pad(stackIndex + 1)}.cluster.${pad(clusterIndex + 1)}.pack.${pad(packIndex + 1)}`);
  }

  /** 展开/收起当前展开的储能柜。 */
  closeCabinet() {
    this.resetDeepState();
  }

  setFlowVisible(on: boolean) {
    this.flow.group.visible = on;
  }

  setSceneNodeVisible(kind: string, on: boolean) {
    this.scene.traverse((o) => {
      if (o.userData.nodeId === kind) o.visible = on;
    });
  }

  get currentTime() {
    return this.timeId;
  }

  get preset() {
    return this.currentPreset;
  }

  resize(width: number, height: number) {
    // 尺寸没变就别重建 drawing buffer（重建会闪一下），交给调用方的 rAF 合并即可。
    if (width === this.lastW && height === this.lastH) return;
    this.lastW = width;
    this.lastH = height;
    this.renderer.setSize(width, height, false);
    this.rig.setAspect(width / Math.max(1, height));
    this.renderer.shadowMap.needsUpdate = true;
  }

  /** 供 UI 查询当前选中的储能柜状态。 */
  get drillState() {
    return this.drill;
  }

  get essCabinets() {
    return this.ess.cabinets;
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  dispose() {
    this.stop();
    this.disposed = true;
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.rig.dispose();
    this.materials.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    this.renderer.dispose();
  }
}

function findNodeId(object: THREE.Object3D): string | null {
  let cursor: THREE.Object3D | null = object;
  while (cursor) {
    if (cursor.userData?.nodeId) return cursor.userData.nodeId as string;
    cursor = cursor.parent;
  }
  return null;
}

function pathLength(points: THREE.Vector3[]) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += points[i].distanceTo(points[i - 1]);
  return Math.max(1, total);
}

const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();

function samplePath(points: THREE.Vector3[], t: number, loop: boolean) {
  const count = points.length;
  const f = Math.max(0, Math.min(0.9999, t)) * (count - 1);
  const i = Math.floor(f);
  const k = f - i;
  const a = points[i];
  const b = points[Math.min(count - 1, i + 1)];
  _pa.copy(a);
  _pb.copy(b);
  void loop;
  return new THREE.Vector3(
    _pa.x + (_pb.x - _pa.x) * k,
    _pa.y + (_pb.y - _pa.y) * k,
    _pa.z + (_pb.z - _pa.z) * k,
  );
}

void THEME;
