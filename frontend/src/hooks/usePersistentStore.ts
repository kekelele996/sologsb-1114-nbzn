import { onUnmounted, reactive } from 'vue'
import type { StoreApi } from 'zustand/vanilla'
import Dexie, { type Table } from 'dexie'
import type { Cave, MergeRecord, Segment, Sketch, Station, SurveyBatch } from '@/types'
import { nextBatchCode } from '@/types'
import { computeHorizontal, computeVertical } from '@/utils/survey'
import { uid } from '@/utils/id'

/** IndexedDB 数据结构版本号（升级迁移时使用） */
export const SCHEMA_VERSION = 3

export interface MetaRow {
  key: string
  value: number
}

/** Dexie 封装：洞穴 / 洞段 / 测点 / 草图 / 批次 / 拼合记录 六张表 + 元数据表 */
class CaveSurveyDb extends Dexie {
  caves!: Table<Cave, string>
  segments!: Table<Segment, string>
  stations!: Table<Station, string>
  sketches!: Table<Sketch, string>
  batches!: Table<SurveyBatch, string>
  merges!: Table<MergeRecord, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('gbcavesurvey')
    this.version(1).stores({
      caves: 'id, name, region',
      segments: 'id, caveId, code',
      stations: 'id, segmentId, code',
      sketches: 'id, segmentId, code',
      meta: 'key'
    })
    // v2：旧版测点记录缺少水平距/垂距，迁移时由斜距 + 倾角补齐
    this.version(2)
      .stores({
        caves: 'id, name, region, archived',
        segments: 'id, caveId, code, type',
        stations: 'id, segmentId, code, date',
        sketches: 'id, segmentId, code, mergeOrder',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        await tx
          .table<Station, string>('stations')
          .toCollection()
          .modify((station) => {
            if (!Number.isFinite(station.horizontalDistance)) {
              station.horizontalDistance = computeHorizontal(station.dip, station.slopeDistance)
            }
            if (!Number.isFinite(station.verticalDistance)) {
              station.verticalDistance = computeVertical(station.dip, station.slopeDistance)
            }
          })
      })
    // v3：引入测量批次与按批次存档的拼合记录。
    // 升级前留下的测点/草图按洞段各归到一个「可追溯的旧批」（已通过状态），
    // 并把该旧批选为洞段当前参与拼合的批次；旧批草图的拼合顺序迁入拼合记录。
    this.version(SCHEMA_VERSION)
      .stores({
        caves: 'id, name, region, archived',
        segments: 'id, caveId, code, type',
        stations: 'id, segmentId, batchId, code, date',
        sketches: 'id, segmentId, batchId, code, mergeOrder',
        batches: 'id, segmentId, code, status',
        merges: 'batchId, segmentId',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        const nowIso = new Date().toISOString()
        const today = nowIso.slice(0, 10)
        const stationTable = tx.table<Station, string>('stations')
        const sketchTable = tx.table<Sketch, string>('sketches')
        const segmentTable = tx.table<Segment, string>('segments')

        const [segments, stations, sketches] = await Promise.all([
          segmentTable.toArray(),
          stationTable.toArray(),
          sketchTable.toArray()
        ])

        // 升级事务内 batches / merges 表已按新 schema 建好，按名取用
        const batchesTableV3 = tx.table<SurveyBatch, string>('batches')
        const mergesTableV3 = tx.table<MergeRecord, string>('merges')

        const legacyBatches: SurveyBatch[] = []
        const legacyBatchBySegment = new Map<string, string>()

        for (const segment of segments) {
          const ownStations = stations.filter((station) => station.segmentId === segment.id)
          const ownSketches = sketches.filter((sketch) => sketch.segmentId === segment.id)
          if (ownStations.length === 0 && ownSketches.length === 0) {
            // 没有历史读数的洞段不需要旧批
            continue
          }
          const existingCodes = legacyBatches
            .filter((batch) => batch.segmentId === segment.id)
            .map((batch) => batch.code)
          const batchId = uid('batch')
          const code = nextBatchCode(segment.code, existingCodes, true)
          const legacyBatch: SurveyBatch = {
            id: batchId,
            segmentId: segment.id,
            code,
            status: 'approved',
            surveyor: '',
            note: '系统升级前的历史测量数据，迁移时自动归集为本洞段的旧批。',
            carriedReason: '',
            forkedFromId: '',
            legacy: true,
            submittedAt: '',
            reviewedAt: nowIso,
            reviewer: '系统迁移',
            createdAt: nowIso,
            updatedAt: nowIso,
            events: [
              {
                type: 'approve',
                at: `${today} 系统升级`,
                actor: '系统迁移',
                note: '升级前历史数据自动归集为可追溯旧批'
              }
            ]
          }
          legacyBatches.push(legacyBatch)
          legacyBatchBySegment.set(segment.id, batchId)

          const orderedSketches = [...ownSketches].sort((a, b) => a.mergeOrder - b.mergeOrder)
          if (orderedSketches.length > 0) {
            await mergesTableV3.put({
              batchId,
              segmentId: segment.id,
              updatedAt: nowIso,
              items: orderedSketches.map((sketch, index) => ({
                sketchId: sketch.id,
                order: index + 1,
                offset: 0,
                snapped: false
              }))
            })
          }
        }

        await batchesTableV3.bulkPut(legacyBatches)

        await stationTable.toCollection().modify((station) => {
          const batchId = legacyBatchBySegment.get(station.segmentId)
          if (batchId) station.batchId = batchId
        })
        await sketchTable.toCollection().modify((sketch) => {
          const batchId = legacyBatchBySegment.get(sketch.segmentId)
          if (batchId) sketch.batchId = batchId
        })
        await segmentTable.toCollection().modify((segment) => {
          const batchId = legacyBatchBySegment.get(segment.id)
          if (batchId) segment.activeBatchId = batchId
        })
      })
  }
}

export const db = new CaveSurveyDb()

/** 记录当前数据结构版本号，便于后续升级判断 */
export async function stampDbVersion(): Promise<void> {
  await db.meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION })
}

/** 读取表内全部记录 */
export async function syncAll<T extends object>(table: Table<T, string>): Promise<T[]> {
  return table.toArray()
}

/** 写入（新增或更新）一条记录 */
export async function syncPut<T extends object>(table: Table<T, string>, row: T): Promise<void> {
  await table.put(row)
}

/** 删除一条记录 */
export async function syncDelete<T extends object>(table: Table<T, string>, id: string): Promise<void> {
  await table.delete(id)
}

/** 按条件统计记录数 */
export async function countBy<T extends object>(table: Table<T, string>, predicate: (row: T) => boolean): Promise<number> {
  const rows = await table.toArray()
  return rows.filter(predicate).length
}

/**
 * 把 Zustand 的 vanilla store 桥接到 Vue 响应式状态。
 * store 变化时同步到 reactive 对象，组件卸载时取消订阅。
 */
export function useStore<T extends object>(store: StoreApi<T>): T {
  const state = reactive({ ...store.getState() }) as T
  const unsubscribe = store.subscribe((next: T) => {
    Object.assign(state, next)
  })
  onUnmounted(() => unsubscribe())
  return state
}

/**
 * 首次打开时写入一套示例洞穴数据，保证各页面进入即有事可做。
 * 只在洞穴表为空时执行一次。示例数据同样走「已通过批次」，
 * 保证草图工作台与图幅拼合开箱即用。
 */
export async function seedDemoData(): Promise<void> {
  const caveCount = await db.caves.count()
  if (caveCount > 0) return

  const caveId = 'cave_demo_001'
  const segmentA = 'seg_demo_001'
  const segmentB = 'seg_demo_002'
  const batchA = 'batch_demo_001'
  const batchB = 'batch_demo_002'

  const nowIso = new Date().toISOString()
  const today = nowIso.slice(0, 10)

  await db.caves.put({
    id: caveId,
    name: '青龙背斜溶洞',
    region: '黔南州 · 平塘县',
    longitude: 107.2136,
    latitude: 25.8123,
    altitude: 986.4,
    layer: '二叠系下统栖霞组灰岩',
    knownLength: 1240,
    startDate: today,
    surveyor: '陆昀',
    climateNote: '洞内 16.2℃，相对湿度 94%，中段有滴水',
    archived: false,
    createdAt: nowIso
  })

  await db.segments.bulkPut([
    {
      id: segmentA,
      caveId,
      code: 'C-01',
      startStake: 'K0+000',
      endStake: 'K0+120',
      type: '廊道',
      avgWidth: 2.4,
      avgHeight: 3.1,
      slopeTrend: '缓升 3°',
      closed: false,
      activeBatchId: batchA,
      sketchNo: 'S-01'
    },
    {
      id: segmentB,
      caveId,
      code: 'C-02',
      startStake: 'K0+120',
      endStake: 'K0+195',
      type: '竖井',
      avgWidth: 1.6,
      avgHeight: 12.5,
      slopeTrend: '陡降 68°',
      closed: true,
      activeBatchId: batchB,
      sketchNo: 'S-02'
    }
  ])

  await db.batches.bulkPut([
    {
      id: batchA,
      segmentId: segmentA,
      code: 'C-01-B1',
      status: 'approved',
      surveyor: '陆昀',
      note: '入口廊道首测，读数稳定。',
      carriedReason: '',
      forkedFromId: '',
      legacy: false,
      submittedAt: nowIso,
      reviewedAt: nowIso,
      reviewer: '复核员·韦岑',
      createdAt: nowIso,
      updatedAt: nowIso,
      events: [
        { type: 'create', at: nowIso, actor: '陆昀' },
        { type: 'submit', at: nowIso, actor: '陆昀' },
        { type: 'approve', at: nowIso, actor: '复核员·韦岑', note: '闭合差合格' }
      ]
    },
    {
      id: batchB,
      segmentId: segmentB,
      code: 'C-02-B1',
      status: 'approved',
      surveyor: '陆昀',
      note: '竖井段首测。',
      carriedReason: '',
      forkedFromId: '',
      legacy: false,
      submittedAt: nowIso,
      reviewedAt: nowIso,
      reviewer: '复核员·韦岑',
      createdAt: nowIso,
      updatedAt: nowIso,
      events: [
        { type: 'create', at: nowIso, actor: '陆昀' },
        { type: 'submit', at: nowIso, actor: '陆昀' },
        { type: 'approve', at: nowIso, actor: '复核员·韦岑', note: '竖井剖面读数齐全' }
      ]
    }
  ])

  await db.stations.bulkPut([
    {
      id: 'st_demo_001',
      segmentId: segmentA,
      batchId: batchA,
      code: 'P1',
      bearing: 118.5,
      dip: -2.5,
      slopeDistance: 12.4,
      horizontalDistance: computeHorizontal(-2.5, 12.4),
      verticalDistance: computeVertical(-2.5, 12.4),
      instrumentNo: 'SOKKIA-2',
      surveyor: '陆昀',
      date: today,
      isClosurePoint: false,
      note: '入口段，左壁有崩塌堆积'
    },
    {
      id: 'st_demo_002',
      segmentId: segmentA,
      batchId: batchA,
      code: 'P2',
      bearing: 121.2,
      dip: -1.8,
      slopeDistance: 15.8,
      horizontalDistance: computeHorizontal(-1.8, 15.8),
      verticalDistance: computeVertical(-1.8, 15.8),
      instrumentNo: 'SOKKIA-2',
      surveyor: '陆昀',
      date: today,
      isClosurePoint: true,
      note: '本段末站，已与 C-02 起点核对'
    }
  ])

  await db.sketches.bulkPut([
    {
      id: 'sk_demo_001',
      segmentId: segmentA,
      batchId: batchA,
      code: 'S-01',
      gridCount: 48,
      scale: 200,
      author: '陆昀',
      mergeOrder: 1,
      anchorStake: 'K0+000',
      imageNote: '平面展开草图，坐标纸 48 格，含左壁支护标注'
    },
    {
      id: 'sk_demo_002',
      segmentId: segmentB,
      batchId: batchB,
      code: 'S-02',
      gridCount: 30,
      scale: 200,
      author: '覃羽',
      mergeOrder: 1,
      anchorStake: 'K0+120',
      imageNote: '竖井剖面草图，标注三处锚点'
    }
  ])

  await db.merges.bulkPut([
    {
      batchId: batchA,
      segmentId: segmentA,
      updatedAt: nowIso,
      items: [{ sketchId: 'sk_demo_001', order: 1, offset: 0, snapped: false }]
    },
    {
      batchId: batchB,
      segmentId: segmentB,
      updatedAt: nowIso,
      items: [{ sketchId: 'sk_demo_002', order: 1, offset: 0, snapped: false }]
    }
  ])
}
