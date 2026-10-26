<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  LAYERS,
  SENSITIVITIES,
  type CreatedKey,
  type KeyInfo,
  type KeyScopes,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { layerLabels, sensitivityLabels } from '../labels'
import { keyPresets } from './keyPresets'

const props = defineProps<{
  spaceId: string
  appId: string
  isAppOwner: boolean
  isSpaceOwner: boolean
}>()
const toast = useToast()
const queryClient = useQueryClient()
const queryKey = computed(() => ['keys', props.spaceId, props.appId])

// 只有应用主人和空间 owner 能看 Key 列表
const keys = useQuery({
  queryKey,
  queryFn: () => api.keys(props.spaceId, props.appId),
  enabled: computed(() => props.isAppOwner || props.isSpaceOwner),
})

const issueOpen = ref(false)
const issued = ref<CreatedKey | null>(null)
const form = reactive({
  name: '',
  preset: 'agent',
  advanced: false,
  scopes: { ...keyPresets[0]!.scopes } as KeyScopes,
})
const layerItems = LAYERS.map((l) => ({ label: layerLabels[l], value: l }))
// editor 签不了 secret 级和 admin，选项里也不给
const sensitivityItems = computed(() =>
  SENSITIVITIES.filter((s) => props.isSpaceOwner || s !== 'secret').map((s) => ({
    label: sensitivityLabels[s],
    value: s,
  })),
)

function pickPreset(id: string) {
  form.preset = id
  const preset = keyPresets.find((p) => p.id === id)
  if (preset)
    form.scopes = {
      ...preset.scopes,
      readLayers: [...preset.scopes.readLayers],
      writeLayers: [...preset.scopes.writeLayers],
    }
}

// 签发中不接受第二次提交：连点两次会签出两把 Key，只有后一把的明文被展示
const issuing = ref(false)
async function issue() {
  if (issuing.value) return
  issuing.value = true
  try {
    issued.value = await api.createKey(props.spaceId, props.appId, {
      name: form.name || form.preset,
      scopes: form.scopes,
    })
    await queryClient.invalidateQueries({ queryKey: queryKey.value })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '签发失败', color: 'error' })
  } finally {
    issuing.value = false
  }
}

// 关掉「逐项调整」时回到所选预设的权限，不让看不见的改动跟着签出去
watch(
  () => form.advanced,
  (on) => {
    if (!on) pickPreset(form.preset)
  },
)

function closeIssue() {
  issueOpen.value = false
  issued.value = null
  form.name = ''
  form.advanced = false
  pickPreset(form.preset)
}

// 剪贴板接口只在 HTTPS 或 localhost 下可用；用局域网 HTTP 地址打开时提示手动复制
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: '已复制', color: 'success' })
  } catch {
    toast.add({ title: '浏览器不允许自动复制，请手动选中 Key 复制', color: 'warning' })
  }
}

const revoking = ref<KeyInfo | null>(null)
async function revoke() {
  if (!revoking.value) return
  try {
    await api.revokeKey(props.spaceId, props.appId, revoking.value.id)
    revoking.value = null
    await queryClient.invalidateQueries({ queryKey: queryKey.value })
    toast.add({ title: 'Key 已吊销', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '吊销失败', color: 'error' })
  }
}

const summary = (s: KeyScopes) =>
  `读 ${s.readLayers.length} 层 · 写 ${s.writeLayers.length} 层 · 最高${sensitivityLabels[s.maxSensitivity]}${s.admin ? ' · admin' : ''}`
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-medium">API Key</h3>
      <UButton
        v-if="isAppOwner"
        :icon="icons.add"
        size="xs"
        variant="subtle"
        @click="issueOpen = true"
        >签发</UButton
      >
    </div>
    <p v-if="!isAppOwner && !isSpaceOwner" class="text-sm text-muted">
      只有应用的主人能查看和签发它的 Key。
    </p>
    <ul v-else class="divide-y divide-default text-sm">
      <li v-for="key in keys.data.value ?? []" :key="key.id" class="flex items-center gap-3 py-2">
        <code>{{ key.prefix }}</code>
        <span>{{ key.name }}</span>
        <span class="text-muted">{{ summary(key.scopes) }}</span>
        <UBadge v-if="key.revokedAt" color="neutral" variant="subtle">已吊销</UBadge>
        <span v-else class="ml-auto text-xs text-muted">
          {{
            key.lastUsedAt ? `最近使用 ${new Date(key.lastUsedAt).toLocaleString()}` : '尚未使用'
          }}
        </span>
        <UButton
          v-if="!key.revokedAt"
          :icon="icons.remove"
          size="xs"
          color="error"
          variant="ghost"
          aria-label="吊销"
          @click="revoking = key"
        />
      </li>
      <li v-if="keys.data.value?.length === 0" class="py-2 text-muted">还没有 Key。</li>
    </ul>

    <!-- 明文 Key 显示期间不能点遮罩、按 Esc 或右上角关掉，只能点「我已保存」，免得没复制就丢了 -->
    <UModal
      :open="issueOpen"
      title="签发 API Key"
      :dismissible="!issued"
      :close="!issued"
      @update:open="(v) => (v ? (issueOpen = true) : closeIssue())"
    >
      <template #body>
        <div v-if="issued" class="space-y-3">
          <UAlert
            color="warning"
            variant="subtle"
            title="Key 只显示这一次，关闭后无法再看到，请现在保存。"
          />
          <div class="flex items-center gap-2">
            <code class="flex-1 break-all rounded bg-elevated p-2 text-xs">{{ issued.key }}</code>
            <UButton
              :icon="icons.copy"
              variant="subtle"
              aria-label="复制"
              @click="copy(issued.key)"
            />
          </div>
        </div>
        <form v-else id="issue-key" class="space-y-4" @submit.prevent="issue">
          <UFormField label="名称" help="用来辨认这把 Key，例如「MacBook 上的 Claude Code」">
            <UInput v-model="form.name" class="w-full" />
          </UFormField>
          <UFormField label="权限">
            <div class="space-y-2">
              <URadioGroup
                :model-value="form.preset"
                :items="
                  keyPresets.map((p) => ({ label: p.label, description: p.help, value: p.id }))
                "
                @update:model-value="(v) => pickPreset(String(v))"
              />
              <USwitch v-model="form.advanced" label="逐项调整" />
            </div>
          </UFormField>
          <template v-if="form.advanced">
            <UFormField label="可读的层">
              <USelect
                v-model="form.scopes.readLayers"
                :items="layerItems"
                multiple
                class="w-full"
              />
            </UFormField>
            <UFormField label="可写的层">
              <USelect
                v-model="form.scopes.writeLayers"
                :items="layerItems"
                multiple
                class="w-full"
              />
            </UFormField>
            <UFormField label="最高敏感级">
              <USelect
                v-model="form.scopes.maxSensitivity"
                :items="sensitivityItems"
                class="w-full"
              />
            </UFormField>
            <USwitch
              v-if="isSpaceOwner"
              v-model="form.scopes.admin"
              label="admin：可以写任何人格与应用命名空间下的记忆"
            />
          </template>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton v-if="issued" @click="closeIssue">我已保存</UButton>
          <template v-else>
            <UButton color="neutral" variant="ghost" @click="closeIssue">取消</UButton>
            <UButton type="submit" form="issue-key" :loading="issuing">签发</UButton>
          </template>
        </div>
      </template>
    </UModal>

    <UModal
      :open="revoking !== null"
      title="吊销这把 Key？"
      @update:open="(v) => !v && (revoking = null)"
    >
      <template #body>
        <p class="text-sm">
          吊销 <code>{{ revoking?.prefix }}</code
          >（{{ revoking?.name }}）后，用它的接入方会立刻失去访问权限。
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="revoking = null">取消</UButton>
          <UButton color="error" @click="revoke">吊销</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
