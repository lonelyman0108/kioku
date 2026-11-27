<script setup lang="ts">
import {
  effectiveBootMode,
  TRANSFER_PASSPHRASE_MIN,
  type ExportFormat,
  type ImportConflictStrategy,
  type ImportPreviewResponse,
  type ImportSource,
  type KiokuExportBundle,
  type LoreBackupUpload,
} from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import { saveFile } from '../download'
import { icons } from '../icons'
import { bootModeLabels, envDisplayName } from '../labels'
import { runtimeName } from '../runtimes'
import { formatTime } from '../time'
import {
  readKiokuBackupFile,
  readLoreBackupFile,
  tokenInClear,
  TransferFileError,
} from '../transfer'
import SegmentedChoice from './SegmentedChoice.vue'
import NoteLine from './ui/NoteLine.vue'
import SectionHeading from './ui/SectionHeading.vue'

const toast = useToast()
const queryClient = useQueryClient()
const { me } = useSession()

const hasMasterKey = computed(() => Boolean(me.data.value?.hasMasterKey))

// ---- 导出状态 ----

const includeExportCreds = ref(false)
const exportPassphrase = ref('')
const exportPassphraseConfirm = ref('')
const exporting = ref<ExportFormat | null>(null)
const exportError = ref<string | null>(null)

watch(hasMasterKey, (ok) => {
  if (!ok) includeExportCreds.value = false
})

const exportPassphraseIssue = computed(() => {
  if (!includeExportCreds.value) return null
  if (exportPassphrase.value.length < TRANSFER_PASSPHRASE_MIN) {
    return `加密口令至少 ${TRANSFER_PASSPHRASE_MIN} 位`
  }
  if (exportPassphrase.value !== exportPassphraseConfirm.value) {
    return '两次输入的加密口令不一致'
  }
  return null
})

async function runExport(format: ExportFormat) {
  if (exporting.value) return
  if (format === 'json' && includeExportCreds.value && exportPassphraseIssue.value) {
    exportError.value = exportPassphraseIssue.value
    return
  }
  exporting.value = format
  exportError.value = null
  try {
    const withCreds = format === 'json' && includeExportCreds.value
    const { blob, filename } = await api.exportBundle({
      format,
      includeCredentials: withCreds,
      ...(withCreds ? { passphrase: exportPassphrase.value } : {}),
    })
    const fallback =
      format === 'markdown'
        ? 'kioku-export.md'
        : withCreds
          ? 'kioku-backup.json'
          : 'kioku-export.json'
    saveFile(blob, filename ?? fallback)
    if (withCreds) {
      exportPassphrase.value = ''
      exportPassphraseConfirm.value = ''
    }
    toast.add({ title: withCreds ? '加密备份已导出' : '导出完成', color: 'success' })
  } catch (err) {
    exportError.value = err instanceof ApiError ? err.message : '导出失败，请重试'
  } finally {
    exporting.value = null
  }
}

// ---- 两步导入状态 ----

type ImportTab = 'kioku' | 'lore'
type LoreMode = 'file' | 'url'

const importTab = ref<ImportTab>('kioku')
const loreMode = ref<LoreMode>('file')

const kiokuFileInput = ref<HTMLInputElement | null>(null)
const kiokuFileName = ref<string | null>(null)
const kiokuBundle = ref<KiokuExportBundle | null>(null)
const kiokuHasEncryptedCreds = ref(false)
const importIncludeCreds = ref(true)
const importPassphrase = ref('')

const loreFileInput = ref<HTMLInputElement | null>(null)
const loreFileName = ref<string | null>(null)
const loreBackup = ref<LoreBackupUpload | null>(null)
const loreUrl = ref('')
const loreToken = ref('')

const fileError = ref<string | null>(null)
const previewBusy = ref(false)
const previewError = ref<string | null>(null)
const preview = ref<ImportPreviewResponse | null>(null)
const activeSource = ref<ImportSource | null>(null)

const conflictStrategy = ref<ImportConflictStrategy>('skip')
const previewFilter = ref<'all' | 'importable' | 'issues'>('all')
const excludedKeys = ref<Set<string>>(new Set())
const excludedCreds = ref<Set<string>>(new Set())
const applyBusy = ref(false)
const applyError = ref<string | null>(null)

const clearTextTokenWarning = computed(
  () => importTab.value === 'lore' && loreMode.value === 'url' && tokenInClear(loreUrl.value),
)

function clearPreview() {
  preview.value = null
  activeSource.value = null
  previewError.value = null
  applyError.value = null
  excludedKeys.value = new Set()
  excludedCreds.value = new Set()
  conflictStrategy.value = 'skip'
  previewFilter.value = 'all'
}

watch([importTab, loreMode], () => {
  fileError.value = null
  clearPreview()
})

async function onKiokuFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  fileError.value = null
  clearPreview()
  if (!file) return
  try {
    const parsed = await readKiokuBackupFile(file)
    kiokuBundle.value = parsed.bundle
    kiokuFileName.value = file.name
    kiokuHasEncryptedCreds.value = parsed.hasEncryptedCredentials
    importIncludeCreds.value = parsed.hasEncryptedCredentials && hasMasterKey.value
    importPassphrase.value = ''
  } catch (err) {
    kiokuBundle.value = null
    kiokuFileName.value = null
    kiokuHasEncryptedCreds.value = false
    fileError.value = err instanceof TransferFileError ? err.message : '无法读取文件'
  } finally {
    input.value = ''
  }
}

async function onLoreFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  fileError.value = null
  clearPreview()
  if (!file) return
  try {
    const trimmed = await readLoreBackupFile(file)
    loreBackup.value = trimmed
    loreFileName.value = file.name
  } catch (err) {
    loreBackup.value = null
    loreFileName.value = null
    fileError.value = err instanceof TransferFileError ? err.message : '无法读取文件'
  } finally {
    input.value = ''
  }
}

const canPreview = computed(() => {
  if (previewBusy.value || applyBusy.value) return false
  if (importTab.value === 'kioku') {
    if (!kiokuBundle.value) return false
    if (kiokuHasEncryptedCreds.value && importIncludeCreds.value) {
      return hasMasterKey.value && importPassphrase.value.length > 0
    }
    return true
  }
  if (loreMode.value === 'file') return loreBackup.value !== null
  return loreUrl.value.trim().length > 0
})

function buildImportSource(): ImportSource | null {
  if (importTab.value === 'kioku') {
    if (!kiokuBundle.value) return null
    const wantCreds = kiokuHasEncryptedCreds.value && importIncludeCreds.value
    return {
      kind: 'kioku',
      bundle: kiokuBundle.value,
      includeCredentials: wantCreds,
      ...(wantCreds ? { passphrase: importPassphrase.value } : {}),
    }
  }
  if (loreMode.value === 'file') {
    if (!loreBackup.value) return null
    return { kind: 'lore-file', backup: loreBackup.value }
  }
  return {
    kind: 'lore-url',
    url: loreUrl.value.trim(),
    token: loreToken.value,
  }
}

async function runPreview() {
  const source = buildImportSource()
  if (!source || !canPreview.value) return
  previewBusy.value = true
  previewError.value = null
  applyError.value = null
  try {
    const res = await api.previewImport({ source })
    preview.value = res
    activeSource.value = source
    conflictStrategy.value = 'skip'
    // 跳过项与默认同名重复项不做强制剔除；同名已存在的 Lore 节点默认取消勾选以防误重导
    const initialExcluded = new Set<string>()
    for (const item of res.items) {
      if (item.skippedReason !== null || item.conflict === 'same_title_exists') {
        initialExcluded.add(item.key)
      }
    }
    excludedKeys.value = initialExcluded
    excludedCreds.value = new Set(res.credentials.filter((c) => c.exists).map((c) => c.slug))
  } catch (err) {
    previewError.value = err instanceof ApiError ? err.message : '预览导入失败，请检查来源'
  } finally {
    previewBusy.value = false
  }
}

const hasShortIdConflicts = computed(
  () => preview.value?.items.some((i) => i.conflict === 'short_id_exists') ?? false,
)

function itemChecked(key: string): boolean {
  return !excludedKeys.value.has(key)
}

function toggleItem(key: string) {
  const next = new Set(excludedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  excludedKeys.value = next
}

function toggleAllItems(select: boolean) {
  if (!preview.value) return
  if (!select) {
    excludedKeys.value = new Set(preview.value.items.map((i) => i.key))
    return
  }
  const next = new Set<string>()
  for (const item of preview.value.items) {
    if (item.skippedReason !== null) next.add(item.key)
  }
  excludedKeys.value = next
}

function credChecked(slug: string): boolean {
  return !excludedCreds.value.has(slug)
}

function toggleCred(slug: string) {
  const next = new Set(excludedCreds.value)
  if (next.has(slug)) next.delete(slug)
  else next.add(slug)
  excludedCreds.value = next
}

const willImportEntriesCount = computed(() => {
  if (!preview.value) return 0
  let count = 0
  for (const item of preview.value.items) {
    if (item.skippedReason !== null || excludedKeys.value.has(item.key)) continue
    if (item.conflict === 'short_id_exists' && conflictStrategy.value === 'skip') continue
    count++
  }
  return count
})

const willImportCredsCount = computed(() => {
  if (!preview.value) return 0
  return preview.value.credentials.filter((c) => !c.exists && !excludedCreds.value.has(c.slug))
    .length
})

const canApply = computed(
  () =>
    !applyBusy.value &&
    activeSource.value !== null &&
    (willImportEntriesCount.value > 0 || willImportCredsCount.value > 0),
)

async function runApply() {
  if (!canApply.value || !activeSource.value) return
  applyBusy.value = true
  applyError.value = null
  try {
    const res = await api.applyImport({
      source: activeSource.value,
      conflictStrategy: conflictStrategy.value,
      excludeKeys: [...excludedKeys.value],
      excludeCredentialSlugs: [...excludedCreds.value],
    })
    const parts: string[] = [`导入 ${res.createdEntries} 条记忆`]
    if (res.reallocatedEntries > 0) parts.push(`重分配 ${res.reallocatedEntries} 个短 ID`)
    if (res.createdCredentials > 0) parts.push(`导入 ${res.createdCredentials} 条凭据`)
    if (res.skippedEntries + res.skippedCredentials > 0) {
      parts.push(`跳过 ${res.skippedEntries + res.skippedCredentials} 项`)
    }
    toast.add({ title: parts.join('，'), color: 'success' })
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['entries'] }),
      queryClient.invalidateQueries({ queryKey: ['credentials'] }),
    ])
    // 清理口令、令牌与已上传文件缓冲
    importPassphrase.value = ''
    loreToken.value = ''
    kiokuBundle.value = null
    kiokuFileName.value = null
    kiokuHasEncryptedCreds.value = false
    loreBackup.value = null
    loreFileName.value = null
    clearPreview()
  } catch (err) {
    applyError.value = err instanceof ApiError ? err.message : '导入失败，请重试'
  } finally {
    applyBusy.value = false
  }
}

const sourceTabOptions = computed(() => {
  const disabled = previewBusy.value || applyBusy.value
  return [
    { value: 'kioku' as const, label: 'Kioku 备份', disabled },
    { value: 'lore' as const, label: '外部导入 · Lore', disabled },
  ]
})

const loreModeOptions = computed(() => {
  const disabled = previewBusy.value
  return [
    { value: 'file' as const, label: '上传导出文件', disabled },
    { value: 'url' as const, label: '从地址拉取', disabled },
  ]
})

const conflictOptions = computed(() => {
  const disabled = applyBusy.value
  return [
    { value: 'skip' as const, label: '跳过已存在', disabled },
    { value: 'reallocate' as const, label: '分配新短 ID（自动改写双链）', disabled },
  ]
})

const previewIssueCount = computed(
  () =>
    preview.value?.items.filter((i) => i.skippedReason !== null || i.conflict !== null).length ?? 0,
)

const previewFilterOptions = computed(() => [
  { value: 'all' as const, label: `全部（${preview.value?.items.length ?? 0}）` },
  { value: 'importable' as const, label: `可导入（${willImportEntriesCount.value}）` },
  { value: 'issues' as const, label: `冲突或跳过（${previewIssueCount.value}）` },
])

const filteredPreviewItems = computed(() => {
  const list = preview.value?.items ?? []
  if (previewFilter.value === 'all') return list
  if (previewFilter.value === 'issues') {
    return list.filter((i) => i.skippedReason !== null || i.conflict !== null)
  }
  return list.filter((i) => {
    if (i.skippedReason !== null || excludedKeys.value.has(i.key)) return false
    if (i.conflict === 'short_id_exists' && conflictStrategy.value === 'skip') return false
    return true
  })
})
</script>

<template>
  <section class="space-y-6">
    <SectionHeading title="数据导入与导出" :level="2" />

    <!-- 导出 -->
    <div class="transfer-box space-y-3">
      <div class="space-y-1">
        <p class="text-sm font-medium">导出备份</p>
        <p class="text-xs text-muted">
          导出全部未删除记忆与场景元数据；默认不包含托管凭据，勾选下方选项后使用口令进行 AES-256-GCM
          加密导出。
        </p>
      </div>

      <div class="space-y-2">
        <USwitch
          v-model="includeExportCreds"
          :disabled="!hasMasterKey || exporting !== null"
          label="同时导出托管凭据（需设置加密口令，仅 JSON）"
        />
        <p v-if="!hasMasterKey" class="text-xs text-muted">
          当前实例未配置 KIOKU_MASTER_KEY，暂不可导出加密凭据。
        </p>
      </div>

      <div v-if="includeExportCreds" class="grid max-w-xl gap-3 sm:grid-cols-2">
        <UFormField label="加密口令" :help="`至少 ${TRANSFER_PASSPHRASE_MIN} 位，导入凭据时需提供`">
          <UInput
            v-model="exportPassphrase"
            type="password"
            autocomplete="new-password"
            class="w-full"
          />
        </UFormField>
        <UFormField label="确认口令">
          <UInput
            v-model="exportPassphraseConfirm"
            type="password"
            autocomplete="new-password"
            class="w-full"
          />
        </UFormField>
      </div>

      <p v-if="exportError" class="text-sm text-error" role="alert">{{ exportError }}</p>

      <div class="flex flex-wrap gap-2">
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          :icon="icons.download"
          :loading="exporting === 'json'"
          :disabled="
            (exporting !== null && exporting !== 'json') ||
            (includeExportCreds && exportPassphraseIssue !== null)
          "
          @click="runExport('json')"
        >
          {{ includeExportCreds ? '导出加密备份（JSON）' : '导出 JSON' }}
        </UButton>
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          :icon="icons.download"
          :loading="exporting === 'markdown'"
          :disabled="includeExportCreds || (exporting !== null && exporting !== 'markdown')"
          @click="runExport('markdown')"
        >
          导出 Markdown
        </UButton>
      </div>
    </div>

    <!-- 导入（两步：选择来源 -> 预览与勾选确认） -->
    <div class="transfer-box space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="space-y-0.5">
          <p class="text-sm font-medium">导入数据</p>
          <p class="text-xs text-muted">
            先预览映射结果与冲突项，勾选确认后再写入；导入不会覆盖现有记忆或凭据。
          </p>
        </div>
        <SegmentedChoice v-model="importTab" :items="sourceTabOptions" label="导入来源" />
      </div>

      <!-- 步骤 1：选择来源 -->
      <template v-if="!preview">
        <!-- 来源 A：Kioku JSON 备份 -->
        <div v-if="importTab === 'kioku'" class="space-y-3">
          <input
            ref="kiokuFileInput"
            type="file"
            accept=".json,application/json"
            class="sr-only"
            @change="onKiokuFileChange"
          />
          <div class="flex flex-wrap items-center gap-3">
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              :icon="icons.upload"
              :disabled="previewBusy"
              @click="kiokuFileInput?.click()"
            >
              选择 Kioku 导出文件
            </UButton>
            <span v-if="kiokuFileName && kiokuBundle" class="text-xs text-muted">
              已选 <code class="font-mono">{{ kiokuFileName }}</code> · 共
              {{ kiokuBundle.entries.length }} 条记忆{{
                kiokuHasEncryptedCreds ? ' · 含加密凭据' : ''
              }}
            </span>
          </div>

          <div v-if="kiokuHasEncryptedCreds" class="space-y-3 border-t border-default pt-3">
            <USwitch
              v-model="importIncludeCreds"
              :disabled="!hasMasterKey || previewBusy"
              label="同时解密并导入托管凭据"
            />
            <p v-if="!hasMasterKey" class="text-xs text-muted">
              当前实例未配置 KIOKU_MASTER_KEY，无法写入托管凭据，仍可仅导入记忆。
            </p>
            <UFormField
              v-if="importIncludeCreds && hasMasterKey"
              label="备份加密口令"
              class="max-w-sm"
            >
              <UInput
                v-model="importPassphrase"
                type="password"
                autocomplete="off"
                placeholder="输入导出时设置的加密口令"
                class="w-full"
              />
            </UFormField>
          </div>
        </div>

        <!-- 来源 B：外部导入 · Lore -->
        <div v-else class="space-y-3">
          <div class="flex flex-wrap items-center gap-3">
            <SegmentedChoice v-model="loreMode" :items="loreModeOptions" label="Lore 导入方式" />
          </div>

          <div v-if="loreMode === 'file'" class="space-y-2">
            <input
              ref="loreFileInput"
              type="file"
              accept=".json,application/json"
              class="sr-only"
              @change="onLoreFileChange"
            />
            <div class="flex flex-wrap items-center gap-3">
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                :icon="icons.upload"
                :disabled="previewBusy"
                @click="loreFileInput?.click()"
              >
                选择 Lore 导出文件
              </UButton>
              <span v-if="loreFileName && loreBackup" class="text-xs text-muted">
                已选 <code class="font-mono">{{ loreFileName }}</code
                >（已在浏览器裁剪，仅上传 5 张记忆表）
              </span>
            </div>
            <p class="text-xs text-muted">
              支持 Lore 导出的 JSON
              备份文件；系统配置与已废弃版本正文会在浏览器端自动剥离，不上传服务端。
            </p>
          </div>

          <div v-else class="space-y-3">
            <div class="grid max-w-2xl gap-3 sm:grid-cols-2">
              <UFormField label="Lore 服务地址" help="填写根路径，例如 http://127.0.0.1:18901">
                <UInput
                  v-model="loreUrl"
                  placeholder="http://127.0.0.1:18901"
                  autocomplete="off"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="API Token" help="仅本次拉取使用，不保存、不记日志">
                <UInput
                  v-model="loreToken"
                  type="password"
                  placeholder="选填（未开启鉴权可留空）"
                  autocomplete="off"
                  class="w-full"
                />
              </UFormField>
            </div>
            <NoteLine v-if="clearTextTokenWarning" tone="warning">
              当前地址通过公网明文 HTTP 传输，API Token 存在暴露风险；建议改用 HTTPS
              或改传本地导出文件。
            </NoteLine>
          </div>
        </div>

        <p v-if="fileError || previewError" class="text-sm text-error" role="alert">
          {{ fileError ?? previewError }}
        </p>

        <div>
          <UButton
            size="sm"
            :icon="importTab === 'lore' && loreMode === 'url' ? icons.globe : icons.search"
            :loading="previewBusy"
            :disabled="!canPreview"
            @click="runPreview"
          >
            预览导入
          </UButton>
        </div>
      </template>

      <!-- 步骤 2：预览清单与勾选确认 -->
      <template v-else-if="preview">
        <div class="summary-bar">
          <span>
            来源：<strong>{{ preview.sourceKind === 'lore' ? 'Lore' : 'Kioku 备份' }}</strong>
          </span>
          <span v-if="preview.exportedAt"> 导出时间：{{ formatTime(preview.exportedAt) }} </span>
          <span>共 {{ preview.summary.total }} 条记忆</span>
          <span>可导入 {{ willImportEntriesCount }} 条</span>
          <span v-if="preview.summary.conflicts > 0"
            >冲突/同名 {{ preview.summary.conflicts }} 条</span
          >
          <span v-if="preview.summary.skipped > 0">不可导入 {{ preview.summary.skipped }} 条</span>
          <span v-if="preview.credentialsDecrypted">
            凭据 {{ willImportCredsCount }} / {{ preview.summary.credentialTotal }} 条
          </span>
        </div>

        <NoteLine
          v-if="preview.hasEncryptedCredentials && !preview.credentialsDecrypted"
          tone="neutral"
        >
          该备份包含加密凭据，但本次未勾选解密导入；仅导入记忆正文与元数据。
        </NoteLine>

        <div v-if="hasShortIdConflicts" class="flex flex-wrap items-center gap-3">
          <span class="text-xs text-muted">短 ID 已存在时：</span>
          <SegmentedChoice
            v-model="conflictStrategy"
            :items="conflictOptions"
            label="短 ID 冲突策略"
          />
        </div>

        <!-- 记忆预览列表 -->
        <div v-if="preview.items.length" class="space-y-2">
          <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <div class="flex flex-wrap items-center gap-2">
              <span>勾选要导入的记忆（已选 {{ willImportEntriesCount }} 条）</span>
              <SegmentedChoice
                v-if="previewIssueCount > 0"
                v-model="previewFilter"
                :items="previewFilterOptions"
                label="筛选导入预览项"
                compact
              />
            </div>
            <div class="flex gap-2">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :disabled="applyBusy"
                @click="toggleAllItems(true)"
              >
                全选可导入
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :disabled="applyBusy"
                @click="toggleAllItems(false)"
              >
                全部取消
              </UButton>
            </div>
          </div>

          <ul v-if="filteredPreviewItems.length" class="preview-list">
            <li
              v-for="item in filteredPreviewItems"
              :key="item.key"
              class="preview-row"
              :class="{ muted: item.skippedReason !== null }"
            >
              <label class="row-check">
                <input
                  type="checkbox"
                  :checked="itemChecked(item.key)"
                  :disabled="item.skippedReason !== null || applyBusy"
                  @change="toggleItem(item.key)"
                />
                <div class="min-w-0 flex-1 space-y-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="font-medium">{{ item.title }}</span>
                    <code class="font-mono text-xs text-muted">{{ item.sourceRef }}</code>
                    <span v-if="effectiveBootMode(item) !== 'none'" class="meta-pill pinned">
                      {{ bootModeLabels[effectiveBootMode(item)] }}
                    </span>
                    <span v-if="item.kind === 'episode'" class="meta-pill">近期摘要</span>
                    <span v-if="item.skippedReason" class="meta-pill warn">
                      跳过：{{ item.skippedReason }}
                    </span>
                    <span v-else-if="item.conflict === 'short_id_exists'" class="meta-pill warn">
                      {{
                        conflictStrategy === 'skip'
                          ? '短 ID 已存在（将跳过）'
                          : '短 ID 已存在（将重分配）'
                      }}
                    </span>
                    <span v-else-if="item.conflict === 'same_title_exists'" class="meta-pill warn">
                      已有同名记忆
                    </span>
                    <span v-if="item.secretHintLabels.length" class="meta-pill warn">
                      疑似含{{ item.secretHintLabels.join('、') }}
                    </span>
                  </div>
                  <div
                    v-if="
                      item.projects.length ||
                      item.envs.length ||
                      item.realms.length ||
                      item.runtimes.length ||
                      item.topics.length
                    "
                    class="flex flex-wrap gap-1"
                  >
                    <span v-for="p in item.projects" :key="`p-${p}`" class="meta-pill">
                      项目:{{ p }}
                    </span>
                    <span v-for="e in item.envs" :key="`e-${e}`" class="meta-pill">
                      环境:{{ envDisplayName(e) }}
                    </span>
                    <span v-for="r in item.realms" :key="`r-${r}`" class="meta-pill">
                      场域:{{ r }}
                    </span>
                    <span v-for="rt in item.runtimes" :key="`rt-${rt}`" class="meta-pill">
                      客户端:{{ runtimeName(rt) }}
                    </span>
                    <span v-for="t in item.topics" :key="`t-${t}`" class="meta-pill">
                      #{{ t }}
                    </span>
                  </div>
                  <p v-if="item.contentPreview" class="truncate text-xs text-muted">
                    {{ item.contentPreview }}
                  </p>
                </div>
              </label>
            </li>
          </ul>
          <p v-else class="preview-empty">暂无符合当前筛选条件的记录。</p>
        </div>

        <!-- 凭据元数据预览（绝不显示明文） -->
        <div v-if="preview.credentials.length" class="space-y-2 border-t border-default pt-3">
          <p class="text-xs text-muted">
            加密凭据预览（仅显示元数据，已存在的标识自动跳过、不覆盖）
          </p>
          <ul class="preview-list">
            <li
              v-for="cred in preview.credentials"
              :key="cred.slug"
              class="preview-row"
              :class="{ muted: cred.exists }"
            >
              <label class="row-check">
                <input
                  type="checkbox"
                  :checked="!cred.exists && credChecked(cred.slug)"
                  :disabled="cred.exists || applyBusy"
                  @change="toggleCred(cred.slug)"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <code class="font-mono text-xs font-medium">{{ cred.slug }}</code>
                    <span class="text-sm">{{ cred.label }}</span>
                    <span v-if="cred.exists" class="meta-pill warn">已存在（将跳过）</span>
                    <span v-else class="meta-pill">将重封写入</span>
                    <span v-for="r in cred.allowedRealms ?? []" :key="r" class="meta-pill">
                      场域:{{ r }}
                    </span>
                  </div>
                  <p v-if="cred.description" class="text-xs text-muted">{{ cred.description }}</p>
                </div>
              </label>
            </li>
          </ul>
        </div>

        <p v-if="applyError" class="text-sm text-error" role="alert">{{ applyError }}</p>

        <div class="flex flex-wrap items-center gap-2">
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            :icon="icons.back"
            :disabled="applyBusy"
            @click="clearPreview"
          >
            上一步
          </UButton>
          <UButton
            size="sm"
            :icon="icons.check"
            :loading="applyBusy"
            :disabled="!canApply"
            @click="runApply"
          >
            确认导入（{{ willImportEntriesCount }} 条记忆<template v-if="willImportCredsCount > 0">
              + {{ willImportCredsCount }} 条凭据</template
            >）
          </UButton>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.transfer-box {
  padding: 14px 16px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.summary-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  padding: 8px 0;
  border-top: 1px solid var(--ui-rule);
  border-bottom: 1px solid var(--ui-border);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.preview-list {
  max-height: 460px;
  overflow-y: auto;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.preview-empty {
  padding: 16px 12px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
  font-size: 12px;
  color: var(--ui-text-muted);
  text-align: center;
}
.preview-row {
  border-bottom: 1px solid var(--ui-border);
}
.preview-row:last-child {
  border-bottom: none;
}
.preview-row.muted {
  opacity: 0.6;
}
.row-check {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
}
.row-check input[type='checkbox'] {
  margin-top: 3px;
  flex: none;
}
.meta-pill {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
}
.meta-pill.pinned {
  border-color: var(--ui-rule);
  background: var(--ui-selected);
  color: var(--ui-on-selected);
}
.meta-pill.warn {
  border-color: var(--ui-warning);
  color: var(--ui-warning);
}
</style>
