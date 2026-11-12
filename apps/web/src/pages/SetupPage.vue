<script setup lang="ts">
import {
  DATABASE_SOURCE_NAMES,
  SetupRequest,
  type DatabaseCheck,
  type DatabaseInspection,
  type DatabaseSslMode,
  type SetupStatus,
} from '@kioku/contracts'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import SegmentedChoice from '../components/SegmentedChoice.vue'
import EntryFrame from '../components/strata/EntryFrame.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import PropertyList from '../components/strata/PropertyList.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import { ME_KEY } from '../composables/useSession'
import { queryClient } from '../query'
import {
  checkRows,
  lockedHint,
  setupFailure,
  SSL_MODE_ITEMS,
  summaryFacts,
  VERDICT_NAMES,
} from '../setup'

// 首次初始化：第一步接上数据库，第二步建第一个管理员与空间。两步都要服务启动日志里的初始化码。
// 数据库来自环境变量或 kioku.json 时，第一步只显示连接与检查结果，不能修改；
// 都没有时在这里填连接（或者用超级用户代建），检查通过后保存并当场接上
const router = useRouter()

const status = ref<SetupStatus | null>(null)
const loadError = ref<string | null>(null)
const step = ref<'database' | 'admin'>('database')
const admin = reactive({
  setupCode: '',
  username: '',
  displayName: '',
  password: '',
  spaceName: '我的空间',
})

type Mode = 'fill' | 'provision'
const mode = ref<Mode>('fill')
const MODES = [
  { value: 'fill' as const, label: '填写连接' },
  { value: 'provision' as const, label: '用超级用户创建' },
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
  role: 'kioku',
  database: 'kioku',
})

const check = ref<DatabaseCheck | null>(null)
const inspection = ref<DatabaseInspection | null>(null)
const error = ref<string | null>(null)
const busy = ref<'inspect' | 'check' | 'connect' | 'provision' | 'admin' | null>(null)
const connected = ref<string | null>(null)

const editable = computed(() => status.value?.database.state === 'missing')
const rows = computed(() => (check.value ? checkRows(check.value) : []))

// 改了连接就要重新检查
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
  if (!status.value.needsSetup) {
    // 接入的是已有实例：用已有账号登录
    await router.replace({ name: 'login' })
    return
  }
  // 测试用的服务没有数据库这一步的状态来源，直接建管理员
  if (status.value.database.state === 'ready' && !status.value.database.source) step.value = 'admin'
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

const inspect = () =>
  run(
    'inspect',
    async () => {
      inspection.value = await api.inspectDatabase(admin.setupCode)
      check.value = inspection.value.check
      // 连不上的库在服务端重试：可能这时已经接上了
      await loadStatus()
    },
    '读取数据库状态失败',
  )

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
  inspection.value = null
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
      const { role, database, ...superuser } = provision
      const result = await api.provisionDatabase({
        setupCode: admin.setupCode,
        superuser: { ...superuser, database: 'postgres' },
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
    await router.replace({ name: 'home' })
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
          <li :class="{ on: step === 'database' }">1 数据库</li>
          <li :class="{ on: step === 'admin' }">2 管理员</li>
        </ol>
      </template>
    </SectionHeading>

    <p v-if="loadError" class="mt-4 text-error" role="alert">{{ loadError }}</p>

    <template v-else-if="status">
      <NoteLine v-if="!status.masterKey" class="mt-4" tone="warning">
        未配置主密钥
        <template #detail>
          机密记忆、托管的凭据等功能不可用；配置 KIOKU_MASTER_KEY 后重启服务。
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
            maxlength="128"
          />
        </UFormField>

        <!-- 来自环境变量或 kioku.json：只显示，不能改 -->
        <template v-if="!editable">
          <NoteLine v-if="status.database.state === 'unavailable'" tone="error" role="alert">
            数据库暂时无法连接
            <template #detail>服务每隔一段时间重试一次，接上后刷新此页。</template>
          </NoteLine>
          <p v-if="status.database.source" class="text-sm text-muted">
            连接来自{{ DATABASE_SOURCE_NAMES[status.database.source] }}，此处无法修改。
          </p>
          <UButton color="neutral" variant="outline" :loading="busy === 'inspect'" @click="inspect">
            {{ inspection ? '重新检查' : '查看连接' }}
          </UButton>
          <PropertyList
            v-if="inspection?.summary"
            :groups="summaryFacts(inspection.summary, inspection.source)"
          />
        </template>

        <!-- 都没有：在这里填，或者用超级用户代建 -->
        <template v-else>
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
              <UButton type="submit" color="neutral" variant="outline" :loading="busy === 'check'">
                检查
              </UButton>
              <!-- 保存不放在表单里提交：回车只做检查 -->
              <UButton
                type="button"
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
              用超级用户新建应用角色（随机密码，不是超级用户、不带 BYPASSRLS）与库，并装好
              vector、zhparser 扩展。只保存应用角色的连接，超级用户的密码不保存。
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
              <UFormField label="新建的角色名" help="小写字母、数字和下划线">
                <UInput v-model="provision.role" class="w-full font-mono" autocomplete="off" />
              </UFormField>
              <UFormField label="新建的库名" help="小写字母、数字和下划线">
                <UInput v-model="provision.database" class="w-full font-mono" autocomplete="off" />
              </UFormField>
            </div>
            <div class="actions">
              <UButton type="button" :loading="busy === 'provision'" @click="createAndConnect">
                创建并接入
              </UButton>
            </div>
          </div>
        </template>

        <p v-if="error" class="text-error" role="alert">{{ error }}</p>

        <section v-if="rows.length" aria-label="检查结果">
          <SectionHeading title="检查结果" :level="2" />
          <ul class="checks">
            <li v-for="row in rows" :key="row.key" :data-verdict="row.verdict">
              <span class="check-label">{{ row.label }}</span>
              <span class="check-value">{{ row.value }}</span>
              <span class="check-verdict" :class="{ 'text-error': row.verdict === 'blocked' }">
                {{ VERDICT_NAMES[row.verdict] }}
              </span>
              <p v-if="row.detail" class="check-detail">{{ row.detail }}</p>
            </li>
          </ul>
        </section>

        <template v-if="!editable && inspection">
          <NoteLine v-if="status.database.source && !check?.ready" tone="error">
            连接无法在此修改
            <template #detail>{{ lockedHint(status.database.source) }}</template>
          </NoteLine>
          <UButton
            v-else-if="status.database.state === 'ready'"
            type="button"
            @click="step = 'admin'"
          >
            下一步
          </UButton>
        </template>
      </div>

      <!-- 第二步：管理员 -->
      <template v-else>
        <p class="mt-2 text-muted">创建首个账号及其空间，该账号为实例管理员。</p>
        <p v-if="connected" class="mt-1 text-sm text-muted">已接入数据库 {{ connected }}。</p>
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
              maxlength="128"
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
          <UFormField label="空间名" name="spaceName">
            <UInput v-model="admin.spaceName" size="lg" class="w-full" />
          </UFormField>
          <p v-if="error" class="text-error" role="alert">{{ error }}</p>
          <UButton type="submit" size="lg" block :loading="busy === 'admin'">创建并登录</UButton>
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
  font-size: 13px;
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
