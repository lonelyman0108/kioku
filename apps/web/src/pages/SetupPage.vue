<script setup lang="ts">
import {
  DATABASE_SOURCE_NAMES,
  SetupRequest,
  type DatabaseCheck,
  type DatabaseSslMode,
  type SetupStatus,
} from '@kioku/contracts'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import Hint from '../components/Hint.vue'
import SegmentedChoice from '../components/SegmentedChoice.vue'
import EntryFrame from '../components/ui/EntryFrame.vue'
import NoteLine from '../components/ui/NoteLine.vue'
import PropertyList from '../components/ui/PropertyList.vue'
import SectionHeading from '../components/ui/SectionHeading.vue'
import { ME_KEY } from '../composables/useSession'
import { icons } from '../icons'
import { queryClient } from '../query'
import {
  checkRows,
  setupFailure,
  SSL_MODE_ITEMS,
  summaryFacts,
  VERDICT_NAMES,
  type CheckVerdict,
} from '../setup'

// 首次初始化：数据库尚未配置时先填写或代建连接，已就绪时直接创建唯一管理员账号
const router = useRouter()

const VERDICT_ICONS: Record<CheckVerdict, string> = {
  passed: icons.checkCircle,
  notice: icons.warning,
  blocked: icons.circleX,
}
const VERDICT_CLASSES: Record<CheckVerdict, string> = {
  passed: 'text-success',
  notice: 'text-warning',
  blocked: 'text-error',
}

const status = ref<SetupStatus | null>(null)
const loadError = ref<string | null>(null)
const step = ref<'database' | 'admin'>('database')
const admin = reactive({
  setupCode: '',
  username: '',
  displayName: '',
  password: '',
})

type Mode = 'fill' | 'provision'
const mode = ref<Mode>('fill')
const MODES = [
  { value: 'fill' as const, label: '填写连接', icon: icons.database },
  { value: 'provision' as const, label: '用超级用户创建', icon: icons.sparkles },
]
const connection = reactive({
  host: '127.0.0.1',
  port: 5432,
  database: 'kioku',
  username: 'kioku',
  password: '',
  ssl: 'disable' as DatabaseSslMode,
})
const provision = reactive({
  host: '127.0.0.1',
  port: 5432,
  ssl: 'disable' as DatabaseSslMode,
  username: 'postgres',
  password: '',
  maintenance: 'postgres',
  role: 'kioku',
  database: 'kioku',
})

const check = ref<DatabaseCheck | null>(null)
const error = ref<string | null>(null)
const busy = ref<'check' | 'connect' | 'provision' | 'admin' | null>(null)
const connected = ref<string | null>(null)

const editable = computed(() => status.value?.database.state === 'missing')
const rows = computed(() => (check.value ? checkRows(check.value) : []))
const readySummary = computed(() =>
  status.value?.database.summary
    ? summaryFacts(status.value.database.summary, status.value.database.source)
    : [],
)

watch(connection, () => {
  check.value = null
})

async function loadStatus() {
  try {
    status.value = await api.setupStatus()
    loadError.value = null
  } catch (err) {
    loadError.value = err instanceof ApiError ? err.message : '读取初始化状态失败'
    return
  }
  if (status.value.database.state === 'unavailable') {
    await router.replace({ name: 'database-unavailable' })
    return
  }
  if (!status.value.needsSetup) {
    await router.replace({ name: 'login' })
    return
  }
  if (status.value.database.state === 'ready') step.value = 'admin'
}

onMounted(loadStatus)

function codeMissing(): boolean {
  if (admin.setupCode.trim()) return false
  error.value = '请填写初始化码'
  return true
}

async function run(
  kind: NonNullable<typeof busy.value>,
  fn: () => Promise<void>,
  fallback: string,
) {
  if (codeMissing()) return
  busy.value = kind
  error.value = null
  try {
    await fn()
  } catch (err) {
    const failure = setupFailure(err, fallback)
    error.value = failure.message
    if (failure.check) check.value = failure.check
  } finally {
    busy.value = null
  }
}

const runCheck = () =>
  run(
    'check',
    async () => {
      check.value = await api.checkDatabase({
        setupCode: admin.setupCode,
        connection: { ...connection },
      })
    },
    '检查失败',
  )

async function afterConnected(database: string) {
  connected.value = database
  await loadStatus()
  if (status.value?.needsSetup) step.value = 'admin'
}

const connect = () =>
  run(
    'connect',
    async () => {
      const result = await api.connectDatabase({
        setupCode: admin.setupCode,
        connection: { ...connection },
      })
      await afterConnected(result.summary.database)
    },
    '接入失败',
  )

const createAndConnect = () =>
  run(
    'provision',
    async () => {
      const { role, database, maintenance, ...superuser } = provision
      const result = await api.provisionDatabase({
        setupCode: admin.setupCode,
        superuser: { ...superuser, database: maintenance },
        role,
        database,
      })
      check.value = result.check
      await afterConnected(result.summary.database)
    },
    '创建失败',
  )

async function submitAdmin() {
  busy.value = 'admin'
  error.value = null
  try {
    const me = await api.setup({ ...admin })
    queryClient.clear()
    queryClient.setQueryData(ME_KEY, me)
    await router.replace({ name: 'memories' })
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '初始化失败'
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <EntryFrame :wide="step === 'database'">
    <SectionHeading title="初始化" :level="1">
      <template #actions>
        <ol class="steps">
          <li :class="{ on: step === 'database', done: step === 'admin' }">
            <UIcon
              :name="step === 'admin' ? icons.checkCircle : icons.database"
              class="step-icon"
              aria-hidden="true"
            />
            <span>1 数据库</span>
          </li>
          <li :class="{ on: step === 'admin' }">
            <UIcon :name="icons.account" class="step-icon" aria-hidden="true" />
            <span>2 账号</span>
          </li>
        </ol>
      </template>
    </SectionHeading>

    <p v-if="loadError" class="mt-4 flex items-start gap-1.5 text-error" role="alert">
      <UIcon :name="icons.error" class="mt-[3px] inline-block size-4 shrink-0" aria-hidden="true" />
      <span>{{ loadError }}</span>
    </p>

    <template v-else-if="status">
      <NoteLine v-if="!status.masterKey" class="mt-4" tone="warning">
        未配置主密钥
        <template #detail>
          托管凭据与模型接口密钥加密不可用；配置 KIOKU_MASTER_KEY 后重启服务。
        </template>
      </NoteLine>

      <!-- 第一步：数据库 -->
      <div v-if="step === 'database'" class="mt-4 space-y-4" data-state="database">
        <UFormField label="初始化码" help="见服务的启动日志">
          <UInput
            v-model="admin.setupCode"
            size="lg"
            class="w-full max-w-sm"
            :ui="{ base: 'font-mono uppercase tracking-widest' }"
            autocomplete="off"
            autocapitalize="characters"
            autocorrect="off"
            spellcheck="false"
            maxlength="256"
          />
        </UFormField>

        <template v-if="editable">
          <div><SegmentedChoice v-model="mode" :items="MODES" label="连接方式" /></div>

          <form v-if="mode === 'fill'" class="space-y-4" @submit.prevent="runCheck">
            <div class="fields">
              <UFormField label="主机" class="wide">
                <UInput v-model="connection.host" class="w-full" autocomplete="off" required />
              </UFormField>
              <UFormField label="端口">
                <UInput v-model.number="connection.port" type="number" class="w-full" required />
              </UFormField>
              <UFormField label="库名">
                <UInput v-model="connection.database" class="w-full" autocomplete="off" required />
              </UFormField>
              <UFormField label="用户名">
                <UInput v-model="connection.username" class="w-full" autocomplete="off" required />
              </UFormField>
              <UFormField label="密码">
                <UInput
                  v-model="connection.password"
                  type="password"
                  class="w-full"
                  autocomplete="new-password"
                />
              </UFormField>
              <UFormField label="SSL">
                <USelect v-model="connection.ssl" :items="SSL_MODE_ITEMS" class="w-full" />
              </UFormField>
            </div>
            <div class="actions">
              <UButton
                type="submit"
                color="neutral"
                variant="outline"
                :icon="icons.shieldCheck"
                :loading="busy === 'check'"
              >
                检查
              </UButton>
              <UButton
                type="button"
                :icon="icons.plug"
                :disabled="!check?.ready || busy !== null"
                :loading="busy === 'connect'"
                @click="connect"
              >
                保存并接入
              </UButton>
            </div>
          </form>

          <div v-else class="space-y-4" data-state="provision">
            <p class="text-sm text-muted">
              新建应用角色与库，只保存应用角色的连接。
              <Hint label="代建规则">
                应用角色使用随机密码并拥有新建库，并在库里安装 vector 与 zhparser
                扩展。超级用户密码只用于本次创建，不保存、不写入日志。
              </Hint>
            </p>
            <div class="fields">
              <UFormField label="主机" class="wide">
                <UInput v-model="provision.host" class="w-full" autocomplete="off" />
              </UFormField>
              <UFormField label="端口">
                <UInput v-model.number="provision.port" type="number" class="w-full" />
              </UFormField>
              <UFormField label="SSL">
                <USelect v-model="provision.ssl" :items="SSL_MODE_ITEMS" class="w-full" />
              </UFormField>
              <UFormField label="超级用户">
                <UInput v-model="provision.username" class="w-full" autocomplete="off" />
              </UFormField>
              <UFormField label="超级用户密码">
                <UInput
                  v-model="provision.password"
                  type="password"
                  class="w-full"
                  autocomplete="off"
                />
              </UFormField>
              <UFormField label="维护库" help="超级用户先连上的库">
                <UInput
                  v-model="provision.maintenance"
                  class="w-full font-mono"
                  autocomplete="off"
                />
              </UFormField>
              <UFormField label="新建的角色名" help="小写字母、数字和下划线">
                <UInput v-model="provision.role" class="w-full font-mono" autocomplete="off" />
              </UFormField>
              <UFormField label="新建的库名" help="小写字母、数字和下划线">
                <UInput v-model="provision.database" class="w-full font-mono" autocomplete="off" />
              </UFormField>
            </div>
            <div class="actions">
              <UButton
                type="button"
                :icon="icons.plug"
                :loading="busy === 'provision'"
                @click="createAndConnect"
              >
                创建并接入
              </UButton>
            </div>
          </div>
        </template>

        <p v-if="error" class="flex items-start gap-1.5 text-error" role="alert">
          <UIcon
            :name="icons.error"
            class="mt-[3px] inline-block size-4 shrink-0"
            aria-hidden="true"
          />
          <span>{{ error }}</span>
        </p>

        <section v-if="rows.length" aria-label="检查结果">
          <SectionHeading title="检查结果" :level="2" :icon="icons.listChecks" />
          <ul class="checks">
            <li v-for="row in rows" :key="row.key" :data-verdict="row.verdict">
              <span class="check-label">{{ row.label }}</span>
              <span class="check-value">{{ row.value }}</span>
              <span class="check-verdict" :class="VERDICT_CLASSES[row.verdict]">
                <UIcon :name="VERDICT_ICONS[row.verdict]" class="verdict-icon" aria-hidden="true" />
                <span>{{ VERDICT_NAMES[row.verdict] }}</span>
              </span>
              <p v-if="row.detail" class="check-detail">{{ row.detail }}</p>
            </li>
          </ul>
        </section>
      </div>

      <!-- 第二步：创建管理员账号 -->
      <template v-else>
        <p class="mt-2 text-muted">创建本实例的所有者账号。</p>
        <p v-if="connected" class="mt-1 flex items-center gap-1.5 text-sm text-muted">
          <UIcon
            :name="icons.checkCircle"
            class="inline-block size-4 shrink-0 text-success"
            aria-hidden="true"
          />
          <span>已接入数据库 {{ connected }}。</span>
        </p>
        <div v-else-if="readySummary.length" class="mt-3">
          <p v-if="status.database.source" class="mb-2 text-xs text-muted">
            连接来自{{ DATABASE_SOURCE_NAMES[status.database.source] }}
          </p>
          <PropertyList :groups="readySummary" />
        </div>

        <UForm
          :schema="SetupRequest"
          :state="admin"
          class="mt-4 space-y-4"
          data-state="admin"
          @submit="submitAdmin"
        >
          <UFormField label="初始化码" name="setupCode" help="见服务的启动日志">
            <UInput
              v-model="admin.setupCode"
              size="lg"
              class="w-full"
              :ui="{ base: 'font-mono uppercase tracking-widest' }"
              autocomplete="off"
              spellcheck="false"
              maxlength="256"
            />
          </UFormField>
          <UFormField label="用户名" name="username" help="小写字母、数字和 _.-">
            <UInput v-model="admin.username" size="lg" autocomplete="username" class="w-full" />
          </UFormField>
          <UFormField label="显示名" name="displayName">
            <UInput v-model="admin.displayName" size="lg" class="w-full" />
          </UFormField>
          <UFormField label="密码" name="password" help="至少 10 位">
            <UInput
              v-model="admin.password"
              size="lg"
              type="password"
              autocomplete="new-password"
              class="w-full"
            />
          </UFormField>
          <p v-if="error" class="flex items-start gap-1.5 text-error" role="alert">
            <UIcon
              :name="icons.error"
              class="mt-[3px] inline-block size-4 shrink-0"
              aria-hidden="true"
            />
            <span>{{ error }}</span>
          </p>
          <UButton type="submit" size="lg" block :icon="icons.userPlus" :loading="busy === 'admin'">
            创建并登录
          </UButton>
        </UForm>
      </template>
    </template>
  </EntryFrame>
</template>

<style scoped>
.steps {
  display: flex;
  gap: 12px;
  font-size: 13px;
}
.steps li {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.step-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
}
.steps .done .step-icon {
  color: var(--ui-success);
}
.steps .on {
  color: var(--ui-text-highlighted);
  font-weight: 600;
}
.fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px 16px;
}
.fields .wide {
  grid-column: span 2;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.checks {
  margin-top: 4px;
}
.checks li {
  display: grid;
  grid-template-columns: 6.5rem minmax(0, 1fr) auto;
  gap: 2px 12px;
  align-items: baseline;
  padding: 6px 0;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
}
.check-label {
  color: var(--ui-text-muted);
  font-size: 13px;
}
.check-value {
  overflow-wrap: anywhere;
}
.check-verdict {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
}
.verdict-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
}
.check-detail {
  grid-column: 2 / -1;
  color: var(--ui-text-muted);
  font-size: 13px;
}
@media (max-width: 639.98px) {
  .fields {
    grid-template-columns: minmax(0, 1fr);
  }
  .fields .wide {
    grid-column: auto;
  }
  .checks li {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .check-label {
    grid-column: 1 / -1;
  }
  .check-detail {
    grid-column: 1 / -1;
  }
}
</style>
