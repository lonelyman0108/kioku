<script setup lang="ts">
import { CHAT_TYPES } from '@kioku/contracts'
import { computed } from 'vue'

import { chatTypeLabels, contextSummary, usesGroup, usesSender } from '../benchForm'
import { useBench } from '../composables/useBench'
import Hint from './Hint.vue'

// 会话上下文：只作用于生命周期事件与 /recall。工具调用不带，真实的 MCP 也不带，写明白，
// 不然选了群聊之后 kioku_get 读得到私人层，或者以为读不到，都会得出错误的权限结论
const { contextForm } = useBench()

const chatTypeItems = [
  { label: '不带', value: null },
  ...CHAT_TYPES.map((value) => ({ label: chatTypeLabels[value], value })),
]
const summary = computed(() => contextSummary(contextForm))
</script>

<template>
  <details class="rounded-lg border border-default px-3 py-2 text-sm">
    <summary class="cursor-pointer">
      会话上下文：<span class="text-muted">{{ summary }}</span>
    </summary>
    <div class="mt-3 space-y-3">
      <p class="text-xs text-muted">
        仅作用于生命周期事件与 /recall，工具调用不带。
        <Hint>
          与真实 MCP 一致，工具调用按 Key 的全部权限读写。判断 Key
          接入群聊后可读取的内容，应看生命周期事件与 /recall，不要看工具。
        </Hint>
      </p>
      <div class="grid gap-3 sm:grid-cols-2">
        <UFormField label="聊天类型">
          <USelect v-model="contextForm.chatType" :items="chatTypeItems" class="w-full" />
        </UFormField>
        <UFormField v-if="usesSender(contextForm.chatType)" label="平台">
          <template #help>
            首次出现的账号会新建联系人，真实模式下无法删除，只能合并。
            <Hint>默认使用与内置场景相同的固定账号。</Hint>
          </template>
          <UInput v-model="contextForm.platform" class="w-full font-mono" />
        </UFormField>
        <template v-if="usesGroup(contextForm.chatType)">
          <UFormField label="群 ID">
            <UInput v-model="contextForm.groupId" class="w-full font-mono" />
          </UFormField>
          <UFormField label="群名">
            <UInput v-model="contextForm.groupName" class="w-full" />
          </UFormField>
        </template>
        <template v-if="usesSender(contextForm.chatType)">
          <UFormField label="发言人 ID">
            <UInput v-model="contextForm.senderId" class="w-full font-mono" />
          </UFormField>
          <UFormField label="发言人名称">
            <UInput v-model="contextForm.senderName" class="w-full" />
          </UFormField>
        </template>
      </div>
    </div>
  </details>
</template>
