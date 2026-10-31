import type { InboxCounts } from '@kioku/contracts'
import { computed, watchPostEffect, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { resolveInboxTab } from '../inbox'

// 看的是哪一类记在地址里，刷新、分享都还在。地址没写时按条数定下来，定下来就写回地址，之后条数怎么变都不跳：
// 不写回的话，确认完最后一条绑定页面会自己跳走，勾选的时候来了新绑定，手底下的按钮也会变。
// 用 post flush：useQuery 的选项在 pre 阶段才更新，pre 下换空间时读到的还是上一个空间的条数
export function useInboxTab(counts: { data: Ref<InboxCounts | undefined>; isError: Ref<boolean> }) {
  const route = useRoute()
  const router = useRouter()
  const tab = computed(() =>
    resolveInboxTab(route.query.tab, counts.data.value, counts.isError.value),
  )
  watchPostEffect(() => {
    if (tab.value && route.name === 'inbox' && route.query.tab !== tab.value) {
      void router.replace({ query: { ...route.query, tab: tab.value } })
    }
  })
  return tab
}
