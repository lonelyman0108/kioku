<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import KiokuMark from '../components/KiokuMark.vue'
import { ME_KEY } from '../composables/useSession'
import { queryClient } from '../query'

const router = useRouter()
const route = useRoute()
const state = reactive({ username: '', password: '' })
const error = ref<string | null>(null)
const submitting = ref(false)

async function submit() {
  submitting.value = true
  error.value = null
  try {
    const me = await api.login(state.username, state.password)
    // 换了账号：之前缓存的记忆、应用等都不能再用
    queryClient.clear()
    queryClient.setQueryData(ME_KEY, me)
    // 只接受站内路径，避免登录后被带到别的站点
    const next =
      typeof route.query.next === 'string' &&
      route.query.next.startsWith('/') &&
      !route.query.next.startsWith('//')
        ? route.query.next
        : '/'
    await router.replace(next)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '登录失败'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-4">
    <UCard class="w-full max-w-sm">
      <template #header>
        <KiokuMark :height="64" class="mb-3" />
        <h1 class="text-lg font-semibold">登录</h1>
      </template>
      <form class="space-y-4" @submit.prevent="submit">
        <UFormField label="用户名">
          <UInput v-model="state.username" autocomplete="username" class="w-full" required />
        </UFormField>
        <UFormField label="密码">
          <UInput
            v-model="state.password"
            type="password"
            autocomplete="current-password"
            class="w-full"
            required
          />
        </UFormField>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
        <UButton type="submit" block :loading="submitting">登录</UButton>
      </form>
    </UCard>
  </div>
</template>
