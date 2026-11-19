<script setup lang="ts">
import { sensitivityAllowed, type CircleSummary, type ConsoleEntryView } from '@kioku/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import { circleKindLabels, sensitivityLabels } from '../labels'
import NoteLine from './strata/NoteLine.vue'

// 跨记忆圈迁移词条：保留短 ID、标题、各切面变体与双链，只在目的圈重新归属并校验权限与敏感级
const props = defineProps<{ circleId: string; entry: ConsoleEntryView }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ done: [entry: ConsoleEntryView, toCircleId: string] }>()
const queryClient = useQueryClient()
const { me } = useSession()

const origin = ref(props.entry)
const targetCircleId = ref<string>('')
const error = ref<string | null>(null)
const saving = ref(false)

const writableCircles = computed<CircleSummary[]>(() =>
  (me.data.value?.circles ?? []).filter((c) => {
    if (c.id === props.circleId) return false
    if (c.role === 'owner') return true
    return c.role === 'editor' && origin.value.sensitivity !== 'secret'
  }),
)

const sourceCircle = computed<CircleSummary | null>(
  () => me.data.value?.circles.find((c) => c.id === props.circleId) ?? null,
)
const targetCircle = computed<CircleSummary | null>(
  () => writableCircles.value.find((c) => c.id === targetCircleId.value) ?? null,
)

watch(open, (value) => {
  if (!value) return
  origin.value = props.entry
  targetCircleId.value = writableCircles.value[0]?.id ?? ''
  error.value = null
})

// 打开之后这条记忆变了：要关掉重新打开，看过新的那一版再操作
const stale = computed(
  () =>
    open.value &&
    (props.entry.id !== origin.value.id || props.entry.version !== origin.value.version),
)

// 个人圈不设公开：公开的记忆要先调高敏感级才能移进个人圈
const problem = computed(() => {
  if (!writableCircles.value.length) return '没有可移入的目标记忆圈'
  if (!targetCircle.value) return '请选择目标记忆圈'
  if (!sensitivityAllowed(targetCircle.value.kind, origin.value.kind, origin.value.sensitivity)) {
    return `个人圈不设${sensitivityLabels[origin.value.sensitivity]}：先把敏感级调到内部或更高，再移入个人圈`
  }
  return null
})

// 在个人圈与共享圈之间迁移会改变谁可见，提醒一句
const crossing = computed(
  () =>
    !!sourceCircle.value &&
    !!targetCircle.value &&
    sourceCircle.value.kind !== targetCircle.value.kind,
)

async function submit() {
  const target = targetCircle.value
  if (!target || problem.value || stale.value || saving.value) return
  const m = origin.value
  saving.value = true
  error.value = null
  try {
    const result = await api.transferEntry(props.circleId, {
      entryId: m.id,
      toCircleId: target.id,
      expectedVersion: m.version,
    })
    open.value = false
    emit('done', result, target.id)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '迁移失败'
    // 冲突时让编辑器重新读取这条记忆：读到新的版本后上面提示重新打开，不会一直重试一直 409
    if (err instanceof ApiError && err.status === 409) {
      void queryClient.invalidateQueries({
        queryKey: ['entry', props.circleId, m.shortId],
        exact: true,
      })
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <!-- 请求期间不能关掉，否则失败的提示没地方显示 -->
  <UModal
    v-model:open="open"
    :title="`迁移「${origin.title}」`"
    :dismissible="!saving"
    :close="!saving"
    :ui="{ content: 'sm:max-w-lg' }"
  >
    <template #body>
      <!-- 不用 form：单选在表单里时回车会隐式提交，还没看见「可见范围将改变」就迁移了。只有点确定才提交 -->
      <div class="space-y-4">
        <div
          v-if="writableCircles.length"
          class="target-list"
          role="radiogroup"
          aria-label="目标记忆圈"
        >
          <label
            v-for="circle in writableCircles"
            :key="circle.id"
            class="target-item"
            :class="{ selected: targetCircleId === circle.id }"
          >
            <input
              type="radio"
              name="target-circle"
              :value="circle.id"
              :checked="targetCircleId === circle.id"
              @change="targetCircleId = circle.id"
            />
            <span class="target-name">{{ circle.name }}</span>
            <span class="target-kind">{{ circleKindLabels[circle.kind] }}</span>
          </label>
        </div>
        <NoteLine v-if="crossing" tone="warning">
          可见范围将改变
          <template #detail>
            {{
              sourceCircle?.kind === 'personal'
                ? '移入共享圈后，共享圈内其他成员与授权接入实例均可读取。'
                : '移入个人圈后，这条记忆仅属于当前账号，共享圈内其他成员将无法读取。'
            }}
          </template>
        </NoteLine>
        <NoteLine v-if="stale" tone="warning">
          这条记忆已更新
          <template #detail>请关闭后重新打开，确认新版本后再操作。</template>
        </NoteLine>
        <NoteLine v-else-if="error" tone="error">{{ error }}</NoteLine>
        <NoteLine v-else-if="problem" tone="warning">{{ problem }}</NoteLine>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="saving" @click="open = false">
          取消
        </UButton>
        <UButton :loading="saving" :disabled="!!problem || stale" @click="submit">确定</UButton>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.target-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ui-border);
}
.target-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  font-size: 14px;
  cursor: pointer;
}
.target-item + .target-item {
  border-top: 1px solid var(--ui-border);
}
.target-item:hover {
  background: var(--ui-bg-elevated);
}
.target-item.selected {
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.target-item input {
  accent-color: currentColor;
}
.target-name {
  font-weight: 500;
}
.target-kind {
  margin-left: auto;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.target-item.selected .target-kind {
  color: var(--strata-on-selected-muted);
}
</style>
