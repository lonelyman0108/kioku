<script setup lang="ts">
import { draftOf, type ChannelDraft } from '../embeddingDrafts'
import { icons } from '../icons'
import EmbeddingChannelRow from './EmbeddingChannelRow.vue'

// 一组嵌入渠道的编辑：最多 5 个，能调整顺序
const MAX_CHANNELS = 5

const channels = defineModel<ChannelDraft[]>({ required: true })

function swap(i: number, j: number) {
  const list = [...channels.value]
  ;[list[i], list[j]] = [list[j]!, list[i]!]
  channels.value = list
}
function remove(key: number) {
  channels.value = channels.value.filter((c) => c.key !== key)
}
function add() {
  channels.value = [...channels.value, draftOf()]
}
</script>

<template>
  <div class="space-y-3">
    <EmbeddingChannelRow
      v-for="(draft, i) in channels"
      :key="draft.key"
      v-model="channels[i]!"
      :index="i"
      :first="i === 0"
      :last="i === channels.length - 1"
      :only="channels.length === 1"
      @up="swap(i, i - 1)"
      @down="swap(i, i + 1)"
      @remove="remove(draft.key)"
    />
    <UButton
      :icon="icons.add"
      color="neutral"
      variant="subtle"
      :disabled="channels.length >= MAX_CHANNELS"
      @click="add"
    >
      添加渠道
    </UButton>
  </div>
</template>
