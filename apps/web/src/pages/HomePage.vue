<script setup lang="ts">
import { watchEffect } from 'vue'
import { useRouter } from 'vue-router'

import EmptyState from '../components/strata/EmptyState.vue'
import { useNewCircleEntry } from '../composables/useCreateSpace'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'

// 根路径跳到最近访问（或个人）记忆圈的概览。没有任何记忆圈时给「新建共享圈」「导入记忆圈」
const router = useRouter()
const { me, circle } = useSession()
watchEffect(() => {
  if (circle.value) void router.replace({ name: 'overview', params: { circleId: circle.value.id } })
})
// 外壳里的那一份入口与弹窗
const newCircle = useNewCircleEntry()
</script>

<template>
  <div class="home">
    <template v-if="me.data.value && !circle">
      <EmptyState
        title="暂无记忆圈"
        :description="
          newCircle
            ? '新建或导入一个记忆圈，或请记忆圈所有者将当前账号加为成员。'
            : '请记忆圈所有者将当前账号加为成员，加入后刷新页面。'
        "
      >
        <template v-if="newCircle" #actions>
          <div class="grid justify-items-start gap-2">
            <div class="flex flex-wrap gap-2">
              <UButton
                :icon="icons.add"
                :disabled="Boolean(newCircle.blocked.value)"
                @click="newCircle.open.value = true"
              >
                新建独立圈
              </UButton>
              <UButton
                :icon="icons.importCircle"
                color="neutral"
                variant="outline"
                @click="newCircle.importing.value = true"
              >
                导入记忆圈
              </UButton>
            </div>
            <p v-if="newCircle.blocked.value" class="text-xs text-muted">
              {{ newCircle.blocked.value }}
            </p>
          </div>
        </template>
      </EmptyState>
    </template>
    <p v-else>正在打开记忆圈……</p>
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
