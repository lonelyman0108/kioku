<script setup lang="ts">
import { computed } from 'vue'

import { ApiError } from '../api/client'
import { REAL_MODE_CONSEQUENCES } from '../benchSession'
import { useBench } from '../composables/useBench'
import { scopesSummary } from '../labels'
import BenchNotice from './BenchNotice.vue'
import Hint from './Hint.vue'
import PageHead from './strata/PageHead.vue'
import StrataCore from './strata/StrataCore.vue'

// 页头：标题在左，选应用与 Key、切模式在右。只列自己是主人的应用与还有效的 Key
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
  <div class="toolbar">
    <PageHead title="测试台">
      <template v-if="owned.length" #note>
        模拟应用调用 Kioku，不接入真实客户端。
        <Hint>
          工具走真实的 MCP 服务端，权限按当前 Key 的有效上限。不记录召回事件，不更新 Key
          的最近使用时间。机密正文与凭据的值一律打码，查看原值请到记忆页、凭据页。
        </Hint>
      </template>
      <template v-if="owned.length" #actions>
        <div class="pickers">
          <UFormField label="应用" class="w-full sm:w-52 min-[87.5rem]:w-60">
            <USelect
              :model-value="appId"
              :items="appItems"
              :disabled="running"
              aria-label="应用"
              class="w-full"
              @update:model-value="(v) => selectApp(String(v))"
            />
          </UFormField>
          <UFormField label="Key" class="w-full sm:w-60 min-[87.5rem]:w-64">
            <USelect
              :model-value="keyId"
              :items="keyItems"
              :disabled="running || !keyItems.length"
              :placeholder="keys.data.value && !keys.isError.value ? '暂无有效 Key' : ''"
              aria-label="Key"
              class="w-full"
              @update:model-value="(v) => selectKey(String(v))"
            />
          </UFormField>
          <div v-if="key?.effectiveScopes" class="key-limit">
            <StrataCore
              :scopes="key.effectiveScopes"
              :width="28"
              :height="48"
              :label="`当前 Key 的上限：${scopesSummary(key.effectiveScopes)}`"
            />
            <p>
              <span class="limit-label">当前 Key 的上限</span>
              {{ scopesSummary(key.effectiveScopes) }}
            </p>
          </div>
          <USwitch
            :model-value="real"
            label="真实执行"
            :description="real ? '写入立即生效，不会回滚' : '默认回滚，不留痕迹'"
            color="error"
            :disabled="running || !key"
            class="mode-switch"
            @update:model-value="requestMode"
          />
        </div>
      </template>
    </PageHead>

    <div class="toolbar-notes">
      <!-- 后台刷新失败时读到过的内容留着，错误放在上面。「暂无」只在读到空、这次也读成功时说：
           缓存是空的又刷新失败时，不知道到底有没有，不能把人引去再建一个 -->
      <BenchNotice
        v-if="apps.isError.value"
        color="error"
        :title="errorOf(apps.error.value, '读取应用失败')"
      />
      <USkeleton v-if="apps.isPending.value" class="h-16 w-full" />
      <div v-else-if="apps.data.value && !owned.length && !apps.isError.value" class="no-apps">
        <p class="text-muted">
          当前账号在此空间暂无应用。
          <Hint>测试台仅限应用所有者使用：调用会读取所有者的私人层。</Hint>
        </p>
        <UButton :to="{ name: 'apps', params: { spaceId } }" size="sm" variant="outline">
          管理应用
        </UButton>
      </div>
      <template v-else-if="owned.length">
        <BenchNotice
          v-if="selectionNotice"
          color="warning"
          :title="selectionNotice"
          close
          @update:open="(v) => !v && (selectionNotice = null)"
        />
        <BenchNotice
          v-if="keys.isError.value"
          color="error"
          :title="errorOf(keys.error.value, '读取 Key 失败')"
        />
        <p v-if="keys.data.value && !usable.length && !keys.isError.value" class="text-muted">
          当前应用暂无有效 Key，
          <RouterLink
            :to="{ name: 'app', params: { spaceId, appId } }"
            class="text-primary hover:underline"
            >签发 Key</RouterLink
          >
          后可使用测试台。
        </p>
      </template>
    </div>

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

<style scoped>
.toolbar {
  flex: none;
}
.pickers {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px 14px;
}
.key-limit {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  min-width: 0;
}
.key-limit svg {
  flex: none;
}
.key-limit p {
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.limit-label {
  display: block;
  color: var(--ui-text-muted);
}
.mode-switch {
  padding-bottom: 2px;
}
.toolbar-notes {
  padding: 0 32px;
}
.toolbar-notes > p {
  padding-bottom: 16px;
}
.no-apps {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding-bottom: 16px;
}
@media (max-width: 1023.98px) {
  /* 页头的操作区按内容算宽度，Key 的名字一长就撑出屏幕 */
  .toolbar :deep(.page-actions),
  .pickers {
    width: 100%;
  }
  .toolbar-notes {
    padding: 0 16px;
  }
}
</style>
