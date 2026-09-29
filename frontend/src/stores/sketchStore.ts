import { createStore } from 'zustand/vanilla'
import type { Sketch } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { batchStore } from '@/stores/batchStore'

export interface SketchState {
  sketches: Sketch[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (sketch: Sketch) => Promise<void>
  remove: (id: string) => Promise<void>
  reorder: (orderedIds: string[]) => Promise<void>
}

/** 草图只能建立在已通过复核的批次上（打回/待复核批次不可选用） */
function assertBatchApproved(batchId: string): void {
  const batch = batchStore.getState().batches.find((item) => item.id === batchId)
  if (!batch || batch.status !== 'approved') {
    throw new Error('只有复核通过的批次才能在草图工作台选用')
  }
}

export const sketchStore = createStore<SketchState>((set, get) => ({
  sketches: [],
  loaded: false,
  hydrate: async () => {
    const sketches = await syncAll<Sketch>(db.sketches)
    sketches.sort((a, b) => a.mergeOrder - b.mergeOrder)
    set({ sketches, loaded: true })
  },
  save: async (sketch) => {
    assertBatchApproved(sketch.batchId)
    await syncPut<Sketch>(db.sketches, sketch)
    await get().hydrate()
  },
  remove: async (id) => {
    const existing = get().sketches.find((sketch) => sketch.id === id)
    if (existing) assertBatchApproved(existing.batchId)
    await syncDelete(db.sketches, id)
    await get().hydrate()
  },
  reorder: async (orderedIds) => {
    const all = get().sketches
    await Promise.all(
      orderedIds.map((id, index) => {
        const target = all.find((item) => item.id === id)
        return target ? syncPut<Sketch>(db.sketches, { ...target, mergeOrder: index + 1 }) : Promise.resolve()
      })
    )
    await get().hydrate()
  }
}))
