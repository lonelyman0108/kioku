<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { DreamBindingMode, ModelChainTestResult } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { profileIdsChanged } from '../embeddingDrafts'
import { flattenProfiles } from '../models'
import Hint from './Hint.vue'
import ModelChainEditor from './ModelChainEditor.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SettingsBlock from './strata/SettingsBlock.vue'

// 有没有没保存的修改：切到别的小节之后表单看不见了，交给页面在子导航上标出来
const dirtyModel = defineModel<boolean>('dirty', { default: false })

const toast = useToast()
const queryClient = useQueryClient()
const queryKey = ['settings', 'models']
const registry = useQuery({ queryKey, queryFn: api.modelRegistry })

const chatOptions = computed(() => flattenProfiles(registry.data.value?.providers ?? [], 'chat'))
const savedExtraction = computed(() => registry.data.value?.bindings.extraction)
const savedDream = computed(() => registry.data.value?.bindings.dream)

const extractionIds = ref<string[]>([])
const dreamMode = ref<DreamBindingMode>('inherit')
const dreamIds = ref<string[]>([])
let syncedSnapshot = ''

watch(
  () =>
    registry.data.value
      ? {
          extraction: registry.data.value.bindings.extraction,
          dream: registry.data.value.bindings.dream,
        }
      : null,
  (b) => {
    if (!b) return
    const nextSnapshot = JSON.stringify(b)
    if (nextSnapshot === syncedSnapshot) return
    const wasDirty = dirty.value
    syncedSnapshot = nextSnapshot
    extractionIds.value = [...b.extraction.profileIds]
    dreamMode.value = b.dream.mode
    dreamIds.value = [...b.dream.profileIds]
    if (wasDirty) {
      toast.add({ title: '抽取与整理设置已在后台更新，未保存的改动已重置', color: 'warning' })
    }
  },
  { immediate: true },
)

const dirty = computed(() => {
  if (!savedExtraction.value || !savedDream.value) return false
  return (
    profileIdsChanged(extractionIds.value, savedExtraction.value.profileIds) ||
    dreamMode.value !== savedDream.value.mode ||
    (dreamMode.value === 'custom' && profileIdsChanged(dreamIds.value, savedDream.value.profileIds))
  )
})

const extractionResult = ref<ModelChainTestResult | null>(null)
const dreamResult = ref<ModelChainTestResult | null>(null)

watch(
  dirty,
  (changed) => {
    dirtyModel.value = changed
    if (changed) {
      extractionResult.value = null
      dreamResult.value = null
    }
  },
  { immediate: true },
)

const saving = ref(false)
async function save() {
  if (dreamMode.value === 'custom' && !dreamIds.value.length) {
    toast.add({ title: '单独指定整理模型时请至少选择一个对话模型', color: 'error' })
    return
  }
  saving.value = true
  let extractionSaved = false
  try {
    const savedExt = await api.saveExtractionBinding({ profileIds: extractionIds.value })
    extractionSaved = true
    const savedDr = await api.saveDreamBinding({
      mode: dreamMode.value,
      profileIds: dreamMode.value === 'custom' ? dreamIds.value : [],
    })
    syncedSnapshot = JSON.stringify({ extraction: savedExt, dream: savedDr })
    await Promise.all([
      queryClient.invalidateQueries({ queryKey }),
      queryClient.invalidateQueries({ queryKey: ['instance-system'] }),
    ])
    extractionResult.value = null
    dreamResult.value = null
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    if (extractionSaved) {
      await queryClient.invalidateQueries({ queryKey })
    }
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

const testingExtraction = ref(false)
async function testExtraction() {
  testingExtraction.value = true
  try {
    extractionResult.value = await api.testExtractionBinding()
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '测试失败', color: 'error' })
  } finally {
    testingExtraction.value = false
  }
}

const testingDream = ref(false)
async function testDream() {
  testingDream.value = true
  try {
    dreamResult.value = await api.testDreamBinding()
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '测试失败', color: 'error' })
  } finally {
    testingDream.value = false
  }
}

const confirmingClear = ref(false)
const clearing = ref(false)
async function clear() {
  clearing.value = true
  try {
    await api.saveExtractionBinding({ profileIds: [] })
    await api.saveDreamBinding({ mode: 'inherit', profileIds: [] })
    extractionIds.value = []
    dreamMode.value = 'inherit'
    dreamIds.value = []
    extractionResult.value = null
    dreamResult.value = null
    confirmingClear.value = false
    await Promise.all([
      queryClient.invalidateQueries({ queryKey }),
      queryClient.invalidateQueries({ queryKey: ['instance-system'] }),
    ])
    toast.add({ title: '已清除，抽取已停止', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '清除失败', color: 'error' })
  } finally {
    clearing.value = false
  }
}
</script>

<template>
  <SettingsBlock title="抽取与整理模型">
    <template #note>
      从已配置的对话模型中指定抽取与整理使用的模型链（按顺位顺序 Fallback）。
      <Hint>
        抽取用于从群聊与私聊中抽取事实并生成会话摘要；未绑定模型时停止抽取，对话缓冲到期后直接丢弃。整理默认沿用抽取模型，也可单独指定更擅长推理的模型。
      </Hint>
    </template>
    <ReadFailureNote v-if="registry.isError.value" :query="registry" />
    <USkeleton v-if="registry.isPending.value" class="h-40 w-full" />
    <form v-else-if="registry.data.value" class="space-y-5" @submit.prevent="save">
      <div class="space-y-2">
        <div class="font-medium">抽取模型</div>
        <ModelChainEditor v-model="extractionIds" :options="chatOptions" :min="0" />
      </div>

      <div class="space-y-3 border-t border-default pt-4">
        <UFormField label="整理模型">
          <USelect
            v-model="dreamMode"
            :items="[
              { label: '沿用抽取模型', value: 'inherit' },
              { label: '单独指定模型', value: 'custom' },
            ]"
            value-key="value"
            class="w-full max-w-xs"
          />
        </UFormField>
        <ModelChainEditor
          v-if="dreamMode === 'custom'"
          v-model="dreamIds"
          :options="chatOptions"
          :min="0"
        />
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <UButton type="submit" color="primary" variant="outline" :loading="saving">保存</UButton>
        <UButton
          color="neutral"
          variant="outline"
          :loading="testingExtraction"
          :disabled="!savedExtraction?.configured || dirty"
          @click="testExtraction"
        >
          测试抽取连接
        </UButton>
        <UButton
          v-if="savedDream?.mode === 'custom'"
          color="neutral"
          variant="outline"
          :loading="testingDream"
          :disabled="!savedDream.configured || dirty"
          @click="testDream"
        >
          测试整理连接
        </UButton>
        <UButton
          v-if="savedExtraction?.configured"
          color="error"
          variant="outline"
          @click="confirmingClear = true"
        >
          清除设置
        </UButton>
        <span v-if="dirty && savedExtraction?.configured" class="text-muted">
          保存改动后才能测试
        </span>
      </div>

      <ul v-if="extractionResult" class="space-y-1 text-sm">
        <li
          v-for="(item, i) in extractionResult.results"
          :key="i"
          :class="item.ok ? 'text-success' : 'text-error'"
        >
          抽取顺位 {{ i + 1 }}<template v-if="item.model">（{{ item.model }}）</template>：{{
            item.ok ? `连接正常，耗时 ${item.latencyMs} ms` : item.error
          }}
        </li>
      </ul>
      <ul v-if="dreamResult" class="space-y-1 text-sm">
        <li
          v-for="(item, i) in dreamResult.results"
          :key="i"
          :class="item.ok ? 'text-success' : 'text-error'"
        >
          整理顺位 {{ i + 1 }}<template v-if="item.model">（{{ item.model }}）</template>：{{
            item.ok ? `连接正常，耗时 ${item.latencyMs} ms` : item.error
          }}
        </li>
      </ul>
    </form>
  </SettingsBlock>

  <UModal
    :open="confirmingClear"
    title="清除抽取模型设置？"
    :dismissible="!clearing"
    @update:open="(v) => !v && !clearing && (confirmingClear = false)"
  >
    <template #body>
      <p class="text-sm">
        清除后不再从对话中抽取事实，也不再生成会话摘要，对话缓冲到期后直接丢弃。已抽取的记忆不受影响。
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="clearing"
          @click="confirmingClear = false"
        >
          取消
        </UButton>
        <UButton color="error" :loading="clearing" @click="clear">清除</UButton>
      </div>
    </template>
  </UModal>
</template>
