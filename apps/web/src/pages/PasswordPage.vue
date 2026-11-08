<script setup lang="ts">
import type { PasswordLinkInfo } from '@kioku/contracts'
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  expiresIn,
  linkLoadState,
  newPasswordProblem,
  newPasswordReady,
  setPasswordError,
  type LinkPageState,
} from '../accounts'
import { readFailure } from '../api/client'
import { api } from '../api/endpoints'
import EntryFrame from '../components/strata/EntryFrame.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import { forgetSpace, ME_KEY } from '../composables/useSession'
import { queryClient } from '../query'

// 设置密码页：打开管理员给的一次性链接。先核对链接，写清给谁设置；设好之后已经登录，进首页。
// 不在外壳里，不需要登录；已经登录着别的账号时，设好之后换成这个账号
const route = useRoute()
const router = useRouter()
const token = computed(() => String(route.params.token ?? ''))

const state = ref<LinkPageState>('loading')
const info = ref<PasswordLinkInfo | null>(null)
const loadError = ref<unknown>(null)
async function load() {
  state.value = 'loading'
  try {
    info.value = await api.inspectPasswordLink(token.value)
    state.value = 'ready'
  } catch (err) {
    loadError.value = err
    state.value = linkLoadState(err)
  }
}
onMounted(load)

const title = computed(() => {
  const i = info.value
  if (!i) return '设置密码'
  return i.purpose === 'reset'
    ? `重置 ${i.displayName} 的密码`
    : `为 ${i.displayName}（${i.username}）设置密码`
})

const form = reactive({ password: '', repeat: '' })
const problem = computed(() => newPasswordProblem(form.password, form.repeat))
const ready = computed(() => newPasswordReady(form.password, form.repeat))
const error = ref<string | null>(null)
const submitting = ref(false)
async function submit() {
  if (submitting.value || !ready.value) return
  submitting.value = true
  error.value = null
  try {
    const me = await api.usePasswordLink(token.value, form.password)
    // 换了账号：之前缓存的内容都不能再用
    forgetSpace()
    queryClient.clear()
    queryClient.setQueryData(ME_KEY, me)
    await router.replace('/')
  } catch (err) {
    const failure = setPasswordError(err)
    if (failure.invalid) state.value = 'invalid'
    else error.value = failure.text
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <EntryFrame>
    <template v-if="state === 'invalid'">
      <SectionHeading title="链接无效或已过期" :level="1" />
      <p class="mt-4" data-state="invalid">
        设置密码链接 24 小时内有效、只能用一次。请联系实例管理员重新生成链接。
      </p>
      <UButton class="mt-6" color="neutral" variant="outline" to="/login">前往登录</UButton>
    </template>
    <template v-else-if="state === 'failed'">
      <SectionHeading title="设置密码" :level="1" />
      <p class="mt-4 text-error" role="alert" data-state="failed">
        {{ readFailure(loadError, '链接读取失败') }}
      </p>
      <UButton class="mt-6" @click="load">重试</UButton>
    </template>
    <template v-else>
      <SectionHeading :title="title" :level="1" />
      <p v-if="info" class="mt-2 text-muted text-sm" data-state="ready">
        链接 {{ expiresIn(info.expiresAt) }}，只能用一次。设好之后其他设备上的登录全部退出。
      </p>
      <form class="mt-4 space-y-4" @submit.prevent="submit">
        <input
          type="text"
          name="username"
          autocomplete="username"
          :value="info?.username"
          class="sr-only"
          tabindex="-1"
          aria-hidden="true"
          readonly
        />
        <UFormField label="新密码" help="至少 10 位">
          <UInput
            v-model="form.password"
            size="lg"
            type="password"
            autocomplete="new-password"
            class="w-full"
            :disabled="state !== 'ready'"
          />
        </UFormField>
        <UFormField label="再输一次" :error="problem ?? undefined">
          <UInput
            v-model="form.repeat"
            size="lg"
            type="password"
            autocomplete="new-password"
            class="w-full"
            :disabled="state !== 'ready'"
          />
        </UFormField>
        <p v-if="error" class="text-error" role="alert">{{ error }}</p>
        <UButton type="submit" size="lg" block :loading="submitting" :disabled="!ready"
          >设置密码并登录</UButton
        >
      </form>
    </template>
  </EntryFrame>
</template>
