<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { BatchEvent, BatchStatus, Station, SurveyBatch } from '@/types'
import { BATCH_STATUS_LABELS } from '@/types'
import BatchStatusTag from '@/components/common/BatchStatusTag.vue'
import ClosureBadge from '@/components/common/ClosureBadge.vue'
import SegmentTag from '@/components/common/SegmentTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { useClosureCheck } from '@/hooks/useClosureCheck'
import { caveStore } from '@/stores/caveStore'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { batchStore, BatchFlowError } from '@/stores/batchStore'
import { computeClosure, formatDms } from '@/utils/survey'

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)
const batchState = useStore(batchStore)

type Filter = BatchStatus | 'all'
const filter = ref<Filter>('review')

const filteredBatches = computed<SurveyBatch[]>(() =>
  batchState.batches
    .filter((batch) => filter.value === 'all' || batch.status === filter.value)
    .sort((a, b) => {
      // 待复核优先置顶，其余按更新时间倒序
      if ((a.status === 'review') !== (b.status === 'review')) return a.status === 'review' ? -1 : 1
      return b.updatedAt.localeCompare(a.updatedAt)
    })
)

const pendingCount = computed(() => batchState.batches.filter((batch) => batch.status === 'review').length)

function caveNameOf(batch: SurveyBatch): string {
  const segment = segmentState.segments.find((item) => item.id === batch.segmentId)
  return caveState.caves.find((cave) => cave.id === segment?.caveId)?.name ?? '未归属洞穴'
}
function segmentOf(batch: SurveyBatch) {
  return segmentState.segments.find((item) => item.id === batch.segmentId)
}
function stationsOf(batch: SurveyBatch): Station[] {
  return stationState.stations
    .filter((station) => station.batchId === batch.id)
    .sort((a, b) => Number((a.code.match(/\d+/) ?? ['0'])[0]) - Number((b.code.match(/\d+/) ?? ['0'])[0]))
}
function closureOf(batch: SurveyBatch) {
  return computeClosure(stationsOf(batch))
}
function formatTime(iso: string): string {
  if (!iso) return '—'
  return iso.replace('T', ' ').slice(0, 16)
}

const EVENT_LABELS: Record<BatchEvent['type'], string> = {
  create: '建批',
  submit: '提交复核',
  approve: '复核通过',
  reject: '打回'
}

async function approve(batch: SurveyBatch): Promise<void> {
  try {
    const { value: reviewer } = await ElMessageBox.prompt('复核员签名', `通过批次「${batch.code}」`, {
      confirmButtonText: '下一步',
      cancelButtonText: '取消',
      inputValue: batch.reviewer,
      inputPlaceholder: '如 复核员·韦岑',
      inputValidator: (v: string) => (v && v.trim() ? true : '请填写复核员姓名')
    })
    const { value: note } = await ElMessageBox.prompt('复核备注（可留空）', `通过批次「${batch.code}」`, {
      confirmButtonText: '确认通过',
      cancelButtonText: '取消',
      inputType: 'textarea',
      inputValue: ''
    })
    await batchStore.getState().approve(batch.id, reviewer ?? '', note ?? '')
    ElMessage.success('批次已通过，草图工作台与图幅拼合已可选用')
  } catch (error) {
    if (error instanceof BatchFlowError) ElMessage.error(error.message)
  }
}

async function reject(batch: SurveyBatch): Promise<void> {
  try {
    const { value: reviewer } = await ElMessageBox.prompt('复核员签名', `打回批次「${batch.code}」`, {
      confirmButtonText: '下一步',
      cancelButtonText: '取消',
      inputValue: batch.reviewer,
      inputPlaceholder: '如 复核员·韦岑',
      inputValidator: (v: string) => (v && v.trim() ? true : '请填写复核员姓名')
    })
    const { value: reason } = await ElMessageBox.prompt(
      '打回原因（必填，会随新草稿带给测量记录员）',
      `打回批次「${batch.code}」`,
      {
        confirmButtonText: '确认打回',
        cancelButtonText: '取消',
        inputType: 'textarea',
        inputPlaceholder: '如：P3 方位角疑受铁架干扰，请复测；P5 斜距与草图比例不符。',
        inputValidator: (v: string) => (v && v.trim() ? true : '打回必须填写原因')
      }
    )
    await batchStore.getState().reject(batch.id, reviewer ?? '', reason ?? '')
    ElMessage.success('批次已打回，原批保留留痕')
  } catch (error) {
    if (error instanceof BatchFlowError) ElMessage.error(error.message)
  }
}

const detailBatch = ref<SurveyBatch | null>(null)
const detailStations = computed<Station[]>(() => (detailBatch.value ? stationsOf(detailBatch.value) : []))
const { result: detailClosure } = useClosureCheck(detailStations)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">复核台</h2>
        <p class="page-sub">
          记录员提交复核的批次在此冻结待审；通过后草图工作台才可选用，打回时原批保留、原因随新草稿带回。
        </p>
      </div>
      <el-tag :type="pendingCount > 0 ? 'warning' : 'success'" effect="dark" size="large">
        待复核 {{ pendingCount }} 批
      </el-tag>
    </div>

    <el-radio-group v-model="filter" class="filter">
      <el-radio-button label="review">待复核</el-radio-button>
      <el-radio-button label="draft">草稿</el-radio-button>
      <el-radio-button label="approved">已通过</el-radio-button>
      <el-radio-button label="rejected">已打回</el-radio-button>
      <el-radio-button label="all">全部</el-radio-button>
    </el-radio-group>

    <el-empty v-if="filteredBatches.length === 0" description="当前筛选下没有批次" />

    <div class="batch-grid">
      <el-card v-for="batch in filteredBatches" :key="batch.id" shadow="hover" class="batch-card">
        <div class="card-top">
          <div>
            <div class="batch-code">
              <b class="mono">{{ batch.code }}</b>
              <BatchStatusTag :status="batch.status" :legacy="batch.legacy" size="default" />
              <el-tag
                v-if="segmentOf(batch)?.activeBatchId === batch.id"
                type="success"
                effect="plain"
                size="small"
              >
                拼合中
              </el-tag>
            </div>
            <div class="muted cave-line">
              {{ caveNameOf(batch) }}
              <template v-if="segmentOf(batch)">
                ·
                <SegmentTag
                  :type="segmentOf(batch)!.type"
                  :code="segmentOf(batch)!.code"
                  :closed="segmentOf(batch)!.closed"
                  size="small"
                />
              </template>
            </div>
          </div>
          <el-tag effect="plain">{{ stationsOf(batch).length }} 站</el-tag>
        </div>

        <ClosureBadge
          v-if="stationsOf(batch).length > 0"
          class="closure"
          :closure="closureOf(batch).closure"
          :threshold="closureOf(batch).threshold"
          :level="closureOf(batch).level"
          :detail="closureOf(batch).detail"
          :count="stationsOf(batch).length"
        />
        <el-alert
          v-if="stationsOf(batch).length > 0 && closureOf(batch).over"
          class="alert"
          type="error"
          :closable="false"
          title="闭合差超限，请重点核对"
        />

        <div v-if="batch.note" class="note-block">建批备注：{{ batch.note }}</div>
        <el-alert
          v-if="batch.carriedReason"
          class="alert"
          type="warning"
          :closable="false"
          :title="`本批由打回批重开，带入原因：${batch.carriedReason}`"
        />
        <div v-if="batch.status === 'rejected'" class="note-block reject">
          最近打回原因：{{ batch.events.filter((e) => e.type === 'reject').slice(-1)[0]?.note || '—' }}
        </div>

        <el-timeline class="timeline">
          <el-timeline-item
            v-for="(event, index) in batch.events"
            :key="index"
            :timestamp="formatTime(event.at)"
            :type="event.type === 'reject' ? 'danger' : event.type === 'approve' ? 'success' : 'primary'"
          >
            <b>{{ EVENT_LABELS[event.type] }}</b> · {{ event.actor }}
            <div v-if="event.note" class="event-note">{{ event.note }}</div>
          </el-timeline-item>
        </el-timeline>

        <div class="card-actions">
          <el-button size="small" @click="detailBatch = batch">查看读数</el-button>
          <template v-if="batch.status === 'review'">
            <el-button size="small" type="success" @click="approve(batch)">复核通过</el-button>
            <el-button size="small" type="danger" plain @click="reject(batch)">打回</el-button>
          </template>
        </div>
      </el-card>
    </div>

    <el-dialog
      v-model="detailBatch"
      :title="detailBatch ? `批次「${detailBatch.code}」读数 · ${BATCH_STATUS_LABELS[detailBatch.status]}` : ''"
      width="860px"
    >
      <ClosureBadge
        v-if="detailStations.length > 0"
        class="closure"
        :closure="detailClosure.closure"
        :threshold="detailClosure.threshold"
        :level="detailClosure.level"
        :detail="detailClosure.detail"
        :count="detailStations.length"
      />
      <el-table :data="detailStations" border stripe size="small" max-height="420">
        <el-table-column prop="code" label="桩号" width="80" />
        <el-table-column label="方位角" width="150">
          <template #default="{ row }: { row: Station }">{{ row.bearing }}° / {{ formatDms(row.bearing) }}</template>
        </el-table-column>
        <el-table-column label="倾角" width="100">
          <template #default="{ row }: { row: Station }">{{ row.dip }}°</template>
        </el-table-column>
        <el-table-column prop="slopeDistance" label="斜距(m)" width="90" />
        <el-table-column prop="horizontalDistance" label="水平距(m)" width="100" />
        <el-table-column prop="verticalDistance" label="垂距(m)" width="90" />
        <el-table-column prop="surveyor" label="测量人" width="90" />
        <el-table-column prop="date" label="日期" width="110" />
        <el-table-column prop="note" label="备注" min-width="120" show-overflow-tooltip />
      </el-table>
      <template #footer>
        <el-button @click="detailBatch = null">关闭</el-button>
        <template v-if="detailBatch?.status === 'review'">
          <el-button type="success" @click="detailBatch && approve(detailBatch)">复核通过</el-button>
          <el-button type="danger" plain @click="detailBatch && reject(detailBatch)">打回</el-button>
        </template>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.filter {
  margin-bottom: 16px;
}
.batch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 14px;
}
.batch-card {
  border-radius: 12px;
}
.card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 10px;
}
.batch-code {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 15px;
}
.cave-line {
  margin-top: 4px;
  font-size: 12px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}
.closure {
  margin-bottom: 8px;
}
.alert {
  margin-bottom: 8px;
}
.note-block {
  font-size: 12px;
  color: #4a5b6b;
  background: #f5f8fb;
  border-radius: 8px;
  padding: 6px 10px;
  margin-bottom: 8px;
}
.note-block.reject {
  color: #b03030;
  background: #fdf2f2;
}
.timeline {
  margin: 8px 0 12px 4px;
}
.event-note {
  font-size: 12px;
  color: #6b7b8c;
}
.card-actions {
  display: flex;
  gap: 8px;
}
</style>
