<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  ALLOWLIST_MAX,
  CORE_PII_KINDS,
  CUSTOM_RULE_MAX,
  OPTIONAL_PII_KINDS,
  PII_KIND_NAMES,
  normalizeRuleKind,
  type CustomSensitiveRule,
  type SpacePrivacySettings as SpacePrivacyView,
  type ToggleablePiiKind,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import Hint from './Hint.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SaveBar from './strata/SaveBar.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsSummaryStrip from './strata/SettingsSummaryStrip.vue'

// 空间 › 隐私与脱敏：控制空间内的明文凭据拦截、个人信息识别、自定义规则与白名单。只有空间所有者能改
const dirtyModel = defineModel<boolean>('dirty', { default: false })
const props = defineProps<{ spaceId: string }>()

const toast = useToast()
const queryClient = useQueryClient()
const { space } = useSession()
const editable = computed(() => space.value?.role === 'owner')

const queryKey = computed(() => ['space-privacy', props.spaceId] as const)
const query = useQuery({
  queryKey,
  enabled: computed(() => Boolean(props.spaceId)),
  queryFn: ({ queryKey: [, sid] }) => api.spacePrivacy(sid),
})

const form = reactive<{
  credentials: boolean
  pii: boolean
  piiKinds: Record<ToggleablePiiKind, boolean>
  customRules: CustomSensitiveRule[]
  allowlist: string[]
  usePrivacyModel: boolean
}>({
  credentials: true,
  pii: true,
  piiKinds: {
    phone: true,
    id_card: true,
    bank_card: true,
    email: true,
    public_ip: false,
    mac: false,
    ssn: false,
    iban: false,
    passport: false,
  },
  customRules: [],
  allowlist: [],
  usePrivacyModel: false,
})

function syncFromSaved(saved: SpacePrivacyView) {
  form.credentials = saved.credentials
  form.pii = saved.pii
  form.piiKinds = { ...saved.piiKinds }
  form.customRules = saved.customRules.map((r) => ({ ...r }))
  form.allowlist = [...saved.allowlist]
  form.usePrivacyModel = saved.usePrivacyModel
}

watch(
  () => query.data.value,
  (saved) => {
    if (saved) syncFromSaved(saved)
  },
  { immediate: true },
)

const dirtyCount = computed(() => {
  const saved = query.data.value
  if (!saved) return 0
  let count = 0
  if (form.credentials !== saved.credentials) count++
  if (form.pii !== saved.pii) count++
  if (form.usePrivacyModel !== saved.usePrivacyModel) count++
  for (const kind of [...CORE_PII_KINDS, ...OPTIONAL_PII_KINDS]) {
    if (Boolean(form.piiKinds[kind]) !== Boolean(saved.piiKinds[kind])) count++
  }
  if (JSON.stringify(form.customRules) !== JSON.stringify(saved.customRules)) count++
  if (JSON.stringify(form.allowlist) !== JSON.stringify(saved.allowlist)) count++
  return count
})

const dirty = computed(() => dirtyCount.value > 0)

watch(
  dirty,
  (changed) => {
    dirtyModel.value = changed
  },
  { immediate: true },
)

const newRule = reactive<{
  kind: string
  mode: 'prefix' | 'regex'
  pattern: string
}>({
  kind: '',
  mode: 'prefix',
  pattern: '',
})
const ruleError = ref<string | null>(null)

function addRule() {
  ruleError.value = null
  if (!editable.value || form.customRules.length >= CUSTOM_RULE_MAX) return
  const kind = normalizeRuleKind(newRule.kind)
  const pat = newRule.pattern.trim()
  if (!kind) {
    ruleError.value = '请填写规则类别标识'
    return
  }
  if (newRule.mode === 'prefix') {
    if (pat.length < 3) {
      ruleError.value = '前缀至少需要 3 个字符'
      return
    }
    form.customRules.push({ kind, prefix: pat })
  } else {
    if (!pat) {
      ruleError.value = '请填写正则表达式'
      return
    }
    try {
      new RegExp(pat)
    } catch {
      ruleError.value = '正则表达式语法有误'
      return
    }
    form.customRules.push({ kind, regex: pat })
  }
  newRule.kind = ''
  newRule.pattern = ''
}

function removeRule(index: number) {
  if (!editable.value) return
  form.customRules.splice(index, 1)
}

const newAllow = ref('')
const allowError = ref<string | null>(null)

function addAllow() {
  allowError.value = null
  if (!editable.value) return
  const items = newAllow.value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
  for (const item of items) {
    if (item.length < 2 || item.length > 200) {
      allowError.value = '每项长度需在 2 到 200 个字符之间'
      return
    }
    if (form.allowlist.includes(item)) continue
    if (form.allowlist.length >= ALLOWLIST_MAX) {
      allowError.value = `白名单最多 ${ALLOWLIST_MAX} 项`
      return
    }
    form.allowlist.push(item)
  }
  newAllow.value = ''
}

function removeAllow(index: number) {
  if (!editable.value) return
  form.allowlist.splice(index, 1)
}

const saving = ref(false)
async function save() {
  if (!editable.value || !dirty.value) return
  saving.value = true
  try {
    const saved = await api.saveSpacePrivacy(props.spaceId, {
      credentials: form.credentials,
      pii: form.pii,
      piiKinds: { ...form.piiKinds },
      customRules: form.customRules.map((r) => ({ ...r })),
      allowlist: [...form.allowlist],
      usePrivacyModel: form.usePrivacyModel,
    })
    queryClient.setQueryData(queryKey.value, saved)
    syncFromSaved(saved)
    toast.add({ title: '已保存隐私设置', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

function reset() {
  if (query.data.value) syncFromSaved(query.data.value)
  ruleError.value = null
  allowError.value = null
}

const rescanning = ref(false)
async function rescan() {
  if (!editable.value || dirty.value || rescanning.value) return
  rescanning.value = true
  try {
    const res = await api.rescanSpacePrivacy(props.spaceId)
    toast.add({
      title: res.queued ? '已提交后台重扫存量记忆' : `已完成重扫，更新 ${res.updated ?? 0} 条记忆`,
      color: 'success',
    })
    for (const key of ['memory-list', 'inbox-counts', 'overview']) {
      void queryClient.invalidateQueries({ queryKey: [key, props.spaceId] })
    }
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '重扫失败', color: 'error' })
  } finally {
    rescanning.value = false
  }
}

const enabledPiiCount = computed(() =>
  form.pii ? [...CORE_PII_KINDS, ...OPTIONAL_PII_KINDS].filter((k) => form.piiKinds[k]).length : 0,
)

const summaryItems = computed(() => [
  {
    label: '当前权限',
    value: editable.value ? '空间所有者' : '空间成员',
    sub: editable.value ? '可配置识别开关、自定义规则与重扫' : '仅所有者可修改空间隐私规则',
    tone: editable.value ? ('ok' as const) : ('warn' as const),
  },
  {
    label: '个人识别规则',
    value: `${enabledPiiCount.value} 类启用`,
    sub: `自定义规则 ${form.customRules.length} 条，白名单 ${form.allowlist.length} 项`,
  },
])
</script>

<template>
  <div class="privacy-page">
    <SettingsSummaryStrip :items="summaryItems" class="summary" />
    <ReadFailureNote v-if="query.isError.value" :query="query" />
    <USkeleton v-if="query.isPending.value" class="h-56 w-full" />

    <form v-else-if="query.data.value" class="space-y-8" @submit.prevent="save">
      <SettingsBlock title="敏感内容识别">
        <template #note>
          控制写入与外发至外部模型或向量服务前的敏感内容保护；原始记忆保留在本地，外发前自动脱敏。
          <Hint>
            新增明文凭据默认拦截写入；个人信息在本人私密边界内静默留存，出现在共享或非私密范围内时进入「待处理」，可移入本人私密、设为机密、抹除敏感段或忽略。
          </Hint>
        </template>

        <div class="switch-list">
          <div class="switch-row">
            <div>
              <p class="switch-title">检测明文凭据</p>
              <p class="switch-desc">识别接口密钥、令牌、助记词、私钥与密码字段。</p>
            </div>
            <USwitch v-model="form.credentials" :disabled="!editable" />
          </div>

          <div class="switch-row">
            <div>
              <p class="switch-title">检测个人信息</p>
              <p class="switch-desc">识别手机号、证件号、银行卡与邮箱，不拦截写入，供统一打码。</p>
            </div>
            <USwitch v-model="form.pii" :disabled="!editable" />
          </div>

          <div class="switch-row">
            <div>
              <p class="switch-title">启用实例隐私识别模型</p>
              <p class="switch-desc">当实例已配置实体识别模型时，补充识别人名、住址与私有账号。</p>
            </div>
            <USwitch v-model="form.usePrivacyModel" :disabled="!editable || !form.pii" />
          </div>
        </div>

        <div v-if="form.pii" class="pii-grid">
          <div class="pii-group">
            <p class="group-title">核心类别（默认开启）</p>
            <div class="kind-grid">
              <label v-for="kind in CORE_PII_KINDS" :key="kind" class="kind-item">
                <UCheckbox v-model="form.piiKinds[kind]" :disabled="!editable" />
                <span>{{ PII_KIND_NAMES[kind] }}</span>
              </label>
            </div>
          </div>

          <div class="pii-group">
            <p class="group-title">扩展类别（按需开启）</p>
            <div class="kind-grid">
              <label v-for="kind in OPTIONAL_PII_KINDS" :key="kind" class="kind-item">
                <UCheckbox v-model="form.piiKinds[kind]" :disabled="!editable" />
                <span>{{ PII_KIND_NAMES[kind] }}</span>
              </label>
            </div>
          </div>
        </div>
      </SettingsBlock>

      <SettingsBlock title="自定义规则">
        <template #note>
          为企业内部分发的专属令牌前缀或内部编号增加自定义识别规则（最多
          {{ CUSTOM_RULE_MAX }} 条）。
        </template>

        <ul v-if="form.customRules.length" class="rule-list">
          <li v-for="(rule, index) in form.customRules" :key="index" class="rule-row">
            <span class="rule-kind font-mono">{{ rule.kind }}</span>
            <span class="rule-mode">{{ rule.prefix ? '前缀' : '正则' }}</span>
            <code class="rule-pattern">{{ rule.prefix ?? rule.regex }}</code>
            <UButton
              v-if="editable"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="removeRule(index)"
            >
              移除
            </UButton>
          </li>
        </ul>
        <p v-else class="empty-note">暂无自定义规则</p>

        <div v-if="editable && form.customRules.length < CUSTOM_RULE_MAX" class="add-rule">
          <UInput
            v-model="newRule.kind"
            placeholder="类别标识，如 ACME_TOKEN"
            class="w-44 font-mono"
          />
          <USelect
            v-model="newRule.mode"
            :items="[
              { label: '固定前缀', value: 'prefix' },
              { label: '正则表达式', value: 'regex' },
            ]"
            value-key="value"
            class="w-32"
          />
          <UInput
            v-model="newRule.pattern"
            :placeholder="newRule.mode === 'prefix' ? '前缀至少 3 位，如 ACME-' : '正则表达式'"
            class="min-w-52 flex-1 font-mono"
          />
          <UButton color="neutral" variant="outline" @click="addRule">添加规则</UButton>
        </div>
        <p v-if="ruleError" class="field-error">{{ ruleError }}</p>
      </SettingsBlock>

      <SettingsBlock title="白名单">
        <template #note>
          明确放行的示例值、内部占位符或测试号码（最多
          {{ ALLOWLIST_MAX }} 项），匹配后不再提醒或打码。
        </template>

        <div v-if="form.allowlist.length" class="allow-tags">
          <span v-for="(item, index) in form.allowlist" :key="item" class="allow-tag font-mono">
            <span>{{ item }}</span>
            <button
              v-if="editable"
              type="button"
              class="allow-remove"
              aria-label="移除白名单项"
              @click="removeAllow(index)"
            >
              ×
            </button>
          </span>
        </div>
        <p v-else class="empty-note">暂无白名单项</p>

        <div v-if="editable && form.allowlist.length < ALLOWLIST_MAX" class="add-allow">
          <UInput
            v-model="newAllow"
            placeholder="输入放行值，多个可用逗号分隔"
            class="min-w-60 flex-1 font-mono"
            @keydown.enter.prevent="addAllow"
          />
          <UButton color="neutral" variant="outline" @click="addAllow">加入白名单</UButton>
        </div>
        <p v-if="allowError" class="field-error">{{ allowError }}</p>
      </SettingsBlock>

      <div v-if="editable" class="actions-bar">
        <SaveBar :count="dirtyCount" :saving="saving" @discard="reset" />
        <div class="rescan-row">
          <UButton
            color="neutral"
            variant="outline"
            :loading="rescanning"
            :disabled="dirty"
            @click="rescan"
          >
            重扫存量记忆
          </UButton>
          <span class="rescan-note">
            {{
              dirty
                ? '保存更改后可执行全空间重扫。'
                : '使用当前规则重新扫描空间内既有记忆的敏感内容标记。'
            }}
          </span>
        </div>
      </div>
    </form>
  </div>
</template>

<style scoped>
.privacy-page {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.summary {
  max-width: 64rem;
}
.switch-list {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--ui-border);
}
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--ui-border);
}
.switch-title {
  font-size: 14px;
  font-weight: 500;
}
.switch-desc {
  margin-top: 2px;
  font-size: 13px;
  color: var(--ui-text-muted);
}
.pii-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  margin-top: 16px;
}
.pii-group {
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
}
.group-title {
  margin-bottom: 10px;
  font-size: 13px;
  font-weight: 500;
  color: var(--ui-text-muted);
}
.kind-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px 12px;
}
.kind-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.rule-list {
  border-top: 1px solid var(--ui-border);
}
.rule-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
}
.rule-kind {
  font-size: 12px;
  font-weight: 600;
}
.rule-mode {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.rule-pattern {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
}
.empty-note {
  font-size: 14px;
  color: var(--ui-text-muted);
}
.add-rule,
.add-allow {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.allow-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.allow-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border: 1px solid var(--ui-border);
  font-size: 13px;
}
.allow-remove {
  color: var(--ui-text-muted);
  cursor: pointer;
}
.allow-remove:hover {
  color: var(--ui-text-highlighted);
}
.field-error {
  margin-top: 6px;
  font-size: 13px;
  color: var(--ui-error);
}
.actions-bar {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rescan-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.rescan-note {
  font-size: 13px;
  color: var(--ui-text-muted);
}
</style>
