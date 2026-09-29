# 洞穴测绘草图编目台（gbcavesurvey）

面向洞穴测绘小组测量记录员的本地化编目台：把「洞段 → 测点方位/倾角/距离读数 → 草图 → 图幅拼合」串成一条可回溯的链路，解决手写记录散落、闭合导线误差看不出来、多张草图拼接对不上桩号的问题。**纯前端单页应用**，全部数据保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21814>

常用命令：

```bash
docker compose ps          # 查看容器状态
docker compose logs -f     # 查看日志
docker compose down        # 停止并移除容器（数据在浏览器本地，不受影响）
```

端口与项目名可在 `.env` 中调整：

```
COMPOSE_PROJECT_NAME=gbcavesurvey
FRONTEND_PORT=21814
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（Composition API） |
| 语言 | TypeScript（`vue-tsc` 类型检查零错误） |
| UI 组件库 | Element Plus |
| 状态管理 | Zustand（`zustand/vanilla` createStore + Vue 响应式桥接） |
| 路由 | Vue Router 4（History 模式，nginx `try_files` 回落） |
| 构建 | Vite 6 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |

## 三、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21814
npm run build      # 类型检查 + 生产构建
```

> 本地开发无需任何后端服务或环境变量。

## 四、目录结构

```
sologsb-1114/
├── docker-compose.yml          # 顶层 name: gbcavesurvey，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # cave.ts / segment.ts / station.ts / sketch.ts / batch.ts / index.ts
│       ├── stores/             # caveStore / segmentStore / stationStore / sketchStore / batchStore（Zustand）
│       ├── components/common/  # SegmentTag / BearingInput / ClosureBadge / GridCanvas
│       ├── hooks/              # usePersistentStore（Dexie + 版本迁移）/ useClosureCheck
│       ├── pages/              # CavesPage / SegmentsPage / StationsPage / SketchPage / MergePage
│       ├── router/index.ts
│       └── utils/              # survey.ts / export.ts / id.ts
└── frontend/scripts/batch-smoke.mts   # 批次状态机 + v2→v3 迁移冒烟测试（fake-indexeddb）
```

冒烟测试（Node 环境，无需浏览器）：

```bash
cd frontend
npm install
npx esbuild scripts/batch-smoke.mts --bundle --platform=node --format=esm \
  --outfile=scripts/batch-smoke.mjs --log-level=warning
node scripts/batch-smoke.mjs   # 输出「全部批次/迁移断言通过 ✔」
```

## 五、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| Cave 洞穴 | 归属根节点：洞名、行政区、经纬度、海拔、发育层位、已知总长、负责人等 | `caves` |
| Segment 洞段 | 起止桩号、类型（竖井/廊道/厅堂/裂隙/水道）、平均宽高、是否闭合、当前参与拼合的批次 | `segments` |
| SurveyBatch 测量批次 | 一次洞段测量连同读数的复核单元：草稿 / 待复核 / 已通过 / 已打回，提交即冻结 | `surveyBatches` |
| Station 测点 | 挂在批次下；方位角、倾角、斜距 → 自动推算水平距/垂距，累计闭合差 | `stations` |
| Sketch 草图 | 挂在已通过批次下；格数、比例、绘制人、拼合顺序号、桩号对齐锚点 | `sketches` |

- 数据库名 `gbcavesurvey`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会把旧版测点记录由「斜距 + 倾角」补齐 `horizontalDistance` / `verticalDistance`；
- `version(3)` 引入测量批次：升级时旧版测点/草图按洞段归并到一个编号 **B-OLD**、状态为「已通过」的**旧批**（`legacy = true`，复核人记为「系统升级」），原洞段自动选中该旧批，升级后历史数据仍可追溯、可继续画草图与拼合；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷，清除浏览器数据即清空。

### 5.1 测量批次复核流转

```
新开草稿(draft) ──提交复核──▶ 待复核(reviewing) ──复核通过──▶ 已通过(approved) ──▶ 草图工作台可选用 / 可指定参与图幅拼合
                                   │
                                   └──打回(必填原因)──▶ 已打回(rejected，原批保留)
                                                             │
                                             从本批重开草稿（读数复制、原因带入）┘
```

- 一个洞段同时只能有一份草稿；提交后整批读数冻结，测点的新增/编辑/删除在 store 层与界面层双重拦截；
- 只有**已通过**批次能在草图工作台选用，草图记录同样按批次归属；
- 同一洞段只能指定**一个**已通过批次参与图幅拼合（`segments.activeBatchId`）；切换批次时该洞段原有图幅的拖动偏移/吸附状态在拼合页清空，新批草图的拼合顺序重新编号并接续其他洞段，新旧拼合记录不会混在一起；
- 重新打开页面后批次按「草稿 / 待复核 / 已通过 / 已打回」四种状态徽标区分，旧批额外带「旧批」标记。

## 六、主要页面

| 路由 | 功能 |
| --- | --- |
| `/caves` | 洞穴清单：卡片展示实测/已知总长、洞段数、最近测量日期，支持新建、编辑、归档、删除（删除前校验下级洞段数） |
| `/segments` | 洞段编目表：按桩号区间/类型/洞穴筛选，批量调整洞段类型与闭合标记，自动累计总长 |
| `/stations` | 测点读数与测量批次：按洞段开草稿批次，方位角/倾角专用输入（度分秒 ⇄ 十进制度），自动推算水平距垂距，实时闭合差徽标，异常读数整行高亮；提交复核冻结、复核通过/打回、打回后从原批重开草稿并带入原因 |
| `/sketch` | 草图工作台：只能选用已通过批次，在坐标纸网格上按该批冻结读数绘制测点折线、标注桩号与倾角箭头，支持草图基准方位旋转与草图记录管理 |
| `/merge` | 图幅拼合视图：每个洞段指定唯一已通过批次参与拼合，拖动图幅按相邻边缘吸附、按桩号锚点一键对齐，输出带来源批次的拼合顺序表并支持 CSV 导出 |

## 七、计算约定

- 水平距 = 斜距 × cos(倾角)，垂距 = 斜距 × sin(倾角)；
- 闭合差 f = √(ΣΔE² + ΣΔN²)，默认阈值 0.25 m，超限时徽标变红并可展开计算过程；
- 方位角范围 0°–360°，倾角范围 -90°–90°，越界读数会被标记为异常。
