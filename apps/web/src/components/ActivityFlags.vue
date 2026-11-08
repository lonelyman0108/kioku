<script setup lang="ts">
import type { ActivityItem } from '@kioku/contracts'

import { benchAccountLabel } from '../labels'
import Hint from './Hint.vue'
import FlagTag from './strata/FlagTag.vue'

// 变更记录里一条改动的状态：记忆现在已删除、已过期，测试台写下的，超出可见范围的。已删除的不再标已过期。
// 文字与图标都从状态标签取（strata/flags.ts）
defineProps<{ item: Pick<ActivityItem, 'deleted' | 'expired' | 'bench' | 'left'> }>()
</script>

<template>
  <span class="flags">
    <FlagTag v-if="item.deleted" status="deleted" />
    <FlagTag v-else-if="item.expired" status="expired" />
    <span
      v-if="item.bench"
      :title="`运行标记 ${item.bench.run}，操作账号：${benchAccountLabel(item.bench)}`"
    >
      <FlagTag status="bench" />
      <span class="sr-only">，操作账号：{{ benchAccountLabel(item.bench) }}</span>
    </span>
    <span v-if="item.left" class="left-flag">
      <FlagTag status="left" />
      <Hint>
        此次改动后，这条记忆超出当前账号的可见范围（例如移入其他成员的本人记忆，或改为机密）。
      </Hint>
    </span>
  </span>
</template>

<style scoped>
.flags {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.flags > * {
  flex-shrink: 0;
  white-space: nowrap;
}
/* 表格的格子很窄时，图标和文字不折成两行 */
.flags :deep(.flag-tag) {
  display: inline-flex;
  align-items: center;
}
.left-flag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
</style>
