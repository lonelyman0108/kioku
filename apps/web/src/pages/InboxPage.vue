<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import DreamSuggestions from '../components/DreamSuggestions.vue'
import InboxBindings from '../components/InboxBindings.vue'
import InboxCredentials from '../components/InboxCredentials.vue'
import InboxPlaintext from '../components/InboxPlaintext.vue'
import InboxReview from '../components/InboxReview.vue'
import { useInboxCounts } from '../composables/useInboxCounts'
import { useInboxTab } from '../composables/useInboxTab'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { canManageCredentials } from '../vault'
import {
  INBOX_TABS,
  actionableInboxCount,
  inboxTabActionable,
  inboxTabCount,
  inboxTabLabels,
  refreshInbox,
  type InboxTab,
} from '../inbox'

const route = useRoute()
const queryClient = useQueryClient()
const { space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const canAct = computed(() => space.value?.role === 'owner' || space.value?.role === 'editor')
const canManageCredential = computed(() => canManageCredentials(space.value?.role))

const counts = useInboxCounts(spaceId)
// 标题的大数字和导航角标、概览同一个口径：当前账号能处理的。角色读到之前不知道口径，先写「–」
const role = computed(() => space.value?.role)
const total = computed(() =>
  counts.data.value && role.value ? actionableInboxCount(counts.data.value, role.value) : null,
)
// 各分类照常写各自的条数：0 不醒目；当前账号处理不了的那几类也一样，等角色读到再定
const quiet = (tab: InboxTab) =>
  !counts.data.value ||
  !inboxTabCount(counts.data.value, tab) ||
  (role.value !== undefined && !inboxTabActionable(tab, role.value))
const tab = useInboxTab(counts)
const refreshing = computed(() => counts.isFetching.value)
// 换分类时回到顶上：各类共用一个滚动区
const scroller = ref<HTMLElement | null>(null)
watch(tab, () => {
  if (scroller.value) scroller.value.scrollTop = 0
})
</script>

<template>
  <div ref="scroller" class="inbox">
    <div class="inbox-grid">
      <aside class="inbox-side">
        <div class="inbox-title">
          <h1>待处理</h1>
          <UButton
            :icon="icons.refresh"
            color="neutral"
            variant="ghost"
            size="sm"
            aria-label="刷新"
            :loading="refreshing"
            @click="refreshInbox(queryClient, spaceId)"
          />
          <span class="inbox-total">{{ total ?? '–' }}</span>
        </div>
        <nav class="inbox-tabs" aria-label="待处理分类">
          <RouterLink
            v-for="t in INBOX_TABS"
            :key="t"
            :to="{ name: 'inbox', params: { spaceId }, query: { tab: t } }"
            replace
            class="inbox-tab"
            :aria-current="tab === t ? 'page' : undefined"
          >
            <span>{{ inboxTabLabels[t] }}</span>
            <b :class="{ none: quiet(t) }">
              {{ counts.data.value ? inboxTabCount(counts.data.value, t) : '–' }}
            </b>
          </RouterLink>
        </nav>
      </aside>
      <section class="inbox-main" :aria-label="tab ? inboxTabLabels[tab] : '待处理'">
        <!-- 切到别的分类时不卸载：勾选的条目和改了一半的草稿都还在 -->
        <KeepAlive>
          <InboxBindings v-if="tab === 'binding'" :space-id="spaceId" />
          <InboxReview v-else-if="tab === 'review'" :space-id="spaceId" :can-act="canAct" />
          <DreamSuggestions v-else-if="tab === 'dream'" :space-id="spaceId" :can-act="canAct" />
          <InboxPlaintext v-else-if="tab === 'plaintext'" :space-id="spaceId" />
          <InboxCredentials
            v-else-if="tab === 'credential'"
            :space-id="spaceId"
            :can-act="canManageCredential"
          />
        </KeepAlive>
      </section>
    </div>
  </div>
</template>

<style scoped>
.inbox {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}
.inbox-grid {
  display: grid;
  grid-template-columns: 272px minmax(0, 1fr);
  min-height: 100%;
}
/* 内容很长时分类还在屏幕里 */
.inbox-side {
  position: sticky;
  top: 0;
  align-self: start;
  padding: 22px 0 24px;
}
.inbox-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 17px;
  padding: 0 24px 0 32px;
}
.inbox-title h1 {
  font-size: 28px;
  font-weight: 500;
  line-height: 1.3;
}
.inbox-title :deep(button) {
  align-self: center;
}
.inbox-total {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 28px;
  font-weight: 300;
  line-height: 1.3;
}
.inbox-tabs {
  border-top: 1px solid var(--strata-rule);
}
.inbox-tab {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 54px;
  padding: 0 24px 0 32px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 15px;
}
.inbox-tab:hover {
  background: var(--ui-bg-muted);
}
.inbox-tab b {
  font-family: var(--font-mono);
  font-size: 22px;
  font-weight: 300;
  line-height: 1;
}
.inbox-tab b.none {
  color: var(--ui-text-muted);
}
.inbox-tab[aria-current='page'],
.inbox-tab[aria-current='page']:hover {
  border-bottom-color: var(--strata-selected);
  background: var(--strata-selected);
  color: var(--strata-on-selected);
  font-weight: 600;
}
.inbox-tab[aria-current='page'] b {
  color: var(--strata-on-selected);
}
/* 选中的那一类反白，不醒目的数字也要退一级 */
.inbox-tab[aria-current='page'] b.none {
  color: var(--strata-on-selected-muted);
}
.inbox-tab:focus-visible {
  outline-offset: -2px;
}
.inbox-main {
  min-width: 0;
  padding: 24px 32px 56px;
  border-left: 1px solid var(--strata-rule);
}
@media (max-width: 1023.98px) {
  .inbox-grid {
    display: block;
    min-height: 0;
  }
  .inbox-side {
    position: static;
    padding: 16px 0 0;
  }
  .inbox-title {
    margin-bottom: 10px;
    padding: 0 16px;
  }
  .inbox-tabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    border-bottom: 1px solid var(--strata-rule);
  }
  .inbox-tab {
    height: 48px;
    padding: 0 12px 0 16px;
    border-bottom: 0;
    font-size: 14px;
  }
  .inbox-tab:nth-child(odd) {
    border-right: 1px solid var(--ui-border);
  }
  /* 两列排开，最后一行之外都有下边线 */
  .inbox-tab:not(:nth-last-child(-n + 2):nth-child(odd), :last-child) {
    border-bottom: 1px solid var(--ui-border);
  }
  .inbox-tab b {
    font-size: 18px;
  }
  .inbox-main {
    padding: 18px 16px 40px;
    border-left: 0;
  }
}
</style>
