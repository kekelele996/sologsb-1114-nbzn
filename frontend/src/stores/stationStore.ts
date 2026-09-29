import { createStore } from 'zustand/vanilla'
import type { Station } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { batchStore } from '@/stores/batchStore'

export interface StationState {
  stations: Station[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (station: Station) => Promise<void>
  remove: (id: string) => Promise<void>
}

/** 读数只允许挂在草稿批次下；提交复核后整批冻结 */
function assertBatchWritable(batchId: string): void {
  const batch = batchStore.getState().batches.find((item) => item.id === batchId)
  if (batch && batch.status !== 'draft') {
    throw new Error(`批次「${batch.code}」已提交复核并冻结，读数不能修改；如被打回请重开草稿`)
  }
}

export const stationStore = createStore<StationState>((set, get) => ({
  stations: [],
  loaded: false,
  hydrate: async () => {
    const stations = await syncAll<Station>(db.stations)
    stations.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true }))
    set({ stations, loaded: true })
  },
  save: async (station) => {
    assertBatchWritable(station.batchId)
    await syncPut<Station>(db.stations, station)
    await get().hydrate()
  },
  remove: async (id) => {
    const existing = get().stations.find((station) => station.id === id)
    if (existing) assertBatchWritable(existing.batchId)
    await syncDelete(db.stations, id)
    await get().hydrate()
  }
}))
