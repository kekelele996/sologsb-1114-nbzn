/** Sketch 草图 */
export interface Sketch {
  id: string
  segmentId: string
  /** 所属测量批次；只有「已通过」批次的草图才能进工作台与拼合 */
  batchId: string
  /** 草图编号 */
  code: string
  /** 坐标纸格数 */
  gridCount: number
  /** 缩放比例（1:N 的 N，如 200 表示 1:200） */
  scale: number
  /** 绘制人 */
  author: string
  /** 图幅拼合顺序号 */
  mergeOrder: number
  /** 桩号对齐锚点 */
  anchorStake: string
  /** 图片数据说明 */
  imageNote: string
}

/** 图幅拼合对齐结果 */
export interface MergeItem {
  sketchId: string
  /** 拼合顺序号（在所属批次内排序） */
  order: number
  /** 对齐后的横向偏移（单位：格/px） */
  offset: number
  /** 是否已吸附到锚点 */
  snapped: boolean
}

/**
 * 拼合记录按批次单独存档：换批次时旧批的偏移/吸附/顺序不会和新批混在一起。
 * 一个已通过批次对应一份 MergeRecord。
 */
export interface MergeRecord {
  /** 即批次 id */
  batchId: string
  segmentId: string
  items: MergeItem[]
  updatedAt: string
}
