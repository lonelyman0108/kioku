<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { VaultConnection } from '@kioku/contracts'
import { computed, toRef, watch } from 'vue'

import { useVaultLogin } from '../composables/useVaultLogin'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'

// 连接密码库与重新登录共用。状态和规则在 useVaultLogin，这里只管长相
const props = defineProps<{ spaceId: string; connection: VaultConnection | null }>()
const open = defineModel<boolean>('open', { required: true })
// 事件带上提交时的空间：提交期间切换了空间，页面刷新的是连上的那个空间
const emit = defineEmits<{ connected: [connection: VaultConnection, spaceId: string] }>()
const toast = useToast()

const { form, step, provider, submitting, failure, problem, reset, back, submit } = useVaultLogin(
  toRef(props, 'spaceId'),
  toRef(props, 'connection'),
  (connection, sid) => {
    open.value = false
    toast.add({ title: props.connection ? '已重新登录' : '已连接密码库', color: 'success' })
    emit('connected', connection, sid)
  },
)

// 打开时按要连的那一个重新填；关掉时清掉主密码与验证码
watch(open, () => reset(), { immediate: true })

const reconnecting = computed(() => props.connection !== null)
</script>

<template>
  <UModal v-model:open="open" :title="reconnecting ? '重新登录密码库' : '连接密码库'">
    <template #body>
      <form id="vault-login" class="space-y-4" autocomplete="off" @submit.prevent="submit">
        <template v-if="step === 'login'">
          <p v-if="!reconnecting" class="text-sm text-muted">
            仅接受专用账号。<Hint>
              <span class="block">
                账号中有个人条目，或在组织中可访问全部集合（所有者、管理员等）时，无法连接；连接后出现这些情况，连接停用，清除后重新检查即可恢复。
              </span>
              <span class="mt-1 block">
                原因：Kioku 保存着能解开此账号的密钥，泄露时损失应仅限分配给 Agent 的条目。
              </span>
              <span class="mt-1 block">
                做法：为 Kioku
                单独注册一个账号，加入一个组织，只分配一个集合（例如「Agent」），把要给 Agent
                用的条目放进这个集合。
              </span>
            </Hint>
          </p>
          <UFormField
            label="服务器地址"
            help="Bitwarden 官方服务或兼容的自建服务端，以 https:// 开头；本机地址与不带点的主机名（例如 http://vaultwarden）可以用 http://"
          >
            <UInput
              v-model="form.serverUrl"
              class="w-full font-mono"
              :disabled="reconnecting"
              placeholder="https://vault.example.com"
            />
          </UFormField>
          <UFormField label="邮箱">
            <UInput v-model="form.email" class="w-full" type="email" autocomplete="off" />
          </UFormField>
          <UFormField label="主密码" help="仅用于本次登录，不保存。">
            <UInput
              v-model="form.masterPassword"
              class="w-full"
              type="password"
              autocomplete="off"
            />
          </UFormField>
        </template>
        <template v-else>
          <p class="text-sm">此账号已开启两步验证。</p>
          <UFormField v-if="provider" label="验证码">
            <UInput
              v-model="form.code"
              class="w-full font-mono"
              inputmode="numeric"
              autocomplete="one-time-code"
            />
          </UFormField>
        </template>
        <NoteLine v-if="failure" tone="error">{{ failure }}</NoteLine>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <span v-if="problem" class="mr-auto text-sm text-muted">{{ problem }}</span>
        <UButton v-if="step === 'two_factor'" color="neutral" variant="ghost" @click="back">
          上一步
        </UButton>
        <UButton color="neutral" variant="ghost" @click="open = false">取消</UButton>
        <UButton type="submit" form="vault-login" :loading="submitting" :disabled="!!problem">
          {{ step === 'two_factor' ? '验证' : reconnecting ? '登录' : '连接' }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
