# 洞穴测绘草图编目台（gbcavesurvey）

面向洞穴测绘小组测量记录员的本地化编目台：把「洞段 → 测量批次（测点方位/倾角/距离读数）→ 复核 → 草图 → 图幅拼合」串成一条可回溯的链路，解决手写记录散落、版本说不清谁认过、闭合导线误差看不出来、多张草图拼接对不上桩号的问题。**纯前端单页应用**，全部数据保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

## 〇、测量批次工作流（核心）

一次洞段测量连同它的测点读数收成一个**批次**，批次有四种状态，重开页面后依然分得清：

| 状态 | 含义 | 读数能否改 |
| --- | --- | --- |
| 草稿 | 测量记录员正在录入 | 可增删改 |
| 待复核 | 已提交复核，**整批冻结** | 只读 |
| 已通过 | 复核员通过；草图工作台**只认这一类批次** | 只读（留痕） |
| 已打回 | 复核员打回；**原批保留**，可从它新开草稿 | 只读；可「新开草稿（带原因）」 |

流转规则：

1. 同一洞段同一时间只允许一份「草稿/待复核」批次；在「测点读数」页新建批次后录入读数，提交复核即冻结；
2. 「复核台」对待复核批次做通过/打回：打回**必须填原因**，原批保留为已打回，原因写进批次事件流；
3. 从已打回批次「新开草稿」：读数整体复制到新草稿（新 id，与原批互不影响），打回原因自动带到新批备注，形成 `B1 → B2 → …` 可追溯链；
4. **只有已通过批次**才会出现在草图工作台的批次选择里；
5. 图幅拼合按洞段选批：同一洞段只能选一个已通过批次参与拼合（「拼合中」）；每个批次的偏移/吸附/顺序**各自存档**，换批次时旧批记录原样保留、新批载入自己的记录，两套排列不会混在一起；
6. 升级前的历史测点/草图在 v3 迁移时按洞段自动归集为一个「已通过·旧批」（编号 `…-BL1`），并默认选为该洞段的拼合批次，旧拼合顺序迁入该批的拼合记录。


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
│       ├── types/              # cave / segment / station / sketch / batch / index
│       ├── stores/             # caveStore / segmentStore / stationStore / sketchStore / batchStore / mergeStore（Zustand）
│       ├── components/common/  # SegmentTag / BearingInput / ClosureBadge / GridCanvas / BatchStatusTag
│       ├── hooks/              # usePersistentStore / useClosureCheck
│       ├── pages/              # CavesPage / SegmentsPage / StationsPage / ReviewPage / SketchPage / MergePage
│       ├── router/index.ts
│       └── utils/              # survey / export / id
```

## 五、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| Cave 洞穴 | 归属根节点：洞名、行政区、经纬度、海拔、发育层位、已知总长、负责人等 | `caves` |
| Segment 洞段 | 起止桩号、类型（竖井/廊道/厅堂/裂隙/水道）、平均宽高、是否闭合、`activeBatchId` 当前拼合批次 | `segments` |
| SurveyBatch 测量批次 | 洞段一次测量的批次：状态（草稿/待复核/已通过/已打回）、建批人、复核员、打回原因、流转事件流 | `batches` |
| Station 测点 | 方位角、倾角、斜距 → 自动推算水平距/垂距，累计闭合差；归属到批次 | `stations` |
| Sketch 草图 | 格数、比例、绘制人、拼合顺序号、桩号对齐锚点；归属到已通过批次 | `sketches` |
| MergeRecord 拼合记录 | 以批次为主键存档图幅偏移/吸附/顺序，换批互不串扰 | `merges` |

- 数据库名 `gbcavesurvey`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会把旧版测点记录由「斜距 + 倾角」补齐 `horizontalDistance` / `verticalDistance`；
- `version(3)` 升级迁移把历史测点/草图按洞段各归入一个「已通过·旧批」（`legacy: true`，编号形如 `C-01-BL1`）：补 `batchId`、把旧批选为洞段 `activeBatchId`、把旧拼合顺序写入该批的 `MergeRecord`；空洞段不建旧批；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷，清除浏览器数据即清空。

## 六、主要页面

| 路由 | 功能 |
| --- | --- |
| `/caves` | 洞穴清单：卡片展示实测/已知总长、洞段数、最近测量日期，支持新建、编辑、归档、删除（删除前校验下级洞段数） |
| `/segments` | 洞段编目表：按桩号区间/类型/洞穴筛选，批量调整洞段类型与闭合标记，自动累计总长 |
| `/stations` | 测点读数录入：以批次组织，支持新开批次、提交复核（冻结）、作废草稿、从打回批新开草稿（带原因）；冻结批读数只读 |
| `/review` | 复核台：待复核批次置顶，查看整批读数与闭合差，复核通过或打回（必填原因），事件时间线全程留痕 |
| `/sketch` | 草图工作台：仅可选择复核通过批次，在坐标纸网格上绘制该批测点折线、标注桩号与倾角箭头，管理草图记录 |
| `/merge` | 图幅拼合视图：每洞段选一个已通过批次参与拼合，拖动吸附/锚点对齐，拼合记录按批次存档，导出拼合顺序表 CSV |

## 七、计算约定

- 水平距 = 斜距 × cos(倾角)，垂距 = 斜距 × sin(倾角)；
- 闭合差 f = √(ΣΔE² + ΣΔN²)，默认阈值 0.25 m，超限时徽标变红并可展开计算过程；
- 方位角范围 0°–360°，倾角范围 -90°–90°，越界读数会被标记为异常。
