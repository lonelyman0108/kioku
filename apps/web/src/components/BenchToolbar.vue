<script setup lang="ts">
import { computed, type Ref } from 'vue'

import { readFailure } from '../api/client'
import { REAL_MODE_CONSEQUENCES } from '../benchSession'
import { useBench } from '../composables/useBench'
import { scopesSummary } from '../labels'
import { runtimeName } from '../runtimes'
import BenchNotice from './BenchNotice.vue'
import Hint from './Hint.vue'
import RuntimeIcon from './RuntimeIcon.vue'
import PageHead from './strata/PageHead.vue'
import ScopeTags from './strata/ScopeTags.vue'
import StrataCore from './strata/StrataCore.vue'

// 页头：标题在左，选接入实例与 Key、切模式在右。只列自己是所有者的接入实例与还有效的 Key
const {
  circleId,
  clients,
  owned,
  clientId,
  client,
  keys,
  usable,
  keyId,
  key,
  selectClient,
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

const clientItems = computed(() =>
  owned.value.map((c) => ({ label: `${c.name}（${runtimeName(c.runtimeFamily)}）`, value: c.id })),
)
const keyItems = computed(() =>
  usable.value.map((k) => ({ label: `${k.name}（${k.prefix}）`, value: k.id })),
)
const retryOf = (query: { isFetching: Readonly<Ref<boolean>>; refetch: () => unknown }) => [
  {
    label: '重新读取',
    color: 'neutral' as const,
    loading: query.isFetching.value,
    onClick: () => void query.refetch(),
  },
]
const retryClients = computed(() => retryOf(clients))
const retryKeys = computed(() => retryOf(keys))
</script>

<template>
  <div class="toolbar">
    <PageHead title="测试台">
      <template v-if="owned.length" #note>
        模拟接入实例调用 Kioku，不接入真实客户端。
        <Hint>
          工具走真实的 MCP
          服务端，权限按当前访问密钥的有效上限。不记录召回事件，不更新访问密钥的最近使用时间。机密正文与凭据的值一律打码，查看原值请到记忆页、凭据页。
        </Hint>
      </template>
      <template v-if="owned.length" #actions>
        <div class="pickers">
          <UFormField label="接入实例" class="w-full sm:w-52 min-[87.5rem]:w-60">
            <USelect
              :model-value="clientId"
              :items="clientItems"
              :disabled="running"
              aria-label="接入实例"
              class="w-full"
              @update:model-value="(v) => selectClient(String(v))"
            >
              <template v-if="client" #leading>
                <RuntimeIcon :family="client.runtimeFamily" :size="15" />
              </template>
            </USelect>
          </UFormField>
          <UFormField label="访问密钥" class="w-full sm:w-60 min-[87.5rem]:w-64">
            <USelect
              :model-value="keyId"
              :items="keyItems"
              :disabled="running || !keyItems.length"
              :placeholder="keys.data.value && !keys.isError.value ? '暂无有效访问密钥' : ''"
              aria-label="访问密钥"
              class="w-full"
              @update:model-value="(v) => selectKey(String(v))"
            />
          </UFormField>
          <div v-if="key?.effectiveScopes" class="key-limit">
            <StrataCore
              :scopes="key.effectiveScopes"
              :width="28"
              :height="48"
              :label="`当前访问密钥的上限：${scopesSummary(key.effectiveScopes)}`"
            />
            <div>
              <p class="limit-label">当前访问密钥的上限</p>
              <ScopeTags :scopes="key.effectiveScopes" />
            </div>
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
        v-if="clients.isError.value"
        color="error"
        :title="readFailure(clients.error.value, '读取接入实例失败')"
        :actions="retryClients"
      />
      <USkeleton v-if="clients.isPending.value" class="h-16 w-full" />
      <div
        v-else-if="clients.data.value && !owned.length && !clients.isError.value"
        class="no-clients"
      >
        <p class="text-muted">
          当前账号在此记忆圈暂无接入实例。
          <Hint>测试台仅限接入实例所有者使用：调用会读取所有者的本人记忆。</Hint>
        </p>
        <UButton :to="{ name: 'clients', params: { circleId } }" size="sm" variant="outline">
          管理接入实例
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
          :title="readFailure(keys.error.value, '读取访问密钥失败')"
          :actions="retryKeys"
        />
        <p v-if="keys.data.value && !usable.length && !keys.isError.value" class="text-muted">
          当前接入实例暂无有效访问密钥，
          <RouterLink :to="{ name: 'client', params: { circleId, clientId } }" class="text-primary"
            >签发访问密钥</RouterLink
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
            后续调用按「{{ client?.name }}」的访问密钥「{{
              key?.name
            }}」真实执行，切回回滚模式也无法撤回：
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
.key-limit > div {
  min-width: 0;
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
.no-clients {
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
