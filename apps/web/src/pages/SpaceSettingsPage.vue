<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { PLAIN_LAYERS, type PlainLayer } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { layerLabels } from '../labels'

const route = useRoute()
const toast = useToast()
const queryClient = useQueryClient()
const { space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const isOwner = computed(() => space.value?.role === 'owner')

const queryKey = computed(() => ['domain-layers', spaceId.value])
const layers = useQuery({ queryKey, queryFn: () => api.domainLayers(spaceId.value) })

interface Row {
  domain: string
  layer: PlainLayer
}
const rows = ref<Row[]>([])
const saved = computed(() => layers.data.value?.defaults ?? {})
const toRows = (defaults: Record<string, PlainLayer>) =>
  Object.entries(defaults)
    .map(([domain, layer]) => ({ domain, layer }))
    .sort((a, b) => a.domain.localeCompare(b.domain))
const dirty = computed(
  () => JSON.stringify(normalized(rows.value)) !== JSON.stringify(normalized(toRows(saved.value))),
)
// 没有改动时跟上服务端（例如换了空间、别的标签页保存过）
watch(
  saved,
  (defaults) => {
    if (!dirty.value) rows.value = toRows(defaults)
  },
  { immediate: true },
)
watch(spaceId, () => (rows.value = toRows(saved.value)))

function normalized(list: Row[]) {
  return list
    .map((r) => ({ domain: r.domain.trim(), layer: r.layer }))
    .filter((r) => r.domain)
    .sort((a, b) => a.domain.localeCompare(b.domain))
}

const DOMAIN = /^[a-z][a-z0-9_]{0,31}$/
const problem = computed(() => {
  const list = normalized(rows.value)
  const bad = list.find((r) => !DOMAIN.test(r.domain))
  if (bad) return `domain「${bad.domain}」格式不对：小写字母开头，只用小写字母、数字和下划线`
  if (list.some((r) => r.domain === 'persona' || r.domain === 'app')) {
    return 'persona 与 app 下的层由 URI 决定，不用配置'
  }
  const seen = new Set<string>()
  for (const r of list) {
    if (seen.has(r.domain)) return `domain「${r.domain}」重复了`
    seen.add(r.domain)
  }
  return null
})

const layerItems = PLAIN_LAYERS.map((l) => ({ label: layerLabels[l], value: l }))

function addRow() {
  rows.value.push({ domain: '', layer: 'private' })
}
// 与从 Lore 导入时的映射一致：core 是基础规则，preferences 是主人画像，其余按私人层
function fillSuggested() {
  const suggested: Row[] = [
    { domain: 'core', layer: 'base' },
    { domain: 'preferences', layer: 'owner' },
  ]
  for (const s of suggested) {
    if (!rows.value.some((r) => r.domain.trim() === s.domain)) rows.value.push({ ...s })
  }
}

const saving = ref(false)
async function save() {
  if (problem.value) return
  saving.value = true
  try {
    const defaults = Object.fromEntries(normalized(rows.value).map((r) => [r.domain, r.layer]))
    const result = await api.saveDomainLayers(spaceId.value, defaults)
    queryClient.setQueryData(queryKey.value, result)
    rows.value = toRows(result.defaults)
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="space-settings">
    <template #header>
      <UDashboardNavbar title="空间设置" />
    </template>
    <template #body>
      <!-- shrink-0：面板内容区是竖向 flex 容器，内容超出时卡片不能被压扁 -->
      <UCard class="max-w-2xl shrink-0">
        <template #header>
          <h2 class="font-medium">domain 默认层</h2>
          <p class="mt-1 text-sm text-muted">
            在管理界面新建记忆时，按 URI 的 domain 带出层，例如 core:// 默认是基础层。
            只是默认值，新建时还能改；通过 Key 写入不受影响，没指定层时仍按私人层。
          </p>
        </template>
        <UAlert
          v-if="layers.isError.value"
          color="error"
          variant="subtle"
          :title="layers.error.value instanceof ApiError ? layers.error.value.message : '读取失败'"
        />
        <div v-else class="space-y-3">
          <p v-if="!isOwner" class="text-sm text-muted">只有空间 owner 能改。</p>
          <div v-for="(row, index) in rows" :key="index" class="flex items-center gap-2">
            <UInput
              v-model="row.domain"
              placeholder="domain，例如 core"
              class="flex-1 font-mono"
              :disabled="!isOwner"
            />
            <USelect v-model="row.layer" :items="layerItems" class="w-36" :disabled="!isOwner" />
            <UButton
              v-if="isOwner"
              :icon="icons.remove"
              color="neutral"
              variant="ghost"
              aria-label="删除这一行"
              @click="rows.splice(index, 1)"
            />
          </div>
          <p v-if="!rows.length" class="text-sm text-muted">
            还没有配置，所有 domain 新建时都默认私人层。
          </p>
          <UAlert v-if="problem" color="warning" variant="subtle" :title="problem" />
          <div v-if="isOwner" class="flex flex-wrap gap-2">
            <UButton :icon="icons.add" color="neutral" variant="subtle" @click="addRow">
              添加一行
            </UButton>
            <UButton color="neutral" variant="ghost" @click="fillSuggested">
              按导入 Lore 的规则填入
            </UButton>
            <UButton
              :icon="icons.save"
              class="ml-auto"
              :loading="saving"
              :disabled="!dirty || !!problem"
              @click="save"
            >
              保存
            </UButton>
          </div>
        </div>
      </UCard>
    </template>
  </UDashboardPanel>
</template>
