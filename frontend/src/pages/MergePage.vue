<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { MergeItem, Sketch, SurveyBatch } from '@/types'
import GridCanvas from '@/components/common/GridCanvas.vue'
import SegmentTag from '@/components/common/SegmentTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { caveStore } from '@/stores/caveStore'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { sketchStore } from '@/stores/sketchStore'
import { batchStore, BatchFlowError } from '@/stores/batchStore'
import { mergeStore } from '@/stores/mergeStore'
import { downloadCsv } from '@/utils/export'
import { stakeToNumber } from '@/utils/survey'

const CANVAS_W = 780
const CANVAS_H = 300
const SNAP_PX = 12
const PX_PER_METER = 1.6

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)
const sketchState = useStore(sketchStore)
const batchState = useStore(batchStore)
const mergeState = useStore(mergeStore)

const selectedCaveId = ref<string>(caveState.caves[0]?.id ?? '')
const draggingId = ref<string | null>(null)
const dragStartX = ref(0)
const dragOriginOffset = ref(0)
const snapLog = ref<string[]>([])

// 工作区偏移/吸附/顺序：从「当前选定批次」各自的拼合存档中装入，换批时整体重灌，不与旧批混
const offsets = reactive<Record<string, number>>({})
const snapped = reactive<Record<string, boolean>>({})

const caveSegments = computed(() =>
  segmentState.segments.filter((segment) => !selectedCaveId.value || segment.caveId === selectedCaveId.value)
)

function approvedBatchesOf(segmentId: string): SurveyBatch[] {
  return batchState.batches
    .filter((batch) => batch.segmentId === segmentId && batch.status === 'approved')
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true }))
}

function activeBatchOf(segmentId: string): SurveyBatch | undefined {
  const segment = segmentState.segments.find((item) => item.id === segmentId)
  return batchState.batches.find((batch) => batch.id === segment?.activeBatchId)
}

/** 当前各洞段选定参与拼合的批次 */
const activeBatches = computed<SurveyBatch[]>(() =>
  caveSegments.value
    .map((segment) => activeBatchOf(segment.id))
    .filter((batch): batch is SurveyBatch => Boolean(batch))
)

const activeBatchIds = computed(() => new Set(activeBatches.value.map((batch) => batch.id)))

/** 参与拼合的草图：必须属于各洞段当前选定的已通过批次 */
const mergeSketches = computed<Sketch[]>(() =>
  sketchState.sketches
    .filter((sketch) => activeBatchIds.value.has(sketch.batchId))
    .sort(
      (a, b) =>
        stakeToNumber(segmentOf(a.segmentId)?.startStake ?? '') -
          stakeToNumber(segmentOf(b.segmentId)?.startStake ?? '') || a.mergeOrder - b.mergeOrder
    )
)

function segmentOf(segmentId: string) {
  return segmentState.segments.find((item) => item.id === segmentId)
}
function segmentCodeOf(sketch: Sketch): string {
  return segmentOf(sketch.segmentId)?.code ?? '未归属'
}
function batchOf(sketch: Sketch): SurveyBatch | undefined {
  return batchState.batches.find((batch) => batch.id === sketch.batchId)
}

function widthOf(sketch: Sketch): number {
  return Math.max(88, Math.round(sketch.gridCount * (200 / Math.max(10, sketch.scale)) * 4))
}

const totalWidth = computed(() =>
  mergeSketches.value.reduce((sum, sketch) => sum + widthOf(sketch) + 10, 0)
)

// IndexedDB 异步水合完成后自动选中第一条洞穴
watch(
  () => [caveState.caves.length, selectedCaveId.value] as const,
  () => {
    if (!selectedCaveId.value && caveState.caves.length > 0) {
      selectedCaveId.value = caveState.caves[0].id
    }
  },
  { immediate: true }
)

/** 把当前选定批次存档中的排列装入工作区（缺记录的批次按草图初始化一份） */
async function loadWorkspace(): Promise<void> {
  for (const batch of activeBatches.value) {
    const sketchIds = sketchState.sketches
      .filter((sketch) => sketch.batchId === batch.id)
      .sort((a, b) => a.mergeOrder - b.mergeOrder)
      .map((sketch) => sketch.id)
    const record = await mergeStore.getState().ensureRecord(batch.id, batch.segmentId, sketchIds)
    for (const item of record.items) {
      offsets[item.sketchId] = item.offset
      snapped[item.sketchId] = item.snapped
    }
  }
  for (const id of Object.keys(offsets)) {
    const sketch = sketchState.sketches.find((item) => item.id === id)
    if (!sketch || !activeBatchIds.value.has(sketch.batchId)) {
      delete offsets[id]
      delete snapped[id]
    }
  }
}

watch([mergeSketches, mergeState], () => void loadWorkspace(), { immediate: true, deep: false })

/** 某洞段洞段闭合差（拼合视图复用闭合差徽标，取当前选定批次读数） */
const caveStations = computed(() =>
  stationState.stations.filter((station) => activeBatchIds.value.has(station.batchId))
)

/** 收集某批次当前工作区排列，写回该批次的拼合存档 */
async function persistBatch(batchId: string): Promise<void> {
  const sketches = mergeSketches.value.filter((sketch) => sketch.batchId === batchId)
  const record = mergeState.records[batchId]
  const orderMap = new Map(record?.items.map((item) => [item.sketchId, item.order]))
  const items: MergeItem[] = sketches.map((sketch, index) => ({
    sketchId: sketch.id,
    order: orderMap.get(sketch.id) ?? index + 1,
    offset: offsets[sketch.id] ?? 0,
    snapped: snapped[sketch.id] ?? false
  }))
  await mergeStore.getState().saveRecord(batchId, sketches[0]?.segmentId ?? '', items)
}

/** 切换洞段参与拼合的已通过批次：旧批存档保留，新批记录单独装入，绝不混排 */
async function switchBatch(segmentId: string, batchId: string): Promise<void> {
  const previous = activeBatchOf(segmentId)
  try {
    if (previous) await persistBatch(previous.id)
    await batchStore.getState().selectForMerge(segmentId, batchId)
    await loadWorkspace()
    const batch = batchState.batches.find((item) => item.id === batchId)
    snapLog.value = [`洞段切换到批次「${batch?.code ?? ''}」，已载入该批自己的拼合记录`]
    ElMessage.success('已切换拼合批次，旧批排列已单独存档')
  } catch (error) {
    if (error instanceof BatchFlowError) ElMessage.error(error.message)
  }
}

/** 按桩号锚点自动吸附：以同批次最小锚点桩号为原点，按桩号差换算横向偏移（各批独立计算） */
async function autoAlign(): Promise<void> {
  const list = mergeSketches.value
  if (list.length === 0) {
    ElMessage.warning('当前洞穴暂无可拼合草图')
    return
  }
  const logs: string[] = []
  const touchedBatches = new Set<string>()
  for (const batchId of activeBatchIds.value) {
    const own = list.filter((sketch) => sketch.batchId === batchId)
    if (own.length === 0) continue
    const base = Math.min(...own.map((sketch) => stakeToNumber(sketch.anchorStake)))
    own.forEach((sketch) => {
      const stake = stakeToNumber(sketch.anchorStake)
      const target = Math.round((stake - base) * PX_PER_METER)
      offsets[sketch.id] = target
      snapped[sketch.id] = true
      logs.push(`${sketch.code}（${batchOf(sketch)?.code}）锚点 ${sketch.anchorStake} → 偏移 ${target}px`)
    })
    touchedBatches.add(batchId)
  }
  for (const batchId of touchedBatches) await persistBatch(batchId)
  snapLog.value = logs
  ElMessage.success(`已按桩号锚点吸附 ${list.length} 张图幅（各批次独立对齐）`)
}

function onMouseDown(sketch: Sketch, event: MouseEvent): void {
  draggingId.value = sketch.id
  dragStartX.value = event.clientX
  dragOriginOffset.value = offsets[sketch.id] ?? 0
}

function onMouseMove(event: MouseEvent): void {
  if (!draggingId.value) return
  const delta = event.clientX - dragStartX.value
  const raw = Math.max(-200, Math.min(CANVAS_W - 60, dragOriginOffset.value + delta))
  const list = mergeSketches.value
  const index = list.findIndex((sketch) => sketch.id === draggingId.value)
  let value = Math.round(raw)
  let snapTarget: string | null = null
  const others = list.filter((sketch) => sketch.id !== draggingId.value)
  for (const other of others) {
    const otherRight = (offsets[other.id] ?? 0) + widthOf(other)
    if (Math.abs(value - otherRight) <= SNAP_PX) {
      value = otherRight
      snapTarget = other.code
      break
    }
  }
  offsets[draggingId.value] = value
  snapped[draggingId.value] = snapTarget !== null
  if (snapTarget) {
    const current = list[index]
    snapLog.value = [`${current.code} 吸附到 ${snapTarget} 右边缘（偏移 ${value}px）`]
  }
}

async function onMouseUp(): Promise<void> {
  const id = draggingId.value
  draggingId.value = null
  if (!id) return
  const sketch = mergeSketches.value.find((item) => item.id === id)
  if (sketch) await persistBatch(sketch.batchId)
}

/** 拼合顺序表（输出结果） */
interface MergeRow {
  order: number
  batchId: string
  batchCode: string
  legacy: boolean
  code: string
  segment: string
  anchorStake: string
  offset: number
  snapped: boolean
}

function orderOf(sketchId: string): number {
  const sketch = mergeSketches.value.find((item) => item.id === sketchId)
  if (!sketch) return Number.MAX_SAFE_INTEGER
  return mergeState.records[sketch.batchId]?.items.find((item) => item.sketchId === sketchId)?.order ?? 1
}

const mergeRows = computed<MergeRow[]>(() =>
  mergeSketches.value
    .map((sketch) => ({
      sketch,
      segStart: stakeToNumber(segmentOf(sketch.segmentId)?.startStake ?? '')
    }))
    .sort(
      (a, b) =>
        a.segStart - b.segStart ||
        orderOf(a.sketch.id) - orderOf(b.sketch.id) ||
        a.sketch.mergeOrder - b.sketch.mergeOrder
    )
    .map(({ sketch }, index) => ({
      order: index + 1,
      batchId: sketch.batchId,
      batchCode: batchOf(sketch)?.code ?? '—',
      legacy: batchOf(sketch)?.legacy ?? false,
      code: sketch.code,
      segment: segmentCodeOf(sketch),
      anchorStake: sketch.anchorStake,
      offset: offsets[sketch.id] ?? 0,
      snapped: snapped[sketch.id] ?? false
    }))
)

async function move(index: number, direction: -1 | 1): Promise<void> {
  const rows = mergeRows.value
  const target = index + direction
  if (target < 0 || target >= rows.length) return
  const a = rows[index]
  const b = rows[target]
  // 交换两图幅在各自批次存档里的顺序；跨批时两批存档各改各的，记录仍按批隔离
  const recordA = mergeState.records[a.batchId]
  const recordB = mergeState.records[b.batchId]
  const sketchA = sketchState.sketches.find((s) => s.code === a.code && s.batchId === a.batchId)
  const sketchB = sketchState.sketches.find((s) => s.code === b.code && s.batchId === b.batchId)
  if (!sketchA || !sketchB || !recordA || !recordB) return
  const orderA = recordA.items.find((item) => item.sketchId === sketchA.id)?.order
  const orderB = recordB.items.find((item) => item.sketchId === sketchB.id)?.order
  if (orderA === undefined || orderB === undefined) return
  const bump = (items: MergeItem[], sketchId: string, order: number): MergeItem[] =>
    items.map((item) => (item.sketchId === sketchId ? { ...item, order } : item))
  if (a.batchId === b.batchId) {
    const record = recordA
    const items = bump(bump(record.items, sketchA.id, orderB), sketchB.id, orderA)
    await mergeStore.getState().saveRecord(a.batchId, record.segmentId, items)
  } else {
    await mergeStore.getState().saveRecord(a.batchId, recordA.segmentId, bump(recordA.items, sketchA.id, orderB))
    await mergeStore.getState().saveRecord(b.batchId, recordB.segmentId, bump(recordB.items, sketchB.id, orderA))
  }
  await loadWorkspace()
}

function exportMergeTable(): void {
  downloadCsv(
    '图幅拼合顺序表.csv',
    mergeRows.value as unknown as Record<string, unknown>[],
    [
      { key: 'order', label: '拼合顺序' },
      { key: 'batchCode', label: '所属批次' },
      { key: 'code', label: '草图编号' },
      { key: 'segment', label: '洞段' },
      { key: 'anchorStake', label: '锚点桩号' },
      { key: 'offset', label: '对齐偏移(px)' },
      { key: 'snapped', label: '是否吸附' }
    ]
  )
  ElMessage.success('拼合顺序表已导出')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">图幅拼合视图</h2>
        <p class="page-sub">
          每个洞段只能选定一个已通过批次参与拼合；每个批次的偏移、吸附与顺序单独存档，换批次后旧批记录不会与新批混排。
        </p>
      </div>
      <div class="head-actions">
        <el-button type="primary" @click="autoAlign">按桩号锚点吸附对齐</el-button>
        <el-button @click="exportMergeTable">导出拼合顺序表</el-button>
      </div>
    </div>

    <div class="toolbar">
      <el-select v-model="selectedCaveId" placeholder="选择洞穴" style="width: 220px">
        <el-option v-for="cave in caveState.caves" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-tag effect="plain">图幅 {{ mergeSketches.length }} 张</el-tag>
      <el-tag effect="plain">总宽 {{ totalWidth }} px</el-tag>
      <el-tag type="info" effect="plain">测点 {{ caveStations.length }} 个（仅选定批次）</el-tag>
    </div>

    <el-card shadow="never" class="seg-panel">
      <template #header>洞段拼合批次（同一洞段只能选一个已通过批次）</template>
      <div v-if="caveSegments.length === 0" class="muted">该洞穴暂无洞段</div>
      <div v-for="segment in caveSegments" :key="segment.id" class="seg-row">
        <SegmentTag :type="segment.type" :code="segment.code" :closed="segment.closed" size="small" />
        <span class="muted stake">{{ segment.startStake }} → {{ segment.endStake }}</span>
        <el-select
          :model-value="segment.activeBatchId"
          size="small"
          style="width: 240px"
          :placeholder="approvedBatchesOf(segment.id).length ? '选择已通过批次' : '暂无已通过批次'"
          @update:model-value="(value: string) => switchBatch(segment.id, value)"
        >
          <el-option
            v-for="batch in approvedBatchesOf(segment.id)"
            :key="batch.id"
            :label="`${batch.code}${batch.legacy ? '（旧批）' : ''}`"
            :value="batch.id"
          />
        </el-select>
        <el-tag v-if="activeBatchOf(segment.id)" type="success" effect="plain" size="small">参与拼合</el-tag>
        <el-tag v-else type="warning" effect="plain" size="small">未选批次，图幅不参与拼合</el-tag>
      </div>
    </el-card>

    <div class="merge-row">
      <div class="canvas-wrap" @mousemove="onMouseMove" @mouseup="onMouseUp" @mouseleave="onMouseUp">
        <GridCanvas
          :width="CANVAS_W"
          :height="CANVAS_H"
          :grid-size="20"
          :meters-per-grid="1"
          title="图幅拼合台（拖动对齐 / 锚点吸附 / 按批次隔离）"
        >
          <g
            v-for="(sketch, index) in mergeSketches"
            :key="sketch.id"
            class="sheet-group"
            @mousedown.prevent="onMouseDown(sketch, $event)"
          >
            <rect
              :x="offsets[sketch.id] ?? 0"
              :y="40 + (index % 2) * 10"
              :width="widthOf(sketch)"
              height="96"
              rx="6"
              :fill="snapped[sketch.id] ? 'rgba(47,111,143,0.22)' : 'rgba(143,211,199,0.28)'"
              :stroke="snapped[sketch.id] ? '#2f6f8f' : '#1f8a70'"
              stroke-width="1.6"
            />
            <text :x="(offsets[sketch.id] ?? 0) + 8" :y="62 + (index % 2) * 10" font-size="12" fill="#1f3a4d">
              {{ sketch.code }}
            </text>
            <text :x="(offsets[sketch.id] ?? 0) + 8" :y="80 + (index % 2) * 10" font-size="11" fill="#4a5b6b">
              {{ batchOf(sketch)?.code }} · 锚点 {{ sketch.anchorStake }}
            </text>
            <text :x="(offsets[sketch.id] ?? 0) + 8" :y="96 + (index % 2) * 10" font-size="11" fill="#7a8896">
              1:{{ sketch.scale }} · {{ sketch.gridCount }} 格
            </text>
            <line
              :x1="offsets[sketch.id] ?? 0"
              :y1="136 + (index % 2) * 10"
              :x2="(offsets[sketch.id] ?? 0) + 14"
              :y2="136 + (index % 2) * 10"
              stroke="#c98a1b"
              stroke-width="2"
            />
          </g>
          <text
            v-if="mergeSketches.length === 0"
            :x="CANVAS_W / 2 - 130"
            :y="CANVAS_H / 2"
            font-size="13"
            fill="#8a97a3"
          >
            请先在上方为各洞段选定复核通过的批次
          </text>
          <template #legend>
            <span>拖动图幅可移动</span>
            <span>绿框 = 未吸附</span>
            <span>蓝框 = 已吸附对齐</span>
            <span>橙色短划 = 锚点桩号位置</span>
          </template>
        </GridCanvas>
      </div>

      <div class="side">
        <el-card shadow="never" class="log-card">
          <template #header>吸附 / 换批记录</template>
          <ul class="log">
            <li v-for="(line, index) in snapLog" :key="index">{{ line }}</li>
            <li v-if="snapLog.length === 0" class="muted">拖动图幅、切换批次或点击「按桩号锚点吸附对齐」后显示结果</li>
          </ul>
        </el-card>
        <el-alert
          type="info"
          :closable="false"
          title="拼合记录按批次存档"
          description="切换洞段批次时，旧批的偏移/吸附/顺序原样保留，新批载入自己的记录，两套排列互不影响。"
        />
      </div>
    </div>

    <h3 class="section-title">图幅拼合顺序表</h3>
    <el-table :data="mergeRows" border stripe>
      <el-table-column prop="order" label="拼合顺序" width="90" />
      <el-table-column label="所属批次" width="150">
        <template #default="{ row }: { row: MergeRow }">
          <span class="mono">{{ row.batchCode }}</span>
          <el-tag v-if="row.legacy" type="info" size="small" effect="plain" style="margin-left: 4px">旧批</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="code" label="草图编号" width="110" />
      <el-table-column prop="segment" label="洞段" width="100" />
      <el-table-column prop="anchorStake" label="桩号对齐锚点" width="140" />
      <el-table-column label="对齐偏移" width="110">
        <template #default="{ row }: { row: MergeRow }">{{ row.offset }} px</template>
      </el-table-column>
      <el-table-column label="吸附状态" width="100">
        <template #default="{ row }: { row: MergeRow }">
          <el-tag :type="row.snapped ? 'success' : 'info'" size="small" effect="plain">
            {{ row.snapped ? '已吸附' : '未吸附' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="调整顺序" width="160">
        <template #default="{ $index }: { $index: number }">
          <el-button link type="primary" size="small" :disabled="$index === 0" @click="move($index, -1)">上移</el-button>
          <el-button
            link
            type="primary"
            size="small"
            :disabled="$index === mergeRows.length - 1"
            @click="move($index, 1)"
          >
            下移
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}
.seg-panel {
  border-radius: 12px;
  margin-bottom: 14px;
}
.seg-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
}
.stake {
  font-size: 12px;
  width: 170px;
}
.canvas-wrap {
  display: inline-flex;
}
.merge-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 320px;
}
.log-card {
  border-radius: 12px;
}
.log {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: #4a5b6b;
  line-height: 1.8;
}
.sheet-group {
  cursor: grab;
}
</style>
