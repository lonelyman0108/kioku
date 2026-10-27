<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { DomainLayers, PLAIN_LAYERS, type PlainLayer } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useUnsavedChangesGuard } from '../composables/unsavedChanges'
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
// 表单是从哪一版载入的；还没载入时为 null，这时不算有改动，也不能保存。
// 改动以它为准，而不是缓存里最新的那份：否则数据晚到时会被当成「有改动」而填不进表单
const baseline = ref<Row[] | null>(null)
const toRows = (defaults: Record<string, PlainLayer>) =>
  Object.entries(defaults)
    .map(([domain, layer]) => ({ domain, layer }))
    .sort((a, b) => a.domain.localeCompare(b.domain))
const normalized = (list: Row[]) =>
  list
    .map((r) => ({ domain: r.domain.trim(), layer: r.layer }))
    .filter((r) => r.domain)
    .sort((a, b) => a.domain.localeCompare(b.domain))
const dirty = computed(
  () =>
    baseline.value !== null &&
    JSON.stringify(normalized(rows.value)) !== JSON.stringify(normalized(baseline.value)),
)

function load(defaults: Record<string, PlainLayer>) {
  rows.value = toRows(defaults)
  baseline.value = toRows(defaults)
}
// 换了空间就重新载入；同一个空间里服务端的数据变了（例如别的标签页保存过），没有改动时才跟上
watch(
  [spaceId, () => layers.data.value],
  ([id, data], previous) => {
    // 第一次执行时 previous 是空数组
    if (previous[0] !== undefined && id !== previous[0]) {
      rows.value = []
      baseline.value = null
    }
    if (data && (baseline.value === null || !dirty.value)) load(data.defaults)
  },
  { immediate: true },
)
// 有未保存的改动时，离开这一页、换空间、退出登录或关掉标签页之前先确认
useUnsavedChangesGuard(dirty)

// 校验规则与服务端用同一个 schema；重复的 domain 会被合并掉，单独查
const problem = computed(() => {
  const list = normalized(rows.value)
  const seen = new Set<string>()
  for (const r of list) {
    if (seen.has(r.domain)) return `domain「${r.domain}」重复了`
    seen.add(r.domain)
  }
  const parsed = DomainLayers.safeParse({
    defaults: Object.fromEntries(list.map((r) => [r.domain, r.layer])),
  })
  if (parsed.success) return null
  const issue = parsed.error.issues[0]
  // domain（记录的键）不合法时，zod 只在外层给一句英文，这里点出是哪个 domain
  if (issue?.code === 'invalid_key') {
    return `domain「${String(issue.path.at(-1) ?? '')}」格式不对：小写字母开头，只用小写字母、数字和下划线`
  }
  return issue?.message ?? '格式不对'
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
// 载入之前和保存期间不能改：载入会覆盖表单，保存的结果也会覆盖期间的改动
const editable = computed(() => isOwner.value && baseline.value !== null && !saving.value)
async function save() {
  if (problem.value || baseline.value === null) return
  saving.value = true
  // 记下发起保存的空间：请求期间换了空间，结果不能写进新空间的表单
  const forSpace = spaceId.value
  try {
    const defaults = Object.fromEntries(normalized(rows.value).map((r) => [r.domain, r.layer]))
    const result = await api.saveDomainLayers(forSpace, defaults)
    queryClient.setQueryData(['domain-layers', forSpace], result)
    if (forSpace === spaceId.value) load(result.defaults)
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
          <div v-if="baseline === null" class="space-y-2">
            <USkeleton v-for="n in 2" :key="n" class="h-8 w-full" />
          </div>
          <p v-if="!isOwner" class="text-sm text-muted">只有空间 owner 能改。</p>
          <div v-for="(row, index) in rows" :key="index" class="flex items-center gap-2">
            <UInput
              v-model="row.domain"
              placeholder="domain，例如 core"
              class="flex-1 font-mono"
              :disabled="!editable"
            />
            <USelect v-model="row.layer" :items="layerItems" class="w-36" :disabled="!editable" />
            <UButton
              v-if="isOwner"
              :icon="icons.remove"
              color="neutral"
              variant="ghost"
              aria-label="删除这一行"
              :disabled="!editable"
              @click="rows.splice(index, 1)"
            />
          </div>
          <p v-if="baseline !== null && !rows.length" class="text-sm text-muted">
            还没有配置，所有 domain 新建时都默认私人层。
          </p>
          <UAlert v-if="problem" color="warning" variant="subtle" :title="problem" />
          <div v-if="isOwner" class="flex flex-wrap gap-2">
            <UButton
              :icon="icons.add"
              color="neutral"
              variant="subtle"
              :disabled="!editable"
              @click="addRow"
            >
              添加一行
            </UButton>
            <UButton color="neutral" variant="ghost" :disabled="!editable" @click="fillSuggested">
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
