<script setup lang="ts">
import {
  BUILTIN_ENVS,
  normalizeSlugList,
  RUNTIME_FAMILIES,
  SceneSlug,
  type EntryFacetsSummary,
} from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { api } from '../api/endpoints'
import { useDebounced } from '../composables/useDebounced'
import { icons } from '../icons'
import {
  bootBucketIcons,
  bootBucketLabels,
  bootExcludeReasonIcons,
  bootExcludeReasonLabels,
  bootModeLabels,
  bootOmitReasonIcons,
  bootOmitReasonLabels,
  envDisplayName,
} from '../labels'
import { runtimeName } from '../runtimes'
import EmptyState from './ui/EmptyState.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'

const NONE_KEY = '__none__'

const props = withDefaults(
  defineProps<{
    facets?: EntryFacetsSummary | null
  }>(),
  { facets: null },
)
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ select: [shortId: string] }>()

const selectedKeyId = ref<string>(NONE_KEY)
const projectInput = ref('')
const runtimeInput = ref('')
const envInput = ref('')
const realmInput = ref('')
const debouncedProject = useDebounced(projectInput, 250)
const debouncedRuntime = useDebounced(runtimeInput, 250)
const debouncedEnv = useDebounced(envInput, 250)
const debouncedRealm = useDebounced(realmInput, 250)
const advancedOpen = ref(false)
const initializedKey = ref(false)

const keysQuery = useQuery({
  queryKey: ['api-keys'] as const,
  queryFn: () => api.keys(),
  enabled: open,
})

const activeKeys = computed(() => (keysQuery.data.value?.items ?? []).filter((k) => !k.revokedAt))

// 首次打开时若有有效访问密钥则默认选中第一个；所选密钥被吊销或清空时自动回退，避免提交失效 keyId
watch(
  [open, activeKeys, () => keysQuery.isSuccess.value],
  ([isOpen, list, loaded]) => {
    if (!isOpen || !loaded) return
    if (list.length === 0) {
      if (selectedKeyId.value !== NONE_KEY) selectedKeyId.value = NONE_KEY
      initializedKey.value = true
      return
    }
    if (!initializedKey.value) {
      selectedKeyId.value = list[0]!.id
      initializedKey.value = true
    } else if (
      selectedKeyId.value !== NONE_KEY &&
      !list.some((k) => k.id === selectedKeyId.value)
    ) {
      selectedKeyId.value = list[0]!.id
    }
  },
  { immediate: true },
)

const keyOptions = computed(() => [
  { value: NONE_KEY, label: '不限访问密钥（仅按场景模拟）' },
  ...activeKeys.value.map((k) => ({
    value: k.id,
    label: `${k.name} · ${runtimeName(k.runtimeFamily)}`,
  })),
])

function validSlug(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const parsed = SceneSlug.safeParse(trimmed)
  return parsed.success ? parsed.data : undefined
}

function slugHint(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  return SceneSlug.safeParse(trimmed).success ? undefined : '仅支持小写字母、数字、连字符或下划线'
}

const runtimeError = computed(() => slugHint(runtimeInput.value))
const envError = computed(() => slugHint(envInput.value))
const realmError = computed(() => slugHint(realmInput.value))

const previewPayload = computed(() => ({
  ...(selectedKeyId.value !== NONE_KEY ? { keyId: selectedKeyId.value } : {}),
  ...(debouncedProject.value ? { project: debouncedProject.value } : {}),
  ...(validSlug(debouncedRuntime.value) ? { runtime: validSlug(debouncedRuntime.value) } : {}),
  ...(validSlug(debouncedEnv.value) ? { env: validSlug(debouncedEnv.value) } : {}),
  ...(validSlug(debouncedRealm.value) ? { realm: validSlug(debouncedRealm.value) } : {}),
}))

const previewQuery = useQuery({
  queryKey: computed(() => ['boot-preview', previewPayload.value] as const),
  queryFn: ({ queryKey: [, body] }) => api.previewBoot(body),
  enabled: computed(() => open.value && !keysQuery.isPending.value),
  staleTime: 0,
})

const preview = computed(() => previewQuery.data.value ?? null)

const fullUsagePct = computed(() => {
  const p = preview.value
  if (!p || p.fullBudget <= 0) return 0
  return Math.min(100, Math.round((p.usedFullChars / p.fullBudget) * 100))
})

const hostUsagePct = computed(() => {
  const p = preview.value
  if (!p?.hostLimit || p.hostLimit <= 0) return null
  return Math.round((p.totalRenderedChars / p.hostLimit) * 100)
})

const projectSuggestions = computed(() => props.facets?.projects ?? [])
const runtimeSuggestions = computed(() =>
  normalizeSlugList([...RUNTIME_FAMILIES, ...(props.facets?.runtimes ?? [])]),
)
const envSuggestions = computed(() =>
  normalizeSlugList([...BUILTIN_ENVS, ...(props.facets?.envs ?? [])]),
)
const realmSuggestions = computed(() =>
  normalizeSlugList(['work', 'personal', ...(props.facets?.realms ?? [])]),
)

function pickEntry(shortId: string) {
  open.value = false
  emit('select', shortId)
}

function resetOverrides() {
  projectInput.value = ''
  runtimeInput.value = ''
  envInput.value = ''
  realmInput.value = ''
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="终端启动加载预览"
    description="模拟指定终端与场景在会话开始时的常驻加载结果"
    :ui="{
      content: 'w-[94vw] max-w-5xl sm:max-w-5xl max-h-[88vh] ring-2 ring-rule',
      body: 'p-0 sm:p-0 flex-1 min-h-0 overflow-hidden flex flex-col',
    }"
  >
    <template #body>
      <div class="preview-shell">
        <!-- 顶部模拟条件栏 -->
        <section class="controls-bar" aria-label="模拟终端条件">
          <div class="controls-main">
            <UFormField label="访问密钥" class="ctrl-key">
              <USelect
                v-model="selectedKeyId"
                :items="keyOptions"
                value-key="value"
                :icon="icons.keys"
                size="sm"
                class="w-full"
              />
            </UFormField>

            <UFormField label="当前项目（可选）" class="ctrl-project">
              <UInput
                v-model="projectInput"
                size="sm"
                :icon="icons.project"
                placeholder="输入项目名，留空表示未在项目目录内"
                class="w-full"
              >
                <template v-if="projectInput" #trailing>
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="link"
                    :icon="icons.cancel"
                    aria-label="清除项目"
                    @click="projectInput = ''"
                  />
                </template>
              </UInput>
            </UFormField>

            <div class="controls-actions">
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                :icon="icons.sliders"
                :aria-expanded="advancedOpen"
                @click="advancedOpen = !advancedOpen"
              >
                场景覆盖
              </UButton>
              <UButton
                size="sm"
                color="neutral"
                variant="ghost"
                :icon="icons.refresh"
                :loading="previewQuery.isFetching.value"
                @click="previewQuery.refetch()"
              >
                刷新
              </UButton>
            </div>
          </div>

          <div v-if="projectSuggestions.length" class="quick-chips">
            <span class="quick-label">快捷项目</span>
            <button
              type="button"
              class="q-chip"
              :class="{ active: !projectInput.trim() }"
              @click="projectInput = ''"
            >
              无项目
            </button>
            <button
              v-for="proj in projectSuggestions"
              :key="proj"
              type="button"
              class="q-chip font-mono"
              :class="{ active: projectInput.trim().toLowerCase() === proj }"
              @click="projectInput = projectInput.trim().toLowerCase() === proj ? '' : proj"
            >
              {{ proj }}
            </button>
          </div>

          <div v-if="advancedOpen" class="advanced-grid">
            <UFormField label="客户端覆盖（支持自定义标识）" :error="runtimeError">
              <UInput
                v-model="runtimeInput"
                size="xs"
                :icon="icons.terminal"
                placeholder="留空沿用所选密钥"
                list="boot-preview-runtimes"
                class="w-full"
              />
              <datalist id="boot-preview-runtimes">
                <option v-for="rt in runtimeSuggestions" :key="rt" :value="rt" />
              </datalist>
            </UFormField>
            <UFormField label="环境覆盖" :error="envError">
              <UInput
                v-model="envInput"
                size="xs"
                :icon="icons.env"
                placeholder="例如 mac / linux"
                list="boot-preview-envs"
                class="w-full"
              />
              <datalist id="boot-preview-envs">
                <option v-for="e in envSuggestions" :key="e" :value="e" />
              </datalist>
            </UFormField>
            <UFormField label="场域焦点覆盖" :error="realmError">
              <UInput
                v-model="realmInput"
                size="xs"
                :icon="icons.realm"
                placeholder="例如 work / personal"
                list="boot-preview-realms"
                class="w-full"
              />
              <datalist id="boot-preview-realms">
                <option v-for="r in realmSuggestions" :key="r" :value="r" />
              </datalist>
            </UFormField>
            <div class="advanced-reset">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :icon="icons.restore"
                @click="resetOverrides"
              >
                清空覆盖
              </UButton>
            </div>
          </div>
        </section>

        <!-- 预览主体滚动区 -->
        <div class="preview-scroll">
          <ReadFailureNote v-if="previewQuery.isError.value" :query="previewQuery" />
          <div v-else-if="previewQuery.isPending.value && !preview" class="space-y-3">
            <USkeleton class="h-20 w-full" />
            <USkeleton class="h-32 w-full" />
            <USkeleton class="h-28 w-full" />
          </div>
          <template v-else-if="preview">
            <!-- 生效焦点与预算计量条 -->
            <section class="stats-strip" aria-label="启动加载预算计量">
              <div class="stat-cell">
                <span class="stat-label">
                  <UIcon :name="icons.pin" class="stat-label-icon" aria-hidden="true" />
                  <span>全文展开</span>
                </span>
                <strong class="stat-value tabular-nums">
                  {{ preview.usedFullChars.toLocaleString() }}
                  <span class="stat-cap">/ {{ preview.fullBudget.toLocaleString() }} 字</span>
                </strong>
                <div class="meter-track" aria-hidden="true">
                  <div
                    class="meter-fill"
                    :class="{ 'is-warn': fullUsagePct >= 85 }"
                    :style="{ width: `${fullUsagePct}%` }"
                  />
                </div>
              </div>

              <div class="stat-cell">
                <span class="stat-label">
                  <UIcon :name="icons.globe" class="stat-label-icon" aria-hidden="true" />
                  <span>全局通用占比（上限 50%）</span>
                </span>
                <strong class="stat-value tabular-nums">
                  {{ preview.globalUsedChars.toLocaleString() }}
                  <span class="stat-cap">/ {{ preview.globalCapChars.toLocaleString() }} 字</span>
                </strong>
              </div>

              <div class="stat-cell">
                <span class="stat-label">
                  <UIcon :name="icons.bookmark" class="stat-label-icon" aria-hidden="true" />
                  <span>独立目录槽</span>
                </span>
                <strong class="stat-value tabular-nums">
                  {{ preview.usedCatalogChars.toLocaleString() }}
                  <span class="stat-cap">/ {{ preview.catalogBudget.toLocaleString() }} 字</span>
                </strong>
                <span class="stat-sub">
                  目录常驻 {{ preview.indexed.length }} 条 · 降级 {{ preview.demoted.length }} 条
                </span>
              </div>

              <div class="stat-cell">
                <span class="stat-label">
                  <UIcon :name="icons.gauge" class="stat-label-icon" aria-hidden="true" />
                  <span>预计总渲染（含指南与目录）</span>
                </span>
                <strong class="stat-value tabular-nums">
                  {{ preview.totalRenderedChars.toLocaleString() }} 字
                  <span v-if="preview.hostLimit" class="stat-cap">
                    / {{ preview.hostLimit.toLocaleString() }}（{{ hostUsagePct }}%）
                  </span>
                </strong>
                <span class="stat-sub">
                  {{
                    preview.runtimeFamily
                      ? `客户端：${runtimeName(preview.runtimeFamily)}`
                      : '未限定客户端上限'
                  }}
                </span>
              </div>
            </section>

            <div class="focus-bar">
              <span class="focus-label">
                <UIcon :name="icons.targetExact" class="focus-label-icon" aria-hidden="true" />
                <span>生效焦点</span>
              </span>
              <span v-if="preview.focus.projects.length" class="focus-tag font-mono">
                项目:{{ preview.focus.projects.join('、') }}
              </span>
              <span v-if="preview.focus.runtimes.length" class="focus-tag">
                客户端:{{ preview.focus.runtimes.map(runtimeName).join('、') }}
              </span>
              <span v-if="preview.focus.envs.length" class="focus-tag">
                环境:{{ preview.focus.envs.map(envDisplayName).join('、') }}
              </span>
              <span v-if="preview.focus.realms.length" class="focus-tag">
                场域:{{ preview.focus.realms.join('、') }}
              </span>
              <span
                v-if="
                  !preview.focus.projects.length &&
                  !preview.focus.runtimes.length &&
                  !preview.focus.envs.length &&
                  !preview.focus.realms.length
                "
                class="text-xs text-muted"
              >
                全部通用（无特定项目、环境或客户端限定）
              </span>
            </div>

            <!-- 1. 全文展开清单 -->
            <section class="result-section">
              <div class="section-head">
                <h3 class="section-title">
                  <UIcon :name="icons.pin" class="section-title-icon" aria-hidden="true" />
                  <span>全文展开（{{ preview.expanded.length }} 条）</span>
                </h3>
                <span class="section-note">会话启动直接写入上下文正文</span>
              </div>
              <EmptyState
                v-if="!preview.expanded.length"
                :icon="icons.terminal"
                title="暂无全文展开的常驻记忆"
                description="当前终端与场景下未命中全文常驻词条。"
              />
              <ul v-else class="item-list">
                <li v-for="item in preview.expanded" :key="item.shortId">
                  <button type="button" class="item-row" @click="pickEntry(item.shortId)">
                    <div class="item-main">
                      <span class="item-title">{{ item.title }}</span>
                      <div class="item-sub">
                        <span class="item-id font-mono">{{ item.shortId }}</span>
                        <span class="item-badge" :class="`is-${item.bucket}`">
                          <UIcon
                            :name="bootBucketIcons[item.bucket]"
                            class="item-badge-icon"
                            aria-hidden="true"
                          />
                          <span>{{ bootBucketLabels[item.bucket] }}</span>
                        </span>
                        <span
                          v-for="p in item.projects"
                          :key="`p:${p}`"
                          class="scope-pill font-mono"
                        >
                          项目:{{ p }}
                        </span>
                        <span v-for="rt in item.runtimes" :key="`rt:${rt}`" class="scope-pill">
                          客户端:{{ runtimeName(rt) }}
                        </span>
                        <span v-for="e in item.envs" :key="`e:${e}`" class="scope-pill">
                          环境:{{ envDisplayName(e) }}
                        </span>
                        <span v-for="r in item.realms" :key="`r:${r}`" class="scope-pill">
                          场域:{{ r }}
                        </span>
                      </div>
                    </div>
                    <span class="item-chars tabular-nums">
                      {{ item.charCount.toLocaleString() }} 字
                    </span>
                  </button>
                </li>
              </ul>
            </section>

            <!-- 2. 目录常驻清单 -->
            <section class="result-section">
              <div class="section-head">
                <h3 class="section-title">
                  <UIcon :name="icons.bookmark" class="section-title-icon" aria-hidden="true" />
                  <span>目录常驻（{{ preview.indexed.length }} 条）</span>
                </h3>
                <span class="section-note">仅占摘要目录槽，按需读取全文</span>
              </div>
              <p v-if="!preview.indexed.length" class="empty-inline">
                当前场景下暂无设为目录常驻的记忆。
              </p>
              <ul v-else class="item-list">
                <li v-for="item in preview.indexed" :key="item.shortId">
                  <button type="button" class="item-row" @click="pickEntry(item.shortId)">
                    <div class="item-main">
                      <span class="item-title">{{ item.title }}</span>
                      <div class="item-sub">
                        <span class="item-id font-mono">{{ item.shortId }}</span>
                        <span v-if="item.summary" class="item-summary">{{ item.summary }}</span>
                        <span v-else class="item-warn">
                          <UIcon :name="icons.warning" class="item-warn-icon" aria-hidden="true" />
                          <span>缺少现行概要</span>
                        </span>
                      </div>
                    </div>
                    <span class="item-chars tabular-nums">
                      {{ item.charCount.toLocaleString() }} 字
                    </span>
                  </button>
                </li>
              </ul>
            </section>

            <!-- 3. 因超限降级清单 -->
            <section v-if="preview.demoted.length" class="result-section">
              <div class="section-head">
                <h3 class="section-title is-warn">
                  <UIcon :name="icons.warning" class="section-title-icon" aria-hidden="true" />
                  <span>超限降级为目录（{{ preview.demoted.length }} 条）</span>
                </h3>
                <span class="section-note">
                  单条超 2,400 字或超出预算与全局 50%
                  上限时自动降级，点击词条可改为目录常驻并补充概要
                </span>
              </div>
              <ul class="item-list">
                <li v-for="item in preview.demoted" :key="item.shortId">
                  <button type="button" class="item-row" @click="pickEntry(item.shortId)">
                    <div class="item-main">
                      <span class="item-title">{{ item.title }}</span>
                      <div class="item-sub">
                        <span class="item-id font-mono">{{ item.shortId }}</span>
                        <span class="item-badge is-warn">
                          <UIcon
                            :name="bootOmitReasonIcons[item.reason]"
                            class="item-badge-icon"
                            aria-hidden="true"
                          />
                          <span>{{ bootOmitReasonLabels[item.reason] }}</span>
                        </span>
                        <span v-if="item.summary" class="item-summary">{{ item.summary }}</span>
                      </div>
                    </div>
                    <span class="item-chars tabular-nums">
                      {{ item.charCount.toLocaleString() }} 字
                    </span>
                  </button>
                </li>
              </ul>
            </section>

            <!-- 4. 本次未加载（被排除）清单 -->
            <section class="result-section">
              <details
                class="excluded-details"
                :open="preview.excluded.length > 0 && preview.excluded.length <= 8"
              >
                <summary class="excluded-summary">
                  <span class="section-title">
                    <UIcon :name="icons.chevronRight" class="excluded-chevron" aria-hidden="true" />
                    <UIcon :name="icons.hide" class="section-title-icon" aria-hidden="true" />
                    <span>本次未加载的常驻记忆（{{ preview.excluded.length }} 条）</span>
                  </span>
                  <span class="section-note">已被场景隔离、场域权限或有效期排除</span>
                </summary>
                <p v-if="!preview.excluded.length" class="empty-inline">
                  全部常驻记忆均命中了当前终端与场景。
                </p>
                <ul v-else class="item-list mt-2">
                  <li v-for="item in preview.excluded" :key="item.shortId">
                    <button type="button" class="item-row" @click="pickEntry(item.shortId)">
                      <div class="item-main">
                        <span class="item-title">{{ item.title }}</span>
                        <div class="item-sub">
                          <span class="item-id font-mono">{{ item.shortId }}</span>
                          <span
                            class="item-badge"
                            :class="item.reason === 'realm_forbidden' ? 'is-error' : ''"
                          >
                            <UIcon
                              :name="bootExcludeReasonIcons[item.reason]"
                              class="item-badge-icon"
                              aria-hidden="true"
                            />
                            <span>{{ bootExcludeReasonLabels[item.reason] }}</span>
                          </span>
                          <span class="item-summary">{{ item.detail }}</span>
                        </div>
                      </div>
                      <span class="item-mode">{{ bootModeLabels[item.bootMode] }}</span>
                    </button>
                  </li>
                </ul>
              </details>
            </section>
          </template>
        </div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.preview-shell {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.controls-bar {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.controls-main {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px 14px;
}
.ctrl-key {
  flex: 1 1 16rem;
  min-width: 14rem;
}
.ctrl-project {
  flex: 1 1 14rem;
  min-width: 12rem;
}
.controls-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.quick-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}
.quick-label {
  font-size: 12px;
  color: var(--ui-text-muted);
  margin-right: 4px;
}
.q-chip {
  padding: 1px 7px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
  font-size: 12px;
  color: var(--ui-text-toned);
  cursor: pointer;
}
.q-chip:hover {
  border-color: var(--ui-rule);
  color: var(--ui-text-highlighted);
}
.q-chip.active {
  border-color: var(--ui-selected);
  background: var(--ui-selected);
  color: var(--ui-on-selected);
}
.advanced-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
  align-items: end;
  gap: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--ui-border);
}
.advanced-reset {
  padding-bottom: 2px;
}
.preview-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.stats-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
}
.stat-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-right: 1px solid var(--ui-border);
  min-width: 0;
}
.stat-cell:last-child {
  border-right: 0;
}
.stat-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.stat-label-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.stat-value {
  font-size: 15px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.stat-cap {
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-text-muted);
}
.stat-sub {
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.meter-track {
  height: 4px;
  width: 100%;
  margin-top: 2px;
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border);
}
.meter-fill {
  height: 100%;
  background: var(--ui-rule);
}
.meter-fill.is-warn {
  background: var(--ui-warning);
}
.focus-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.focus-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-muted);
}
.focus-label-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.focus-tag {
  padding: 0 6px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
  font-size: 12px;
  color: var(--ui-text-highlighted);
}
.result-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--ui-border-accented);
}
.section-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.section-title-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.section-title.is-warn {
  color: var(--ui-warning);
}
.section-title.is-warn .section-title-icon {
  color: currentColor;
}
.section-note {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.excluded-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--ui-border);
  list-style: none;
  cursor: pointer;
}
.excluded-summary::-webkit-details-marker {
  display: none;
}
.excluded-chevron {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
  transition: transform 0.12s ease;
}
.excluded-details[open] .excluded-chevron {
  transform: rotate(90deg);
}
.empty-inline {
  font-size: 13px;
  color: var(--ui-text-muted);
  padding: 6px 0;
}
.item-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ui-border);
}
.item-list li {
  border-bottom: 1px solid var(--ui-border-muted);
}
.item-list li:last-child {
  border-bottom: 0;
}
.item-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 9px 12px;
  background: var(--ui-bg);
  text-align: left;
  cursor: pointer;
}
.item-row:hover {
  background: var(--ui-bg-muted);
}
.item-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}
.item-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.item-sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.item-id {
  flex: none;
  white-space: nowrap;
  color: var(--ui-text-dimmed);
}
.item-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-muted);
  color: var(--ui-text-toned);
  white-space: nowrap;
}
.item-badge-icon,
.item-warn-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
}
.item-badge.is-exact {
  border-color: var(--ui-rule);
  color: var(--ui-text-highlighted);
  font-weight: 500;
}
.item-badge.is-warn {
  border-color: var(--ui-warning);
  color: var(--ui-warning);
}
.item-badge.is-error {
  border-color: var(--ui-error);
  color: var(--ui-error);
}
.scope-pill {
  padding: 0 5px;
  border: 1px solid var(--ui-border);
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.item-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: min(34rem, 100%);
}
.item-warn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ui-warning);
}
.item-chars,
.item-mode {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
@media (max-width: 900px) {
  .stats-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .stat-cell:nth-child(2) {
    border-right: 0;
  }
  .stat-cell:nth-child(1),
  .stat-cell:nth-child(2) {
    border-bottom: 1px solid var(--ui-border);
  }
  .advanced-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 639.98px) {
  .controls-bar,
  .preview-scroll {
    padding-inline: 14px;
  }
  .stats-strip {
    grid-template-columns: minmax(0, 1fr);
  }
  .stat-cell {
    border-right: 0;
    border-bottom: 1px solid var(--ui-border);
  }
  .stat-cell:last-child {
    border-bottom: 0;
  }
}
</style>
