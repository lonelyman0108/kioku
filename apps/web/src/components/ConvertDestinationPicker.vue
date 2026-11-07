<script setup lang="ts">
import { CREDENTIAL_EXPIRING_DAYS } from '@kioku/contracts'
import { nextTick, useId, watch } from 'vue'

import {
  itemKey,
  type ConvertDestination,
  type NewCredentialFields,
  type UnmappedVaultField,
} from '../plaintext'
import {
  CREDENTIAL_URL_HINT,
  expiresElementBad,
  expiresInputBad,
  itemFieldPhrase,
  storeLabel,
  type NewCredentialStore,
} from '../vault'
import Hint from './Hint.vue'

// 转存的去处：已有凭据、还没起标识的密码库条目、新建凭据，单选。选中条目时填它的标识，
// 选中新建凭据时填标识、名称、字段名、网址与到期时间，并说明写到哪里（store：设了去处写进那个集合，
// 没有时由 Kioku 托管；连接列表没读到时为 null，读取失败时 storeFailed）。起了标识却没对应这个字段的条目只列出来，不能选。
// locked：已经建好的不能再改（保存前处理中途失败之后），freshLocked 管新建的凭据，lockedItems 按条目（itemKey）。
// 条目的标识（vaultIdentifiers，按 itemKey）与新建凭据的几项（fresh）归调用方所有，这里只读，
// 改了什么经 vaultIdentifier、freshField、freshExpiresBad 几个事件交给调用方去写
const props = withDefaults(
  defineProps<{
    destinations: ConvertDestination[]
    unmapped: UnmappedVaultField[]
    vaultIdentifiers: Readonly<Record<string, string>>
    fresh: Readonly<NewCredentialFields>
    store: NewCredentialStore | null
    storeFailed?: boolean
    // 去处眼下用不了的原因（vault.ts 的 destinationProblem），新建会失败
    storeIssue?: string | null
    freshLocked?: boolean
    lockedItems?: ReadonlySet<string>
  }>(),
  {
    storeFailed: false,
    storeIssue: null,
    freshLocked: false,
    lockedItems: () => new Set<string>(),
  },
)
const emit = defineEmits<{
  vaultIdentifier: [key: string, identifier: string]
  freshField: [field: Exclude<keyof NewCredentialFields, 'expiresBad'>, value: string]
  // 到期时间的输入框填了一半：这时值是空的，要另外报上去
  freshExpiresBad: [bad: boolean]
}>()
const selected = defineModel<string>({ required: true })
const group = useId()

// 到期时间的输入框换了一个（选别的去处再选回来会卸载再挂载）或者值被程序改了（重置、重新打开）：
// 「填了一半」按输入框现在的 validity 重新判断，不留着上一个输入框的状态
let expiresEl: HTMLInputElement | null = null
function setExpiresInput(component: unknown) {
  const el = (component as { inputRef?: HTMLInputElement } | null)?.inputRef ?? null
  if (el === expiresEl) return
  expiresEl = el
  emit('freshExpiresBad', expiresElementBad(el))
}
watch(
  () => props.fresh.expires,
  () => void nextTick(() => emit('freshExpiresBad', expiresElementBad(expiresEl))),
)
</script>

<template>
  <div class="destinations" role="radiogroup" aria-label="转存到">
    <div v-for="d in destinations" :key="d.key" class="destination">
      <label class="destination-option">
        <input
          type="radio"
          :name="group"
          :checked="selected === d.key"
          @change="selected = d.key"
        />
        <span v-if="d.kind === 'credential'" class="min-w-0">
          凭据「{{ d.name }}」<code class="destination-ref">{{ d.identifier }}#{{ d.field }}</code>
        </span>
        <span v-else-if="d.kind === 'vault'" class="min-w-0">
          密码库条目「{{ d.itemName }}」的{{ itemFieldPhrase(d.itemField) }}
          <span class="text-muted">尚未起标识</span>
        </span>
        <span v-else class="min-w-0">
          新建凭据
          <span class="text-muted">{{ storeLabel(store, storeFailed) }}</span>
        </span>
      </label>
      <div v-if="selected === d.key && d.kind === 'vault'" class="destination-body">
        <UFormField label="凭据标识" help="名称取条目名称，字段对应按条目的字段">
          <UInput
            :model-value="vaultIdentifiers[itemKey(d)]"
            class="w-full font-mono"
            autocomplete="off"
            :disabled="lockedItems.has(itemKey(d))"
            @update:model-value="(v: string) => emit('vaultIdentifier', itemKey(d), v)"
          />
        </UFormField>
      </div>
      <div v-if="selected === d.key && d.kind === 'new'" class="destination-body">
        <p v-if="storeIssue" class="destination-issue text-warning">{{ storeIssue }}</p>
        <div class="fresh-fields">
          <UFormField label="凭据标识">
            <UInput
              :model-value="fresh.identifier"
              class="w-full font-mono"
              autocomplete="off"
              :disabled="freshLocked"
              @update:model-value="(v: string) => emit('freshField', 'identifier', v)"
            />
          </UFormField>
          <UFormField label="名称">
            <UInput
              :model-value="fresh.name"
              class="w-full"
              autocomplete="off"
              :disabled="freshLocked"
              @update:model-value="(v: string) => emit('freshField', 'name', v)"
            />
          </UFormField>
          <UFormField label="字段名">
            <UInput
              :model-value="fresh.field"
              class="w-full font-mono"
              autocomplete="off"
              :disabled="freshLocked"
              @update:model-value="(v: string) => emit('freshField', 'field', v)"
            />
          </UFormField>
        </div>
        <div class="fresh-extra">
          <UFormField>
            <template #label
              >网址<Hint>{{ CREDENTIAL_URL_HINT }}</Hint></template
            >
            <UInput
              :model-value="fresh.url"
              class="w-full font-mono"
              placeholder="可选"
              autocomplete="off"
              :disabled="freshLocked"
              @update:model-value="(v: string) => emit('freshField', 'url', v)"
            />
          </UFormField>
          <UFormField>
            <template #label
              >到期时间<Hint>
                可选；到期前 {{ CREDENTIAL_EXPIRING_DAYS }} 天起进入待处理，到期后照常可以取用。
              </Hint></template
            >
            <UInput
              :ref="setExpiresInput"
              :model-value="fresh.expires"
              type="datetime-local"
              class="w-full"
              aria-label="到期时间"
              :disabled="freshLocked"
              @update:model-value="(v: string) => emit('freshField', 'expires', v)"
              @input="(e: Event) => emit('freshExpiresBad', expiresInputBad(e))"
              @keyup="(e: Event) => emit('freshExpiresBad', expiresInputBad(e))"
              @blur="(e: Event) => emit('freshExpiresBad', expiresInputBad(e))"
            />
          </UFormField>
        </div>
      </div>
    </div>
    <p v-for="(u, i) in unmapped" :key="i" class="destination-unmapped">
      条目「{{ u.itemName }}」的{{ itemFieldPhrase(u.itemField) }}同值，凭据
      <code>{{ u.identifier }}</code> 中暂无这个字段<Hint>
        在凭据页给这条凭据添加这个字段的对应后可选。
      </Hint>
    </p>
  </div>
</template>

<style scoped>
.destinations {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 14px;
}
.destination-option {
  display: flex;
  align-items: baseline;
  gap: 8px;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.destination-option input {
  flex: none;
  accent-color: var(--ui-text-highlighted);
}
.destination-ref {
  margin-left: 4px;
  font-family: var(--font-mono);
  font-size: 13px;
}
.destination-body {
  margin: 6px 0 4px 22px;
}
.fresh-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.fresh-extra {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 8px;
  margin-top: 8px;
}
.destination-issue {
  margin-bottom: 6px;
}
@media (max-width: 640px) {
  .fresh-fields,
  .fresh-extra {
    grid-template-columns: minmax(0, 1fr);
  }
}
.destination-unmapped {
  padding-left: 22px;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
</style>
