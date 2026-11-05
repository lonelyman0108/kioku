<script setup lang="ts">
import { SetupRequest } from '@kioku/contracts'
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import EntryFrame from '../components/strata/EntryFrame.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
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
    queryClient.clear()
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
  <EntryFrame>
    <SectionHeading title="初始化" :level="1" />
    <p class="mt-2 text-muted">创建首个账号及其空间，该账号为实例管理员。</p>
    <UForm :schema="SetupRequest" :state="state" class="mt-4 space-y-4" @submit="submit">
      <UFormField label="用户名" name="username" help="小写字母、数字和 _.-">
        <UInput v-model="state.username" size="lg" autocomplete="username" class="w-full" />
      </UFormField>
      <UFormField label="显示名" name="displayName">
        <UInput v-model="state.displayName" size="lg" class="w-full" />
      </UFormField>
      <UFormField label="密码" name="password" help="至少 10 位">
        <UInput
          v-model="state.password"
          size="lg"
          type="password"
          autocomplete="new-password"
          class="w-full"
        />
      </UFormField>
      <UFormField label="空间名" name="spaceName">
        <UInput v-model="state.spaceName" size="lg" class="w-full" />
      </UFormField>
      <p v-if="error" class="text-error" role="alert">{{ error }}</p>
      <UButton type="submit" size="lg" block :loading="submitting">创建并登录</UButton>
    </UForm>
  </EntryFrame>
</template>
