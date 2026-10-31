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
  <details class="context">
    <summary>
      会话上下文：<span class="text-muted">{{ summary }}</span>
    </summary>
    <div class="context-body">
      <p class="context-note">
        仅作用于生命周期事件与 /recall，工具调用不带。
        <Hint>
          与真实 MCP 一致，工具调用按 Key 的全部权限读写。判断 Key
          接入群聊后可读取的内容，应看生命周期事件与 /recall，不要看工具。
        </Hint>
      </p>
      <div class="context-fields">
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

<style scoped>
.context {
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.6;
}
.context > summary {
  cursor: pointer;
  overflow-wrap: anywhere;
}
.context > summary::marker {
  font-size: 0.8em;
  color: var(--ui-text-muted);
}
.context-body {
  padding-top: 8px;
}
.context-note {
  font-size: 13px;
  color: var(--ui-text-muted);
}
/* 放在调用台的表单上面是两列，放在模型对话的窄栏里是一列 */
.context-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: 10px 12px;
  padding-top: 8px;
}
</style>
