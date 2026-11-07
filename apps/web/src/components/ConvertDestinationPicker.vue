<script setup lang="ts">
import { useId } from 'vue'

import { itemKey, type ConvertDestination, type UnmappedVaultField } from '../plaintext'
import { itemFieldLabel } from '../vault'
import Hint from './Hint.vue'

// 转存的去处：已有凭据、还没起标识的密码库条目、新建托管凭据，单选。选中条目时填它的标识，
// 选中新建托管凭据时填标识、名称与字段名。起了标识却没对应这个字段的条目只列出来，不能选。
// locked：已经建好的不能再改（保存前处理中途失败之后），hostedLocked 管托管凭据，lockedItems 按条目（itemKey）。
// 条目的标识（vaultIdentifiers，按 itemKey）与托管凭据的三项（hosted）归调用方所有，这里只读，
// 改了什么经 vaultIdentifier、hostedField 两个事件交给调用方去写
export type HostedFields = { identifier: string; name: string; field: string }
withDefaults(
  defineProps<{
    destinations: ConvertDestination[]
    unmapped: UnmappedVaultField[]
    vaultIdentifiers: Readonly<Record<string, string>>
    hosted: Readonly<HostedFields>
    hostedLocked?: boolean
    lockedItems?: ReadonlySet<string>
  }>(),
  { hostedLocked: false, lockedItems: () => new Set<string>() },
)
const emit = defineEmits<{
  vaultIdentifier: [key: string, identifier: string]
  hostedField: [field: keyof HostedFields, value: string]
}>()
const selected = defineModel<string>({ required: true })
const group = useId()
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
          密码库条目「{{ d.itemName }}」的{{ itemFieldLabel(d.itemField) }}
          <span class="text-muted">尚未起标识</span>
        </span>
        <span v-else>新建托管凭据</span>
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
      <div v-if="selected === d.key && d.kind === 'hosted'" class="destination-body hosted-fields">
        <UFormField label="凭据标识">
          <UInput
            :model-value="hosted.identifier"
            class="w-full font-mono"
            autocomplete="off"
            :disabled="hostedLocked"
            @update:model-value="(v: string) => emit('hostedField', 'identifier', v)"
          />
        </UFormField>
        <UFormField label="名称">
          <UInput
            :model-value="hosted.name"
            class="w-full"
            autocomplete="off"
            :disabled="hostedLocked"
            @update:model-value="(v: string) => emit('hostedField', 'name', v)"
          />
        </UFormField>
        <UFormField label="字段名">
          <UInput
            :model-value="hosted.field"
            class="w-full font-mono"
            autocomplete="off"
            :disabled="hostedLocked"
            @update:model-value="(v: string) => emit('hostedField', 'field', v)"
          />
        </UFormField>
      </div>
    </div>
    <p v-for="(u, i) in unmapped" :key="i" class="destination-unmapped">
      条目「{{ u.itemName }}」的{{ itemFieldLabel(u.itemField) }}同值，凭据
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
.hosted-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
@media (max-width: 640px) {
  .hosted-fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
.destination-unmapped {
  padding-left: 22px;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
</style>
