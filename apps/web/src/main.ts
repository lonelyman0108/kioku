import './assets/css/main.css'

import ui from '@nuxt/ui/vue-plugin'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'

import {
  setDatabaseUnavailableHandler,
  setLegacyDatabaseHandler,
  setUnauthorizedHandler,
} from './api/client'
import App from './App.vue'
import { ME_KEY, queryClient } from './query'
import { installGuards, routes, setupLost } from './routes'

const router = createRouter({ history: createWebHistory(), routes })
installGuards(router)
// 任何请求返回 401 都重新确认当前账号：变成 null 后布局会带人回登录页
setUnauthorizedHandler(() => void queryClient.invalidateQueries({ queryKey: ME_KEY }))
// 服务没接上数据库：重新确认初始化状态，守卫按状态带到初始化页（没配数据库）或数据库不可用页（暂时连不上）
setDatabaseUnavailableHandler(() => {
  setupLost()
  const current = router.currentRoute.value
  if (
    current.name === 'setup' ||
    current.name === 'database-unavailable' ||
    current.name === 'legacy-upgrade'
  ) {
    return
  }
  void router.replace({ name: 'database-unavailable', query: { next: current.fullPath } })
})
// 库是重构之前的结构：带到旧版升级页
setLegacyDatabaseHandler(() => {
  setupLost()
  if (router.currentRoute.value.name !== 'legacy-upgrade') {
    void router.replace({ name: 'legacy-upgrade' })
  }
})

createApp(App).use(router).use(ui).use(VueQueryPlugin, { queryClient }).mount('#app')
