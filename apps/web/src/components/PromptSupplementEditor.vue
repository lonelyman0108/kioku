<script setup lang="ts">
import { computed, ref, useId } from 'vue'

import { promptText, SUPPLEMENT_MAX } from '../advancedSettings'
import { icons } from '../icons'

// 提示词的补充：固定部分只读在上（等宽小字、锁图标，写明为什么不能改），上一级的补充只读（写明来自哪一级），
// 本级的补充可编辑、计字数。「预览全文」按发给模型的顺序拼出来；「恢复」清空本级的补充。
// fixed 有几种场景时（抽取与只要摘要、整理的两种范围）各列一段，补充接在每一种后面
const props = defineProps<{
  label: string
  fixed: readonly { title?: string; text: string }[]
  why: string
  inherited?: { level: string; text: string | null } | null
  // 本级的名称，预览里标出这一段
  level: string
  editable: boolean
  invalid?: boolean
}>()
const model = defineModel<string>({ required: true })

const id = useId()
const length = computed(() => [...model.value].length)
const previewing = ref(false)
const previews = computed(() =>
  props.fixed.map((f) => ({
    title: f.title,
    text: promptText(f.text, [props.inherited?.text, model.value]),
  })),
)
</script>

<template>
  <div class="supplement">
    <div class="part-head">
      <UIcon :name="icons.secret" class="part-icon" aria-hidden="true" />
      <span class="part-name">固定部分</span>
      <span class="part-note">{{ why }}</span>
    </div>
    <div v-for="(f, i) in fixed" :key="i" class="fixed-part">
      <p v-if="f.title" class="fixed-title">{{ f.title }}</p>
      <pre class="fixed-text">{{ f.text }}</pre>
    </div>

    <template v-if="inherited">
      <div class="part-head">
        <UIcon :name="icons.down" class="part-icon" aria-hidden="true" />
        <span class="part-name">{{ inherited.level }}的补充</span>
        <span class="part-note"
          >来自{{ inherited.level }}，在{{ inherited.level }}的设置里修改</span
        >
      </div>
      <pre v-if="inherited.text" class="fixed-text inherited">{{ inherited.text }}</pre>
      <p v-else class="empty">暂无</p>
    </template>

    <div class="part-head">
      <UIcon :name="icons.edit" class="part-icon" aria-hidden="true" />
      <label :for="id" class="part-name">{{ level }}的补充</label>
      <span class="part-note">追加在{{ inherited ? '上面两段' : '固定部分' }}之后</span>
      <span class="gap" />
      <span class="count" :class="{ over: length > SUPPLEMENT_MAX }"
        >{{ length.toLocaleString('en-US') }} / {{ SUPPLEMENT_MAX.toLocaleString('en-US') }}</span
      >
    </div>
    <UTextarea
      :id="id"
      v-model="model"
      :rows="5"
      autoresize
      :maxrows="16"
      :disabled="!editable"
      :aria-label="label"
      class="w-full"
    />
    <p v-if="invalid" class="text-xs text-error">
      补充至多 2,000 字，只能包含可见字符、换行与制表符。
    </p>
    <div class="actions">
      <UButton
        color="neutral"
        variant="ghost"
        size="sm"
        :icon="icons.file"
        @click="previewing = true"
        >预览全文</UButton
      >
      <UButton
        v-if="editable"
        color="neutral"
        variant="ghost"
        size="sm"
        :icon="icons.restore"
        :disabled="!model"
        @click="model = ''"
        >恢复</UButton
      >
    </div>

    <UModal v-model:open="previewing" :title="`预览全文：${label}`" :ui="{ content: 'max-w-3xl' }">
      <template #body>
        <div v-for="(p, i) in previews" :key="i" class="preview">
          <p v-if="p.title" class="fixed-title">{{ p.title }}</p>
          <pre class="fixed-text">{{ p.text }}</pre>
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.supplement {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.part-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 13px;
}
.part-icon {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.part-name {
  font-weight: 500;
}
.part-note {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.gap {
  flex: 1;
}
.count {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.count.over {
  color: var(--ui-error);
}
.fixed-title {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.fixed-text {
  max-height: 220px;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ui-text-toned);
}
.preview .fixed-text {
  max-height: none;
}
.preview + .preview {
  margin-top: 14px;
}
.empty {
  font-size: 13px;
  color: var(--ui-text-muted);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
</style>
