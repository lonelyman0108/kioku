<script setup lang="ts">
import { sensitivityAllowed, type ConsoleMemoryView } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { draftFromUri, draftProblem, draftUri, type CoordinateDraft } from '../coordinates'
import { sensitivityLabels } from '../labels'
import CoordinateFields from './CoordinateFields.vue'
import NoteLine from './strata/NoteLine.vue'

// 移动改的是坐标：换归属（换开头）、换位置、换标识。标题不变，只有标题就是原来的标识时服务端按新坐标重新取
const props = defineProps<{ spaceId: string; memory: ConsoleMemoryView }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ done: [memory: ConsoleMemoryView, from: string] }>()
const queryClient = useQueryClient()

const { apps, canWriteUri } = useMemoryPermissions(computed(() => props.spaceId))
const personas = useQuery({
  queryKey: computed(() => ['personas', props.spaceId]),
  queryFn: () => api.personas(props.spaceId),
  enabled: open,
})
// 编辑者只能写自己是所有者的应用
const writableApps = computed(() =>
  (apps.data.value ?? []).filter((a) => canWriteUri(`app://${a.slug}/x`)),
)

const draft = ref<CoordinateDraft>({ layer: 'user', entity: null, position: '', identifier: '' })
const error = ref<string | null>(null)
const saving = ref(false)

// 打开时的那一版：提交带的 id 与版本号、换没换归属、要不要提醒都以它为准。
// 弹窗开着时编辑器可能载入了新版本，或换成了删除后在同一个坐标重建的另一条，不能对着换进来的那条提交
const origin = ref(props.memory)
watch(open, (value) => {
  if (!value) return
  origin.value = props.memory
  draft.value = draftFromUri(props.memory.uri) ?? draft.value
  error.value = null
})
// 打开之后这条记忆变了：要关掉重新打开，看过新的那一版再操作
const stale = computed(
  () =>
    open.value &&
    (props.memory.id !== origin.value.id || props.memory.version !== origin.value.version),
)

const target = computed(() => draftUri(draft.value))
const changed = computed(() => !!target.value && target.value !== origin.value.uri)
// 本人不设公开：公开的记忆要先调高敏感级才能移进本人
const problem = computed(() => {
  const coordinate = draftProblem(draft.value)
  if (coordinate) return coordinate
  if (!sensitivityAllowed(draft.value.layer, origin.value.sensitivity)) {
    return `本人不设${sensitivityLabels[origin.value.sensitivity]}：先把敏感级调到内部或更高，再移进本人`
  }
  return null
})

// 在共享的归属与本人之间转换会改变谁看得到它，提醒一句
const personal = (layer: string) => layer === 'user'
const crossing = computed(
  () => changed.value && personal(draft.value.layer) !== personal(origin.value.layer),
)

async function submit() {
  const to = target.value
  if (!to || problem.value || !changed.value || stale.value) return
  const m = origin.value
  saving.value = true
  error.value = null
  // 带上打开时那一版的 id 与版本号：期间被改过、或删除后在同一个坐标重建了，返回 409，不会动到别的记忆
  const expected = { expectedId: m.id, expectedVersion: m.version }
  try {
    const result = await api.moveMemory(props.spaceId, { from: m.uri, to, ...expected })
    open.value = false
    emit('done', result, m.uri)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '操作失败'
    // 冲突时让编辑器重新读取这条记忆：读到新的版本后上面提示重新打开，不会一直重试一直 409
    if (err instanceof ApiError && err.status === 409) {
      void queryClient.invalidateQueries({
        queryKey: ['memory', props.spaceId, m.uri],
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
    :title="`移动「${origin.title}」`"
    :dismissible="!saving"
    :close="!saving"
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <!-- 不用 form：单选在表单里时回车会隐式提交，还没看见「可见范围将改变」就移动了。只有点确定才提交 -->
      <div class="space-y-4">
        <CoordinateFields
          v-model="draft"
          :personas="personas.data.value ?? []"
          :apps="writableApps"
          :sensitivity="origin.sensitivity"
        />
        <NoteLine v-if="crossing" tone="warning">
          可见范围将改变
          <template #detail>
            {{
              personal(origin.layer)
                ? '移出本人后，空间内其他成员与有权限的应用均可读取。'
                : '移进本人后，这条记忆仅属于当前账号，其他成员及其应用将无法读取。'
            }}
          </template>
        </NoteLine>
        <NoteLine v-if="stale" tone="warning">
          这条记忆已更新
          <template #detail>请关闭后重新打开，确认新版本后再操作。</template>
        </NoteLine>
        <NoteLine v-else-if="error" tone="error">{{ error }}</NoteLine>
        <NoteLine v-else-if="problem && target !== origin.uri" tone="warning">{{
          problem
        }}</NoteLine>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="saving" @click="open = false">
          取消
        </UButton>
        <UButton :loading="saving" :disabled="!!problem || !changed || stale" @click="submit">
          确定
        </UButton>
      </div>
    </template>
  </UModal>
</template>
