<script setup lang="ts">
import { watchEffect } from 'vue'
import { useRouter } from 'vue-router'

import EmptyState from '../components/strata/EmptyState.vue'
import { useNewSpaceEntry } from '../composables/useCreateSpace'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'

// 根路径跳到最近访问（或第一个）空间的概览。没有任何空间时给「新建空间」「导入空间」；名额用完时按钮还在、不可用，下面写原因
const router = useRouter()
const { me, space } = useSession()
watchEffect(() => {
  if (space.value) void router.replace({ name: 'overview', params: { spaceId: space.value.id } })
})
// 外壳里的那一份入口与弹窗
const newSpace = useNewSpaceEntry()
</script>

<template>
  <div class="home">
    <template v-if="me.data.value && !space">
      <EmptyState
        title="暂无空间"
        :description="
          newSpace
            ? '新建或导入一个空间，或请空间所有者将当前账号加为成员。'
            : '请空间所有者将当前账号加为成员，加入后刷新页面。'
        "
      >
        <template v-if="newSpace" #actions>
          <UButton
            :icon="icons.add"
            :disabled="Boolean(newSpace.blocked.value)"
            @click="newSpace.open.value = true"
            >新建空间</UButton
          >
          <UButton
            :icon="icons.importSpace"
            color="neutral"
            variant="outline"
            :disabled="Boolean(newSpace.blocked.value)"
            @click="newSpace.importing.value = true"
            >导入空间</UButton
          >
          <p v-if="newSpace.blocked.value" class="w-full text-sm text-muted">
            {{ newSpace.blocked.value }}
          </p>
        </template>
      </EmptyState>
    </template>
    <p v-else>正在打开空间……</p>
  </div>
</template>

<style scoped>
.home {
  flex: 1;
  min-width: 0;
  padding: 24px 32px;
  color: var(--ui-text-muted);
}
@media (max-width: 1023.98px) {
  .home {
    padding: 16px;
  }
}
</style>
