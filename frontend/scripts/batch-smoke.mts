// 批次状态机 + v2→v3 旧数据迁移的冒烟测试（Node + fake-indexeddb）
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

function assertEq(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
}
function assertOk(value: unknown, msg: string) {
  if (!value) throw new Error(msg)
}

// ---------- 第一阶段：以 v2 结构写入旧数据 ----------
// 每个阶段用全新的 IDBFactory，确保连接重建触发升级
globalThis.indexedDB = new IDBFactory()
const DexieMod = await import('dexie')
const Dexie = DexieMod.default

const oldDb = new Dexie('gbcavesurvey')
oldDb.version(2).stores({
  caves: 'id, name, region, archived',
  segments: 'id, caveId, code, type',
  stations: 'id, segmentId, code, date',
  sketches: 'id, segmentId, code, mergeOrder',
  meta: 'key'
})

const now = new Date().toISOString()
await oldDb.caves.bulkPut([
  { id: 'cave1', name: '老洞', region: '黔', archived: false, createdAt: now }
])
await oldDb.segments.bulkPut([
  { id: 'seg1', caveId: 'cave1', code: 'C-01', startStake: 'K0+000', endStake: 'K0+050', sketchNo: '' },
  { id: 'seg2', caveId: 'cave1', code: 'C-02', startStake: 'K0+050', endStake: 'K0+090', sketchNo: '' }
])
await oldDb.stations.bulkPut([
  { id: 's1', segmentId: 'seg1', code: 'P1', bearing: 90, dip: 0, slopeDistance: 10, horizontalDistance: 10, verticalDistance: 0 },
  { id: 's2', segmentId: 'seg1', code: 'P2', bearing: 90, dip: 0, slopeDistance: 10, horizontalDistance: 10, verticalDistance: 0 }
])
await oldDb.sketches.bulkPut([
  { id: 'k1', segmentId: 'seg1', code: 'S-01', gridCount: 40, scale: 200, author: '甲', mergeOrder: 1, anchorStake: 'K0+000', imageNote: '' }
])
await oldDb.close()

// ---------- 第二阶段：打开当前 v3，触发升级迁移 ----------
const { db, SCHEMA_VERSION } = await import('../src/hooks/usePersistentStore.ts')
assertEq(SCHEMA_VERSION, 3, 'schema 版本')

const [segs, stations, sketches, batches] = await Promise.all([
  db.segments.toArray(),
  db.stations.toArray(),
  db.sketches.toArray(),
  db.surveyBatches.toArray()
])

assertEq(batches.length, 1, '只有 seg1（有测点/草图）应生成 1 个旧批')
const legacy = batches[0]
assertEq(legacy.segmentId, 'seg1', '旧批归到 seg1')
assertEq(legacy.status, 'approved', '旧批状态为已通过')
assertEq(legacy.legacy, true, '旧批带 legacy 标记')
assertEq(legacy.code, 'B-OLD', '旧批编号 B-OLD')
assertOk(stations.every((s) => s.batchId === legacy.id), '旧测点全部挂到旧批')
assertOk(sketches.every((s) => s.batchId === legacy.id), '旧草图全部挂到旧批')
assertEq(segs.find((s) => s.id === 'seg1')?.activeBatchId, legacy.id, 'seg1 自动选中旧批参与拼合')
assertEq(segs.find((s) => s.id === 'seg2')?.activeBatchId, '', '无数据的 seg2 不选批')

// ---------- 第三阶段：状态机 ----------
const { batchStore } = await import('../src/stores/batchStore.ts')
const { segmentStore } = await import('../src/stores/segmentStore.ts')
await segmentStore.getState().hydrate()
await batchStore.getState().hydrate()

// 新开草稿
const draft = await batchStore.getState().createDraft('seg2')
assertEq(draft.code, 'B-01', '新洞段首个草稿编号 B-01')
assertEq(draft.status, 'draft', '新批为草稿')

// 同洞段不能有两份草稿
await assertRejects(() => batchStore.getState().createDraft('seg2'), /已有草稿/, '重复草稿应报错')

// 提交复核 → 冻结：尝试改读数应被拒
await batchStore.getState().submit(draft.id, '记录员甲')
const { stationStore } = await import('../src/stores/stationStore.ts')
await stationStore.getState().hydrate()
await assertRejects(
  () =>
    stationStore.getState().save({
      id: 'x1', segmentId: 'seg2', batchId: draft.id, code: 'P1', bearing: 1, dip: 0,
      slopeDistance: 5, horizontalDistance: 5, verticalDistance: 0, instrumentNo: '', surveyor: '', date: '', isClosurePoint: false, note: ''
    }),
  /冻结/,
  '待复核批次读数必须冻结'
)

// 打回必须填原因
await assertRejects(() => batchStore.getState().reject(draft.id, '复核员乙', '  '), /原因/, '空打回原因应报错')

// 打回 → 原批保留 → 重开草稿，读数复制、原因带入
await batchStore.getState().reject(draft.id, '复核员乙', 'P1 读数异常')
const rejected = await db.surveyBatches.get(draft.id)
assertEq(rejected?.status, 'rejected', '原批状态为已打回并保留')
assertEq(rejected?.rejectReason, 'P1 读数异常', '打回原因已记录')

// 先给打回批放一条读数，验证复制
await db.stations.put({
  id: 'old1', segmentId: 'seg2', batchId: draft.id, code: 'P1', bearing: 90, dip: 0,
  slopeDistance: 5, horizontalDistance: 5, verticalDistance: 0, instrumentNo: '', surveyor: '', date: '', isClosurePoint: false, note: ''
})
const newDraft = await batchStore.getState().reopenFromRejected(draft.id)
assertEq(newDraft.status, 'draft', '重开得到草稿')
assertEq(newDraft.originBatchId, draft.id, '溯源链指向原批')
assertEq(newDraft.carriedReason, 'P1 读数异常', '打回原因带入新草稿')
const copied = await db.stations.where('batchId').equals(newDraft.id).toArray()
assertEq(copied.length, 1, '读数复制到新草稿')
assertOk(copied[0].id !== 'old1', '复制产生新 id，原批读数保留')
const originals = await db.stations.where('batchId').equals(draft.id).toArray()
assertEq(originals.length, 1, '原批读数不动')

// 复核通过后，才能选入拼合
await assertRejects(
  () => batchStore.getState().selectForMerge('seg2', newDraft.id),
  /已通过/,
  '非已通过批次不能参与拼合'
)
await batchStore.getState().submit(newDraft.id, '记录员甲')
await batchStore.getState().approve(newDraft.id, '复核员乙')
// 给新批放一张草图，验证切换时拼合顺序被重置
await db.sketches.put({
  id: 'nk1', segmentId: 'seg2', batchId: newDraft.id, code: 'S-09', gridCount: 10, scale: 200,
  author: '', mergeOrder: 99, anchorStake: 'K0+060', imageNote: ''
})
await batchStore.getState().selectForMerge('seg2', newDraft.id)
const seg2 = await db.segments.get('seg2')
assertEq(seg2?.activeBatchId, newDraft.id, '洞段拼合批次指向新批')
const resetSketch = await db.sketches.get('nk1')
assertEq(resetSketch?.mergeOrder, 2, '新批草图拼合顺序接续其他洞段已选批次（旧批占 1 → 新批为 2），不与旧记录相混')

// 状态四分类齐全
await batchStore.getState().hydrate()
const seg2Batches = batchStore.getState().batches.filter((b) => b.segmentId === 'seg2')
const statuses = new Set(seg2Batches.map((b) => b.status))
assertOk(statuses.has('rejected') && statuses.has('approved'), '页面重开后可区分已打回/已通过')

console.log('全部批次/迁移断言通过 ✔')
await db.close()
process.exit(0)

async function assertRejects(promiseFactory: () => Promise<unknown>, pattern: RegExp, msg: string): Promise<void> {
  try {
    await promiseFactory()
  } catch (error) {
    if (pattern.test((error as Error).message)) return
    throw new Error(`${msg}: 报错信息不匹配 → ${(error as Error).message}`)
  }
  throw new Error(`${msg}: 应当抛错但没有`)
}
