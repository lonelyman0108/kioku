<script setup lang="ts">
import { computed } from 'vue'

import { ApiError } from '../api/client'
import { REAL_MODE_CONSEQUENCES } from '../benchSession'
import { useBench } from '../composables/useBench'
import { scopesSummary } from '../labels'

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
  requestMode,
  confirmReal,
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
        只有应用的主人能用测试台：它会读到主人的私人层。你在这个空间里还没有自己的应用。
      </p>
      <UButton :to="{ name: 'apps', params: { spaceId } }" size="sm" variant="subtle">
        去应用与 Key
      </UButton>
    </div>
    <template v-else>
      <p class="text-xs text-muted">
        不接真实客户端，按一把 Key 模拟接入方调用 Kioku：工具走真实的 MCP 服务端，权限按这把 Key
        现在的有效上限。不记召回事件，不更新 Key 的最后使用时间；
        <code>secret</code> 的正文与凭据的值一律打码，要看值去记忆页、凭据页。
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
            placeholder="没有有效的 Key"
            aria-label="Key"
            class="w-full"
            @update:model-value="(v) => selectKey(String(v))"
          />
        </UFormField>
        <USwitch
          :model-value="real"
          label="真实执行"
          description="默认回滚：做完不留痕迹"
          color="error"
          :disabled="running || !key"
          class="pb-1"
          @update:model-value="requestMode"
        />
      </div>
      <p v-if="key?.effectiveScopes" class="text-xs text-muted">
        这把 Key 现在的上限：{{ scopesSummary(key.effectiveScopes) }}
      </p>
      <UAlert v-if="selectionNotice" color="warning" variant="subtle" :title="selectionNotice" />
      <UAlert
        v-if="keys.isError.value && !keys.data.value"
        color="error"
        variant="subtle"
        :title="errorOf(keys.error.value, '读取 Key 失败')"
      />
      <p v-else-if="keys.isSuccess.value && !usable.length" class="text-muted">
        这个应用还没有有效的 Key，先
        <RouterLink
          :to="{ name: 'app', params: { spaceId, appId } }"
          class="text-primary hover:underline"
          >签发一把</RouterLink
        >
        再用测试台。
      </p>
    </template>

    <UModal
      :open="confirmingReal"
      title="切到真实模式？"
      @update:open="(v) => !v && (confirmingReal = false)"
    >
      <template #body>
        <div class="space-y-2 text-sm">
          <p>
            接下来的调用按「{{ app?.name }}」的 Key「{{ key?.name }}」真实执行，切回回滚也撤不回来：
          </p>
          <ul class="list-disc space-y-1 pl-5">
            <li v-for="line in REAL_MODE_CONSEQUENCES" :key="line">{{ line }}</li>
          </ul>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirmingReal = false">取消</UButton>
          <UButton color="error" @click="confirmReal">切到真实模式</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
