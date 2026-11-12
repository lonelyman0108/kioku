<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useCopy } from '../composables/useCopy'
import { useNow } from '../composables/useNow'
import { icons } from '../icons'
import {
  commitUrl,
  configured,
  shortCommit,
  updateStatus,
  uptimeText,
  versionLabel,
  WEB_UI_TEXT,
} from '../systemInfo'
import { formatTime } from '../time'
import Hint from './Hint.vue'
import PropertyList from './strata/PropertyList.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SettingsBlock from './strata/SettingsBlock.vue'

// 实例 › 系统信息：构建、运行环境、数据库、配置与后台任务，排查问题、贴 issue 时用；检查新版本的开关也在这里
const SYSTEM_KEY = ['instance-system']
const toast = useToast()
const queryClient = useQueryClient()
const copy = useCopy()
const now = useNow()

const system = useQuery({ queryKey: SYSTEM_KEY, queryFn: api.systemInfo })
const data = computed(() => system.data.value)

// 已运行多久按启动时间现算，页面开着也跟着走
const uptime = computed(() => {
  const started = data.value?.runtime.startedAt
  if (!started) return null
  return uptimeText(Math.max(0, (now.value.getTime() - new Date(started).getTime()) / 1000))
})

const build = computed(() => [
  [
    { key: 'version', label: '版本' },
    { key: 'commit', label: '提交' },
    {
      key: 'builtAt',
      label: '构建时间',
      value: data.value?.build.builtAt ? formatTime(data.value.build.builtAt) : null,
    },
  ],
])
const runtime = computed(() => {
  const r = data.value?.runtime
  return [
    [
      { key: 'node', label: 'Node', value: r?.node },
      { key: 'os', label: '系统', value: r ? `${r.platform} ${r.osRelease}（${r.arch}）` : null },
      { key: 'container', label: '容器', value: r ? (r.container ? '是' : '否') : null },
      { key: 'startedAt', label: '启动时间', value: r ? formatTime(r.startedAt) : null },
      { key: 'uptime', label: '已运行', value: uptime.value },
    ],
  ]
})
const database = computed(() => {
  const d = data.value?.database
  return [
    [
      { key: 'version', label: '版本', value: d?.version },
      { key: 'pgvector', label: 'pgvector', value: d ? (d.pgvector ?? '未安装') : null },
      { key: 'zhparser', label: 'zhparser', value: d ? (d.zhparser ?? '未安装') : null },
      { key: 'migration', label: '迁移' },
    ],
    [
      { key: 'name', label: '库名' },
      { key: 'host', label: '主机' },
    ],
  ]
})
const config = computed(() => {
  const c = data.value?.config
  if (!c) return []
  return [
    [
      { key: 'masterKey', label: '主密钥' },
      ...(c.masterKey.configured
        ? [{ key: 'rotating', label: '轮换', value: c.masterKey.rotating ? '轮换中' : '否' }]
        : []),
      { key: 'cookie', label: 'Cookie', value: c.cookieSecure ? '仅 HTTPS' : '允许 HTTP' },
      {
        key: 'proxies',
        label: '受信代理',
        value: c.trustedProxies ? String(c.trustedProxies) : '无',
      },
      { key: 'webUi', label: '管理界面', value: WEB_UI_TEXT[c.webUi] },
    ],
    [
      { key: 'jobs', label: '后台任务', value: c.jobs ? '运行中' : '未运行' },
      { key: 'embedding', label: '嵌入模型', value: configured(c.embedding) },
      { key: 'extraction', label: '抽取模型', value: configured(c.extraction) },
    ],
  ]
})

const updates = computed(() => data.value?.updates ?? null)
const saving = ref(false)
async function setUpdateCheck(enabled: boolean) {
  if (saving.value) return
  saving.value = true
  try {
    const view = await api.saveUpdateCheck(enabled)
    queryClient.setQueryData(SYSTEM_KEY, (old: typeof data.value) =>
      old ? { ...old, updates: view } : old,
    )
    // 概览的系统提醒跟着变
    void queryClient.invalidateQueries({ queryKey: ['overview'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <ReadFailureNote v-if="system.isError.value" :query="system" />
    <USkeleton v-if="system.isPending.value" class="h-64 w-full max-w-xl" />
    <template v-else-if="data">
      <SettingsBlock title="构建">
        <template #actions>
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            :icon="icons.copy"
            @click="copy(data.diagnostics)"
          >
            复制诊断信息
          </UButton>
        </template>
        <template #note>
          贴到 issue 时用「复制诊断信息」。
          <Hint>复制的内容不含库名、主机与主密钥标识。</Hint>
        </template>
        <PropertyList :groups="build">
          <template #version>
            <span class="font-mono text-[13px]">{{ data.build.version }}</span>
          </template>
          <template #commit>
            <a
              v-if="commitUrl(data.build.commit)"
              :href="commitUrl(data.build.commit)!"
              target="_blank"
              rel="noopener noreferrer"
              class="commit-link"
            >
              <span class="font-mono text-[13px]">{{ shortCommit(data.build.commit) }}</span>
              <UIcon :name="icons.link" class="link-icon" />
            </a>
            <template v-else>–</template>
          </template>
        </PropertyList>
      </SettingsBlock>

      <SettingsBlock title="运行环境">
        <PropertyList :groups="runtime" />
      </SettingsBlock>

      <SettingsBlock title="数据库">
        <PropertyList :groups="database">
          <template #migration>
            <span class="font-mono text-[13px]">{{ data.database.migration ?? '–' }}</span>
          </template>
          <template #name>
            <span class="font-mono text-[13px]">{{ data.database.name ?? '–' }}</span>
          </template>
          <template #host>
            <span class="font-mono text-[13px]">{{ data.database.host ?? '–' }}</span>
          </template>
        </PropertyList>
      </SettingsBlock>

      <SettingsBlock title="配置与后台任务">
        <template #note>
          来自服务器的环境变量，修改后重启服务生效。
          <Hint>
            主密钥：KIOKU_MASTER_KEY，轮换期间另配
            KIOKU_MASTER_KEY_PREVIOUS。Cookie：KIOKU_COOKIE_SECURE。受信代理：KIOKU_TRUSTED_PROXIES。管理界面：KIOKU_WEB_DIR。嵌入模型与抽取模型在「模型」小节配置。
          </Hint>
        </template>
        <PropertyList :groups="config">
          <template #masterKey>
            <template v-if="data.config.masterKey.configured">
              已配置
              <span class="ml-1 font-mono text-[13px] text-muted">{{
                data.config.masterKey.id
              }}</span>
            </template>
            <template v-else>未配置</template>
          </template>
        </PropertyList>
      </SettingsBlock>

      <SettingsBlock v-if="updates" title="检查新版本">
        <template #note>
          打开后服务器每天最多向 GitHub 请求一次最新正式版，默认关闭。
          <Hint>
            只比较正式版，不含预发布。发现新版本时在此处与概览的系统提醒中提示，仅实例管理员可见。当前版本不是正式版（本地构建、edge
            镜像）时不检查。
          </Hint>
        </template>
        <div class="space-y-2">
          <USwitch
            :model-value="updates.enabled"
            :loading="saving"
            :disabled="saving"
            label="检查新版本"
            @update:model-value="setUpdateCheck"
          />
          <p class="text-sm/6">
            <span :class="{ 'text-warning': updates.available }">{{ updateStatus(updates) }}</span>
            <a
              v-if="updates.available"
              :href="updates.available.url"
              target="_blank"
              rel="noopener noreferrer"
              class="release-link"
            >
              查看发布说明<UIcon :name="icons.link" class="link-icon" />
            </a>
          </p>
          <p v-if="updates.enabled && updates.checkedAt" class="text-xs text-muted">
            上次检查：{{ formatTime(updates.checkedAt) }}
            <template v-if="updates.latest"
              >，最新正式版 {{ versionLabel(updates.latest) }}</template
            >
          </p>
        </div>
      </SettingsBlock>
    </template>
  </div>
</template>

<style scoped>
.commit-link,
.release-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.release-link {
  margin-left: 8px;
}
.link-icon {
  display: inline-block;
  width: 12px;
  height: 12px;
}
</style>
