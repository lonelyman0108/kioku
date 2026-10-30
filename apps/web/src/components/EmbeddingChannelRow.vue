<script setup lang="ts">
import { computed } from 'vue'

import type { ChannelDraft } from '../embeddingDrafts'
import { needsNewKey, newKeyHint } from '../endpointKey'
import { icons } from '../icons'

// 一个嵌入渠道的编辑：接口地址、请求用的模型名与 Key，以及挪位置、删掉
const draft = defineModel<ChannelDraft>({ required: true })
defineProps<{ index: number; first: boolean; last: boolean; only: boolean }>()
const emit = defineEmits<{ up: []; down: []; remove: [] }>()

// 换了接口主机又没说 Key 怎么处理：在 Key 旁边说清楚，保存按钮由外面禁用
const keyError = computed(() => (needsNewKey(draft.value) ? newKeyHint('Key', true) : undefined))
</script>

<template>
  <div class="space-y-3 rounded-md border border-default p-3">
    <div class="flex items-center gap-1">
      <span class="text-sm font-medium">渠道 {{ index + 1 }}</span>
      <span class="flex-1" />
      <UButton
        :icon="icons.up"
        color="neutral"
        variant="ghost"
        size="xs"
        :aria-label="`把渠道 ${index + 1} 往前挪`"
        :disabled="first"
        @click="emit('up')"
      />
      <UButton
        :icon="icons.down"
        color="neutral"
        variant="ghost"
        size="xs"
        :aria-label="`把渠道 ${index + 1} 往后挪`"
        :disabled="last"
        @click="emit('down')"
      />
      <UButton
        :icon="icons.remove"
        color="neutral"
        variant="ghost"
        size="xs"
        :aria-label="`删掉渠道 ${index + 1}`"
        :disabled="only"
        @click="emit('remove')"
      />
    </div>
    <UFormField label="接口地址" help="例如 https://api.example.com/v1">
      <UInput v-model="draft.baseUrl" class="w-full font-mono" required />
    </UFormField>
    <UFormField label="请求用的模型名" help="服务商给模型改了名，只改这里，不用重新生成向量">
      <UInput v-model="draft.model" class="w-full font-mono" required />
    </UFormField>
    <UFormField
      label="API Key"
      :help="
        draft.hasApiKey
          ? '已保存（加密存储）。留空表示不修改；改了接口主机时必须重新填写'
          : '用实例主密钥加密后存库；接口不需要 Key 时留空'
      "
      :error="keyError"
    >
      <UInput
        v-model="draft.apiKey"
        type="password"
        autocomplete="off"
        class="w-full"
        :disabled="draft.clearKey"
      />
    </UFormField>
    <UCheckbox
      v-if="draft.hasApiKey"
      v-model="draft.clearKey"
      label="清除已保存的 Key（接口不需要 Key）"
    />
  </div>
</template>
