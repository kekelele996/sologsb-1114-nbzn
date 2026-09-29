import { createStore } from 'zustand/vanilla'
import type { Segment, SegmentType } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'

export interface SegmentState {
  segments: Segment[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (segment: Segment) => Promise<void>
  remove: (id: string) => Promise<void>
  removeByCave: (caveId: string) => Promise<void>
  bulkSetType: (ids: string[], type: SegmentType) => Promise<void>
  bulkSetClosed: (ids: string[], closed: boolean) => Promise<void>
}

export const segmentStore = createStore<SegmentState>((set, get) => ({
  segments: [],
  loaded: false,
  hydrate: async () => {
    const segments = await syncAll<Segment>(db.segments)
    segments.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
    set({ segments, loaded: true })
  },
  save: async (segment) => {
    await syncPut<Segment>(db.segments, segment)
    await get().hydrate()
  },
  remove: async (id) => {
    // 洞段删除是物理清理：其下所有批次、测点、草图与按批存档的拼合记录一并删除。
    // 业务页面会先拦截仍有数据的洞段，这里只保证不会留下孤儿记录。
    const batches = await db.batches.where('segmentId').equals(id).primaryKeys()
    await db.stations.where('segmentId').equals(id).delete()
    await db.sketches.where('segmentId').equals(id).delete()
    await db.merges.where('segmentId').equals(id).delete()
    await db.batches.bulkDelete(batches)
    await syncDelete(db.segments, id)
    await get().hydrate()
  },
  removeByCave: async (caveId) => {
    const segments = get().segments.filter((item) => item.caveId === caveId)
    for (const segment of segments) {
      const batches = await db.batches.where('segmentId').equals(segment.id).primaryKeys()
      await db.stations.where('segmentId').equals(segment.id).delete()
      await db.sketches.where('segmentId').equals(segment.id).delete()
      await db.merges.where('segmentId').equals(segment.id).delete()
      await db.batches.bulkDelete(batches)
    }
    const ids = segments.map((item) => item.id)
    await db.segments.bulkDelete(ids)
    await get().hydrate()
  },
  bulkSetType: async (ids, type) => {
    await Promise.all(
      get()
        .segments.filter((item) => ids.includes(item.id))
        .map((item) => syncPut<Segment>(db.segments, { ...item, type }))
    )
    await get().hydrate()
  },
  bulkSetClosed: async (ids, closed) => {
    await Promise.all(
      get()
        .segments.filter((item) => ids.includes(item.id))
        .map((item) => syncPut<Segment>(db.segments, { ...item, closed }))
    )
    await get().hydrate()
  }
}))
