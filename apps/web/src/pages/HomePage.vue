<script setup lang="ts">
import { computed, watchEffect } from 'vue'
import { useRouter } from 'vue-router'

import CreateSpaceModal from '../components/CreateSpaceModal.vue'
import EmptyState from '../components/strata/EmptyState.vue'
import { useCreateSpace } from '../composables/useCreateSpace'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'

// 根路径跳到最近访问（或第一个）空间的概览。没有任何空间时：能新建就给「新建空间」，否则写下一步
const router = useRouter()
const { me, space } = useSession()
watchEffect(() => {
  if (space.value) void router.replace({ name: 'overview', params: { spaceId: space.value.id } })
})
const newSpace = useCreateSpace(computed(() => Boolean(me.data.value)))
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
      <CreateSpaceModal
        :open="newSpace.open.value"
        :current-account-id="me.data.value.id"
        @close="newSpace.open.value = false"
        @created="newSpace.created"
      />
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
