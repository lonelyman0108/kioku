<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  normalizeWhen,
  type CircleKind,
  type CircleSummary,
  type FacetVocabularyView,
  type IssuedKey,
  type KeyInfo,
  type LensKeyScopes,
  type LinkedCircleGrant,
  type LinkedCircleMode,
  type PersonaInfo,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, toRef, watch } from 'vue'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { effectiveNote } from '../apps'
import { useCopy } from '../composables/useCopy'
import { useKeyMatrices } from '../composables/useKeyMatrices'
import { icons } from '../icons'
import { circleKindLabels, scopesSummary } from '../labels'
import { whenLabel } from '../memoryDetail'
import { formatRelative, formatShort, formatTime } from '../time'
import ConsequenceModal from './ConsequenceModal.vue'
import FacetWhenPicker from './FacetWhenPicker.vue'
import Hint from './Hint.vue'
import KeyScopeEditor from './KeyScopeEditor.vue'
import {
  CREDENTIAL_CAPABILITY_HINT,
  issuedCredentialCapability,
  keyPresets,
  matchPreset,
  presetScopes,
  tightenScopes,
} from './keyPresets'
import EmptyState from './strata/EmptyState.vue'
import FlagTag from './strata/FlagTag.vue'
import NoteLine from './strata/NoteLine.vue'
import ScopeTags from './strata/ScopeTags.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataCore from './strata/StrataCore.vue'

const props = withDefaults(
  defineProps<{
    circleId: string
    circleKind?: CircleKind
    clientId: string
    isClientOwner: boolean
    // 签发与轮换还要求客户端所有者在记忆圈里是所有者或编辑者；列表与吊销只看归属
    canIssue: boolean
    isCircleOwner: boolean
    // 右边权限范围看的是哪个访问密钥
    selected: string | null
    personas?: readonly PersonaInfo[]
    linkedCircleOptions?: readonly CircleSummary[]
    vocabulary?: FacetVocabularyView | null
  }>(),
  {
    circleKind: 'shared',
    personas: () => [],
    linkedCircleOptions: () => [],
    vocabulary: null,
  },
)
const emit = defineEmits<{ select: [keyId: string] }>()
const toast = useToast()
const queryClient = useQueryClient()
const queryKey = computed(() => ['keys', props.circleId, props.clientId] as const)

// 只有客户端所有者和记忆圈所有者能看访问密钥列表
const keys = useQuery({
  queryKey,
  queryFn: () => api.keys(props.circleId, props.clientId),
  enabled: computed(() => props.isClientOwner || props.isCircleOwner),
})
const live = computed(() => (keys.data.value ?? []).filter((key) => !key.revokedAt))
const revoked = computed(() => (keys.data.value ?? []).filter((key) => key.revokedAt))

// 每个还有效的访问密钥一根岩芯，画的是无上下文时的实际范围
const { rowsOf, failureOf } = useKeyMatrices(
  toRef(props, 'circleId'),
  computed(() =>
    live.value
      .filter((key) => key.effectiveScopes)
      .map((key) => ({ clientId: props.clientId, key })),
  ),
)

const realmTerms = computed(() =>
  (props.vocabulary?.terms ?? [])
    .filter((t) => t.dimensionKey === 'realm')
    .map((t) => ({ slug: t.slug, label: t.label })),
)

const otherCircles = computed(() =>
  props.linkedCircleOptions.filter((c) => c.id !== props.circleId),
)

const personaItems = computed(() => [
  { label: '沿用客户端默认人格', value: null },
  ...props.personas.map((p) => ({ label: `${p.name}（${p.slug}）`, value: p.id })),
])

const issueOpen = ref(false)
const issued = ref<IssuedKey | null>(null)
const issuedMode = ref<'create' | 'rotate'>('create')
const form = reactive({
  name: '',
  preset: keyPresets[0]!.id,
  scopes: presetScopes(keyPresets[0]!, props.isCircleOwner) as LensKeyScopes,
  linkedCircles: [] as LinkedCircleGrant[],
  contextFacets: {} as Record<string, string[]>,
  personaOverrideId: null as string | null,
})

function resetIssueForm() {
  form.name = ''
  form.preset = keyPresets[0]!.id
  form.scopes = presetScopes(keyPresets[0]!, props.isCircleOwner)
  form.linkedCircles = []
  form.contextFacets = {}
  form.personaOverrideId = null
}

function openIssue() {
  resetIssueForm()
  issued.value = null
  issuedMode.value = 'create'
  issueOpen.value = true
}

watch(
  () => props.isCircleOwner,
  (owner) => {
    form.scopes = tightenScopes(form.scopes, owner)
    form.preset = matchPreset(form.scopes, owner)
  },
  { immediate: true },
)

const actualCredentials = computed(() => issuedCredentialCapability(form.scopes))
const defaultName = computed(() => keyPresets.find((p) => p.id === form.preset)?.label ?? '自定义')

function isCircleLinked(cid: string): boolean {
  return form.linkedCircles.some((g) => g.circleId === cid)
}

function linkedMode(cid: string): LinkedCircleMode {
  return form.linkedCircles.find((g) => g.circleId === cid)?.mode ?? 'read'
}

function toggleLinkedCircle(circle: CircleSummary, checked: boolean) {
  if (!checked) {
    form.linkedCircles = form.linkedCircles.filter((g) => g.circleId !== circle.id)
    return
  }
  if (!isCircleLinked(circle.id)) {
    form.linkedCircles = [...form.linkedCircles, { circleId: circle.id, mode: 'read' }]
  }
}

function setLinkedMode(circleId: string, mode: LinkedCircleMode) {
  form.linkedCircles = form.linkedCircles.map((g) => (g.circleId === circleId ? { ...g, mode } : g))
}

const issuing = ref(false)
async function issue() {
  if (issuing.value) return
  issuing.value = true
  try {
    issuedMode.value = 'create'
    issued.value = await api.createKey(props.circleId, props.clientId, {
      name: form.name.trim() || defaultName.value,
      linkedCircles: form.linkedCircles,
      contextFacets: normalizeWhen(form.contextFacets),
      personaOverrideId: form.personaOverrideId,
      scopes: form.scopes,
    })
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKey.value }),
      queryClient.invalidateQueries({
        queryKey: ['key-matrix', props.circleId, props.clientId],
      }),
    ])
    emit('select', issued.value.id)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '签发失败', color: 'error' })
  } finally {
    issuing.value = false
  }
}

function closeIssue() {
  if (issuing.value) return
  issueOpen.value = false
  issued.value = null
  issuedMode.value = 'create'
  resetIssueForm()
}

// 轮换访问密钥：生成同名或重命名的新密钥，旧密钥立即吊销，新明文仅展示一次
const rotatingTarget = ref<KeyInfo | null>(null)
const rotateName = ref('')
const rotating = ref(false)

function openRotate(key: KeyInfo) {
  rotatingTarget.value = key
  rotateName.value = key.name
}

async function confirmRotate() {
  const target = rotatingTarget.value
  if (!target || rotating.value) return
  rotating.value = true
  try {
    const trimmed = rotateName.value.trim()
    const result = await api.rotateKey(
      props.circleId,
      props.clientId,
      target.id,
      trimmed && trimmed !== target.name ? { name: trimmed } : {},
    )
    rotatingTarget.value = null
    issuedMode.value = 'rotate'
    issued.value = result
    issueOpen.value = true
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKey.value }),
      queryClient.invalidateQueries({
        queryKey: ['key-matrix', props.circleId, props.clientId],
      }),
    ])
    emit('select', result.id)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '轮换失败', color: 'error' })
  } finally {
    rotating.value = false
  }
}

// 剪贴板接口只在 HTTPS 或 localhost 下可用；用局域网 HTTP 地址打开时提示手动复制
const copyText = useCopy()
const copy = (text: string) => copyText(text, '浏览器不允许自动复制，请手动选中访问密钥后复制')

const revoking = ref<KeyInfo | null>(null)
const revokingBusy = ref(false)
const revokeError = ref<string | null>(null)
const revokeConsequences = computed(() =>
  revoking.value
    ? [
        `访问密钥 ${revoking.value.prefix}（${revoking.value.name}）将立即失效，使用它的客户端会立刻失去访问权限。`,
        '吊销后不可恢复，需重新签发新访问密钥。',
      ]
    : [],
)
async function revoke() {
  if (!revoking.value || revokingBusy.value) return
  revokingBusy.value = true
  revokeError.value = null
  try {
    await api.revokeKey(props.circleId, props.clientId, revoking.value.id)
    revoking.value = null
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKey.value }),
      queryClient.invalidateQueries({
        queryKey: ['key-matrix', props.circleId, props.clientId],
      }),
    ])
    toast.add({ title: '访问密钥已吊销', color: 'success' })
  } catch (err) {
    revokeError.value = err instanceof ApiError ? err.message : '吊销失败'
  } finally {
    revokingBusy.value = false
  }
}

watch(
  () => [props.circleId, props.clientId],
  () => {
    issueOpen.value = false
    issued.value = null
    issuedMode.value = 'create'
    rotatingTarget.value = null
    rotateName.value = ''
    revoking.value = null
    revokeError.value = null
    resetIssueForm()
  },
)

const personaLabel = (id: string | null) =>
  id ? (props.personas.find((p) => p.id === id)?.name ?? id) : null
const facetsLabel = (when: Record<string, string[]>) =>
  Object.keys(when).length ? whenLabel(when, props.vocabulary ?? undefined) : null
const linkedGrants = (key: KeyInfo) => {
  const nonPrimary = key.circleGrants.filter((g) => !g.isPrimary)
  if (nonPrimary.length) {
    return nonPrimary.map((g) => ({
      id: g.circleId,
      name: g.circleName,
      suffix: !g.active ? '（已失效）' : g.mode === 'read_write' ? '（可跨圈写入）' : '（只读）',
    }))
  }
  const byId = new Map(props.linkedCircleOptions.map((c) => [c.id, c.name]))
  return key.linkedCircles.map((g) => ({
    id: g.circleId,
    name: byId.get(g.circleId) ?? g.circleId.slice(0, 8),
    suffix: g.mode === 'read_write' ? '（可跨圈写入）' : '（只读）',
  }))
}
</script>

<template>
  <section class="app-keys">
    <SectionHeading title="访问密钥">
      <template v-if="canIssue" #actions>
        <UButton size="sm" color="primary" variant="outline" @click="openIssue">
          签发访问密钥
        </UButton>
      </template>
    </SectionHeading>
    <p v-if="!isClientOwner && !isCircleOwner" class="keys-empty">
      仅客户端所有者或记忆圈所有者可查看访问密钥
    </p>
    <template v-else>
      <NoteLine v-if="keys.isError.value" class="keys-failed" tone="error">
        {{ readFailure(keys.error.value) }}
      </NoteLine>
      <USkeleton v-if="keys.isPending.value" class="mt-3 h-24 w-full" />
      <EmptyState v-else-if="keys.data.value && !keys.data.value.length" title="暂无访问密钥">
        <template v-if="canIssue" #actions>
          <UButton size="sm" color="primary" variant="outline" @click="openIssue">
            签发访问密钥
          </UButton>
        </template>
      </EmptyState>
      <ul>
        <li v-for="key in live" :key="key.id" class="key-row" :class="{ on: key.id === selected }">
          <component
            :is="key.effectiveScopes ? 'button' : 'div'"
            class="key-main"
            :type="key.effectiveScopes ? 'button' : undefined"
            :aria-pressed="key.effectiveScopes ? key.id === selected : undefined"
            @click="key.effectiveScopes && emit('select', key.id)"
          >
            <StrataCore
              :rows="rowsOf(key.id)"
              :label="`${key.name} 无上下文时`"
              :width="44"
              :height="72"
            />
            <span class="key-text">
              <b>{{ key.name }}</b>
              <code>{{ key.prefix }}</code>
              <ScopeTags
                class="key-tags"
                :scopes="key.scopes"
                :title="`签发范围：${scopesSummary(key.scopes)}`"
              />
              <ul
                v-if="
                  linkedGrants(key).length ||
                  facetsLabel(key.contextFacets) ||
                  personaLabel(key.personaOverrideId)
                "
                class="key-lens-tags"
              >
                <li v-for="grant in linkedGrants(key)" :key="grant.id">
                  <span>关联圈 </span><b>{{ grant.name }}</b
                  ><span>{{ grant.suffix }}</span>
                </li>
                <li v-if="facetsLabel(key.contextFacets)">
                  <span>语境 </span><b>{{ facetsLabel(key.contextFacets) }}</b>
                </li>
                <li v-if="personaLabel(key.personaOverrideId)">
                  <span>人格 </span><b>{{ personaLabel(key.personaOverrideId) }}</b>
                </li>
              </ul>
              <span v-if="key.lastUsedAt" :title="formatTime(key.lastUsedAt)">
                最近使用 {{ formatRelative(key.lastUsedAt) }}
              </span>
              <span v-else>尚未使用</span>
              <span v-if="effectiveNote(key)" class="key-note">{{ effectiveNote(key) }}</span>
              <span v-if="failureOf(key.id)" class="key-note">
                访问范围：{{ failureOf(key.id) }}
              </span>
            </span>
          </component>
          <div class="key-actions">
            <UButton
              v-if="canIssue && key.effectiveScopes"
              size="xs"
              color="neutral"
              variant="outline"
              :icon="icons.rotate"
              :aria-label="`轮换 ${key.name}`"
              @click="openRotate(key)"
            >
              轮换
            </UButton>
            <UButton
              size="xs"
              color="error"
              variant="outline"
              :aria-label="`吊销 ${key.name}`"
              @click="((revoking = key), (revokeError = null))"
            >
              吊销
            </UButton>
          </div>
        </li>
      </ul>
      <ul v-if="revoked.length" class="keys-revoked">
        <li v-for="key in revoked" :key="key.id" class="key-row revoked">
          <div class="key-main">
            <StrataCore :scopes="key.scopes" revoked :label="key.name" :width="44" :height="72" />
            <span class="key-text">
              <b>{{ key.name }}</b>
              <code>{{ key.prefix }}</code>
              <span :title="formatTime(key.revokedAt!)">
                <FlagTag status="revoked" />
                {{ formatShort(key.revokedAt!) }}
              </span>
              <span v-if="key.lastUsedAt" :title="formatTime(key.lastUsedAt)">
                最近使用 {{ formatShort(key.lastUsedAt) }}
              </span>
            </span>
          </div>
        </li>
      </ul>
    </template>

    <!-- 明文访问密钥显示期间不能点遮罩、按 Esc 或右上角关掉，只能点「我已保存」 -->
    <UModal
      :open="issueOpen"
      :title="issuedMode === 'rotate' ? '已轮换访问密钥' : '签发访问密钥'"
      :dismissible="!issued && !issuing"
      :close="!issued && !issuing"
      :ui="{ content: 'sm:max-w-4xl' }"
      @update:open="(v) => (v ? (issueOpen = true) : !issued && !issuing && closeIssue())"
    >
      <template #body>
        <div v-if="issued" class="space-y-3">
          <NoteLine tone="warning">
            {{
              issuedMode === 'rotate'
                ? '原访问密钥已立即吊销。新访问密钥只显示这一次，关闭后无法再次查看，请立即保存。'
                : '访问密钥只显示这一次，关闭后无法再次查看，请立即保存。'
            }}
          </NoteLine>
          <div class="once">
            <code>{{ issued.key }}</code>
            <UButton
              :icon="icons.copy"
              color="primary"
              variant="outline"
              aria-label="复制"
              @click="copy(issued.key)"
            />
          </div>
        </div>
        <!-- 不用表单元素：模板、分段与切面选择器按回车不隐式提交 -->
        <div v-else class="issue">
          <div class="grid gap-3 sm:grid-cols-2">
            <UFormField label="名称" help="用于辨认，例如设备加工具">
              <UInput v-model="form.name" class="w-full" :placeholder="defaultName" />
            </UFormField>
            <UFormField label="人格覆盖" help="不指定时使用客户端默认人格或按群规则">
              <USelect
                v-model="form.personaOverrideId"
                :items="personaItems"
                value-key="value"
                class="w-full"
              />
            </UFormField>
          </div>

          <div class="lens-block">
            <p class="lens-title">
              默认语境（动态焦点）
              <Hint>
                声明此访问密钥所在终端的环境或场域条件，决定启动加载变体编译与默认召回侧重；提问命中唤醒别名或切换项目时，普通记忆仍可跨语境与跨关联圈读取。
              </Hint>
            </p>
            <FacetWhenPicker
              v-model="form.contextFacets"
              :circle-id="circleId"
              :vocabulary="vocabulary"
              :exclude-dimensions="['runtime']"
              mode="context"
            />
          </div>

          <KeyScopeEditor
            v-model:scopes="form.scopes"
            v-model:preset="form.preset"
            :is-circle-owner="isCircleOwner"
            :circle-kind="circleKind"
            :realm-terms="realmTerms"
          />

          <div v-if="otherCircles.length" class="lens-block">
            <p class="lens-title">
              关联记忆圈（跨圈访问范围）
              <Hint>
                本客户端所在记忆圈为主圈；此处可额外勾选当前账号所属的其他记忆圈作为关联圈（仅允许跨圈写入正式记忆、最高私密，机密与凭据在关联圈一律不可读取）。
              </Hint>
            </p>
            <ul class="linked-list">
              <li v-for="circle in otherCircles" :key="circle.id" class="linked-row">
                <label class="linked-check">
                  <input
                    type="checkbox"
                    :checked="isCircleLinked(circle.id)"
                    @change="
                      toggleLinkedCircle(circle, ($event.target as HTMLInputElement).checked)
                    "
                  />
                  <span>{{ circle.name }}</span>
                  <span class="linked-kind">{{ circleKindLabels[circle.kind] }}</span>
                </label>
                <USelect
                  v-if="isCircleLinked(circle.id)"
                  :model-value="linkedMode(circle.id)"
                  :items="[
                    { label: '仅读取', value: 'read' },
                    {
                      label: '可跨圈写入正式记忆',
                      value: 'read_write',
                      disabled: circle.role === 'viewer',
                    },
                  ]"
                  value-key="value"
                  size="xs"
                  class="w-44"
                  @update:model-value="(v) => setLinkedMode(circle.id, v as LinkedCircleMode)"
                />
              </li>
            </ul>
          </div>
        </div>
      </template>
      <template #footer>
        <div v-if="issued" class="flex w-full justify-end gap-2">
          <UButton @click="closeIssue">我已保存</UButton>
        </div>
        <div v-else class="issue-foot">
          <div class="issue-summary">
            <span class="sr-only">签发范围</span>
            <ScopeTags :scopes="form.scopes" :credentials="actualCredentials" />
            <Hint label="凭据能力说明">{{ CREDENTIAL_CAPABILITY_HINT }}</Hint>
          </div>
          <div class="issue-actions">
            <UButton color="neutral" variant="ghost" :disabled="issuing" @click="closeIssue"
              >取消</UButton
            >
            <UButton :loading="issuing" @click="issue">签发</UButton>
          </div>
        </div>
      </template>
    </UModal>

    <UModal
      :open="rotatingTarget !== null"
      title="轮换访问密钥？"
      :dismissible="!rotating"
      :close="!rotating"
      @update:open="(v) => !v && !rotating && (rotatingTarget = null)"
    >
      <template #body>
        <!-- 不用 form -->
        <div class="space-y-3">
          <p class="text-sm">
            轮换后 <code>{{ rotatingTarget?.prefix }}</code
            >（{{ rotatingTarget?.name }}）立即吊销并生成继承相同权限的新密钥；新明文仅展示一次。
          </p>
          <UFormField label="新密钥名称">
            <UInput v-model="rotateName" class="w-full" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="rotating"
            @click="rotatingTarget = null"
          >
            取消
          </UButton>
          <UButton :loading="rotating" @click="confirmRotate">确认轮换</UButton>
        </div>
      </template>
    </UModal>

    <ConsequenceModal
      :open="revoking !== null"
      title="吊销这个访问密钥？"
      :consequences="revokeConsequences"
      action="吊销"
      :busy="revokingBusy"
      :error="revokeError"
      @close="revoking = null"
      @confirm="revoke"
    />
  </section>
</template>

<style scoped>
.keys-empty {
  padding: 14px 0;
  color: var(--ui-text-muted);
}
.note-line.keys-failed {
  margin: 10px 0 0;
  border-top: 0;
}
.key-row {
  position: relative;
  border-bottom: 1px solid var(--ui-border);
}
.key-main {
  display: flex;
  gap: 14px;
  width: 100%;
  padding: 11px 116px 11px 10px;
  text-align: left;
}
button.key-main:hover {
  background: var(--ui-bg-muted);
}
button.key-main:focus-visible {
  outline-offset: -2px;
}
.key-row.on .key-main {
  --strata-frame: var(--strata-selected-frame);
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.key-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.key-text b {
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.key-text code {
  font-size: 13px;
  color: var(--ui-text);
}
.key-lens-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 2px 0;
}
.key-lens-tags li {
  display: inline-flex;
  align-items: center;
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 18px;
  color: var(--ui-text-toned);
}
.key-lens-tags b {
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.key-note {
  color: var(--ui-warning);
}
.key-row.on .key-text {
  color: var(--strata-on-selected-muted);
}
.key-row.on .key-text b,
.key-row.on .key-text code,
.key-row.on .key-note {
  color: var(--strata-on-selected);
}
.key-actions {
  position: absolute;
  top: 10px;
  right: 8px;
  display: flex;
  gap: 4px;
  background: var(--ui-bg);
}
.keys-revoked {
  margin-top: -1px;
  border-top: 1px dashed var(--ui-border-accented);
}
.key-row.revoked .key-main {
  padding-right: 10px;
}
.key-row.revoked b {
  font-weight: 500;
  color: var(--ui-text-muted);
}
.once {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
.once code {
  flex: 1;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--strata-rule);
  font-size: 14px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.issue {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.lens-block {
  display: grid;
  gap: 8px;
}
.lens-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
}
.linked-list {
  display: grid;
  gap: 6px;
}
.linked-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--ui-border-accented);
}
.linked-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.linked-kind {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.issue-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
  width: 100%;
}
.issue-summary {
  display: flex;
  flex: 1 1 18rem;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.issue-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
.key-tags {
  margin: 2px 0;
}
.key-row.on .key-tags :deep(li),
.key-row.on .key-lens-tags li {
  border-color: var(--strata-on-selected-muted);
  color: var(--strata-on-selected-muted);
}
.key-row.on .key-tags :deep(b),
.key-row.on .key-lens-tags b {
  color: var(--strata-on-selected);
}
</style>
