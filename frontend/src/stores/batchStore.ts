import { createStore } from 'zustand/vanilla'
import type { BatchEvent, SurveyBatch } from '@/types'
import { nextBatchCode } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { segmentStore } from './segmentStore'
import { stationStore } from './stationStore'
import { mergeStore } from './mergeStore'
import { uid } from '@/utils/id'

export class BatchFlowError extends Error {}

export interface BatchState {
  batches: SurveyBatch[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 新开一份草稿（同一洞段同时只能有一份草稿/待复核批次） */
  createDraft: (segmentId: string, surveyor: string, note: string) => Promise<string>
  /** 提交复核：草稿冻结为待复核，读数不可再改 */
  submit: (id: string) => Promise<void>
  /** 复核通过：草图工作台与拼合才可选用 */
  approve: (id: string, reviewer: string, reviewNote: string) => Promise<void>
  /** 打回：原批保留为已打回，记录原因 */
  reject: (id: string, reviewer: string, reason: string) => Promise<void>
  /** 从已打回批次新开一份草稿，复制读数并把打回原因带过去 */
  forkDraft: (sourceBatchId: string, surveyor: string) => Promise<string>
  /** 作废草稿（仅草稿可删，连同其读数一起清理） */
  removeDraft: (id: string) => Promise<void>
  /** 选定洞段参与拼合的已通过批次（同洞段唯一，换批不混用拼合记录） */
  selectForMerge: (segmentId: string, batchId: string) => Promise<void>
  bySegment: (segmentId: string) => SurveyBatch[]
}

function nowIso(): string {
  return new Date().toISOString()
}

export const batchStore = createStore<BatchState>((set, get) => ({
  batches: [],
  loaded: false,

  hydrate: async () => {
    const batches = await syncAll<SurveyBatch>(db.batches)
    batches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    set({ batches, loaded: true })
  },

  createDraft: async (segmentId, surveyor, note) => {
    const segment = segmentStore.getState().segments.find((item) => item.id === segmentId)
    if (!segment) throw new BatchFlowError('洞段不存在，无法建批')
    const blocking = get().batches.find(
      (batch) => batch.segmentId === segmentId && (batch.status === 'draft' || batch.status === 'review')
    )
    if (blocking) {
      throw new BatchFlowError(`洞段已有${blocking.status === 'draft' ? '草稿' : '待复核'}批次「${blocking.code}」，请先处理`)
    }
    const siblingCodes = get()
      .batches.filter((batch) => batch.segmentId === segmentId)
      .map((batch) => batch.code)
    const id = uid('batch')
    const ts = nowIso()
    const batch: SurveyBatch = {
      id,
      segmentId,
      code: nextBatchCode(segment.code, siblingCodes),
      status: 'draft',
      surveyor: surveyor.trim(),
      note: note.trim(),
      carriedReason: '',
      forkedFromId: '',
      legacy: false,
      submittedAt: '',
      reviewedAt: '',
      reviewer: '',
      createdAt: ts,
      updatedAt: ts,
      events: [{ type: 'create', at: ts, actor: surveyor.trim() || '记录员' }]
    }
    await syncPut(db.batches, batch)
    await get().hydrate()
    return id
  },

  submit: async (id) => {
    const batch = get().batches.find((item) => item.id === id)
    if (!batch) throw new BatchFlowError('批次不存在')
    if (batch.status !== 'draft') throw new BatchFlowError('只有草稿批次可以提交复核')
    const stationCount = stationStore.getState().stations.filter((station) => station.batchId === id).length
    if (stationCount === 0) throw new BatchFlowError('该批次还没有任何测点读数，无法提交复核')
    const ts = nowIso()
    const next: SurveyBatch = {
      ...batch,
      status: 'review',
      submittedAt: ts,
      updatedAt: ts,
      events: [...batch.events, { type: 'submit', at: ts, actor: batch.surveyor || '记录员' }]
    }
    await syncPut(db.batches, next)
    await get().hydrate()
  },

  approve: async (id, reviewer, reviewNote) => {
    const batch = get().batches.find((item) => item.id === id)
    if (!batch) throw new BatchFlowError('批次不存在')
    if (batch.status !== 'review') throw new BatchFlowError('只有待复核批次可以复核通过')
    const ts = nowIso()
    const event: BatchEvent = {
      type: 'approve',
      at: ts,
      actor: reviewer.trim() || '复核员',
      note: reviewNote.trim()
    }
    const next: SurveyBatch = {
      ...batch,
      status: 'approved',
      reviewedAt: ts,
      reviewer: reviewer.trim() || '复核员',
      updatedAt: ts,
      events: [...batch.events, event]
    }
    await syncPut(db.batches, next)

    // 洞段还没有选定任何拼合批次时，首个通过的批次自动入选，开箱即可进草图/拼合
    const segment = segmentStore.getState().segments.find((item) => item.id === batch.segmentId)
    if (segment && !segment.activeBatchId) {
      await syncPut(db.segments, { ...segment, activeBatchId: id })
      await segmentStore.getState().hydrate()
    }
    await get().hydrate()
  },

  reject: async (id, reviewer, reason) => {
    if (!reason.trim()) throw new BatchFlowError('打回必须填写原因，原因会带到新草稿')
    const batch = get().batches.find((item) => item.id === id)
    if (!batch) throw new BatchFlowError('批次不存在')
    if (batch.status !== 'review') throw new BatchFlowError('只有待复核批次可以打回')
    const ts = nowIso()
    const event: BatchEvent = {
      type: 'reject',
      at: ts,
      actor: reviewer.trim() || '复核员',
      note: reason.trim()
    }
    // 原批保留：仅状态变为已打回，读数原样冻结留痕
    const next: SurveyBatch = {
      ...batch,
      status: 'rejected',
      reviewedAt: ts,
      reviewer: reviewer.trim() || '复核员',
      updatedAt: ts,
      events: [...batch.events, event]
    }
    await syncPut(db.batches, next)
    await get().hydrate()
  },

  forkDraft: async (sourceBatchId, surveyor) => {
    const source = get().batches.find((item) => item.id === sourceBatchId)
    if (!source) throw new BatchFlowError('来源批次不存在')
    if (source.status !== 'rejected') throw new BatchFlowError('只能从已打回批次新开草稿')
    const blocking = get().batches.find(
      (batch) => batch.segmentId === source.segmentId && (batch.status === 'draft' || batch.status === 'review')
    )
    if (blocking) {
      throw new BatchFlowError(`洞段已有${blocking.status === 'draft' ? '草稿' : '待复核'}批次「${blocking.code}」，请先处理`)
    }
    const segment = segmentStore.getState().segments.find((item) => item.id === source.segmentId)
    const siblingCodes = get()
      .batches.filter((batch) => batch.segmentId === source.segmentId)
      .map((batch) => batch.code)
    const id = uid('batch')
    const ts = nowIso()
    const reasonEvent = source.events.find((event) => event.type === 'reject')
    const carriedReason = source.events
      .filter((event) => event.type === 'reject')
      .map((event) => event.note ?? '')
      .filter(Boolean)
      .join('；')
    const batch: SurveyBatch = {
      id,
      segmentId: source.segmentId,
      code: nextBatchCode(segment?.code ?? 'SEG', siblingCodes),
      status: 'draft',
      surveyor: surveyor.trim() || source.surveyor,
      note: source.note,
      carriedReason,
      forkedFromId: source.id,
      legacy: false,
      submittedAt: '',
      reviewedAt: '',
      reviewer: '',
      createdAt: ts,
      updatedAt: ts,
      events: [
        {
          type: 'create',
          at: ts,
          actor: surveyor.trim() || source.surveyor || '记录员',
          note: reasonEvent ? `从打回批「${source.code}」重开，打回原因：${carriedReason}` : `从打回批「${source.code}」重开`
        }
      ]
    }
    await syncPut(db.batches, batch)

    // 复制来源批次的读数为新草稿读数（新 id，与原批互不影响）
    const sourceStations = stationStore.getState().stations.filter((station) => station.batchId === sourceBatchId)
    await db.stations.bulkPut(
      sourceStations.map((station) => ({ ...station, id: uid('st'), batchId: id }))
    )
    await stationStore.getState().hydrate()
    await get().hydrate()
    return id
  },

  removeDraft: async (id) => {
    const batch = get().batches.find((item) => item.id === id)
    if (!batch) throw new BatchFlowError('批次不存在')
    if (batch.status !== 'draft') throw new BatchFlowError('只有草稿批次可以作废，待复核/已通过/已打回批次均需留痕保留')
    await stationStore.getState().removeByBatch(id)
    await syncDelete(db.batches, id)
    await get().hydrate()
  },

  selectForMerge: async (segmentId, batchId) => {
    const batch = get().batches.find((item) => item.id === batchId)
    if (!batch || batch.segmentId !== segmentId) throw new BatchFlowError('批次不属于该洞段')
    if (batch.status !== 'approved') throw new BatchFlowError('只有复核通过的批次才能参与图幅拼合')
    const segment = segmentStore.getState().segments.find((item) => item.id === segmentId)
    if (!segment) throw new BatchFlowError('洞段不存在')
    await syncPut(db.segments, { ...segment, activeBatchId: batchId })
    await segmentStore.getState().hydrate()
  },

  bySegment: (segmentId) =>
    get()
      .batches.filter((batch) => batch.segmentId === segmentId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}))

/** 批次是否允许编辑读数：只有草稿可改；提交复核后整批冻结 */
export function batchWritable(batch: SurveyBatch | undefined): boolean {
  return batch?.status === 'draft'
}

/** 重新水合批次相关 store（给外部页面统一调用） */
export async function hydrateBatchStores(): Promise<void> {
  await mergeStore.getState().hydrate()
  await batchStore.getState().hydrate()
}
