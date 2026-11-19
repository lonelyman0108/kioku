<script setup lang="ts">
import {
  LEGACY_SCHEMA,
  type LegacyUpgradeResult,
  type LegacyUpgradeStatus,
  type LegacyUpgradeSummary,
} from '@kioku/contracts'
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import Hint from '../components/Hint.vue'
import EntryFrame from '../components/strata/EntryFrame.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import PropertyList, { type Property } from '../components/strata/PropertyList.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import { setupLost } from '../routes'

// 旧版就地升级：库还是记忆圈重构之前的结构时，管理员用旧实例账号确认身份后，
// 先整套预览（跑完回滚），再确认执行就地迁移，旧表保留在 kioku_legacy
const router = useRouter()

const upgradeStatus = ref<LegacyUpgradeStatus | null>(null)
const loadError = ref<string | null>(null)
const loading = ref(true)

const form = reactive({ username: '', password: '' })
const stage = ref<'auth' | 'preview' | 'done'>('auth')
const busy = ref<'preview' | 'apply' | null>(null)
const error = ref<string | null>(null)
const result = ref<LegacyUpgradeResult | null>(null)

function summaryGroups(summary: LegacyUpgradeSummary): Property[][] {
  const circlesText = summary.sharedCircles.length
    ? `${summary.sharedCircles.length} 个（${summary.sharedCircles
        .map((c) => `${c.name} ${c.memberCount} 人`)
        .join('、')}）`
    : '0 个'
  const skippedParts: string[] = []
  if (summary.skippedDeletedMemories > 0)
    skippedParts.push(`旧记忆 ${summary.skippedDeletedMemories} 条`)
  if (summary.skippedDeletedCredentials > 0) {
    skippedParts.push(`旧凭据 ${summary.skippedDeletedCredentials} 条`)
  }
  return [
    [
      { key: 'accounts', label: '账号', value: `${summary.accounts} 个（含个人记忆圈）` },
      {
        key: 'circles',
        label: '共享圈',
        value: circlesText,
        stacked: summary.sharedCircles.length > 2,
      },
      {
        key: 'personas',
        label: '独立人格',
        value: `${summary.personas} 个，${summary.personaTraits} 条设定`,
      },
      {
        key: 'clients',
        label: '接入实例',
        value: `${summary.clients} 个，${summary.groupRules} 条群规则`,
      },
      {
        key: 'subjects',
        label: '联系人',
        value: `${summary.subjects} 个，${summary.conversations} 个会话`,
      },
    ],
    [
      {
        key: 'entries',
        label: '正式词条',
        value: `${summary.entries.entry} 条（含机密 ${summary.entries.secret} 条）`,
      },
      { key: 'facts', label: '联系人事实', value: `${summary.entries.fact} 条` },
      { key: 'episodes', label: '会话摘要', value: `${summary.entries.episode} 条` },
      {
        key: 'credentials',
        label: '凭据与库',
        value: `${summary.credentials} 条凭据，${summary.vaultConnections} 个密码库连接`,
      },
      { key: 'settings', label: '实例设置', value: `${summary.settings} 项` },
    ],
    [
      {
        key: 'legacyKeys',
        label: '旧密钥',
        value: `${summary.legacyKeys} 个（迁移后失效，需重新签发）`,
      },
      ...(skippedParts.length
        ? [{ key: 'skipped', label: '已忽略', value: `软删除记录：${skippedParts.join('、')}` }]
        : []),
    ],
  ]
}

const groups = computed(() => (result.value ? summaryGroups(result.value.summary) : []))

async function loadStatus() {
  loading.value = true
  loadError.value = null
  try {
    const s = await api.legacyUpgradeStatus()
    upgradeStatus.value = s
    if (!s.pending) {
      setupLost()
      await router.replace({ name: 'home' })
    }
  } catch (err) {
    loadError.value = err instanceof ApiError ? err.message : '读取升级状态失败'
  } finally {
    loading.value = false
  }
}

onMounted(loadStatus)

async function runPreview() {
  if (!form.username.trim() || !form.password) {
    error.value = '请填写旧实例管理员的用户名与密码'
    return
  }
  busy.value = 'preview'
  error.value = null
  try {
    result.value = await api.previewLegacyUpgrade({
      username: form.username,
      password: form.password,
    })
    stage.value = 'preview'
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '预览迁移失败'
  } finally {
    busy.value = null
  }
}

async function runApply() {
  busy.value = 'apply'
  error.value = null
  try {
    result.value = await api.applyLegacyUpgrade({
      username: form.username,
      password: form.password,
    })
    stage.value = 'done'
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '执行迁移失败'
  } finally {
    busy.value = null
  }
}

async function goLogin() {
  setupLost()
  await router.replace({ name: 'login' })
}
</script>

<template>
  <EntryFrame :wide="stage !== 'auth'">
    <div v-if="loading" class="text-sm text-muted">正在检查升级状态…</div>
    <div v-else-if="loadError" class="space-y-4">
      <SectionHeading title="升级旧版数据" :level="1" />
      <p class="text-error" role="alert">{{ loadError }}</p>
      <UButton type="button" size="lg" block @click="loadStatus">重试</UButton>
    </div>

    <template v-else-if="stage === 'auth'">
      <SectionHeading title="升级旧版数据" :level="1">
        <template #hint>
          <Hint label="就地迁移说明">
            整套迁移在同一个数据库事务里完成：旧表、类型与旧版迁移记录会移入
            <code>{{ LEGACY_SCHEMA }}</code>
            留存，再在原地建好记忆圈结构并写入数据；中途出错会自动回滚，旧库不受影响。
          </Hint>
        </template>
      </SectionHeading>
      <p class="mt-3 text-sm text-muted">
        当前数据库为记忆圈重构之前的结构。使用原管理员账号验证后即可预览并一键就地迁移。
      </p>
      <NoteLine v-if="upgradeStatus && !upgradeStatus.masterKey" tone="warning" class="mt-4">
        尚未配置 <code>KIOKU_MASTER_KEY</code>。
        <template #detail>
          若旧库包含机密词条、托管凭据、密码库连接或已加密的模型服务商密钥，请先配置
          <code>KIOKU_MASTER_KEY</code> 后重启服务再迁移。
        </template>
      </NoteLine>
      <form class="mt-4 space-y-4" @submit.prevent="runPreview">
        <UFormField label="管理员用户名">
          <UInput
            v-model="form.username"
            size="lg"
            autocomplete="username"
            class="w-full"
            required
          />
        </UFormField>
        <UFormField label="密码">
          <UInput
            v-model="form.password"
            size="lg"
            type="password"
            autocomplete="current-password"
            class="w-full"
            required
          />
        </UFormField>
        <p v-if="error" class="text-error" role="alert">{{ error }}</p>
        <UButton type="submit" size="lg" block :loading="busy === 'preview'">
          检查并预览迁移
        </UButton>
      </form>
    </template>

    <template v-else-if="stage === 'preview' && result">
      <SectionHeading title="确认迁移计划" :level="1">
        <template #hint>
          <Hint label="预览说明">
            已完成一次完整的模拟迁移并回滚，以下统计与实际写入完全一致，尚未改动数据库。
          </Hint>
        </template>
      </SectionHeading>
      <p class="mt-3 text-sm text-muted">
        执行后旧表将移入 <code>{{ LEGACY_SCHEMA }}</code> 保留，旧版访问密钥会统一失效。
      </p>
      <PropertyList class="mt-4" :groups="groups" />
      <NoteLine
        v-for="(warn, index) in result.summary.warnings"
        :key="index"
        tone="warning"
        class="mt-3"
      >
        {{ warn }}
      </NoteLine>
      <p v-if="error" class="mt-3 text-error" role="alert">{{ error }}</p>
      <div class="mt-5 flex flex-wrap gap-3">
        <UButton
          type="button"
          size="lg"
          :disabled="busy !== null"
          :loading="busy === 'apply'"
          @click="runApply"
        >
          执行就地迁移
        </UButton>
        <UButton
          type="button"
          size="lg"
          color="neutral"
          variant="outline"
          :disabled="busy !== null"
          @click="stage = 'auth'"
        >
          返回
        </UButton>
      </div>
    </template>

    <template v-else-if="stage === 'done' && result">
      <SectionHeading title="升级完成" :level="1" />
      <p class="mt-3 text-sm text-muted">
        数据已就地迁入记忆圈结构并切换至新版服务，旧表保留在 <code>{{ LEGACY_SCHEMA }}</code
        >。
      </p>
      <PropertyList class="mt-4" :groups="groups" />
      <NoteLine
        v-for="(warn, index) in result.summary.warnings"
        :key="index"
        tone="warning"
        class="mt-3"
      >
        {{ warn }}
      </NoteLine>
      <div class="mt-4 space-y-1.5 border-t border-default pt-3 text-sm text-muted">
        <p class="font-medium text-default">后续步骤</p>
        <ol class="list-inside list-decimal space-y-1">
          <li>使用原有账号登录管理界面。</li>
          <li>
            升级前签发的访问密钥（{{ result.summary.legacyKeys }}
            个）已失效：登录后重新签发，或在终端运行
            <code>npx @kioku-memory/cli migrate</code> 重新接入客户端。
          </li>
          <li>若原实例配置过对象存储备份，登录后重新配置。</li>
          <li>
            向量索引将由后台自动补齐；旧数据保留在 <code>{{ LEGACY_SCHEMA }}</code
            >，确认运行正常后可手动清理。
          </li>
        </ol>
      </div>
      <UButton type="button" size="lg" class="mt-5" @click="goLogin">前往登录</UButton>
    </template>
  </EntryFrame>
</template>
