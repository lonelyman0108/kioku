<script setup lang="ts">
import { SetupRequest } from '@kioku/contracts'
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { ME_KEY } from '../composables/useSession'
import { queryClient } from '../query'

const router = useRouter()
const state = reactive({ username: '', displayName: '', password: '', spaceName: '我的空间' })
const error = ref<string | null>(null)
const submitting = ref(false)

async function submit() {
  submitting.value = true
  error.value = null
  try {
    const me = await api.setup(state)
    queryClient.setQueryData(ME_KEY, me)
    await router.replace({ name: 'home' })
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '初始化失败'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-4">
    <UCard class="w-full max-w-md">
      <template #header>
        <h1 class="text-lg font-semibold">初始化 Kioku</h1>
        <p class="mt-1 text-sm text-muted">创建第一个账号和它的空间，这个账号是实例管理员。</p>
      </template>
      <UForm :schema="SetupRequest" :state="state" class="space-y-4" @submit="submit">
        <UFormField label="用户名" name="username" help="小写字母、数字和 _.-">
          <UInput v-model="state.username" autocomplete="username" class="w-full" />
        </UFormField>
        <UFormField label="显示名" name="displayName">
          <UInput v-model="state.displayName" class="w-full" />
        </UFormField>
        <UFormField label="密码" name="password" help="至少 10 位">
          <UInput
            v-model="state.password"
            type="password"
            autocomplete="new-password"
            class="w-full"
          />
        </UFormField>
        <UFormField label="空间名" name="spaceName">
          <UInput v-model="state.spaceName" class="w-full" />
        </UFormField>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
        <UButton type="submit" block :loading="submitting">创建并登录</UButton>
      </UForm>
    </UCard>
  </div>
</template>
