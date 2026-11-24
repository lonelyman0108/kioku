<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'

// 客户端模块共享的纸墨二级切换条：聚合「客户端与密钥」「召回与试算」「测试台」三处视图
const props = defineProps<{ circleId: string }>()
const route = useRoute()
const { me } = useSession()

const clients = useQuery({
  queryKey: computed(() => ['clients', props.circleId] as const),
  queryFn: ({ queryKey: [, cid] }) => api.clients(cid),
})
const ownsClient = computed(() =>
  (clients.data.value ?? []).some((c) => c.ownerAccountId === me.data.value?.id),
)

const items = computed(() => [
  {
    key: 'clients',
    label: '客户端与密钥',
    icon: icons.clients,
    to: { name: 'clients', params: { circleId: props.circleId } },
    active: route.name === 'clients' || route.name === 'client',
  },
  {
    key: 'recall',
    label: '召回与试算',
    icon: icons.recall,
    to: { name: 'recall', params: { circleId: props.circleId } },
    active: route.name === 'recall',
  },
  ...(ownsClient.value || route.name === 'bench'
    ? [
        {
          key: 'bench',
          label: '测试台',
          icon: icons.bench,
          to: { name: 'bench', params: { circleId: props.circleId } },
          active: route.name === 'bench',
        },
      ]
    : []),
])
</script>

<template>
  <nav class="clients-subnav" aria-label="客户端视图">
    <RouterLink
      v-for="item in items"
      :key="item.key"
      :to="item.to"
      class="sub-link"
      :aria-current="item.active ? 'page' : undefined"
    >
      <UIcon :name="item.icon" class="sub-icon" />
      <span>{{ item.label }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.clients-subnav {
  flex: none;
  display: flex;
  align-items: stretch;
  gap: 2px;
  height: 40px;
  padding: 0 16px;
  border-bottom: 1px solid var(--strata-rule);
  overflow-x: auto;
}
.sub-link {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  font-size: 13px;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.sub-link:hover {
  color: var(--ui-text);
}
.sub-link[aria-current='page'] {
  color: var(--ui-text-highlighted);
  font-weight: 600;
}
.sub-link[aria-current='page']::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 0;
  height: 2px;
  background: var(--strata-rule);
}
.sub-icon {
  display: inline-block;
  width: 15px;
  height: 15px;
}
</style>
