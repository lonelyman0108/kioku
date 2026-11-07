<script setup lang="ts">
import { useId } from 'vue'

import type { ConvertDestination, UnmappedVaultField } from '../plaintext'
import { itemFieldLabel } from '../vault'
import Hint from './Hint.vue'

// 转存的去处：已有凭据、还没起标识的密码库条目、新建托管凭据，单选。选中项下面放它要填的内容（插槽）。
// 起了标识却没对应这个字段的条目只列出来，不能选
defineProps<{ destinations: ConvertDestination[]; unmapped: UnmappedVaultField[] }>()
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
      <div v-if="selected === d.key && d.kind === 'vault' && $slots.vault" class="destination-body">
        <slot name="vault" :destination="d" />
      </div>
      <div
        v-if="selected === d.key && d.kind === 'hosted' && $slots.hosted"
        class="destination-body"
      >
        <slot name="hosted" />
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
.destination-unmapped {
  padding-left: 22px;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
</style>
