# sologsb-1123 无人机航拍航线与成果编目台（gbdronemap）

面向航拍作业与测绘内业人员：先按测区规划航线与航点（重叠率、相对航高、地面分辨率），再对飞行产出的成果影像逐张编目（片号、GSD、重叠度、质量）。范围只覆盖**航线规划**与**成果影像编目**本身。纯前端单页应用，数据全部保存在浏览器本地。

## 航线批次（多标签页协作的核心）

为解决「多个标签页同时编辑同一次航拍，参数一改航点 / 成果就用错旧数」的问题，每个任务的数据按**航线批次**组织：

- **参数改动进新批次**：测区、航高、重叠率、相机参数改动后，预计张数等指标立即按新参数失效重算；点击「保存为新批次」后，改动进入新批次（自动记录变更说明，如「航高 120→150 m」），原批次航点**冻结**在旧批次不再改动。
- **成果跟着拍摄时批次**：每条成果影像带拍摄时的批次 id；切批次后，地图、航点表、成果编目三处通过同一个批次切换器展示**同一组批次数据**（localStorage 持久化、跨标签页同步）。
- **旧数据回填**：v2 及更早的无批次数据在 v3 升级时自动回填为「批次 1（初始批次）」，航点、成果、缩略图全部挂入该批次。
- **保存失败不写一半**：所有跨表写入（参数+航点、成果+缩略图、任务相机+批次）都在单个 Dexie 事务内完成；失败时改动/成果以**失败草稿**落盘（独立事务），可在页面顶部或顶栏「失败草稿」入口恢复并重试。
- **过期标签页冲突**：批次带乐观锁修订号（revision）。后提交的过期标签页不覆盖先提交内容，而是保留为**冲突稿**：
  - 参数冲突稿 → 重试时把改动**追加为最新批次**（两版数据并存，先提交内容原样保留）；
  - 成果冲突稿 → 重试时**按片号合并**，已存在片号保留先提交内容，仅新增缺失片号。
- **跨标签页感知**：提交后通过 localStorage 事件通知其它标签页重新从 IndexedDB 拉取；即使漏收通知，乐观锁也会兜底把过期提交转为冲突稿。

> 故障演练（验证失败草稿）：浏览器控制台执行 `localStorage.setItem('gbdronemap:fault','params')` 或 `'assets'`，下一次对应保存会在写入前失败（一次性消费）。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21823**

停止服务：

```bash
docker compose down
```

## 本地开发与测试

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite build
npm test         # vitest 单元 + IndexedDB 集成 + 页面冒烟测试（fake-indexeddb / happy-dom）
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | Ant Design 5 |
| 构建 | Vite 5 |
| 测试 | Vitest + fake-indexeddb + happy-dom |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 地图 | 高德地图 JS API 2.0（可选，key 缺失时自动退化） |
| 本地存储 | IndexedDB（Dexie 4），缩略图单独建表，含结构版本号与升级迁移 |

## VITE_AMAP_KEY 配置与退化行为（重要）

- key 从环境变量 `VITE_AMAP_KEY` 读取（`.env` / `.env.example` 中已留空）。
- **未配置 key（默认）**：`<AmapRouteView>` 自动渲染**本地 SVG 网格视图**——按经纬度等比投影，仍可绘制测区边界、航点折线、每个航点的视场矩形，并支持**点击网格新增航点**。此模式下页面**不发起任何外部网络请求**。
- **配置了 key**：动态加载 `https://webapi.amap.com/maps?v=2.0&key=...`，用高德地图绘制多边形 / 折线 / 航点 / 视场矩形。
- **构建与运行都不依赖该 key**：`vite.config.ts` 与 Dockerfile 均不校验 key；即使填了 key 但脚本加载失败或 8 s 超时，也会自动退化为 SVG 网格视图，页面顶部用 `Alert` 标明当前模式。冻结批次用批次相机快照绘制视场，切批次后图形与表格为同一组数据。

## 目录结构

```
sologsb-1123/
├── docker-compose.yml
├── .env.example           # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    ├── vitest.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── index.css
        ├── vite-env.d.ts
        ├── router/index.tsx
        ├── types/{mission,batch,waypoint,imageasset}.ts
        ├── stores/{mission,batch,waypoint,asset}Store.ts
        ├── components/common/{AmapRouteView,OverlapCalcPanel,BatchControls,AssetGrid,MissionCard}.tsx
        ├── hooks/{useMissionFilter,useRouteMetrics,useSelectedBatch}.ts
        ├── pages/{MissionList,RoutePlanner,WaypointTable,AssetCatalog,CameraPreset}.tsx
        ├── utils/{db,batch,geoCalc,tick,faults,amapLoader,id}.ts
        └── test/{batch,batchStore,migration,render}.test.{ts,tsx}
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/missions` | 任务台账：按测区/机型/飞行日期区间/状态筛选，显示批次数、当前批次预计张数与成果条目数 | Mission、RouteBatch |
| `/missions/:id/route` | 航线规划主视图：批次切换器，地图/网格绘制当前批次测区与航点；参数面板改航高/航速/重叠率时预计张数立即失效重算，保存为新批次，旧批次只读冻结 | Mission、RouteBatch、Waypoint、PendingDraft |
| `/missions/:id/waypoints` | 航点明细：按批次查看；粘贴导入、批量改高度、上下移与拖拽换序仅对当前批次开放，冻结批次只读 | Waypoint、RouteBatch |
| `/missions/:id/assets` | 成果影像编目：按**拍摄时批次**列出片号/缩略图/GSD/质量，提交带乐观锁；多选标记质量、定位到图、按片号合并冲突稿、导出清单 | ImageAsset、RouteBatch、PendingDraft |
| `/settings/camera` | 相机与传感器参数预设管理，带入任务后任务相机字段更新并立即开新航线批次（旧批次冻结） | CameraPreset、Mission、RouteBatch |

`/` 重定向到 `/missions`，未匹配路由同样兜底到 `/missions`。

## 关键算法

- **地面分辨率**：`GSD(cm/px) = 像元尺寸(μm) × 航高(m) / (焦距(mm) × 10)`
- **地面幅宽**：`幅宽(m) = 传感器尺寸(mm) × 航高(m) / 焦距(mm)`
- **航线间距** = 旁向幅宽 × (1 − 旁向重叠率)；**拍照间隔** = 航向幅宽 × (1 − 航向重叠率)
- **预计张数** = Σ(每条航带长度 / 拍照间隔 + 1)；**预计耗时** = (总航程 / 航速 + 转弯与悬停附加) / 60；**电池组数** 按 20 min 有效续航向上取整
- 以上指标在保存批次时冻结到 `RouteBatch.metrics`；编辑当前批次航点后立即重算并重新冻结，参数改动则随新批次冻结。
- **测区面积**：经纬度投影到米制后用鞋带公式；**航带路径长度**：逐段球面近似距离累加
- **成果按片号合并**：片号集合取并集，已存在片号保留先提交内容（字段不覆盖），新片号入库。

## 数据存储说明

- 数据库名 `gbdronemap`，当前结构版本 **v3**（`localStorage['gbdronemap:db-version']` 记录）。
- 七张表：`missions`（任务）、`batches`（航线批次，含冻结参数快照、相机快照、指标、`active` 与乐观锁 `revision`）、`waypoints`（航点，带 `batchId`）、`assets`（成果影像条目，带拍摄时 `batchId`）、`thumbs`（**缩略图单独建表**，dataUrl，带 `batchId`）、`drafts`（保存失败 / 过期冲突的挂起稿）、`presets`（相机预设）。
- v2 → v3 迁移：为每个任务回填**初始批次（批次 1）**，全部旧航点 / 成果 / 缩略图挂入该批次，批次指标按旧数据重算；旧 `lines` 表删除（其职责由批次承担）。
- v1 → v2 迁移：为老任务补 `areaPolygon`/传感器默认值，为航线补 `updatedAt`/`batteryCount`，并新增索引。
- 当前批次选择记录在 `localStorage['gbdronemap:selected-batch']`（按任务 id），跨标签页通过 `storage` 事件同步；批次数据变更戳记为 `gbdronemap:tick`。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范任务、3 个批次（任务 A 批次 1 已冻结含 4 航点 6 成果、批次 2 为当前批次含 3 航点）、8 个航点、6 条成果影像条目（含缩略图）与 3 套相机预设。
