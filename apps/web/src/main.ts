import './assets/css/main.css'

import ui from '@nuxt/ui/vue-plugin'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'

import { setUnauthorizedHandler } from './api/client'
import App from './App.vue'
import { ME_KEY, queryClient } from './query'
import { installGuards, routes } from './routes'

const router = createRouter({ history: createWebHistory(), routes })
installGuards(router)
// 任何请求返回 401 都重新确认当前账号：变成 null 后布局会带人回登录页
setUnauthorizedHandler(() => void queryClient.invalidateQueries({ queryKey: ME_KEY }))

createApp(App).use(router).use(ui).use(VueQueryPlugin, { queryClient }).mount('#app')
