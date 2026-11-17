<script setup lang="ts">
import { MAX_FALLBACK_MODELS } from '@kioku/contracts'
import { computed, ref } from 'vue'

import { icons } from '../icons'
import { FORMAT_LABELS, type ProfileOption } from '../models'

// 有序模型引用编辑：按顺序请求，前一个失败时自动切换到下一个
const modelIds = defineModel<string[]>({ required: true })
const props = withDefaults(
  defineProps<{
    options: readonly ProfileOption[]
    min?: number
    max?: number
    emptyHint?: string
  }>(),
  {
    min: 0,
    max: MAX_FALLBACK_MODELS,
    emptyHint: '请先在「模型服务商」中添加对应类型的模型。',
  },
)

const byId = computed(() => new Map(props.options.map((o) => [o.profileId, o])))
const remaining = computed(() =>
  props.options
    .filter((o) => !modelIds.value.includes(o.profileId))
    .map((o) => ({ label: o.display, value: o.profileId })),
)

const pending = ref<string | undefined>(undefined)
const selectKey = ref(0)

function append(id: string | undefined) {
  pending.value = undefined
  selectKey.value++
  if (!id || modelIds.value.includes(id) || modelIds.value.length >= props.max) return
  modelIds.value = [...modelIds.value, id]
}

function swap(i: number, j: number) {
  const list = [...modelIds.value]
  ;[list[i], list[j]] = [list[j]!, list[i]!]
  modelIds.value = list
}

function removeAt(i: number) {
  if (modelIds.value.length <= props.min) return
  modelIds.value = modelIds.value.filter((_, idx) => idx !== i)
}
</script>

<template>
  <div class="space-y-3">
    <div v-if="!options.length" class="border border-default p-3 text-sm text-muted">
      {{ emptyHint }}
    </div>
    <template v-else>
      <div
        v-for="(id, i) in modelIds"
        :key="id"
        class="flex flex-wrap items-center gap-2 border-t border-default pt-2"
      >
        <span class="text-xs text-muted tabular-nums">顺位 {{ i + 1 }}</span>
        <div class="min-w-0 flex-1">
          <div class="truncate font-medium">
            {{ byId.get(id)?.display ?? `未知模型（${id}）` }}
          </div>
          <div v-if="byId.get(id)" class="truncate font-mono text-xs text-muted">
            {{ FORMAT_LABELS[byId.get(id)!.format] }} · {{ byId.get(id)!.baseUrl }}
          </div>
        </div>
        <div class="flex items-center gap-1">
          <UButton
            :icon="icons.up"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="`上移第 ${i + 1} 项`"
            :disabled="i === 0"
            @click="swap(i, i - 1)"
          />
          <UButton
            :icon="icons.down"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="`下移第 ${i + 1} 项`"
            :disabled="i === modelIds.length - 1"
            @click="swap(i, i + 1)"
          />
          <UButton
            :icon="icons.remove"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="`移除第 ${i + 1} 项`"
            :disabled="modelIds.length <= min"
            @click="removeAt(i)"
          />
        </div>
      </div>

      <div v-if="modelIds.length < max && remaining.length" class="flex items-center gap-2 pt-1">
        <USelect
          :key="selectKey"
          v-model="pending"
          :items="remaining"
          value-key="value"
          placeholder="选择要添加的模型条目"
          class="w-full max-w-md"
          @update:model-value="(v) => append(v ? String(v) : undefined)"
        />
      </div>
      <p v-else-if="modelIds.length >= max" class="text-xs text-muted">
        已达备选数量上限（{{ max }} 个）。
      </p>
    </template>
  </div>
</template>
