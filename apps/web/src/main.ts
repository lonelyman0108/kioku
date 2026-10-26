import './assets/css/main.css'

import ui from '@nuxt/ui/vue-plugin'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'

import App from './App.vue'
import { routes } from './routes'

const router = createRouter({ history: createWebHistory(), routes })

createApp(App).use(router).use(ui).use(VueQueryPlugin).mount('#app')
