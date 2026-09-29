import { createStore } from 'zustand/vanilla'
import type { MergeItem, MergeRecord } from '@/types'
import { db, syncAll, syncPut } from '@/hooks/usePersistentStore'

export interface MergeState {
  /** 按批次 id 索引的拼合记录；换批次读取各自存档，偏移/吸附/顺序互不串扰 */
  records: Record<string, MergeRecord>
  loaded: boolean
  hydrate: () => Promise<void>
  getRecord: (batchId: string) => MergeRecord | undefined
  /** 用当前工作台上的图幅排列覆盖存档某一批次（仅在其选定拼合期间允许） */
  saveRecord: (batchId: string, segmentId: string, items: MergeItem[]) => Promise<void>
  /** 某洞段切换拼合批次后，新批若还没有记录，按其草图初始化一份空排列 */
  ensureRecord: (batchId: string, segmentId: string, sketchIds: string[]) => Promise<MergeRecord>
}

function sortItems(items: MergeItem[]): MergeItem[] {
  return [...items].sort((a, b) => a.order - b.order)
}

export const mergeStore = createStore<MergeState>((set, get) => ({
  records: {},
  loaded: false,

  hydrate: async () => {
    const rows = await syncAll<MergeRecord>(db.merges)
    const records: Record<string, MergeRecord> = {}
    for (const row of rows) records[row.batchId] = row
    set({ records, loaded: true })
  },

  getRecord: (batchId) => get().records[batchId],

  saveRecord: async (batchId, segmentId, items) => {
    const record: MergeRecord = {
      batchId,
      segmentId,
      items: sortItems(items),
      updatedAt: new Date().toISOString()
    }
    await syncPut<MergeRecord>(db.merges, record)
    set((state) => ({ records: { ...state.records, [batchId]: record } }))
  },

  ensureRecord: async (batchId, segmentId, sketchIds) => {
    const existing = get().records[batchId]
    if (existing) return existing
    const record: MergeRecord = {
      batchId,
      segmentId,
      updatedAt: new Date().toISOString(),
      items: sketchIds.map((sketchId, index) => ({
        sketchId,
        order: index + 1,
        offset: 0,
        snapped: false
      }))
    }
    await syncPut<MergeRecord>(db.merges, record)
    set((state) => ({ records: { ...state.records, [batchId]: record } }))
    return record
  }
}))

/** 把草图清单与存档排列合并成有序拼合项；存档缺失的草图追加到队尾 */
export function mergeItemsOf(record: MergeRecord | undefined, orderedSketchIds: string[]): MergeItem[] {
  const map = new Map(record?.items.map((item) => [item.sketchId, item]))
  const used = new Set<string>()
  const items: MergeItem[] = []
  for (const sketchId of orderedSketchIds) {
    const saved = map.get(sketchId)
    if (saved) {
      items.push(saved)
      used.add(sketchId)
    }
  }
  let order = items.length
  for (const sketchId of orderedSketchIds) {
    if (used.has(sketchId)) continue
    order += 1
    items.push({ sketchId, order, offset: 0, snapped: false })
  }
  return sortItems(items)
}
