<script setup lang="ts">
import { CREDENTIAL_EXPIRING_DAYS } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'

import { api } from '../api/endpoints'
import { useActivated } from '../composables/useActivated'
import { attentionCredentialsKey } from '../inbox'
import { attentionNotes, credentialFlags } from '../vault'
import Hint from './Hint.vue'
import FlagTag from './strata/FlagTag.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SectionHeading from './strata/SectionHeading.vue'

// 待处理的凭据：快到期、已到期、标了需要轮换的，只有当前账号自己的。到凭据详情里改值、改到期时间或清除标记
const props = defineProps<{ spaceId: string; canAct: boolean }>()

const active = useActivated()
const list = useQuery({
  queryKey: computed(() => attentionCredentialsKey(props.spaceId)),
  queryFn: ({ queryKey: [, sid] }) => api.credentials(sid, { attention: 'true' }),
  enabled: active,
})
const items = computed(() => list.data.value?.items ?? [])
</script>

<template>
  <div>
    <SectionHeading title="凭据">
      <template #hint>
        <Hint>
          到期前 {{ CREDENTIAL_EXPIRING_DAYS }}
          天起列在这里，已到期的照常可以取用。改值后需要轮换的标记自动清除。
        </Hint>
      </template>
    </SectionHeading>
    <ReadFailureNote v-if="list.isError.value" class="cred-note" :query="list" />
    <div v-if="list.isPending.value" class="mt-3 space-y-3">
      <USkeleton v-for="n in 3" :key="n" class="h-12 w-full" />
    </div>
    <template v-else-if="list.data.value">
      <p v-if="!items.length" class="cred-empty">暂无待处理的凭据</p>
      <ul v-else>
        <li v-for="c in items" :key="c.id" class="cred-row">
          <div class="cred-name">
            <RouterLink :to="{ name: 'credentials', params: { spaceId }, query: { id: c.id } }">{{
              c.name
            }}</RouterLink>
            <code class="cred-identifier">{{ c.identifier }}</code>
            <FlagTag v-for="flag in credentialFlags(c)" :key="flag">{{ flag }}</FlagTag>
          </div>
          <p class="cred-sub">
            <span v-for="note in attentionNotes(c)" :key="note">{{ note }}</span>
          </p>
          <div class="cred-actions">
            <UButton
              color="neutral"
              variant="outline"
              :to="{ name: 'credentials', params: { spaceId }, query: { id: c.id } }"
            >
              {{ canAct ? '去处理' : '查看' }}
            </UButton>
          </div>
        </li>
      </ul>
      <p v-if="list.data.value.truncated" class="cred-empty">仅显示前 1000 条</p>
    </template>
  </div>
</template>

<style scoped>
.note-line.cred-note {
  margin: 10px 0 0;
  border-top: 0;
}
.cred-empty {
  padding: 22px 0;
  color: var(--ui-text-muted);
}
.cred-row {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) minmax(100px, auto);
  align-items: center;
  gap: 8px 24px;
  min-height: 60px;
  padding: 11px 0;
  border-bottom: 1px solid var(--ui-border);
}
.cred-name {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 9px;
  min-width: 0;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.cred-name a {
  font-weight: 500;
}
.cred-name a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.cred-identifier {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ui-text-muted);
}
.cred-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 0 12px;
  min-width: 0;
  font-size: 14px;
  color: var(--ui-text-muted);
}
.cred-actions {
  display: flex;
  justify-content: flex-end;
}
@media (max-width: 1023.98px) {
  .cred-row {
    grid-template-columns: minmax(0, 1fr);
  }
  .cred-actions > * {
    flex: 1;
    justify-content: center;
  }
}
</style>
