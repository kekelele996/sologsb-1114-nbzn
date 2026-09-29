<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Station, SurveyBatch } from '@/types'
import { BATCH_STATUS_LABELS } from '@/types'
import BearingInput from '@/components/common/BearingInput.vue'
import ClosureBadge from '@/components/common/ClosureBadge.vue'
import SegmentTag from '@/components/common/SegmentTag.vue'
import BatchStatusTag from '@/components/common/BatchStatusTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { useClosureCheck } from '@/hooks/useClosureCheck'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { caveStore } from '@/stores/caveStore'
import { batchStore, BatchFlowError, batchWritable } from '@/stores/batchStore'
import { computeHorizontal, computeVertical, formatDms, isValidBearing, isValidDip } from '@/utils/survey'
import { nextCode, uid } from '@/utils/id'

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)
const batchState = useStore(batchStore)

const selectedCaveId = ref<string>(caveState.caves[0]?.id ?? '')
const selectedSegmentId = ref<string>('')
const selectedBatchId = ref<string>('')
const editingId = ref<string | null>(null)
const lastSaved = ref<string>('')

const form = reactive({
  code: 'P1',
  bearing: 90,
  dip: 0,
  slopeDistance: 10,
  instrumentNo: 'SOKKIA-2',
  surveyor: '',
  date: new Date().toISOString().slice(0, 10),
  isClosurePoint: false,
  note: ''
})

const segmentOptions = computed(() =>
  segmentState.segments.filter((segment) => !selectedCaveId.value || segment.caveId === selectedCaveId.value)
)
const currentSegment = computed(() => segmentState.segments.find((segment) => segment.id === selectedSegmentId.value))

/** 当前洞段的批次，按最近更新倒序 */
const segmentBatches = computed<SurveyBatch[]>(() =>
  batchState.batches
    .filter((batch) => batch.segmentId === selectedSegmentId.value)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
)
const currentBatch = computed<SurveyBatch | undefined>(() =>
  batchState.batches.find((batch) => batch.id === selectedBatchId.value)
)
/** 只有一份批次时可编辑读数：正在编辑的草稿 */
const writable = computed(() => batchWritable(currentBatch.value))
const stationCountOf = (batchId: string): number =>
  stationState.stations.filter((station) => station.batchId === batchId).length

const segmentStations = computed(() =>
  stationState.stations
    .filter((station) => station.batchId === selectedBatchId.value)
    .sort((a, b) => Number((a.code.match(/\d+/) ?? ['0'])[0]) - Number((b.code.match(/\d+/) ?? ['0'])[0]))
)

/** 已保存测点 + 当前待录入测点一起参与闭合差计算（仅草稿编辑态） */
const pendingStation = computed<Station | null>(() => {
  if (!writable.value || !currentBatch.value) return null
  return {
    id: 'pending',
    segmentId: selectedSegmentId.value,
    batchId: currentBatch.value.id,
    code: form.code,
    bearing: form.bearing,
    dip: form.dip,
    slopeDistance: form.slopeDistance,
    horizontalDistance: previewHorizontal.value,
    verticalDistance: previewVertical.value,
    instrumentNo: form.instrumentNo,
    surveyor: form.surveyor,
    date: form.date,
    isClosurePoint: form.isClosurePoint,
    note: form.note
  }
})

const closureInput = computed<Station[]>(() =>
  pendingStation.value ? [...segmentStations.value, pendingStation.value] : segmentStations.value
)
const { result: closureResult, over: closureOver } = useClosureCheck(closureInput)

const previewHorizontal = computed(() => computeHorizontal(form.dip, form.slopeDistance))
const previewVertical = computed(() => computeVertical(form.dip, form.slopeDistance))

/** 异常读数：方位角或倾角超范围、斜距非正、水平距大于斜距 */
function isAbnormal(station: Station): boolean {
  if (!isValidBearing(station.bearing)) return true
  if (!isValidDip(station.dip)) return true
  if (!(station.slopeDistance > 0)) return true
  return station.horizontalDistance > Math.abs(station.slopeDistance) + 0.001
}

function rowClassName(param: { row: Station }): string {
  return isAbnormal(param.row) ? 'abnormal-row' : ''
}

function refreshDefaultCode(): void {
  form.code = nextCode('P', segmentStations.value.map((station) => station.code))
}

// IndexedDB 数据是异步水合的，洞穴/洞段到达后自动选中第一条，避免空选
watch(
  () => [caveState.caves.length, selectedCaveId.value] as const,
  () => {
    if (!selectedCaveId.value && caveState.caves.length > 0) {
      selectedCaveId.value = caveState.caves[0].id
    }
  },
  { immediate: true }
)

watch(
  () => [selectedCaveId.value, segmentOptions.value.length] as const,
  () => {
    const list = segmentOptions.value
    if (!list.some((segment) => segment.id === selectedSegmentId.value)) {
      selectedSegmentId.value = list.length > 0 ? list[0].id : ''
    }
  },
  { immediate: true }
)

// 切换洞段：优先选中草稿；没有草稿则选中最新一批（只读查看）
watch(
  [selectedSegmentId, segmentBatches],
  () => {
    const list = segmentBatches.value
    if (list.length === 0) {
      selectedBatchId.value = ''
      return
    }
    if (!list.some((batch) => batch.id === selectedBatchId.value)) {
      selectedBatchId.value = list.find((batch) => batch.status === 'draft')?.id ?? list[0].id
    }
  },
  { immediate: true }
)

watch(
  selectedBatchId,
  () => {
    editingId.value = null
    refreshDefaultCode()
  },
  { immediate: true }
)

function formatTime(iso: string): string {
  if (!iso) return '—'
  return iso.replace('T', ' ').slice(0, 16)
}

async function createDraft(): Promise<void> {
  if (!selectedSegmentId.value) {
    ElMessage.warning('请先选择洞段')
    return
  }
  try {
    const { value } = await ElMessageBox.prompt('新批次的建批人（测量记录员）', '新开测量批次', {
      confirmButtonText: '建批',
      cancelButtonText: '取消',
      inputValue: form.surveyor || caveState.caves.find((cave) => cave.id === selectedCaveId.value)?.surveyor || '',
      inputPlaceholder: '如 陆昀'
    })
    const note = ''
    const id = await batchStore.getState().createDraft(selectedSegmentId.value, value ?? '', note)
    selectedBatchId.value = id
    ElMessage.success('已新开草稿批次，可开始录入读数')
  } catch (error) {
    if (error instanceof BatchFlowError) ElMessage.error(error.message)
  }
}

async function submitBatch(): Promise<void> {
  if (!currentBatch.value) return
  try {
    await ElMessageBox.confirm(
      `提交复核后批次「${currentBatch.value.code}」将冻结，测点读数不能再增删改。确认提交？`,
      '提交复核',
      { type: 'warning', confirmButtonText: '提交复核' }
    )
    await batchStore.getState().submit(currentBatch.value.id)
    ElMessage.success('批次已提交复核，等待复核员处理')
  } catch (error) {
    if (error instanceof BatchFlowError) ElMessage.error(error.message)
  }
}

async function forkDraft(batch: SurveyBatch): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      `将从打回批「${batch.code}」新开一份草稿，读数会复制过来，打回原因也会带过去。请确认建批人：`,
      '打回后重开草稿',
      {
        confirmButtonText: '重开草稿',
        cancelButtonText: '取消',
        inputValue: batch.surveyor,
        inputPlaceholder: '如 陆昀'
      }
    )
    const id = await batchStore.getState().forkDraft(batch.id, value ?? batch.surveyor)
    selectedBatchId.value = id
    ElMessage.success('已新开草稿，打回原因已带入批次备注')
  } catch (error) {
    if (error instanceof BatchFlowError) ElMessage.error(error.message)
  }
}

async function discardDraft(batch: SurveyBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认作废草稿批次「${batch.code}」？草稿内读数将一并删除。`, '作废草稿', {
      type: 'warning'
    })
    await batchStore.getState().removeDraft(batch.id)
    selectedBatchId.value = ''
    ElMessage.success('草稿已作废')
  } catch (error) {
    if (error instanceof BatchFlowError) ElMessage.error(error.message)
  }
}

async function submit(continueNext: boolean): Promise<void> {
  if (!currentBatch.value || !writable.value) {
    ElMessage.warning('当前批次已冻结，不能修改读数；请从已打回批次新开草稿')
    return
  }
  if (!form.code.trim()) {
    ElMessage.warning('请填写测点桩号')
    return
  }
  if (!(form.slopeDistance > 0)) {
    ElMessage.warning('斜距必须大于 0')
    return
  }
  if (!isValidBearing(form.bearing)) {
    ElMessage.warning('前视方位角必须在 0°–360° 之间')
    return
  }
  if (!isValidDip(form.dip)) {
    ElMessage.warning('倾角必须在 -90°–90° 之间')
    return
  }
  const existing = stationState.stations.find((station) => station.id === editingId.value)
  const station: Station = {
    id: existing?.id ?? uid('st'),
    segmentId: selectedSegmentId.value,
    batchId: currentBatch.value.id,
    code: form.code.trim(),
    bearing: form.bearing,
    dip: form.dip,
    slopeDistance: form.slopeDistance,
    horizontalDistance: previewHorizontal.value,
    verticalDistance: previewVertical.value,
    instrumentNo: form.instrumentNo.trim(),
    surveyor: form.surveyor.trim(),
    date: form.date,
    isClosurePoint: form.isClosurePoint,
    note: form.note.trim()
  }
  await stationStore.getState().save(station)
  lastSaved.value = `${station.code} · 水平距 ${station.horizontalDistance} m / 垂距 ${station.verticalDistance} m`
  ElMessage.success(existing ? `测点 ${station.code} 已更新` : `测点 ${station.code} 已录入`)
  editingId.value = null
  form.isClosurePoint = false
  form.note = ''
  if (continueNext) {
    await stationStore.getState().hydrate()
    form.code = nextCode('P', segmentStations.value.map((item) => item.code))
  }
}

function editStation(station: Station): void {
  if (!writable.value) return
  editingId.value = station.id
  form.code = station.code
  form.bearing = station.bearing
  form.dip = station.dip
  form.slopeDistance = station.slopeDistance
  form.instrumentNo = station.instrumentNo
  form.surveyor = station.surveyor
  form.date = station.date
  form.isClosurePoint = station.isClosurePoint
  form.note = station.note
}

async function removeStation(station: Station): Promise<void> {
  if (!writable.value) {
    ElMessage.warning('批次已冻结，不能删除读数')
    return
  }
  await ElMessageBox.confirm(`确认删除测点「${station.code}」？`, '删除确认', { type: 'warning' })
  await stationStore.getState().remove(station.id)
  ElMessage.success('测点已删除')
}

/** 冻结态提示文案 */
const freezeHint = computed(() => {
  const batch = currentBatch.value
  if (!batch) return ''
  if (batch.status === 'review') return '本批已提交复核并冻结，复核通过前读数只读。'
  if (batch.status === 'approved') return '本批已复核通过并冻结；如需复测请新建后续批次。'
  if (batch.status === 'rejected') return '本批已打回保留留痕，可从它新开一份草稿继续修改。'
  return ''
})
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">测点与读数录入</h2>
        <p class="page-sub">
          一次洞段测量连同读数收成一个批次：草稿阶段可随时录入，提交复核后整批冻结；复核通过才开放给草图工作台。
        </p>
      </div>
      <el-tag v-if="lastSaved" type="success" effect="plain">最近保存：{{ lastSaved }}</el-tag>
    </div>

    <div class="toolbar">
      <el-select v-model="selectedCaveId" placeholder="选择洞穴" style="width: 200px">
        <el-option v-for="cave in caveState.caves" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-select v-model="selectedSegmentId" placeholder="选择洞段" style="width: 220px">
        <el-option
          v-for="segment in segmentOptions"
          :key="segment.id"
          :label="`${segment.code}（${segment.startStake} → ${segment.endStake}）`"
          :value="segment.id"
        />
      </el-select>
      <SegmentTag v-if="currentSegment" :type="currentSegment.type" :closed="currentSegment.closed" size="small" />
      <el-button v-if="selectedSegmentId" type="primary" plain @click="createDraft">新开测量批次</el-button>
    </div>

    <el-card shadow="never" class="batch-card">
      <template #header>
        <div class="batch-head">
          <span>本洞段测量批次（{{ segmentBatches.length }}）</span>
          <span class="muted">同一洞段同一时间只有一份草稿；提交复核后冻结</span>
        </div>
      </template>
      <el-empty v-if="segmentBatches.length === 0" description="该洞段还没有批次，点击「新开测量批次」开始一次测量" :image-size="64" />
      <div v-else class="batch-list">
        <div
          v-for="batch in segmentBatches"
          :key="batch.id"
          class="batch-item"
          :class="{ active: batch.id === selectedBatchId }"
          @click="selectedBatchId = batch.id"
        >
          <div class="batch-item-main">
            <div class="batch-item-line">
              <b class="mono">{{ batch.code }}</b>
              <BatchStatusTag :status="batch.status" :legacy="batch.legacy" />
              <el-tag size="small" effect="plain">{{ stationCountOf(batch.id) }} 站</el-tag>
            </div>
            <div class="muted batch-meta">
              建批 {{ formatTime(batch.createdAt) }}
              <template v-if="batch.submittedAt"> · 提交 {{ formatTime(batch.submittedAt) }}</template>
              <template v-if="batch.reviewer"> · 复核 {{ batch.reviewer }}</template>
            </div>
            <div v-if="batch.status === 'rejected'" class="reject-reason">
              打回原因：{{ batch.events.filter((e) => e.type === 'reject').slice(-1)[0]?.note || '—' }}
            </div>
          </div>
          <div class="batch-item-actions" @click.stop>
            <el-button
              v-if="batch.status === 'draft'"
              size="small"
              type="warning"
              plain
              @click="submitBatch()"
            >
              提交复核
            </el-button>
            <el-button
              v-if="batch.status === 'rejected'"
              size="small"
              type="primary"
              @click="forkDraft(batch)"
            >
              新开草稿（带原因）
            </el-button>
            <el-button v-if="batch.status === 'draft'" size="small" type="danger" plain @click="discardDraft(batch)">
              作废
            </el-button>
          </div>
        </div>
      </div>
    </el-card>

    <el-alert
      v-if="currentBatch && currentBatch.carriedReason"
      class="alert"
      type="warning"
      :closable="false"
      :title="`已从上一批带过打回原因：${currentBatch.carriedReason}`"
    />

    <template v-if="currentBatch">
      <el-alert v-if="freezeHint" class="alert" type="info" :closable="false" :title="freezeHint" />

      <el-card v-if="writable" shadow="never" class="form-card">
        <el-form label-width="96px">
          <el-row :gutter="16">
            <el-col :span="6">
              <el-form-item label="测点桩号" required>
                <el-input v-model="form.code" placeholder="如 P12" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="前视方位角">
                <BearingInput v-model="form.bearing" kind="bearing" @invalid="(msg: string) => ElMessage.warning(msg)" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="倾角">
                <BearingInput v-model="form.dip" kind="dip" @invalid="(msg: string) => ElMessage.warning(msg)" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="斜距(m)" required>
                <el-input-number v-model="form.slopeDistance" :min="0" :step="0.1" :precision="3" :controls="false" style="width: 100%" />
              </el-form-item>
            </el-col>
          </el-row>
          <el-row :gutter="16">
            <el-col :span="6">
              <el-form-item label="仪器号">
                <el-input v-model="form.instrumentNo" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="测量人">
                <el-input v-model="form.surveyor" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="测量日期">
                <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
              </el-form-item>
            </el-col>
            <el-col :span="6">
              <el-form-item label="闭合点">
                <el-switch v-model="form.isClosurePoint" />
              </el-form-item>
            </el-col>
          </el-row>
          <el-form-item label="备注">
            <el-input v-model="form.note" type="textarea" :rows="2" placeholder="岩壁、滴水、崩塌堆积等现场情况" />
          </el-form-item>
          <div class="preview">
            <el-tag effect="plain">自动推算：水平距 {{ previewHorizontal.toFixed(3) }} m</el-tag>
            <el-tag effect="plain">垂距 {{ previewVertical.toFixed(3) }} m</el-tag>
            <el-tag effect="plain">方位角 {{ formatDms(form.bearing) }}</el-tag>
            <el-tag effect="plain">倾角 {{ formatDms(form.dip) }}</el-tag>
          </div>
          <div class="actions">
            <el-button type="primary" @click="submit(false)">{{ editingId ? '保存修改' : '保存测点' }}</el-button>
            <el-button type="success" plain @click="submit(true)">保存并录入下一站</el-button>
            <el-button :disabled="!selectedBatchId" @click="refreshDefaultCode">重算下一桩号</el-button>
            <el-button v-if="editingId" @click="editingId = null">取消编辑</el-button>
          </div>
        </el-form>
      </el-card>

      <ClosureBadge
        class="closure"
        :closure="closureResult.closure"
        :threshold="closureResult.threshold"
        :level="closureResult.level"
        :detail="closureResult.detail"
        :count="segmentStations.length"
      />
      <el-alert
        v-if="closureOver"
        class="alert"
        type="error"
        :closable="false"
        title="闭合差已超限"
        description="当前批次累计闭合差超过阈值，建议复测异常测点或对读数做误差分配。"
      />

      <h3 class="section-title">
        批次「{{ currentBatch.code }}」读数（{{ segmentStations.length }} 站 · {{ BATCH_STATUS_LABELS[currentBatch.status] }}）
      </h3>
      <el-table :data="segmentStations" border stripe :row-class-name="rowClassName">
        <el-table-column prop="code" label="桩号" width="90" />
        <el-table-column label="方位角" width="150">
          <template #default="{ row }: { row: Station }">{{ row.bearing }}° / {{ formatDms(row.bearing) }}</template>
        </el-table-column>
        <el-table-column label="倾角" width="140">
          <template #default="{ row }: { row: Station }">{{ row.dip }}°</template>
        </el-table-column>
        <el-table-column prop="slopeDistance" label="斜距(m)" width="100" />
        <el-table-column prop="horizontalDistance" label="水平距(m)" width="110" />
        <el-table-column prop="verticalDistance" label="垂距(m)" width="100" />
        <el-table-column prop="instrumentNo" label="仪器号" width="110" />
        <el-table-column prop="surveyor" label="测量人" width="90" />
        <el-table-column prop="date" label="日期" width="120" />
        <el-table-column label="闭合点" width="90">
          <template #default="{ row }: { row: Station }">
            <el-tag v-if="row.isClosurePoint" type="success" size="small" effect="plain">是</el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="读数状态" width="110">
          <template #default="{ row }: { row: Station }">
            <el-tag v-if="isAbnormal(row)" type="danger" size="small" effect="dark">异常</el-tag>
            <el-tag v-else type="success" size="small" effect="plain">正常</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="140" show-overflow-tooltip />
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }: { row: Station }">
            <el-button link type="primary" size="small" :disabled="!writable" @click="editStation(row)">编辑</el-button>
            <el-button link type="danger" size="small" :disabled="!writable" @click="removeStation(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </template>
  </div>
</template>

<style scoped>
.batch-card {
  border-radius: 12px;
  margin-bottom: 16px;
}
.batch-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.batch-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.batch-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid #dde6ee;
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.batch-item:hover {
  border-color: #2f6f8f;
}
.batch-item.active {
  border-color: #2f6f8f;
  background: #f0f6fa;
  box-shadow: inset 0 0 0 1px #2f6f8f;
}
.batch-item-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.batch-item-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.batch-meta {
  font-size: 12px;
}
.reject-reason {
  font-size: 12px;
  color: #b03030;
}
.batch-item-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.form-card {
  border-radius: 12px;
  margin-bottom: 16px;
}
.alert {
  margin-bottom: 12px;
}
.preview {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 0 0 96px;
}
.actions {
  display: flex;
  gap: 10px;
  padding: 14px 0 0 96px;
}
.closure {
  margin-bottom: 12px;
}
:deep(.abnormal-row) {
  background: #fdf2f2 !important;
}
:deep(.abnormal-row td) {
  color: #b03030;
}
</style>
