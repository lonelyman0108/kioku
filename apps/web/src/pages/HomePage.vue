<script setup lang="ts">
import { watchEffect } from 'vue'
import { useRouter } from 'vue-router'

import EmptyState from '../components/strata/EmptyState.vue'
import { useNewSpaceEntry } from '../composables/useCreateSpace'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'

// 根路径跳到最近访问（或第一个）空间的概览。没有任何空间时：能新建就给「新建空间」，否则写下一步
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
          newSpace.canCreate.value
            ? '新建一个空间，或请空间所有者将当前账号加为成员。'
            : '请空间所有者将当前账号加为成员，加入后刷新页面。'
        "
      >
        <template v-if="newSpace.canCreate.value" #actions>
          <UButton :icon="icons.add" @click="newSpace.open.value = true">新建空间</UButton>
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
