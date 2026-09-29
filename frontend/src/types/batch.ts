/** 批次状态：草稿 → 待复核 → 已通过 / 已打回（打回后可再开草稿） */
export const BATCH_STATUSES = ['draft', 'review', 'approved', 'rejected'] as const
export type BatchStatus = (typeof BATCH_STATUSES)[number]

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  draft: '草稿',
  review: '待复核',
  approved: '已通过',
  rejected: '已打回'
}

/** Element Plus tag type 与批次状态的对应关系 */
export const BATCH_STATUS_TAG_TYPES: Record<BatchStatus, 'info' | 'warning' | 'success' | 'danger'> = {
  draft: 'info',
  review: 'warning',
  approved: 'success',
  rejected: 'danger'
}

/** 批次流转事件：保留谁、在什么时候、做了什么，打回原因随之留痕 */
export interface BatchEvent {
  /** 事件类型：建批 / 提交复核 / 复核通过 / 打回 / 选定拼合 / 换批 */
  type: 'create' | 'submit' | 'approve' | 'reject'
  at: string
  /** 操作人（复核员姓名等） */
  actor: string
  /** 打回原因或复核备注 */
  note?: string
}

/** SurveyBatch 测量批次：一次洞段测量连同读数收成一批，提交复核后冻结 */
export interface SurveyBatch {
  id: string
  segmentId: string
  /** 批次编号，如 C-01-B3 */
  code: string
  status: BatchStatus
  /** 建批人（测量记录员） */
  surveyor: string
  note: string
  /** 从已打回批次新开草稿时，把上一批的打回原因带过来 */
  carriedReason: string
  /** 打回来源批次 id（可追溯链） */
  forkedFromId: string
  /** 升级迁移归集的旧批 */
  legacy: boolean
  submittedAt: string
  reviewedAt: string
  /** 复核员 */
  reviewer: string
  createdAt: string
  updatedAt: string
  /** 状态流转留痕 */
  events: BatchEvent[]
}

/** 生成洞段下一个批次编号，如 C-01-B3（旧批用 B-L 前缀单独计数） */
export function nextBatchCode(segmentCode: string, existingCodes: string[], legacy = false): string {
  const prefix = `${segmentCode}-B`
  if (legacy) {
    let serial = 1
    while (existingCodes.includes(`${prefix}L${serial}`)) serial += 1
    return `${prefix}L${serial}`
  }
  const numbers = existingCodes
    .map((code) => {
      const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`).exec(code.trim())
      return match ? Number(match[1]) : 0
    })
    .filter((n) => n > 0)
  const max = numbers.length > 0 ? Math.max(...numbers) : 0
  return `${prefix}${max + 1}`
}
