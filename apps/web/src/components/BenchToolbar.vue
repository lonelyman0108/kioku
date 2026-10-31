<script setup lang="ts">
import { computed } from 'vue'

import { ApiError } from '../api/client'
import { REAL_MODE_CONSEQUENCES } from '../benchSession'
import { useBench } from '../composables/useBench'
import { scopesSummary } from '../labels'
import Hint from './Hint.vue'

// 选应用与 Key、切模式。只列自己是主人的应用与还有效的 Key
const {
  spaceId,
  apps,
  owned,
  appId,
  app,
  keys,
  usable,
  keyId,
  key,
  selectApp,
  selectKey,
  selectionNotice,
  real,
  confirmingReal,
  confirmingRollback,
  modeLoss,
  rollbackLoss,
  requestMode,
  confirmReal,
  confirmRollback,
  running,
} = useBench()

const appItems = computed(() =>
  owned.value.map((a) => ({ label: `${a.name}（${a.runtimeFamily}）`, value: a.id })),
)
const keyItems = computed(() =>
  usable.value.map((k) => ({ label: `${k.name}（${k.prefix}）`, value: k.id })),
)
const errorOf = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback
</script>

<template>
  <div class="space-y-3 text-sm">
    <USkeleton v-if="apps.isPending.value" class="h-16 w-full" />
    <UAlert
      v-else-if="apps.isError.value && !apps.data.value"
      color="error"
      variant="subtle"
      :title="errorOf(apps.error.value, '读取应用失败')"
    />
    <div v-else-if="!owned.length" class="space-y-2">
      <p class="text-muted">
        当前账号在此空间暂无应用。
        <Hint>测试台仅限应用所有者使用：调用会读取所有者的私人层。</Hint>
      </p>
      <UButton :to="{ name: 'apps', params: { spaceId } }" size="sm" variant="subtle">
        管理应用
      </UButton>
    </div>
    <template v-else>
      <p class="text-xs text-muted">
        模拟应用调用 Kioku，不接入真实客户端。
        <Hint>
          工具走真实的 MCP 服务端，权限按当前 Key 的有效上限。不记录召回事件，不更新 Key
          的最近使用时间。机密正文与凭据的值一律打码，查看原值请到记忆页、凭据页。
        </Hint>
      </p>
      <div class="flex flex-wrap items-end gap-3">
        <UFormField label="应用" class="w-full sm:w-64">
          <USelect
            :model-value="appId"
            :items="appItems"
            :disabled="running"
            aria-label="应用"
            class="w-full"
            @update:model-value="(v) => selectApp(String(v))"
          />
        </UFormField>
        <UFormField label="Key" class="w-full sm:w-64">
          <USelect
            :model-value="keyId"
            :items="keyItems"
            :disabled="running || !keyItems.length"
            placeholder="暂无有效 Key"
            aria-label="Key"
            class="w-full"
            @update:model-value="(v) => selectKey(String(v))"
          />
        </UFormField>
        <USwitch
          :model-value="real"
          label="真实执行"
          :description="real ? '写入立即生效，不会回滚' : '默认回滚，不留痕迹'"
          color="error"
          :disabled="running || !key"
          class="pb-1"
          @update:model-value="requestMode"
        />
      </div>
      <p v-if="key?.effectiveScopes" class="text-xs text-muted">
        当前 Key 的上限：{{ scopesSummary(key.effectiveScopes) }}
      </p>
      <UAlert
        v-if="selectionNotice"
        color="warning"
        variant="subtle"
        :title="selectionNotice"
        close
        @update:open="(v) => !v && (selectionNotice = null)"
      />
      <UAlert
        v-if="keys.isError.value && !keys.data.value"
        color="error"
        variant="subtle"
        :title="errorOf(keys.error.value, '读取 Key 失败')"
      />
      <p v-else-if="keys.isSuccess.value && !usable.length" class="text-muted">
        当前应用暂无有效 Key，
        <RouterLink
          :to="{ name: 'app', params: { spaceId, appId } }"
          class="text-primary hover:underline"
          >签发 Key</RouterLink
        >
        后可使用测试台。
      </p>
    </template>

    <UModal
      :open="confirmingReal"
      title="切换到真实模式？"
      @update:open="(v) => !v && (confirmingReal = false)"
    >
      <template #body>
        <div class="space-y-2 text-sm">
          <p>
            后续调用按「{{ app?.name }}」的 Key「{{ key?.name }}」真实执行，切回回滚模式也无法撤回：
          </p>
          <ul class="list-disc space-y-1 pl-5">
            <li v-for="line in REAL_MODE_CONSEQUENCES" :key="line">{{ line }}</li>
          </ul>
          <p v-if="modeLoss" class="text-muted">{{ modeLoss }}</p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirmingReal = false">取消</UButton>
          <UButton color="error" @click="confirmReal">切换到真实模式</UButton>
        </div>
      </template>
    </UModal>

    <UModal
      :open="confirmingRollback"
      title="切回回滚模式？"
      @update:open="(v) => !v && (confirmingRollback = false)"
    >
      <template #body>
        <p class="text-sm">{{ rollbackLoss }}</p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirmingRollback = false">
            取消
          </UButton>
          <UButton color="warning" @click="confirmRollback">切回回滚模式</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
