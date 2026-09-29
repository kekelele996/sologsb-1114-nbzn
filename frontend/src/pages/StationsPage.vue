<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Station, SurveyBatch } from '@/types'
import { BATCH_STATUS_LABELS, BATCH_STATUS_TAG_TYPE } from '@/types'
import BearingInput from '@/components/common/BearingInput.vue'
import ClosureBadge from '@/components/common/ClosureBadge.vue'
import SegmentTag from '@/components/common/SegmentTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { useClosureCheck } from '@/hooks/useClosureCheck'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { caveStore } from '@/stores/caveStore'
import { batchStore } from '@/stores/batchStore'
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

/** 复核操作对话框 */
const reviewVisible = ref(false)
const reviewAction = ref<'approve' | 'reject'>('approve')
const reviewForm = reactive({ reviewer: '', reason: '' })
/** 提交复核对话框 */
const submitVisible = ref(false)
const submitForm = reactive({ submittedBy: '' })

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

const segmentBatches = computed(() =>
  batchState.batches.filter((batch) => batch.segmentId === selectedSegmentId.value)
)
const currentBatch = computed(() => batchState.batches.find((batch) => batch.id === selectedBatchId.value))
/** 打回重开链上的上一批编号（仅展示用） */
const originBatchCode = computed(
  () => segmentBatches.value.find((b) => b.id === currentBatch.value?.originBatchId)?.code ?? ''
)
const batchEditable = computed(() => currentBatch.value?.status === 'draft')
const hasDraft = computed(() => segmentBatches.value.some((batch) => batch.status === 'draft'))

function stationCountOf(batchId: string): number {
  return stationState.stations.filter((station) => station.batchId === batchId).length
}

const batchStations = computed(() =>
  stationState.stations
    .filter((station) => station.batchId === selectedBatchId.value)
    .sort((a, b) => Number((a.code.match(/\d+/) ?? ['0'])[0]) - Number((b.code.match(/\d+/) ?? ['0'])[0]))
)

/** 已保存测点 + 当前待录入测点一起参与闭合差计算，实时反映累计闭合差 */
const pendingStation = computed<Station>(() => ({
  id: 'pending',
  segmentId: selectedSegmentId.value,
  batchId: selectedBatchId.value,
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
}))

const closureInput = computed<Station[]>(() =>
  batchEditable.value && editingId.value === null ? [...batchStations.value, pendingStation.value] : batchStations.value
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
  form.code = nextCode('P', batchStations.value.map((station) => station.code))
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

// 切换洞段：优先落到草稿，其次待复核，再取最新一批
watch(
  () => [selectedSegmentId.value, segmentBatches.value.length] as const,
  () => {
    const list = segmentBatches.value
    if (!list.some((batch) => batch.id === selectedBatchId.value)) {
      const prefer =
        list.find((batch) => batch.status === 'draft') ??
        list.find((batch) => batch.status === 'reviewing') ??
        list[0]
      selectedBatchId.value = prefer?.id ?? ''
    }
  },
  { immediate: true }
)

watch(
  () => selectedBatchId.value,
  () => {
    editingId.value = null
    refreshDefaultCode()
  },
  { immediate: true }
)

async function createDraft(): Promise<void> {
  if (!selectedSegmentId.value) return
  try {
    const batch = await batchStore.getState().createDraft(selectedSegmentId.value)
    selectedBatchId.value = batch.id
    ElMessage.success(`已新开草稿批次 ${batch.code}`)
  } catch (error) {
    ElMessage.warning((error as Error).message)
  }
}

function openSubmit(): void {
  if (batchStations.value.length === 0) {
    ElMessage.warning('空批次不能提交复核，请至少录入一条读数')
    return
  }
  submitForm.submittedBy = caveState.caves.find((cave) => cave.id === selectedCaveId.value)?.surveyor ?? ''
  submitVisible.value = true
}

async function confirmSubmit(): Promise<void> {
  if (!submitForm.submittedBy.trim()) {
    ElMessage.warning('请填写提交人')
    return
  }
  try {
    await batchStore.getState().submit(selectedBatchId.value, submitForm.submittedBy)
    submitVisible.value = false
    ElMessage.success('批次已提交复核，读数已冻结')
  } catch (error) {
    ElMessage.warning((error as Error).message)
  }
}

function openReview(action: 'approve' | 'reject'): void {
  reviewAction.value = action
  reviewForm.reviewer = ''
  reviewForm.reason = ''
  reviewVisible.value = true
}

async function confirmReview(): Promise<void> {
  if (!reviewForm.reviewer.trim()) {
    ElMessage.warning('请填写复核员姓名')
    return
  }
  try {
    if (reviewAction.value === 'approve') {
      await batchStore.getState().approve(selectedBatchId.value, reviewForm.reviewer)
      ElMessage.success('复核通过，该批次可在草图工作台选用')
    } else {
      if (!reviewForm.reason.trim()) {
        ElMessage.warning('打回必须填写原因')
        return
      }
      await batchStore.getState().reject(selectedBatchId.value, reviewForm.reviewer, reviewForm.reason)
      ElMessage.success('已打回，原批保留；可从它重开一份草稿')
    }
    reviewVisible.value = false
  } catch (error) {
    ElMessage.warning((error as Error).message)
  }
}

async function reopenDraft(batch: SurveyBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将从已打回批次 ${batch.code} 新开一份草稿：原批保留不动，读数原样复制，打回原因带入新草稿。确认继续？`,
      '重开草稿',
      { type: 'info', confirmButtonText: '重开草稿', cancelButtonText: '取消' }
    )
    const draft = await batchStore.getState().reopenFromRejected(batch.id)
    selectedBatchId.value = draft.id
    ElMessage.success(`已新开草稿 ${draft.code}，请按打回原因修订`)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.warning((error as Error).message)
  }
}

async function submit(continueNext: boolean): Promise<void> {
  if (!selectedBatchId.value) {
    ElMessage.warning('请先选择批次')
    return
  }
  if (!batchEditable.value) {
    ElMessage.warning('该批次已冻结，读数不能修改')
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
    batchId: selectedBatchId.value,
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
    form.code = nextCode('P', batchStations.value.map((item) => item.code))
  }
}

function editStation(station: Station): void {
  if (!batchEditable.value) return
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
  if (!batchEditable.value) return
  await ElMessageBox.confirm(`确认删除测点「${station.code}」？`, '删除确认', { type: 'warning' })
  await stationStore.getState().remove(station.id)
  ElMessage.success('测点已删除')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">测点读数与测量批次</h2>
        <p class="page-sub">
          一次洞段测量连同读数收成一个批次：提交复核后整批冻结，复核通过才可供草图工作台选用；打回后原批保留，可从它重开草稿并带上原因。
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
      <el-button :disabled="!selectedSegmentId || hasDraft" type="primary" plain @click="createDraft">
        新开草稿批次
      </el-button>
    </div>

    <el-card shadow="never" class="batch-card">
      <template #header>
        <div class="batch-head">
          <span>该洞段测量批次（{{ segmentBatches.length }}）</span>
          <span class="muted">草稿可录数 · 提交即冻结 · 通过才能画草图 · 打回可重开</span>
        </div>
      </template>
      <el-radio-group v-model="selectedBatchId" class="batch-list">
        <el-radio-button v-for="batch in segmentBatches" :key="batch.id" :value="batch.id" class="batch-radio">
          <span class="batch-code">{{ batch.code }}</span>
          <el-tag :type="BATCH_STATUS_TAG_TYPE[batch.status]" size="small" effect="plain" class="batch-tag">
            {{ BATCH_STATUS_LABELS[batch.status] }}
          </el-tag>
          <span class="muted">{{ stationCountOf(batch.id) }} 站</span>
          <el-tag v-if="batch.legacy" type="info" size="small" effect="dark">旧批</el-tag>
        </el-radio-button>
        <span v-if="segmentBatches.length === 0" class="muted">该洞段还没有测量批次，点上方「新开草稿批次」开始第一次测量。</span>
      </el-radio-group>
    </el-card>

    <template v-if="currentBatch">
      <el-alert
        v-if="currentBatch.status === 'draft' && currentBatch.carriedReason"
        class="alert"
        type="warning"
        :closable="false"
        show-icon
        :title="`本草稿从已打回批次 ${originBatchCode} 重开`"
        :description="`打回原因：${currentBatch.carriedReason}`"
      />
      <el-alert
        v-if="currentBatch.status === 'reviewing'"
        class="alert"
        type="info"
        :closable="false"
        show-icon
        :title="`批次已提交复核（提交人：${currentBatch.submittedBy || '—'}），读数冻结`"
        description="等待复核员处理：通过后可供草图工作台选用；打回需填写原因，原批保留。"
      />
      <el-alert
        v-if="currentBatch.status === 'approved'"
        class="alert"
        type="success"
        :closable="false"
        show-icon
        :title="`复核通过（复核员：${currentBatch.reviewedBy || '—'}），读数定稿`"
        description="该批次可在草图工作台选用；如需修改读数，请联系复核员或在新一轮测量中重开草稿。"
      />
      <el-alert
        v-if="currentBatch.status === 'rejected'"
        class="alert"
        type="error"
        :closable="false"
        show-icon
        :title="`已打回（复核员：${currentBatch.reviewedBy || '—'}），原批保留`"
        :description="`打回原因：${currentBatch.rejectReason}`"
      >
        <div class="alert-action">
          <el-button size="small" type="warning" @click="reopenDraft(currentBatch)">从本批重开草稿（带上原因）</el-button>
        </div>
      </el-alert>

      <div class="batch-actions">
        <el-button v-if="currentBatch.status === 'draft'" type="primary" @click="openSubmit">提交复核（冻结本批）</el-button>
        <template v-if="currentBatch.status === 'reviewing'">
          <el-button type="success" @click="openReview('approve')">复核通过</el-button>
          <el-button type="danger" plain @click="openReview('reject')">打回</el-button>
        </template>
        <el-button :disabled="!selectedBatchId" @click="refreshDefaultCode">重算下一桩号</el-button>
      </div>

      <el-card v-if="batchEditable" shadow="never" class="form-card">
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
        :count="batchStations.length"
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
        批次 {{ currentBatch.code }} 读数（{{ batchStations.length }} 站）
        <span class="muted">· {{ BATCH_STATUS_LABELS[currentBatch.status] }}{{ batchEditable ? '' : '，只读' }}</span>
      </h3>
      <el-table :data="batchStations" border stripe :row-class-name="rowClassName">
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
            <el-button link type="primary" size="small" :disabled="!batchEditable" @click="editStation(row)">编辑</el-button>
            <el-button link type="danger" size="small" :disabled="!batchEditable" @click="removeStation(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <el-dialog v-model="submitVisible" title="提交复核" width="460px">
      <el-alert type="info" :closable="false" class="dialog-alert"
        title="提交后本批读数立即冻结，不能再改测点；复核通过前草图工作台不能选用。" />
      <el-form label-width="80px">
        <el-form-item label="提交人" required>
          <el-input v-model="submitForm.submittedBy" placeholder="测量记录员姓名" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="submitVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmSubmit">确认提交</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="reviewVisible"
      :title="reviewAction === 'approve' ? '复核通过' : '复核打回'"
      width="500px"
    >
      <el-alert
        :type="reviewAction === 'approve' ? 'success' : 'error'"
        :closable="false"
        class="dialog-alert"
        :title="reviewAction === 'approve' ? '通过后该批次定稿，草图工作台可选用。' : '打回后原批保留，测量员可从它重开一份草稿，原因会带过去。'"
      />
      <el-form label-width="80px">
        <el-form-item label="复核员" required>
          <el-input v-model="reviewForm.reviewer" placeholder="复核员姓名" />
        </el-form-item>
        <el-form-item v-if="reviewAction === 'reject'" label="打回原因" required>
          <el-input v-model="reviewForm.reason" type="textarea" :rows="3" placeholder="写明哪条读数有问题、需要如何复测" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reviewVisible = false">取消</el-button>
        <el-button :type="reviewAction === 'approve' ? 'success' : 'danger'" @click="confirmReview">
          {{ reviewAction === 'approve' ? '确认通过' : '确认打回' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.batch-card {
  border-radius: 12px;
  margin-bottom: 14px;
}
.batch-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.batch-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.batch-radio {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: auto;
  padding: 6px 12px;
}
.batch-code {
  font-weight: 600;
}
.batch-tag {
  margin: 0 2px;
}
.batch-actions {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
}
.alert-action {
  margin-top: 8px;
}
.dialog-alert {
  margin-bottom: 12px;
}
.form-card {
  border-radius: 12px;
  margin-bottom: 16px;
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
.alert {
  margin-bottom: 12px;
}
:deep(.abnormal-row) {
  background: #fdf2f2 !important;
}
:deep(.abnormal-row td) {
  color: #b03030;
}
</style>
