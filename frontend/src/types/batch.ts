/** 测量批次状态：草稿 → 待复核 → 已通过 / 已打回 */
export type BatchStatus = 'draft' | 'reviewing' | 'approved' | 'rejected'

/** 批次状态展示文案 */
export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  draft: '草稿',
  reviewing: '待复核',
  approved: '已通过',
  rejected: '已打回'
}

/** 批次状态对应的 el-tag 类型 */
export const BATCH_STATUS_TAG_TYPE: Record<BatchStatus, 'info' | 'warning' | 'success' | 'danger'> = {
  draft: 'info',
  reviewing: 'warning',
  approved: 'success',
  rejected: 'danger'
}

/**
 * SurveyBatch 测量批次：一次洞段测量连同全部读数的冻结单元。
 * 提交复核后本批读数冻结；复核通过才允许草图工作台选用；
 * 打回后原批保留，只能从它重开一份草稿继续修订。
 */
export interface SurveyBatch {
  id: string
  segmentId: string
  /** 批次编号，如 B-03（洞段内顺序编号） */
  code: string
  status: BatchStatus
  /** 提交复核人 */
  submittedBy: string
  /** 提交复核时间 ISO 字符串 */
  submittedAt: string
  /** 复核人 */
  reviewedBy: string
  /** 复核时间 ISO 字符串 */
  reviewedAt: string
  /** 打回原因（status = rejected 时填写） */
  rejectReason: string
  /** 从已打回批次重开草稿时，带过来的打回原因 */
  carriedReason: string
  /** 溯源链：本草稿由哪个批次重开而来 */
  originBatchId: string
  /** 是否为历史数据升级时归并产生的旧批 */
  legacy: boolean
  createdAt: string
  updatedAt: string
}
