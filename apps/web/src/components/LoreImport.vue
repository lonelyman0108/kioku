<script setup lang="ts">
import {
  LORE_DEFAULT_PERSONA,
  LORE_FILE_MAX_BYTES,
  LORE_UPLOAD_MAX_BYTES,
  Slug,
  type LoreBackupUpload,
  type LoreImportPlan,
  type LoreImportResult,
  type LoreImportSource,
  type LorePlanNode,
  type LorePlanTarget,
  type LoreTargetState,
} from '@kioku/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, ref, shallowRef, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { formatBytes } from '../backup'
import { icons } from '../icons'
import { layerLabels, sensitivityColors, sensitivityLabels } from '../labels'
import {
  applyFailureOf,
  excludeLabel,
  importProblems,
  LoreFileError,
  matchesFilter,
  NODE_FILTERS,
  planBlocker,
  readLoreBackup,
  replanAfterFailure,
  secretSelectable,
  selectionEffects,
  selectionOf,
  sourceTabs,
  staleNotice,
  syncGroups,
  targetStateLabels,
  tokenInClear,
  type ApplyFailure,
  type NodeFilter,
} from '../loreBackup'
import { formatTime } from '../time'
import Hint from './Hint.vue'

const props = defineProps<{ spaceId: string; editable: boolean; isAdmin: boolean }>()

const queryClient = useQueryClient()

type SourceKind = LoreImportSource['kind']
const sourceKind = ref<SourceKind>('file')
const file = ref<File | null>(null)
// 裁剪过的导出：执行时要重新发一次。只在内存里，换了文件、换了空间或导入成功就丢掉
const backup = shallowRef<LoreBackupUpload | null>(null)
const url = ref('')
const token = ref('')
const personaSlug = ref<string>(LORE_DEFAULT_PERSONA.slug)
const personaName = ref<string>(LORE_DEFAULT_PERSONA.name)

const plan = shallowRef<LoreImportPlan | null>(null)
const result = shallowRef<LoreImportResult | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)
// 重看计划的原因（计划变了、写到一半出错），和新的计划一起显示
const notice = ref<string | null>(null)
// 勾选按节点 uuid 记：重看计划之后还在（409 或写到一半出错之后不用重新勾）
const secretIds = ref(new Set<string>())
const excludedIds = ref(new Set<string>())
const confirmStale = ref(false)
const filter = ref<NodeFilter>('all')

const clearSelection = () => {
  secretIds.value = new Set()
  excludedIds.value = new Set()
}
// 来源或人格变了，看过的计划就不算数了；换了来源连勾选一起清
watch([sourceKind, file, url, token, personaSlug, personaName], () => {
  plan.value = null
  error.value = null
  notice.value = null
  confirmStale.value = false
})
watch([sourceKind, file, url], clearSelection)
watch(file, () => (backup.value = null))
watch(
  () => props.spaceId,
  () => {
    file.value = null
    url.value = ''
    token.value = ''
    result.value = null
    sourceKind.value = 'file'
    personaSlug.value = LORE_DEFAULT_PERSONA.slug
    personaName.value = LORE_DEFAULT_PERSONA.name
    plan.value = null
    error.value = null
    notice.value = null
    confirmStale.value = false
    filter.value = 'all'
    clearSelection()
  },
)

const tooLarge = computed(() => (file.value ? file.value.size > LORE_FILE_MAX_BYTES : false))
const tokenExposed = computed(() => sourceKind.value === 'url' && tokenInClear(url.value))
const personaProblem = computed(() =>
  Slug.safeParse(personaSlug.value).success ? null : '只能使用小写字母、数字和连字符',
)
const persona = computed(() => ({ slug: personaSlug.value, name: personaName.value.trim() }))
const blocker = computed(() =>
  planBlocker({
    busy: busy.value,
    sourceKind: sourceKind.value,
    hasFile: Boolean(file.value),
    tooLarge: tooLarge.value,
    url: url.value.trim(),
    personaProblem: personaProblem.value,
    personaName: persona.value.name,
  }),
)
const ready = computed(() => !blocker.value)

async function currentSource(): Promise<LoreImportSource> {
  if (sourceKind.value === 'url') {
    return { kind: 'url', url: url.value.trim(), token: token.value.trim() }
  }
  backup.value ??= await readLoreBackup(file.value!)
  return { kind: 'file', backup: backup.value }
}

const messageOf = (err: unknown, fallback: string) =>
  err instanceof ApiError || err instanceof LoreFileError ? err.message : fallback

// 返回有没有拿到新的计划。没拿到时错误里有原因：执行失败之后的说明会让人看下面的错误
async function showPlan(): Promise<boolean> {
  if (!ready.value) {
    error.value = blocker.value
    return false
  }
  busy.value = true
  error.value = null
  const forSpace = props.spaceId
  try {
    const next = await api.lorePlan(forSpace, {
      source: await currentSource(),
      persona: persona.value,
    })
    if (forSpace !== props.spaceId) return false
    plan.value = next
    confirmStale.value = false
    return true
  } catch (err) {
    if (forSpace !== props.spaceId) return false
    plan.value = null
    error.value = messageOf(err, '生成计划失败')
    return false
  } finally {
    busy.value = false
  }
}

async function replan() {
  notice.value = null
  result.value = null
  await showPlan()
}

// 表单的提交（包括在输入框里按回车的隐式提交）只用来看计划。计划显示之后什么都不做：写入只来自点「确认导入」，
// 不然没看完、没勾 secret 的节点就按明文写进去了
function onSubmit() {
  if (!plan.value) void replan()
}

async function applyPlan() {
  const seen = plan.value
  if (!seen || !ready.value || confirmMissing.value) return
  busy.value = true
  error.value = null
  notice.value = null
  const forSpace = props.spaceId
  let failure: ApplyFailure | null = null
  try {
    const done = await api.loreApply(forSpace, {
      source: await currentSource(),
      persona: persona.value,
      fingerprint: seen.fingerprint,
      ...selectionOf(seen, secretIds.value, excludedIds.value),
      confirmStale: confirmStale.value,
    })
    if (forSpace === props.spaceId) {
      result.value = done
      plan.value = null
      // 全部做成就不再留着文件、Token 与勾选。有没做成的要重看计划，先留着：
      // 勾选丢了再确认一次，写失败的 secret 节点就成了明文
      if (!importProblems(done)) {
        file.value = null
        token.value = ''
        clearSelection()
      }
      void queryClient.invalidateQueries()
    }
  } catch (err) {
    if (forSpace === props.spaceId) failure = applyFailureOf(err)
  } finally {
    busy.value = false
  }
  if (!failure) return
  if (failure.kind === 'refused') {
    error.value = failure.message
    return
  }
  // 不用旧指纹重试：可能已经写了一部分，或者计划确实变了。直接重看计划，勾选还在
  plan.value = null
  await replanAfterFailure(failure, showPlan, (text) => {
    if (forSpace === props.spaceId) notice.value = text
  })
}

function toggle(set: Set<string>, id: string, on: boolean | 'indeterminate'): Set<string> {
  const next = new Set(set)
  if (on === true) next.add(id)
  else next.delete(id)
  return next
}
const toggleSecret = (id: string, on: boolean | 'indeterminate') =>
  (secretIds.value = toggle(secretIds.value, id, on))
const toggleExcluded = (id: string, on: boolean | 'indeterminate') =>
  (excludedIds.value = toggle(excludedIds.value, id, on))

const nodes = computed(() => plan.value?.nodes ?? [])
const plannedBoot = computed(() =>
  plan.value ? selectionEffects(plan.value, new Set(), new Set()).boot : new Set<LorePlanTarget>(),
)
const visibleNodes = computed(() =>
  nodes.value.filter((n) => matchesFilter(n, filter.value, plannedBoot.value)),
)
const filterItems = computed(() =>
  NODE_FILTERS.map(({ value, label }) => ({
    value,
    label: `${label}（${nodes.value.filter((n) => matchesFilter(n, value, plannedBoot.value)).length}）`,
  })),
)
const sync = computed(() => (plan.value ? syncGroups(plan.value) : null))
// 勾选之后这次到底会动什么
const effects = computed(
  () => plan.value && selectionEffects(plan.value, secretIds.value, excludedIds.value),
)
const stale = computed(() => plan.value && effects.value && staleNotice(plan.value, effects.value))
const confirmMissing = computed(() => stale.value === 'confirm' && !confirmStale.value)
// 之前的导入写到了别的人格：换了人格时 core://soul 另写一份，之前那份不再同步
const otherPersonas = computed(() => {
  const imported = plan.value?.persona.imported ?? []
  return imported.includes(plan.value?.persona.slug ?? '') ? [] : imported
})

const STATE_COLORS: Record<LoreTargetState, 'primary' | 'neutral' | 'warning'> = {
  new: 'primary',
  imported: 'neutral',
  moved: 'warning',
}
const isSecret = (node: LorePlanNode, target: LorePlanTarget) =>
  target.state === 'new' && secretIds.value.has(node.uuid) && !excludedIds.value.has(node.uuid)
// 显示的敏感级：这次要标的，或者之前导入的那条现在已经是 secret
const secretNow = (node: LorePlanNode, target: LorePlanTarget) =>
  isSecret(node, target) || target.current.some((c) => c.secret)
const sensitivityOf = (node: LorePlanNode, target: LorePlanTarget) =>
  secretNow(node, target) ? 'secret' : target.sensitivity
// 之前导入的那条现在的样子：移动过、删除了都说一声
function currentNote(target: LorePlanTarget): string | null {
  const notes = target.current.flatMap((c) => {
    if (c.uri === null) return ['已在 Kioku 中删除']
    return c.uri === target.uri ? [] : [`当前位于 ${c.uri}`]
  })
  return notes.length ? notes.join('；') : null
}
// 路径或正文像有凭据的提醒：已经全是 secret 的不用再说；导入过的这里标不了，要到记忆详情里改
function credentialNote(node: LorePlanNode): string | null {
  const { path, content } = node.credentialHints
  if ((!path && !content) || node.targets.every((t) => secretNow(node, t))) return null
  const where = path ? '路径' : '正文'
  return secretSelectable(node)
    ? `${where}疑似包含明文凭据：建议标记机密，或将值替换为凭据占位符`
    : `${where}疑似包含明文凭据：请到记忆详情改为机密（同时清除历史中的明文），或将值替换为凭据占位符`
}
function secretHint(node: LorePlanNode): string | undefined {
  if (!plan.value?.secretAvailable) return '当前实例未配置主密钥，无法标记机密'
  if (!secretSelectable(node)) return '已导入，此处不生效；如需改为机密，请到记忆详情修改'
  if (excludedIds.value.has(node.uuid)) return '本次不导入'
  return undefined
}
const disclosureCut = computed(
  () =>
    new Set(
      plan.value?.warnings.filter((w) => w.kind === 'disclosureTruncated').map((w) => w.uri) ?? [],
    ),
)
</script>

<template>
  <UCard class="max-w-2xl shrink-0">
    <template #header>
      <h2 class="font-medium">从 Lore 导入</h2>
      <p class="mt-1 text-sm text-muted">
        将 Lore 的节点导入当前空间，确认计划后才写入。
        <Hint>
          映射规则与命令行相同：core://agent 进入基础层，core://soul
          进入人格层，core://agent/&lt;运行时&gt; 进入当前账号的对应应用，preferences://
          进入当前账号的个人画像层，其余进入当前账号的私人层。可重复执行：已导入的不重复写入，Lore
          中修改过的按 Lore 同步；在 Kioku 中修改、移动或删除过的不变。
        </Hint>
      </p>
    </template>

    <p v-if="!editable" class="text-sm text-muted">仅空间所有者可导入</p>

    <!-- 结果：有没做成的就不显示成成功 -->
    <div v-else-if="result" class="space-y-3">
      <UAlert
        v-if="importProblems(result)"
        color="warning"
        variant="subtle"
        title="部分内容未完成：请查看下方说明，处理后重新生成计划以继续"
      />
      <UAlert v-else color="success" variant="subtle" title="导入完成" />
      <ul class="space-y-1 text-sm">
        <li v-if="result.personaUsed">
          人格 {{ persona.slug }}：{{ result.personaCreated ? '新建' : '已有' }}
        </li>
        <li v-else>
          人格 {{ persona.slug }} 不存在，本次也没有要写入的
          core://soul：未新建人格，新建应用的默认人格为空
        </li>
        <li v-if="result.appsCreated.length">
          新建应用：{{ result.appsCreated.join('、') }}。暂无 Key，请在「应用」中为要接入的应用签发
        </li>
        <li v-if="result.appsGivenPersona.length">
          设为默认人格 {{ persona.slug }}：{{ result.appsGivenPersona.join('、') }}
        </li>
        <li v-if="result.appsOtherPersona.length">
          以下应用使用其他人格，core://soul 不会进入其启动加载：{{
            result.appsOtherPersona.join('、')
          }}
        </li>
        <li>
          新建记忆 {{ result.created.length }} 条；跳过已导入的
          {{ result.previouslyImported.length }} 条（含导入后在 Kioku 中删除或移动的）
        </li>
        <li>按 Lore 同步 {{ result.sync.updated.length }} 条</li>
        <li>向量在后台生成</li>
      </ul>
      <ul
        v-if="
          result.occupied.length ||
          result.movedInLore.length ||
          result.secretAlreadyImported.length ||
          result.failed.length ||
          result.sync.failed.length
        "
        class="space-y-1 text-sm break-all"
      >
        <li v-for="uri in result.occupied" :key="`occupied-${uri}`">
          跳过 <code>{{ uri }}</code
          >：URI 已被其他记忆占用
        </li>
        <li v-for="m in result.movedInLore" :key="`moved-${m.uri}-${m.current}`">
          跳过 <code>{{ m.uri }}</code
          >：Lore 中路径已变更，<template v-if="m.current">
            此前导入的记忆仍在 <code>{{ m.current }}</code
            >，如需跟随请手动移动</template
          ><template v-else>此前导入的记忆已在 Kioku 中删除</template>，未在新位置新建
        </li>
        <li
          v-for="s in result.secretAlreadyImported"
          :key="`secret-${s.uri}-${s.current}`"
          class="text-warning"
        >
          <code>{{ s.uri }}</code> 此前已导入，当前仍为明文，本次标记的机密未生效。请到记忆详情将
          <code>{{ s.current }}</code> 改为机密（同时清除历史中的明文）
        </li>
        <li v-for="f in result.failed" :key="`failed-${f.uri}`" class="text-error">
          失败 <code>{{ f.uri }}</code
          >：{{ f.reason }}
        </li>
        <li v-for="f in result.sync.failed" :key="`sync-${f.uri}`" class="text-error">
          同步失败 <code>{{ f.uri }}</code
          >：{{ f.reason }}
        </li>
      </ul>
      <div class="flex justify-end gap-2">
        <UButton
          v-if="importProblems(result)"
          :icon="icons.refresh"
          :loading="busy"
          :disabled="!ready"
          @click="replan"
        >
          重新生成计划
        </UButton>
        <UButton v-else color="neutral" variant="subtle" @click="result = null">再次导入</UButton>
      </div>
    </div>

    <form v-else class="space-y-4" @submit.prevent="onSubmit">
      <UTabs
        v-if="isAdmin"
        v-model="sourceKind"
        :items="sourceTabs(busy)"
        :content="false"
        size="sm"
        class="w-full"
      />
      <p v-else class="text-xs text-muted">
        仅可上传导出文件。
        <Hint>从地址拉取需要实例管理员权限：服务端要向该地址发送请求。</Hint>
      </p>
      <UFormField
        v-if="sourceKind === 'file'"
        label="Lore 的导出文件"
        :error="tooLarge ? `文件超过 ${formatBytes(LORE_FILE_MAX_BYTES)} 的上限` : undefined"
      >
        <template #help>
          在 Lore 设置页导出的 JSON，不超过 {{ formatBytes(LORE_FILE_MAX_BYTES) }}。
          <Hint>
            导出时不要包含召回事件：导入不使用，且文件会很大。文件先在浏览器中裁剪再上传，只上传所需的五张表（不超过
            {{ formatBytes(LORE_UPLOAD_MAX_BYTES) }}），Lore 的接口
            Key、事件、日记与旧版本正文不会离开浏览器。
          </Hint>
        </template>
        <!-- 不预览文件内容：预览要给它建 blob: 地址当图片加载，会被内容安全策略拦下 -->
        <UFileUpload
          v-model="file"
          label="选择或拖入导出文件"
          description=".json"
          accept=".json,application/json"
          layout="list"
          :file-image="false"
          class="w-full"
          :disabled="busy"
        />
      </UFormField>
      <template v-else>
        <UFormField label="Lore 地址">
          <template #help>
            填写服务根路径，仅支持 http 与 https。
            <Hint>不能包含账号密码、查询参数与片段；不跟随重定向。</Hint>
          </template>
          <UInput
            v-model="url"
            placeholder="https://lore.example.com"
            autocomplete="off"
            class="w-full"
            :disabled="busy"
          />
        </UFormField>
        <UFormField label="API Token" help="Lore 的 API_TOKEN，仅本次使用，不保存">
          <UInput
            v-model="token"
            type="password"
            autocomplete="off"
            class="w-full"
            :disabled="busy"
          />
        </UFormField>
        <UAlert
          v-if="tokenExposed"
          color="warning"
          variant="subtle"
          title="此地址为 http 且不在内网：Token 将明文传输，而此 Token 可清空整个 Lore。请尽量改用 https。"
        />
      </template>
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField
          label="人格标识"
          help="core://soul 导入为此人格的设定，默认与命令行相同"
          :error="personaProblem ?? undefined"
        >
          <UInput v-model="personaSlug" class="w-full font-mono" :disabled="busy" />
        </UFormField>
        <UFormField label="人格名称" help="写入新的 core://soul 且此人格不存在时，以此名称新建">
          <UInput v-model="personaName" class="w-full" maxlength="64" :disabled="busy" />
        </UFormField>
      </div>

      <UAlert v-if="notice" color="warning" variant="subtle" :title="notice" />

      <div v-if="plan && effects" class="space-y-4">
        <p class="text-sm">
          数据导出于 {{ formatTime(plan.exportedAt) }}：{{ plan.nodeCount }} 个节点，{{
            plan.previousVersions
          }}
          个旧版本不迁移。
        </p>
        <UAlert
          color="warning"
          variant="subtle"
          title="只导入本人导出的文件或本人的 Lore"
          :description="`内容按受信来源写入。本次写入的节点中有 ${effects.bootNodes} 个进入启动加载，每次会话开始时注入，客户端将其作为指令读取${effects.credentialRefs.length ? `；正文引用了凭据 ${effects.credentialRefs.join('、')}，Agent 可取用这些凭据` : ''}。来源不明的内容写入后，会成为当前账号 Agent 的指令。`"
        />
        <div v-if="stale === 'confirm'" class="space-y-2">
          <UAlert
            color="error"
            variant="subtle"
            :title="`此文件早于已写入的数据（数据时间 ${formatTime(plan.staleSince!)}）`"
            description="同步只比较内容是否相同，用旧文件写入会把内容改回旧版，还可能新建已在 Lore 中删除的节点。建议重新导出；之后上传新的导出文件可同步回来。"
          />
          <UCheckbox v-model="confirmStale" label="确认此文件较旧，仍要写入" />
        </div>
        <p v-else-if="stale === 'older'" class="text-sm text-muted">
          此文件早于已写入的数据（{{
            formatTime(plan.dataTime!)
          }}）。本次没有要写入的内容，下方列出的「Lore 中已不存在」可能只是因为文件较旧。
        </p>
        <UAlert
          v-if="!plan.secretAvailable"
          color="warning"
          variant="subtle"
          title="当前实例未配置主密钥，无法标记机密。请配置 KIOKU_MASTER_KEY 后再导入机密节点。"
        />

        <section class="space-y-1 text-sm">
          <h3 class="font-medium">人格与应用</h3>
          <p v-if="effects.writesPersona">
            core://soul 导入为 <code>{{ plan.persona.slug }}</code>
            <template v-if="plan.persona.exists">（已有）</template>
            <template v-else>（不存在，新建为「{{ plan.persona.name }}」）</template>
          </p>
          <p v-else-if="plan.persona.exists">
            本次没有要新写入的 core://soul，不新建人格。已有人格
            <code>{{ plan.persona.slug }}</code>
            照常使用：新建应用和暂无默认人格的应用将设为此人格。
          </p>
          <p v-else>
            本次没有要新写入的 core://soul，人格
            <code>{{ plan.persona.slug }}</code> 也不存在：不新建，新建应用的默认人格为空。
          </p>
          <p v-if="effects.writesPersona && otherPersonas.length" class="text-warning">
            此前的导入写入了人格 {{ otherPersonas.join('、') }}：本次将另写一份
            core://soul，此前那份不再同步。如需继续同步，请改回原人格标识。
          </p>
          <p v-for="mapping in effects.apps" :key="mapping.runtime" class="break-all">
            core://agent/{{ mapping.runtime }} →
            <template v-for="(app, i) in mapping.apps" :key="app.slug"
              ><template v-if="i">、</template><code>{{ app.slug }}</code
              >{{ app.create ? `（新建，类型 ${app.runtimeFamily}）` : '（已有）' }}</template
            >
          </p>
          <p v-if="effects.appsGivenPersona.length">
            以下应用暂无默认人格，将设为 {{ plan.persona.slug }}：{{
              effects.appsGivenPersona.join('、')
            }}
          </p>
          <p v-if="effects.appsOtherPersona.length" class="text-warning">
            以下应用使用其他人格，core://soul 不会进入其启动加载：{{
              effects.appsOtherPersona.join('、')
            }}
          </p>
        </section>

        <section class="space-y-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-sm font-medium">节点</h3>
            <USelect
              v-model="filter"
              :items="filterItems"
              size="sm"
              class="w-44"
              aria-label="筛选节点"
            />
          </div>
          <p v-if="!visibleNodes.length" class="text-sm text-muted">没有匹配的节点</p>
          <ul v-else class="max-h-[32rem] divide-y divide-default overflow-y-auto">
            <li
              v-for="node in visibleNodes"
              :key="node.uuid"
              class="space-y-1 py-2 pr-1"
              :class="{ 'opacity-60': excludedIds.has(node.uuid) }"
            >
              <div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <div class="min-w-0 flex-1 basis-48">
                  <p class="font-mono text-xs break-all">{{ node.uri }}</p>
                  <p v-if="node.aliases.length" class="text-xs break-all text-muted">
                    别名不导入：{{ node.aliases.join('、') }}
                  </p>
                </div>
                <div class="flex shrink-0 flex-wrap gap-3">
                  <UTooltip :text="secretHint(node)" :disabled="!secretHint(node)">
                    <UCheckbox
                      size="xs"
                      label="标记机密"
                      :model-value="secretIds.has(node.uuid) && secretSelectable(node)"
                      :disabled="Boolean(secretHint(node))"
                      @update:model-value="toggleSecret(node.uuid, $event)"
                    />
                  </UTooltip>
                  <UCheckbox
                    size="xs"
                    :label="excludeLabel(node)"
                    :model-value="excludedIds.has(node.uuid)"
                    @update:model-value="toggleExcluded(node.uuid, $event)"
                  />
                </div>
              </div>
              <div
                v-for="target in node.targets"
                :key="target.uri"
                class="flex flex-wrap items-center gap-1 text-xs"
              >
                <UIcon :name="icons.inherits" class="size-3 shrink-0 text-muted" />
                <span class="font-mono break-all">{{ target.uri }}</span>
                <UBadge size="sm" variant="subtle" :color="STATE_COLORS[target.state]">
                  {{ targetStateLabels[target.state] }}
                </UBadge>
                <UBadge size="sm" variant="subtle" color="neutral">
                  {{ layerLabels[target.layer] }}
                </UBadge>
                <UBadge
                  size="sm"
                  variant="subtle"
                  :color="sensitivityColors[sensitivityOf(node, target)]"
                >
                  {{ sensitivityLabels[sensitivityOf(node, target)] }}
                </UBadge>
                <UBadge size="sm" variant="subtle" color="neutral">P{{ target.priority }}</UBadge>
                <UBadge v-if="effects.boot.has(target)" size="sm" variant="subtle" color="warning">
                  进入启动加载
                </UBadge>
                <span v-if="currentNote(target)" class="break-all text-muted">
                  {{ currentNote(target) }}
                </span>
              </div>
              <p v-if="node.credentialRefs.length" class="text-xs text-muted">
                引用凭据：{{ node.credentialRefs.join('、') }}
              </p>
              <p v-if="credentialNote(node)" class="text-xs text-warning">
                {{ credentialNote(node) }}
              </p>
              <p v-if="node.credentialHints.extras" class="text-xs text-warning">
                触发场景或关键词疑似包含明文凭据：机密只加密正文，这两项仍为明文
              </p>
              <p v-if="disclosureCut.has(node.uri)" class="text-xs text-muted">
                触发场景过长，写入时截断
              </p>
            </li>
          </ul>
        </section>

        <details v-if="plan.skipped.length" class="text-sm">
          <summary class="cursor-pointer font-medium">不导入（{{ plan.skipped.length }}）</summary>
          <ul class="mt-1 space-y-1 text-xs break-all text-muted">
            <li v-for="(s, i) in plan.skipped" :key="i">
              <code>{{ s.source }}</code
              >：{{ s.reason }}
            </li>
          </ul>
        </details>
        <details v-if="plan.droppedKeywords.length" class="text-sm">
          <summary class="cursor-pointer font-medium">
            丢弃的关键词（{{ plan.droppedKeywords.length }}）
          </summary>
          <ul class="mt-1 space-y-1 text-xs break-all text-muted">
            <li v-for="(k, i) in plan.droppedKeywords" :key="i">
              <code>{{ k.source }}</code
              >「{{ k.keyword }}」：{{ k.reason }}
            </li>
          </ul>
        </details>

        <section v-if="sync" class="space-y-2 text-sm">
          <h3 class="font-medium">同步已导入的节点</h3>
          <p v-if="sync.current || sync.groups.length">
            已是最新 {{ sync.current }} 条。如不需要同步某节点，请在上方勾选「本次不同步」。
          </p>
          <p v-else class="text-muted">暂无已导入的节点</p>
          <details v-for="group in sync.groups" :key="group.state" :open="group.state === 'update'">
            <summary class="cursor-pointer">{{ group.title }}（{{ group.lines.length }}）</summary>
            <ul class="mt-1 space-y-1 text-xs break-all text-muted">
              <li v-for="(line, i) in group.lines" :key="i">{{ line }}</li>
            </ul>
          </details>
        </section>

        <p class="text-sm">
          本次将新建 {{ effects.create }} 条、按 Lore 更新
          {{ effects.update }} 条。写入中途出错时，已写入的内容保留，重新生成计划后可继续。
        </p>
      </div>

      <UAlert v-if="error" color="error" variant="subtle" :title="error" />

      <div class="flex flex-wrap justify-end gap-2">
        <template v-if="plan">
          <UButton
            color="neutral"
            variant="subtle"
            :icon="icons.refresh"
            :disabled="!ready"
            @click="replan"
          >
            重新生成计划
          </UButton>
          <UButton
            :icon="icons.importSpace"
            :loading="busy"
            :disabled="!ready || confirmMissing"
            @click="applyPlan"
          >
            确认导入
          </UButton>
        </template>
        <UButton v-else type="submit" :icon="icons.search" :loading="busy" :disabled="!ready">
          查看计划
        </UButton>
      </div>
    </form>
  </UCard>
</template>
