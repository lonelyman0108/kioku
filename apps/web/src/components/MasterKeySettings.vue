<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'

import { api } from '../api/endpoints'
import { icons } from '../icons'
import { remainingRows, remainingTotal } from '../masterKey'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import PropertyList from './strata/PropertyList.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsTable from './strata/SettingsTable.vue'

// 主密钥：轮换还没换完时每隔几秒刷新，看得到每一类还剩多少条是旧主密钥包装的；出了错就不再刷新（错误显示出来）
const masterKey = useQuery({
  queryKey: ['settings', 'master-key'],
  queryFn: api.masterKeyStatus,
  refetchInterval: (query) => {
    const data = query.state.data
    return remainingTotal(data?.remaining) > 0 && !data?.lastError ? 5_000 : false
  },
})
const remaining = computed(() => remainingTotal(masterKey.data.value?.remaining))
const rows = computed(() =>
  masterKey.data.value ? remainingRows(masterKey.data.value.remaining) : [],
)
</script>

<template>
  <SettingsBlock title="主密钥" wide>
    <template #note>
      用于加密机密记忆、托管的凭据值，以及实例设置中保存的 API Key 与 Secret Access Key。
      <Hint>
        在服务器的 KIOKU_MASTER_KEY 中配置。标识是哈希值，无法反推密钥，用于核对当前配置的主密钥。
      </Hint>
    </template>
    <!-- 后台刷新失败时读到过的状态留着，错误放在上面 -->
    <ReadFailureNote v-if="masterKey.isError.value" :query="masterKey" />
    <div v-if="masterKey.data.value" class="space-y-4">
      <p v-if="!masterKey.data.value.configured" class="text-muted">
        未配置主密钥，无法保存机密记忆、托管的凭据，以及实例设置中的 API Key 与 Secret Access Key。
      </p>
      <template v-else>
        <PropertyList
          :groups="[
            [
              { key: 'current', label: '标识' },
              ...(masterKey.data.value.previousId ? [{ key: 'previous', label: '旧主密钥' }] : []),
            ],
          ]"
        >
          <template #current>
            <span class="font-mono text-[13px]">{{ masterKey.data.value.currentId }}</span>
          </template>
          <template #previous>
            <span class="font-mono text-[13px]">{{ masterKey.data.value.previousId }}</span>
          </template>
        </PropertyList>
        <template v-if="masterKey.data.value.previousId">
          <NoteLine v-if="masterKey.data.value.lastError" tone="error">
            {{ masterKey.data.value.lastError.message }}
          </NoteLine>
          <SettingsTable class="max-w-xl">
            <thead>
              <tr>
                <th>数据</th>
                <th class="num">待重新包装</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.key">
                <td>{{ row.label }}</td>
                <td class="num">{{ row.count.toLocaleString() }}</td>
                <td>
                  <span v-if="row.count === 0" class="state done">
                    <UIcon :name="icons.check" class="state-icon" />完成
                  </span>
                  <!-- 轮换出了错就停下、不再刷新：不写成还在进行，原因在上面 -->
                  <span v-else-if="masterKey.data.value.lastError" class="state stopped">
                    <UIcon :name="icons.warning" class="state-icon" />已停止
                  </span>
                  <span v-else class="state">
                    <UIcon :name="icons.refresh" class="state-icon" />轮换中
                  </span>
                </td>
              </tr>
            </tbody>
          </SettingsTable>
          <p v-if="remaining === 0" class="text-success">
            轮换完成。可以从配置中移除 KIOKU_MASTER_KEY_PREVIOUS，然后重启服务。
          </p>
        </template>
      </template>
    </div>
  </SettingsBlock>
</template>

<style scoped>
.state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--ui-text-toned);
}
.state.stopped {
  color: var(--ui-error);
}
.state.done {
  color: var(--ui-success);
}
.state-icon {
  width: 12px;
  height: 12px;
}
</style>
