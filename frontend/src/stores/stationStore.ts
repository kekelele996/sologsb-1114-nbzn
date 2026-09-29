import { createStore } from 'zustand/vanilla'
import type { Station } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'

export interface StationState {
  stations: Station[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (station: Station) => Promise<void>
  remove: (id: string) => Promise<void>
  /** 删除某批次下全部读数（草稿作废/新开草稿替换时使用） */
  removeByBatch: (batchId: string) => Promise<void>
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
    await syncPut<Station>(db.stations, station)
    await get().hydrate()
  },
  remove: async (id) => {
    await syncDelete(db.stations, id)
    await get().hydrate()
  },
  removeByBatch: async (batchId) => {
    const ids = get()
      .stations.filter((station) => station.batchId === batchId)
      .map((station) => station.id)
    await db.stations.bulkDelete(ids)
    await get().hydrate()
  }
}))
