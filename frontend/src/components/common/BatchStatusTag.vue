<script setup lang="ts">
import { computed } from 'vue'
import type { BatchStatus } from '@/types'
import { BATCH_STATUS_LABELS, BATCH_STATUS_TAG_TYPES } from '@/types'

const props = withDefaults(
  defineProps<{
    status: BatchStatus
    /** 是否为升级迁移归集的旧批 */
    legacy?: boolean
    size?: 'large' | 'default' | 'small'
  }>(),
  { legacy: false, size: 'small' }
)

const label = computed(() => {
  const base = BATCH_STATUS_LABELS[props.status]
  return props.legacy ? `${base}·旧批` : base
})
</script>

<template>
  <el-tag :type="BATCH_STATUS_TAG_TYPES[status]" :size="size" effect="light" round>{{ label }}</el-tag>
</template>
