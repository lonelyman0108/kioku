<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { CreatedKey, KeyInfo, KeyScopes } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, toRef, watch } from 'vue'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { effectiveNote } from '../apps'
import { useCopy } from '../composables/useCopy'
import { useKeyMatrices } from '../composables/useKeyMatrices'
import { icons } from '../icons'
import { scopesSummary } from '../labels'
import { formatRelative, formatShort, formatTime } from '../time'
import Hint from './Hint.vue'
import KeyScopeEditor from './KeyScopeEditor.vue'
import {
  allowedCredentialCapability,
  issuedCredentialCapability,
  keyPresets,
  matchPreset,
  presetScopes,
} from './keyPresets'
import EmptyState from './strata/EmptyState.vue'
import FlagTag from './strata/FlagTag.vue'
import NoteLine from './strata/NoteLine.vue'
import ScopeTags from './strata/ScopeTags.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataCore from './strata/StrataCore.vue'

const props = defineProps<{
  spaceId: string
  appId: string
  isAppOwner: boolean
  // 签发还要求应用所有者在空间里是所有者或编辑者；列表与吊销只看归属，被降级的所有者仍能吊销泄露的 Key
  canIssue: boolean
  isSpaceOwner: boolean
  // 右边权限范围看的是哪个 Key
  selected: string | null
}>()
const emit = defineEmits<{ select: [keyId: string] }>()
const toast = useToast()
const queryClient = useQueryClient()
const queryKey = computed(() => ['keys', props.spaceId, props.appId])

// 只有应用所有者和空间所有者能看 Key 列表
const keys = useQuery({
  queryKey,
  queryFn: () => api.keys(props.spaceId, props.appId),
  enabled: computed(() => props.isAppOwner || props.isSpaceOwner),
})
const live = computed(() => (keys.data.value ?? []).filter((key) => !key.revokedAt))
const revoked = computed(() => (keys.data.value ?? []).filter((key) => key.revokedAt))
// 每个还有效的 Key 一根岩芯，画的是无上下文时的实际范围
const { rowsOf, failureOf } = useKeyMatrices(
  toRef(props, 'spaceId'),
  computed(() =>
    live.value.filter((key) => key.effectiveScopes).map((key) => ({ appId: props.appId, key })),
  ),
)

const issueOpen = ref(false)
const issued = ref<CreatedKey | null>(null)
const form = reactive({
  name: '',
  preset: keyPresets[0]!.id,
  scopes: presetScopes(keyPresets[0]!, props.isSpaceOwner) as KeyScopes,
})
// 不是空间所有者时打开表单就收紧：模板里的「取用」、机密级与跨人格写入都不能带过去
watch(
  () => props.isSpaceOwner,
  (owner) => {
    const s = form.scopes
    form.scopes = {
      ...s,
      credentials: allowedCredentialCapability(s.credentials, owner),
      maxSensitivity: !owner && s.maxSensitivity === 'secret' ? 'private' : s.maxSensitivity,
      admin: owner && s.admin,
    }
    form.preset = matchPreset(form.scopes, owner)
  },
  { immediate: true },
)
// 底部标签写实际能用到的凭据能力，和表格里的提示一致
const actualCredentials = computed(() => issuedCredentialCapability(form.scopes))

// 没填名称时用模板的名字
const defaultName = computed(() => keyPresets.find((p) => p.id === form.preset)?.label ?? '自定义')

// 签发中不接受第二次提交：连点两次会签出两个 Key，只有后一个的明文被展示
const issuing = ref(false)
async function issue() {
  if (issuing.value) return
  issuing.value = true
  try {
    issued.value = await api.createKey(props.spaceId, props.appId, {
      name: form.name || defaultName.value,
      scopes: form.scopes,
    })
    await queryClient.invalidateQueries({ queryKey: queryKey.value })
    // 右边跟着看新签发的这个
    emit('select', issued.value.id)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '签发失败', color: 'error' })
  } finally {
    issuing.value = false
  }
}

// 关掉时只清名称：选的模板与表格里的改动留着，下次打开接着用
function closeIssue() {
  issueOpen.value = false
  issued.value = null
  form.name = ''
}

// 剪贴板接口只在 HTTPS 或 localhost 下可用；用局域网 HTTP 地址打开时提示手动复制
const copyText = useCopy()
const copy = (text: string) => copyText(text, '浏览器不允许自动复制，请手动选中访问密钥后复制')

const revoking = ref<KeyInfo | null>(null)
async function revoke() {
  if (!revoking.value) return
  try {
    await api.revokeKey(props.spaceId, props.appId, revoking.value.id)
    revoking.value = null
    await queryClient.invalidateQueries({ queryKey: queryKey.value })
    toast.add({ title: '访问密钥已吊销', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '吊销失败', color: 'error' })
  }
}
</script>

<template>
  <section class="app-keys">
    <SectionHeading title="访问密钥">
      <template v-if="canIssue" #actions>
        <UButton size="sm" color="primary" variant="outline" @click="issueOpen = true">
          签发访问密钥
        </UButton>
      </template>
    </SectionHeading>
    <p v-if="!isAppOwner && !isSpaceOwner" class="keys-empty">仅应用所有者可查看和签发访问密钥</p>
    <template v-else>
      <NoteLine v-if="keys.isError.value" class="keys-failed" tone="error">
        {{ readFailure(keys.error.value) }}
      </NoteLine>
      <USkeleton v-if="keys.isPending.value" class="mt-3 h-24 w-full" />
      <EmptyState v-else-if="keys.data.value && !keys.data.value.length" title="暂无访问密钥">
        <template v-if="canIssue" #actions>
          <UButton size="sm" color="primary" variant="outline" @click="issueOpen = true">
            签发访问密钥
          </UButton>
        </template>
      </EmptyState>
      <ul>
        <li v-for="key in live" :key="key.id" class="key-row" :class="{ on: key.id === selected }">
          <!-- 已作废的 Key 没有权限范围可看，只能吊销 -->
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
              <span v-if="key.lastUsedAt" :title="formatTime(key.lastUsedAt)">
                最近使用 {{ formatRelative(key.lastUsedAt) }}
              </span>
              <span v-else>尚未使用</span>
              <span v-if="effectiveNote(key)" class="key-note">{{ effectiveNote(key) }}</span>
              <span v-if="failureOf(key.id)" class="key-note">
                权限范围：{{ failureOf(key.id) }}
              </span>
            </span>
          </component>
          <UButton
            class="key-revoke"
            size="sm"
            color="error"
            variant="outline"
            :aria-label="`吊销 ${key.name}`"
            @click="revoking = key"
          >
            吊销
          </UButton>
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

    <!-- 明文 Key 显示期间不能点遮罩、按 Esc 或右上角关掉，只能点「我已保存」，免得没复制就丢了 -->
    <UModal
      :open="issueOpen"
      title="签发访问密钥"
      :dismissible="!issued"
      :close="!issued"
      :ui="{ content: 'sm:max-w-4xl' }"
      @update:open="(v) => (v ? (issueOpen = true) : closeIssue())"
    >
      <template #body>
        <div v-if="issued" class="space-y-3">
          <NoteLine tone="warning">访问密钥只显示这一次，关闭后无法再次查看，请立即保存。</NoteLine>
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
        <!--
          不用表单元素：卡片、分段按钮是单选，读写是勾选框，在它们上面按回车会隐式提交，
          方向键选到一半就签出访问密钥、明文马上显示。名称框里按回车同样不签发，只有点「签发」才签发
        -->
        <div v-else class="issue">
          <UFormField label="名称" help="用于辨认，例如设备加工具">
            <UInput v-model="form.name" class="w-full" :placeholder="defaultName" />
          </UFormField>
          <KeyScopeEditor
            v-model:scopes="form.scopes"
            v-model:preset="form.preset"
            :is-space-owner="isSpaceOwner"
          />
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
            <Hint label="凭据能力说明">
              取用与管理都需要可读本人、最高敏感级不低于私密，管理还需要可写本人。带会话上下文时（群聊、私聊、定时任务）凭据一律不可用。
            </Hint>
          </div>
          <div class="issue-actions">
            <UButton color="neutral" variant="ghost" @click="closeIssue">取消</UButton>
            <UButton :loading="issuing" @click="issue">签发</UButton>
          </div>
        </div>
      </template>
    </UModal>

    <UModal
      :open="revoking !== null"
      title="吊销这个访问密钥？"
      @update:open="(v) => !v && (revoking = null)"
    >
      <template #body>
        <p class="text-sm">
          吊销 <code>{{ revoking?.prefix }}</code
          >（{{ revoking?.name }}）后，使用它的客户端将立即失去访问权限。
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="revoking = null">取消</UButton>
          <UButton color="error" @click="revoke">吊销</UButton>
        </div>
      </template>
    </UModal>
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
  padding: 11px 64px 11px 10px;
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
.key-revoke {
  position: absolute;
  top: 10px;
  right: 8px;
  background: var(--ui-bg);
}
.key-revoke:hover {
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
.key-row.on .key-tags :deep(li) {
  border-color: var(--strata-on-selected-muted);
  color: var(--strata-on-selected-muted);
}
.key-row.on .key-tags :deep(b) {
  color: var(--strata-on-selected);
}
</style>
