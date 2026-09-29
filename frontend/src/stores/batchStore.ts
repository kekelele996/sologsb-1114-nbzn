import { createStore } from 'zustand/vanilla'
import type { BatchStatus, Segment, Sketch, SurveyBatch } from '@/types'
import { db, syncAll, syncPut } from '@/hooks/usePersistentStore'
import { segmentStore } from '@/stores/segmentStore'
import { sketchStore } from '@/stores/sketchStore'
import { uid } from '@/utils/id'

export interface BatchState {
  batches: SurveyBatch[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 在洞段下新开一份空白草稿 */
  createDraft: (segmentId: string) => Promise<SurveyBatch>
  /** 提交复核：草稿 → 待复核，批次读数从此冻结 */
  submit: (id: string, submittedBy: string) => Promise<void>
  /** 复核通过：待复核 → 已通过 */
  approve: (id: string, reviewer: string) => Promise<void>
  /** 复核打回：待复核 → 已打回，原批保留并记录原因 */
  reject: (id: string, reviewer: string, reason: string) => Promise<void>
  /** 从已打回批次重开一份草稿，读数复制、原因带过去 */
  reopenFromRejected: (id: string) => Promise<SurveyBatch>
  /** 选定（或取消）洞段参与图幅拼合的已通过批次；切换时清掉新批旧有的拼合顺序 */
  selectForMerge: (segmentId: string, batchId: string) => Promise<void>
}

function nextBatchCode(all: SurveyBatch[], segmentId: string): string {
  const used = all
    .filter((batch) => batch.segmentId === segmentId)
    .map((batch) => /^B-(\d+)$/.exec(batch.code)?.[1] ?? '')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
  const max = used.length > 0 ? Math.max(...used) : 0
  return `B-${String(max + 1).padStart(2, '0')}`
}

export const batchStore = createStore<BatchState>((set, get) => ({
  batches: [],
  loaded: false,
  hydrate: async () => {
    const batches = await syncAll<SurveyBatch>(db.surveyBatches)
    // 同洞段按编号升序，旧批（B-OLD）沉底
    batches.sort((a, b) => {
      if (a.segmentId !== b.segmentId) return a.segmentId.localeCompare(b.segmentId)
      if (a.code === 'B-OLD') return 1
      if (b.code === 'B-OLD') return -1
      return a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true })
    })
    set({ batches, loaded: true })
  },

  createDraft: async (segmentId) => {
    const all = get().batches
    if (all.some((batch) => batch.segmentId === segmentId && batch.status === 'draft')) {
      throw new Error('该洞段已有草稿批次，请先提交或继续编辑现有草稿')
    }
    const now = new Date().toISOString()
    const batch: SurveyBatch = {
      id: uid('batch'),
      segmentId,
      code: nextBatchCode(all, segmentId),
      status: 'draft',
      submittedBy: '',
      submittedAt: '',
      reviewedBy: '',
      reviewedAt: '',
      rejectReason: '',
      carriedReason: '',
      originBatchId: '',
      legacy: false,
      createdAt: now,
      updatedAt: now
    }
    await syncPut(db.surveyBatches, batch)
    await get().hydrate()
    return batch
  },

  submit: async (id, submittedBy) => {
    const target = get().batches.find((batch) => batch.id === id)
    if (!target) throw new Error('批次不存在')
    if (target.status !== 'draft') throw new Error('只有草稿批次可以提交复核')
    const now = new Date().toISOString()
    await syncPut<SurveyBatch>(db.surveyBatches, {
      ...target,
      status: 'reviewing',
      submittedBy: submittedBy.trim(),
      submittedAt: now,
      updatedAt: now
    })
    await get().hydrate()
  },

  approve: async (id, reviewer) => {
    const target = get().batches.find((batch) => batch.id === id)
    if (!target) throw new Error('批次不存在')
    if (target.status !== 'reviewing') throw new Error('只有待复核批次可以复核通过')
    const now = new Date().toISOString()
    await syncPut<SurveyBatch>(db.surveyBatches, {
      ...target,
      status: 'approved',
      reviewedBy: reviewer.trim(),
      reviewedAt: now,
      rejectReason: '',
      updatedAt: now
    })
    await get().hydrate()
  },

  reject: async (id, reviewer, reason) => {
    const target = get().batches.find((batch) => batch.id === id)
    if (!target) throw new Error('批次不存在')
    if (target.status !== 'reviewing') throw new Error('只有待复核批次可以打回')
    if (!reason.trim()) throw new Error('打回时必须填写原因')
    const now = new Date().toISOString()
    await syncPut<SurveyBatch>(db.surveyBatches, {
      ...target,
      status: 'rejected',
      reviewedBy: reviewer.trim(),
      reviewedAt: now,
      rejectReason: reason.trim(),
      updatedAt: now
    })
    await get().hydrate()
  },

  reopenFromRejected: async (id) => {
    const source = get().batches.find((batch) => batch.id === id)
    if (!source) throw new Error('批次不存在')
    if (source.status !== 'rejected') throw new Error('只能从已打回批次重开草稿')
    if (get().batches.some((batch) => batch.segmentId === source.segmentId && batch.status === 'draft')) {
      throw new Error('该洞段已有草稿批次，请先处理现有草稿')
    }

    const now = new Date().toISOString()
    const draft: SurveyBatch = {
      ...source,
      id: uid('batch'),
      code: nextBatchCode(get().batches, source.segmentId),
      status: 'draft',
      submittedBy: '',
      submittedAt: '',
      reviewedBy: '',
      reviewedAt: '',
      rejectReason: '',
      carriedReason: source.rejectReason,
      originBatchId: source.id,
      legacy: false,
      createdAt: now,
      updatedAt: now
    }
    await syncPut(db.surveyBatches, draft)

    // 把原批读数原样复制到新草稿（新 id），原批保留不动
    const stations = await db.stations.where('batchId').equals(source.id).toArray()
    await db.stations.bulkPut(
      stations.map((station) => ({ ...station, id: uid('st'), batchId: draft.id }))
    )

    await get().hydrate()
    return draft
  },

  selectForMerge: async (segmentId, batchId) => {
    if (batchId) {
      const target = get().batches.find((batch) => batch.id === batchId)
      if (!target || target.segmentId !== segmentId || target.status !== 'approved') {
        throw new Error('只能选择本洞段已通过的批次参与拼合')
      }
    }

    await segmentStore.getState().setActiveBatch(segmentId, batchId)

    // 重新参与拼合时重排本批拼合顺序：接上其他洞段已选批次的最大顺序号，
    // 保证上一批的拖动/对齐结果不会和新批记录混在一起，跨洞段顺序也不撞号。
    const [allSketches, allSegments] = await Promise.all([
      syncAll<Sketch>(db.sketches),
      syncAll<Segment>(db.segments)
    ])
    const otherActiveBatchIds = new Set(
      allSegments
        .filter((segment) => segment.id !== segmentId)
        .map((segment) => segment.activeBatchId)
        .filter(Boolean)
    )
    const offset = allSketches
      .filter((sketch) => otherActiveBatchIds.has(sketch.batchId))
      .reduce((max, sketch) => Math.max(max, sketch.mergeOrder), 0)
    const sketches = allSketches
      .filter((sketch) => sketch.segmentId === segmentId && sketch.batchId === batchId)
      .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true }))
    await Promise.all(
      sketches.map((sketch, index) => syncPut<Sketch>(db.sketches, { ...sketch, mergeOrder: offset + index + 1 }))
    )
    await sketchStore.getState().hydrate()
    await segmentStore.getState().hydrate()
  }
}))

/** 批次是否允许编辑测点读数：只有草稿可改，提交即冻结 */
export function isBatchEditable(status: BatchStatus | undefined): boolean {
  return status === 'draft'
}
