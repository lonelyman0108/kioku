<script setup lang="ts">
import {
  LORE_DEFAULT_PERSONA,
  LORE_FILE_MAX_BYTES,
  LORE_UPLOAD_MAX_BYTES,
  PLAINTEXT_KIND_NAMES,
  Slug,
  type LoreBackupUpload,
  type LoreImportPlan,
  type LoreImportResult,
  type LoreImportSource,
  type LorePlaintextSpot,
  type LorePlanNode,
  type LorePlanTarget,
  type LoreTargetState,
  type StrataBand,
} from '@kioku/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, ref, shallowRef, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { formatBytes } from '../backup'
import { icons } from '../icons'
import {
  applyFailureOf,
  excludeLabel,
  importProblems,
  LoreFileError,
  matchesFilter,
  NODE_FILTERS,
  planBlocker,
  planUnmatchedNote,
  plaintextAllConverted,
  plaintextKey,
  keptTargets,
  pruneUnconverted,
  spotConverts,
  spotFingerprint,
  readLoreBackup,
  replanAfterFailure,
  secretSelectable,
  selectionEffects,
  selectionOf,
  sourceTabs,
  spotState,
  staleNotice,
  syncGroups,
  targetStateLabels,
  targetTitle,
  tokenInClear,
  type ApplyFailure,
  type NodeFilter,
  type Unconverted,
} from '../loreBackup'
import { UNMATCHED_HINT } from '../plaintext'
import { formatTime } from '../time'
import Hint from './Hint.vue'
import RuntimeLabel from './RuntimeLabel.vue'
import TransferEntryRow from './TransferEntryRow.vue'
import NoteLine from './strata/NoteLine.vue'
import SectionHeading from './strata/SectionHeading.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import UriPath from './strata/UriPath.vue'

const props = defineProps<{ circleId: string; editable: boolean; isAdmin: boolean }>()

const queryClient = useQueryClient()

type SourceKind = LoreImportSource['kind']
type PlanTab = 'nodes' | 'mapping' | 'sync'
const open = ref(false)
const planTab = ref<PlanTab>('nodes')
const PLAN_TABS: readonly PlanTab[] = ['nodes', 'mapping', 'sync']
const tabRefs = ref<Partial<Record<PlanTab, HTMLButtonElement | null>>>({})
function onPlanTabKeydown(event: KeyboardEvent, current: PlanTab) {
  const index = PLAN_TABS.indexOf(current)
  let nextIndex = -1
  if (event.key === 'ArrowRight') nextIndex = (index + 1) % PLAN_TABS.length
  else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + PLAN_TABS.length) % PLAN_TABS.length
  else if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = PLAN_TABS.length - 1
  if (nextIndex < 0) return
  event.preventDefault()
  const next = PLAN_TABS[nextIndex]!
  planTab.value = next
  tabRefs.value[next]?.focus()
}
const sourceKind = ref<SourceKind>('file')
const file = ref<File | null>(null)
// 裁剪过的导出：执行时要重新发一次。只在内存里，换了文件、换了记忆圈或导入成功就丢掉
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
// 和已有凭据同值的疑似明文默认换成占位符，这里记取消勾选的，连同那一处的特征（见 Unconverted）
const unconvertedIds = ref<Unconverted>(new Map())
const confirmStale = ref(false)
const filter = ref<NodeFilter>('all')

const clearSelection = () => {
  secretIds.value = new Set()
  excludedIds.value = new Set()
  unconvertedIds.value = new Map()
}
// 来源或人格变了，看过的计划就不算数了；换了来源连勾选一起清
watch([sourceKind, file, url, token, personaSlug, personaName], () => {
  plan.value = null
  planTab.value = 'nodes'
  error.value = null
  notice.value = null
  confirmStale.value = false
})
watch([sourceKind, file, url], clearSelection)
watch(file, () => (backup.value = null))
watch(open, (opened) => {
  if (opened && result.value && !importProblems(result.value)) {
    result.value = null
  }
})
watch(
  () => props.circleId,
  () => {
    open.value = false
    planTab.value = 'nodes'
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
  const forCircle = props.circleId
  try {
    const next = await api.lorePlan(forCircle, {
      source: await currentSource(),
      persona: persona.value,
    })
    if (forCircle !== props.circleId) return false
    plan.value = next
    // 重出的计划里序号可能指到另一处上：特征对不上的选择丢掉
    unconvertedIds.value = pruneUnconverted(next, unconvertedIds.value)
    confirmStale.value = false
    return true
  } catch (err) {
    if (forCircle !== props.circleId) return false
    plan.value = null
    error.value = messageOf(err, '生成计划失败')
    return false
  } finally {
    busy.value = false
  }
}

async function replan() {
  notice.value = null
  const ok = await showPlan()
  if (ok) result.value = null
}

function resetSource() {
  if (busy.value) return
  plan.value = null
  result.value = null
  planTab.value = 'nodes'
  filter.value = 'all'
  confirmStale.value = false
  error.value = null
  notice.value = null
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
  const forCircle = props.circleId
  let failure: ApplyFailure | null = null
  try {
    const done = await api.loreApply(forCircle, {
      source: await currentSource(),
      persona: persona.value,
      fingerprint: seen.fingerprint,
      ...selectionOf(seen, secretIds.value, excludedIds.value, unconvertedIds.value),
      confirmStale: confirmStale.value,
    })
    if (forCircle === props.circleId) {
      result.value = done
      plan.value = null
      // 全部做成就不再留着文件、Token 与勾选。有没做成的要重看计划，先留着：
      // 勾选丢了再确认一次，写失败的 secret 节点就成了明文
      if (!importProblems(done)) {
        file.value = null
        token.value = ''
        planTab.value = 'nodes'
        filter.value = 'all'
        confirmStale.value = false
        error.value = null
        notice.value = null
        clearSelection()
      }
      void queryClient.invalidateQueries()
    }
  } catch (err) {
    if (forCircle === props.circleId) failure = applyFailureOf(err)
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
    if (forCircle === props.circleId) notice.value = text
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
// 勾上是换成占位符，记的是取消勾选的
function toggleConverted(
  node: LorePlanNode,
  spot: LorePlaintextSpot,
  on: boolean | 'indeterminate',
) {
  const next = new Map(unconvertedIds.value)
  if (on === true) next.delete(plaintextKey(node, spot))
  else next.set(plaintextKey(node, spot), spotFingerprint(spot))
  unconvertedIds.value = next
}
const plaintextState = (node: LorePlanNode, spot: LorePlaintextSpot) =>
  plan.value ? spotState(plan.value, node, spot, secretIds.value, excludedIds.value) : 'unwritten'
const converting = (node: LorePlanNode, spot: LorePlaintextSpot) =>
  !!plan.value &&
  spotConverts(plan.value, node, spot, secretIds.value, excludedIds.value, unconvertedIds.value)
// 这一处换成占位符时，同一节点里照原样写明文的目标有几个
const keptCount = (node: LorePlanNode) =>
  plan.value ? keptTargets(plan.value, node, secretIds.value).length : 0
// 这次同步的已导入记忆还在 Kioku 里：才能指向记忆详情
const syncedStillThere = (node: LorePlanNode) =>
  !!plan.value &&
  keptTargets(plan.value, node, secretIds.value).some((t) =>
    t.current.some((c) => c.shortId !== null),
  )

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
  () =>
    plan.value &&
    selectionEffects(plan.value, secretIds.value, excludedIds.value, unconvertedIds.value),
)
const stale = computed(() => plan.value && effects.value && staleNotice(plan.value, effects.value))
const confirmMissing = computed(() => stale.value === 'confirm' && !confirmStale.value)
// 之前的导入写到了别的人格：换了人格时 core://soul 另写一份，之前那份不再同步
const otherPersonas = computed(() => {
  const imported = plan.value?.persona.imported ?? []
  return imported.includes(plan.value?.persona.slug ?? '') ? [] : imported
})

// 目标的状态靠文字说，路径变过的才带语气
const STATE_CLASSES: Record<LoreTargetState, string> = {
  new: '',
  imported: 'text-muted',
  moved: 'text-warning',
}
const isSecret = (node: LorePlanNode, target: LorePlanTarget) =>
  target.state === 'new' && secretIds.value.has(node.uuid) && !excludedIds.value.has(node.uuid)
// 显示的敏感级：这次要标的，或者之前导入的那条现在已经是 secret
const secretNow = (node: LorePlanNode, target: LorePlanTarget) =>
  isSecret(node, target) || target.current.some((c) => c.secret)
const sensitivityOf = (node: LorePlanNode, target: LorePlanTarget) =>
  secretNow(node, target) ? 'secret' : target.sensitivity
const isSoulUri = (uri: string) => uri === 'core://soul' || uri.startsWith('core://soul/')
const targetBand = (node: LorePlanNode, target: LorePlanTarget): StrataBand => {
  if (isSoulUri(node.uri) || isSoulUri(target.legacyUri)) return 'persona'
  return target.targetCircleKind === 'personal' ? 'personal' : 'primary'
}
// 之前导入的那条现在的样子：删除了或给出短 ID
function currentNote(target: LorePlanTarget): string | null {
  const notes = target.current.flatMap((c) =>
    c.shortId === null ? ['已在 Kioku 中删除'] : [`当前词条 ${c.shortId}`],
  )
  return notes.length ? notes.join('；') : null
}
// 路径或正文像有凭据的提醒：已经全是 secret 的不用再说；导入过的这里标不了，要到记忆详情里改
// 正文里的疑似明文这次都换成占位符时，只剩路径要提醒
function credentialNote(node: LorePlanNode): string | null {
  const { path } = node.credentialHints
  const content =
    node.credentialHints.content &&
    !(
      plan.value &&
      plaintextAllConverted(
        plan.value,
        node,
        secretIds.value,
        excludedIds.value,
        unconvertedIds.value,
      )
    )
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
      plan.value?.warnings
        .filter((w) => w.kind === 'disclosureTruncated')
        .map((w) => w.legacyUri) ?? [],
    ),
)
const syncIssuesCount = computed(() => {
  const s = sync.value
  const p = plan.value
  if (!s || !p) return 0
  return (
    s.groups.reduce((acc, g) => acc + g.lines.length, 0) +
    p.skipped.length +
    p.droppedKeywords.length
  )
})
const currentStep = computed(() => (result.value ? 3 : plan.value ? 2 : 1))
const entryStatus = computed(() => {
  if (plan.value && effects.value) {
    return `已解析 ${plan.value.nodeCount} 个节点（将新建 ${effects.value.create} 条、同步 ${effects.value.update} 条），待确认`
  }
  if (result.value) {
    return importProblems(result.value)
      ? '上次导入有部分未完成条目，可继续处理'
      : `上次已导入 ${result.value.created.length} 条记忆`
  }
  return null
})
</script>

<template>
  <SettingsBlock title="Lore" :level="4">
    <template #note>
      导入 Lore 的节点，确认计划后才写入。查看计划与确认在独立弹窗中完成。
      <Hint>
        映射规则与命令行相同：core://agent 进入通用，core://soul
        进入人格，core://agent/&lt;运行时&gt; 进入当前账号的对应接入实例，preferences://
        进入个人圈（内部），其余进入个人圈（私密）。可重复执行：已导入的不重复写入，Lore
        中修改过的按 Lore 同步；在 Kioku 中修改、移动或删除过的不变。
      </Hint>
    </template>

    <p v-if="!editable" class="text-muted">仅记忆圈所有者可导入</p>

    <TransferEntryRow
      v-else
      :icon="icons.lore"
      title="Lore 知识库"
      description="支持上传导出的 JSON 文件，或从 Lore 服务地址拉取，核对节点、映射与凭据后写入当前记忆圈。"
      :status="entryStatus"
      :status-tone="plan ? 'warning' : 'neutral'"
    >
      <template #action>
        <UButton color="neutral" variant="outline" :icon="icons.lore" @click="open = true">
          {{ plan ? '继续查看计划' : '从 Lore 导入' }}
        </UButton>
      </template>
    </TransferEntryRow>

    <UModal
      :open="open"
      title="从 Lore 导入"
      :dismissible="!busy"
      :close="!busy"
      :ui="{ content: 'sm:max-w-4xl' }"
      @update:open="(v: boolean) => !busy && (open = v)"
    >
      <template #body>
        <ol class="steps mb-4" aria-label="导入步骤">
          <li
            :data-state="currentStep === 1 ? 'active' : currentStep > 1 ? 'done' : 'idle'"
            :aria-current="currentStep === 1 ? 'step' : undefined"
          >
            <span class="step-num">1</span>
            <span>选择来源</span>
          </li>
          <li
            :data-state="currentStep === 2 ? 'active' : currentStep > 2 ? 'done' : 'idle'"
            :aria-current="currentStep === 2 ? 'step' : undefined"
          >
            <span class="step-num">2</span>
            <span>查看与确认计划</span>
          </li>
          <li
            :data-state="currentStep === 3 ? 'active' : 'idle'"
            :aria-current="currentStep === 3 ? 'step' : undefined"
          >
            <span class="step-num">3</span>
            <span>导入结果</span>
          </li>
        </ol>

        <!-- 结果：有没做成的就不显示成成功 -->
        <div v-if="result" class="space-y-4">
          <NoteLine v-if="importProblems(result)" tone="warning">
            部分内容未完成：请查看下方说明，处理后重新生成计划以继续
          </NoteLine>
          <NoteLine v-else><span class="text-success">导入完成</span></NoteLine>

          <dl class="kpi-strip">
            <div class="kpi-cell">
              <dt>新建记忆</dt>
              <dd>{{ result.created.length }}</dd>
            </div>
            <div class="kpi-cell">
              <dt>按 Lore 同步</dt>
              <dd>{{ result.sync.updated.length }}</dd>
            </div>
            <div class="kpi-cell">
              <dt>转为凭据占位符</dt>
              <dd>{{ result.plaintextConverted.length }}</dd>
            </div>
            <div class="kpi-cell">
              <dt>跳过与未完成</dt>
              <dd>
                {{
                  result.movedInLore.length +
                  result.secretAlreadyImported.length +
                  result.failed.length +
                  result.sync.failed.length +
                  result.plaintextKept.length
                }}
              </dd>
            </div>
          </dl>

          <ul class="space-y-1">
            <li v-if="result.personaUsed">
              人格 {{ persona.slug }}：{{ result.personaCreated ? '新建' : '已有' }}
            </li>
            <li v-else>
              人格 {{ persona.slug }} 不存在，本次也没有要写入的
              core://soul：未新建人格，新建接入实例的默认人格为空
            </li>
            <li v-if="result.clientsCreated.length">
              新建接入实例：{{
                result.clientsCreated.join('、')
              }}。暂无访问密钥，请在「接入实例」中为要接入的实例签发
            </li>
            <li v-if="result.clientsGivenPersona.length">
              设为默认人格 {{ persona.slug }}：{{ result.clientsGivenPersona.join('、') }}
            </li>
            <li v-if="result.clientsOtherPersona.length">
              以下接入实例使用其他人格，core://soul 不会进入其启动加载：{{
                result.clientsOtherPersona.join('、')
              }}
            </li>
            <li>
              跳过已导入 {{ result.previouslyImported.length }} 条（含导入后在 Kioku
              中删除或移动的）
            </li>
            <li class="text-muted">向量在后台生成</li>
          </ul>

          <ul
            v-if="
              result.movedInLore.length ||
              result.secretAlreadyImported.length ||
              result.failed.length ||
              result.sync.failed.length ||
              result.plaintextKept.length
            "
            class="space-y-1 break-all border-t border-[var(--ui-border)] pt-3"
          >
            <li v-for="m in result.movedInLore" :key="`moved-${m.legacyUri}-${m.shortId}`">
              跳过 <code class="uri">{{ m.legacyUri }}</code
              >：Lore 中路径已变更，<template v-if="m.shortId">
                此前导入的记忆仍保留在
                <code class="uri">{{ m.shortId }}</code> ，如需跟随请手动调整</template
              ><template v-else>此前导入的记忆已在 Kioku 中删除</template>，未在新位置新建
            </li>
            <li
              v-for="s in result.secretAlreadyImported"
              :key="`secret-${s.legacyUri}-${s.shortId}`"
              class="text-warning"
            >
              <code class="uri">{{ s.legacyUri }}</code>
              此前已导入，当前仍为明文，本次标记的机密未生效。请到记忆详情将
              <code class="uri">{{ s.shortId }}</code> 改为机密（同时清除历史中的明文）
            </li>
            <li v-for="f in result.failed" :key="`failed-${f.source}`" class="text-error">
              失败 <code class="uri">{{ f.source }}</code
              >：{{ f.reason }}
            </li>
            <li v-for="f in result.sync.failed" :key="`sync-${f.source}`" class="text-error">
              同步失败 <code class="uri">{{ f.source }}</code
              >：{{ f.reason }}
            </li>
            <li v-for="f in result.plaintextKept" :key="`kept-${f.source}`" class="text-warning">
              保留明文 <code class="uri">{{ f.source }}</code
              >：<span>{{ f.reason }}</span>
              <Hint>勾选了写成占位符，但照原样写入。可在待处理中转存为凭据。</Hint>
            </li>
          </ul>

          <NoteLine v-if="error" tone="error">{{ error }}</NoteLine>

          <div class="modal-foot">
            <div />
            <div class="flex flex-wrap gap-2">
              <UButton
                v-if="importProblems(result)"
                color="primary"
                variant="outline"
                :loading="busy"
                :disabled="!ready"
                @click="replan"
              >
                重新生成计划
              </UButton>
              <UButton v-else color="neutral" variant="outline" @click="resetSource">
                再次导入
              </UButton>
              <UButton color="neutral" variant="ghost" @click="open = false">完成</UButton>
            </div>
          </div>
        </div>

        <form v-else class="space-y-4" @submit.prevent="onSubmit">
          <div v-if="!plan" class="source space-y-4">
            <UTabs
              v-if="isAdmin"
              v-model="sourceKind"
              :items="sourceTabs(busy)"
              :content="false"
              size="sm"
              class="w-full"
            />
            <p v-else class="text-muted">
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
                  {{ formatBytes(LORE_UPLOAD_MAX_BYTES) }}），Lore 保存的 API
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
              <NoteLine v-if="tokenExposed" tone="warning">
                此地址为 http 且不在内网：API Token 将明文传输，而此 API Token 可清空整个
                Lore。请尽量改用 https。
              </NoteLine>
            </template>
            <div class="grid gap-4 sm:grid-cols-2">
              <UFormField
                label="人格标识"
                help="core://soul 导入为此人格的设定，默认与命令行相同"
                :error="personaProblem ?? undefined"
              >
                <UInput v-model="personaSlug" class="w-full font-mono" :disabled="busy" />
              </UFormField>
              <UFormField
                label="人格名称"
                help="写入新的 core://soul 且此人格不存在时，以此名称新建"
              >
                <UInput v-model="personaName" class="w-full" maxlength="64" :disabled="busy" />
              </UFormField>
            </div>
          </div>

          <NoteLine v-if="notice" tone="warning">{{ notice }}</NoteLine>

          <div v-if="plan && effects" class="plan space-y-4">
            <div class="plan-meta-bar">
              <p class="text-muted">
                导出于 {{ formatTime(plan.exportedAt) }} · 共 {{ plan.nodeCount }} 个节点（{{
                  plan.previousVersions
                }}
                个旧版本不迁移）
              </p>
              <UButton
                color="neutral"
                variant="outline"
                size="xs"
                :disabled="busy"
                @click="resetSource"
              >
                更换来源
              </UButton>
            </div>

            <dl class="kpi-strip">
              <div class="kpi-cell">
                <dt>将新建</dt>
                <dd>{{ effects.create }}</dd>
              </div>
              <div class="kpi-cell">
                <dt>按 Lore 更新</dt>
                <dd>{{ effects.update }}</dd>
              </div>
              <div class="kpi-cell">
                <dt>进入启动加载</dt>
                <dd>{{ effects.bootNodes }}</dd>
              </div>
              <div class="kpi-cell">
                <dt>涉及接入实例</dt>
                <dd>{{ effects.clients.reduce((n, m) => n + m.clients.length, 0) }}</dd>
              </div>
            </dl>

            <NoteLine tone="warning">
              只导入本人导出的文件或本人的 Lore
              <template #detail>
                内容按受信来源写入。本次写入的节点中有
                {{ effects.bootNodes }}
                个进入启动加载，每次会话开始时注入，客户端将其作为指令读取<template
                  v-if="effects.credentialRefs.length"
                  >；正文引用了凭据 {{ effects.credentialRefs.join('、') }}，Agent
                  可取用这些凭据</template
                >。来源不明的内容写入后，会成为当前账号 Agent 的指令。
              </template>
            </NoteLine>
            <div v-if="stale === 'confirm'" class="space-y-2">
              <NoteLine tone="error">
                此文件早于已写入的数据（数据时间 {{ formatTime(plan.staleSince!) }}）
                <template #detail>
                  同步只比较内容是否相同，用旧文件写入会把内容改回旧版，还可能新建已在 Lore
                  中删除的节点。建议重新导出；之后上传新的导出文件可同步回来。
                </template>
              </NoteLine>
              <UCheckbox v-model="confirmStale" label="确认此文件较旧，仍要写入" />
            </div>
            <p v-else-if="stale === 'older'" class="text-muted">
              此文件早于已写入的数据（{{
                formatTime(plan.dataTime!)
              }}）。本次没有要写入的内容，「同步与跳过」分页里列出的「Lore
              中已不存在」可能只是因为文件较旧。
            </p>
            <NoteLine v-if="!plan.secretAvailable" tone="warning">
              当前实例未配置主密钥，无法标记机密。请配置 KIOKU_MASTER_KEY 后再导入机密节点。
            </NoteLine>
            <p v-if="planUnmatchedNote(plan)" class="text-muted">
              疑似明文：{{ planUnmatchedNote(plan) }}<Hint>{{ UNMATCHED_HINT }}</Hint>
            </p>

            <div class="plan-tabs" role="tablist" aria-label="导入计划分页">
              <button
                id="lore-tab-nodes"
                :ref="(el) => (tabRefs.nodes = el as HTMLButtonElement | null)"
                type="button"
                role="tab"
                aria-controls="lore-panel-nodes"
                :aria-selected="planTab === 'nodes'"
                :tabindex="planTab === 'nodes' ? 0 : -1"
                :data-active="planTab === 'nodes'"
                class="plan-tab"
                @click="planTab = 'nodes'"
                @keydown="onPlanTabKeydown($event, 'nodes')"
              >
                节点清单（{{ visibleNodes.length }}）
              </button>
              <button
                id="lore-tab-mapping"
                :ref="(el) => (tabRefs.mapping = el as HTMLButtonElement | null)"
                type="button"
                role="tab"
                aria-controls="lore-panel-mapping"
                :aria-selected="planTab === 'mapping'"
                :tabindex="planTab === 'mapping' ? 0 : -1"
                :data-active="planTab === 'mapping'"
                class="plan-tab"
                @click="planTab = 'mapping'"
                @keydown="onPlanTabKeydown($event, 'mapping')"
              >
                人格与接入实例（{{ effects.clients.length + 1 }}）
              </button>
              <button
                id="lore-tab-sync"
                :ref="(el) => (tabRefs.sync = el as HTMLButtonElement | null)"
                type="button"
                role="tab"
                aria-controls="lore-panel-sync"
                :aria-selected="planTab === 'sync'"
                :tabindex="planTab === 'sync' ? 0 : -1"
                :data-active="planTab === 'sync'"
                class="plan-tab"
                @click="planTab = 'sync'"
                @keydown="onPlanTabKeydown($event, 'sync')"
              >
                同步与跳过（{{ syncIssuesCount }}）
              </button>
            </div>

            <section
              v-show="planTab === 'nodes'"
              id="lore-panel-nodes"
              role="tabpanel"
              aria-labelledby="lore-tab-nodes"
              class="space-y-3"
            >
              <div class="nodes-toolbar">
                <USelect
                  v-model="filter"
                  :items="filterItems"
                  size="sm"
                  class="w-48"
                  aria-label="筛选节点"
                />
                <span class="text-xs text-muted">勾选可标为机密或不导入</span>
              </div>
              <p v-if="!visibleNodes.length" class="plan-body text-muted">没有匹配的节点</p>
              <ul v-else class="nodes">
                <li
                  v-for="node in visibleNodes"
                  :key="node.uuid"
                  class="node"
                  :class="{ 'opacity-60': excludedIds.has(node.uuid) }"
                >
                  <div class="node-head">
                    <div class="min-w-0 flex-1 basis-48">
                      <p class="uri"><UriPath :uri="node.uri" wrap /></p>
                      <p v-if="node.aliases.length" class="break-all text-muted">
                        别名不导入：{{ node.aliases.join('、') }}
                      </p>
                    </div>
                    <div class="flex shrink-0 flex-wrap gap-3">
                      <UTooltip :text="secretHint(node)" :disabled="!secretHint(node)">
                        <UCheckbox
                          size="sm"
                          label="标记机密"
                          :model-value="secretIds.has(node.uuid) && secretSelectable(node)"
                          :disabled="Boolean(secretHint(node))"
                          @update:model-value="toggleSecret(node.uuid, $event)"
                        />
                      </UTooltip>
                      <UCheckbox
                        size="sm"
                        :label="excludeLabel(node)"
                        :model-value="excludedIds.has(node.uuid)"
                        @update:model-value="toggleExcluded(node.uuid, $event)"
                      />
                    </div>
                  </div>
                  <div
                    v-for="target in node.targets"
                    :key="`${target.legacyUri}-${target.targetCircleId}`"
                    class="node-target"
                  >
                    <UIcon :name="icons.inherits" class="target-arrow" aria-hidden="true" />
                    <!-- prettier-ignore -->
                    <span class="target-title">{{ targetTitle(target, secretNow(node, target)) }}</span>
                    <UriPath :uri="target.legacyUri" wrap />
                    <span :class="STATE_CLASSES[target.state]">
                      {{ targetStateLabels[target.state] }}
                    </span>
                    <StrataSwatch
                      :band="targetBand(node, target)"
                      :sensitivity="sensitivityOf(node, target)"
                      label="both"
                    />
                    <span class="font-mono text-[13px]">P{{ target.priority }}</span>
                    <span v-if="effects.boot.has(target)" class="text-warning">进入启动加载</span>
                    <span v-if="currentNote(target)" class="break-all text-muted">
                      {{ currentNote(target) }}
                    </span>
                  </div>
                  <p v-if="node.credentialRefs.length" class="text-muted">
                    引用凭据：{{ node.credentialRefs.join('、') }}
                  </p>
                  <!-- 正文里的疑似明文：和已有凭据同值的可以换成占位符，默认勾上 -->
                  <ul v-if="node.plaintext.length" class="spots">
                    <li v-for="spot in node.plaintext" :key="spot.index" class="spot">
                      <span class="text-muted">
                        第 {{ spot.index + 1 }} 处 · 第 {{ spot.line }} 行 ·
                        {{ PLAINTEXT_KIND_NAMES[spot.kind] }}
                      </span>
                      <template v-if="spot.credential">
                        <span>
                          与凭据「{{ spot.credential.name }}」<code class="uri"
                            >{{ spot.credential.identifier }}#{{ spot.credential.field }}</code
                          >同值
                        </span>
                        <UCheckbox
                          size="sm"
                          label="写成占位符"
                          :model-value="converting(node, spot)"
                          :disabled="plaintextState(node, spot) !== 'convertible'"
                          @update:model-value="toggleConverted(node, spot, $event)"
                        />
                        <span v-if="plaintextState(node, spot) === 'blocked'" class="text-warning">
                          无法写成占位符<Hint>
                            凭据占位符只能放在个人圈、正式词条且敏感级不低于私密的记忆中。
                          </Hint>
                        </span>
                        <span
                          v-else-if="converting(node, spot) && keptCount(node)"
                          class="text-warning"
                        >
                          另有 {{ keptCount(node) }} 条记忆保留明文<Hint>
                            这些记忆放不进凭据占位符，或是已导入、这次同步的记忆，正文照原样写入。
                          </Hint>
                        </span>
                        <span
                          v-else-if="plaintextState(node, spot) === 'synced'"
                          class="text-muted"
                        >
                          已导入，按原样同步<Hint v-if="syncedStillThere(node)">
                            同步后可在记忆详情或待处理中转存为凭据。
                          </Hint>
                        </span>
                        <span
                          v-else-if="plaintextState(node, spot) === 'unwritten'"
                          class="text-muted"
                        >
                          本次不写入
                        </span>
                      </template>
                      <span v-else class="text-muted">
                        无同值的凭据<Hint>
                          导入只匹配已有的凭据。密码库条目需先在凭据页起标识，再重新生成计划；也可以导入后在待处理中转存为凭据。
                        </Hint>
                      </span>
                    </li>
                  </ul>
                  <p v-if="credentialNote(node)" class="text-warning">
                    {{ credentialNote(node) }}
                  </p>
                  <p v-if="node.credentialHints.extras" class="text-warning">
                    触发场景或关键词疑似包含明文凭据：机密只加密正文，这两项仍为明文
                  </p>
                  <p
                    v-if="
                      disclosureCut.has(node.uri) ||
                      node.targets.some((t) => disclosureCut.has(t.legacyUri))
                    "
                    class="text-muted"
                  >
                    触发场景过长，写入时截断
                  </p>
                </li>
              </ul>
            </section>

            <section
              v-show="planTab === 'mapping'"
              id="lore-panel-mapping"
              role="tabpanel"
              aria-labelledby="lore-tab-mapping"
              class="space-y-4"
            >
              <SectionHeading title="人格与默认归属" :level="4" />
              <div class="plan-body space-y-2">
                <p v-if="effects.writesPersona">
                  core://soul 导入为 <code class="uri">{{ plan.persona.slug }}</code>
                  <template v-if="plan.persona.exists">（已有）</template>
                  <template v-else>（不存在，新建为「{{ plan.persona.name }}」）</template>
                </p>
                <p v-else-if="plan.persona.exists">
                  本次没有要新写入的 core://soul，不新建人格。已有人格
                  <code class="uri">{{ plan.persona.slug }}</code>
                  照常使用：新建接入实例和暂无默认人格的接入实例将设为此人格。
                </p>
                <p v-else>
                  本次没有要新写入的 core://soul，人格
                  <code class="uri">{{ plan.persona.slug }}</code>
                  也不存在：不新建，新建接入实例的默认人格为空。
                </p>
                <p v-if="effects.writesPersona && otherPersonas.length" class="text-warning">
                  此前的导入写入了人格 {{ otherPersonas.join('、') }}：本次将另写一份
                  core://soul，此前那份不再同步。如需继续同步，请改回原人格标识。
                </p>
              </div>

              <SectionHeading title="接入实例映射" :level="4" />
              <div v-if="effects.clients.length" class="plan-body space-y-2">
                <p v-for="mapping in effects.clients" :key="mapping.runtime" class="break-all">
                  core://agent/{{ mapping.runtime }} →
                  <template v-for="(client, i) in mapping.clients" :key="client.slug"
                    ><template v-if="i">、</template><code class="uri">{{ client.slug }}</code
                    ><template v-if="client.create"
                      >（新建，<RuntimeLabel
                        :family="client.runtimeFamily"
                        :size="14"
                      />）</template
                    ><template v-else>（已有）</template></template
                  >
                </p>
                <p v-if="effects.clientsGivenPersona.length">
                  以下接入实例暂无默认人格，将设为 {{ plan.persona.slug }}：{{
                    effects.clientsGivenPersona.join('、')
                  }}
                </p>
                <p v-if="effects.clientsOtherPersona.length" class="text-warning">
                  以下接入实例使用其他人格，core://soul 不会进入其启动加载：{{
                    effects.clientsOtherPersona.join('、')
                  }}
                </p>
              </div>
              <p v-else class="text-muted">本次节点未涉及接入实例映射。</p>
            </section>

            <section
              v-show="planTab === 'sync'"
              id="lore-panel-sync"
              role="tabpanel"
              aria-labelledby="lore-tab-sync"
              class="space-y-4"
            >
              <section v-if="sync">
                <SectionHeading title="同步已导入的节点" :level="4" />
                <div class="plan-body space-y-2">
                  <p v-if="sync.current || sync.groups.length">
                    已是最新
                    {{ sync.current }} 条。如不需要同步某节点，请在节点清单中勾选「本次不同步」。
                  </p>
                  <p v-else class="text-muted">暂无已导入的节点</p>
                  <details
                    v-for="group in sync.groups"
                    :key="group.state"
                    :open="group.state === 'update'"
                  >
                    <summary>{{ group.heading }}（{{ group.lines.length }}）</summary>
                    <ul class="detail-list">
                      <!-- 和上面的写入目标一样先写标题，来源路径跟在后面 -->
                      <li v-for="(line, i) in group.lines" :key="i" class="sync-line">
                        <span v-if="line.title" class="target-title">{{ line.title }}</span>
                        <UriPath :uri="line.legacyUri" wrap />
                        <code v-if="line.shortId" class="uri">{{ line.shortId }}</code>
                        <template v-if="line.target">
                          <span>→</span>
                          <UriPath :uri="line.target" wrap />
                        </template>
                        <span v-if="line.detail">{{ line.detail }}</span>
                      </li>
                    </ul>
                  </details>
                </div>
              </section>

              <details v-if="plan.skipped.length" open>
                <summary>不导入（{{ plan.skipped.length }}）</summary>
                <ul class="detail-list">
                  <li v-for="(s, i) in plan.skipped" :key="i">
                    <code class="uri">{{ s.source }}</code
                    >：{{ s.reason }}
                  </li>
                </ul>
              </details>
              <details v-if="plan.droppedKeywords.length">
                <summary>丢弃的关键词（{{ plan.droppedKeywords.length }}）</summary>
                <ul class="detail-list">
                  <li v-for="(k, i) in plan.droppedKeywords" :key="i">
                    <code class="uri">{{ k.source }}</code
                    >「{{ k.keyword }}」：{{ k.reason }}
                  </li>
                </ul>
              </details>
              <p
                v-if="!sync?.groups.length && !plan.skipped.length && !plan.droppedKeywords.length"
                class="text-muted"
              >
                暂无同步差异或被跳过的条目。
              </p>
            </section>
          </div>

          <NoteLine v-if="error" tone="error">{{ error }}</NoteLine>

          <div class="modal-foot">
            <p v-if="plan && effects" class="text-xs text-muted">
              本次将新建 {{ effects.create }} 条、按 Lore 更新
              {{ effects.update }} 条。写入中途出错时，已写入的内容保留，重新生成计划后可继续。
            </p>
            <div v-else />
            <div class="flex flex-wrap gap-2">
              <UButton color="neutral" variant="ghost" :disabled="busy" @click="open = false">
                取消
              </UButton>
              <template v-if="plan">
                <UButton
                  color="neutral"
                  variant="outline"
                  :loading="busy"
                  :disabled="!ready"
                  @click="replan"
                >
                  重新生成计划
                </UButton>
                <UButton :loading="busy" :disabled="!ready || confirmMissing" @click="applyPlan">
                  确认导入
                </UButton>
              </template>
              <UButton v-else type="submit" color="primary" :loading="busy" :disabled="!ready">
                查看计划
              </UButton>
            </div>
          </div>
        </form>
      </template>
    </UModal>
  </SettingsBlock>
</template>

<style scoped>
.source {
  max-width: 44rem;
}
.steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border: 1px solid var(--ui-border);
}
.steps li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--ui-text-muted);
  border-right: 1px solid var(--ui-border);
}
.steps li:last-child {
  border-right: 0;
}
.steps li[data-state='active'] {
  color: var(--ui-text-highlighted);
  font-weight: 600;
  background: var(--ui-bg-elevated);
}
.steps li[data-state='done'] {
  color: var(--ui-text);
}
.step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  border: 1px solid var(--ui-border);
}
.steps li[data-state='active'] .step-num {
  border-color: var(--ui-text-highlighted);
  background: var(--ui-text-highlighted);
  color: var(--ui-bg);
}
.plan-meta-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}
.kpi-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border: 1px solid var(--ui-border);
}
.kpi-cell {
  padding: 10px 12px;
  border-right: 1px solid var(--ui-border);
}
.kpi-cell:last-child {
  border-right: 0;
}
.kpi-cell dt {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.kpi-cell dd {
  margin-top: 2px;
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-highlighted);
}
.plan-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  border-bottom: 1px solid var(--strata-rule);
}
.plan-tab {
  padding: 8px 2px;
  font-size: 14px;
  color: var(--ui-text-muted);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  cursor: pointer;
}
.plan-tab:hover {
  color: var(--ui-text);
}
.plan-tab[data-active='true'] {
  color: var(--ui-text-highlighted);
  font-weight: 600;
  border-bottom-color: var(--ui-text-highlighted);
}
.nodes-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}
.plan-body {
  padding-top: 4px;
}
.uri {
  font-family: var(--font-mono);
  font-size: 13px;
}
.nodes {
  max-height: 24rem;
  overflow-y: auto;
  border-top: 1px solid var(--ui-border);
}
.node {
  padding: 10px 4px 10px 0;
  border-bottom: 1px solid var(--ui-border);
  line-height: 1.6;
}
.node-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 2px 12px;
}
.node-target {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 10px;
  margin-top: 2px;
  font-size: 13px;
}
.target-arrow {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--ui-text-muted);
}
.target-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.sync-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 10px;
  font-size: 13px;
}
summary {
  font-weight: 500;
  cursor: pointer;
}
.spots {
  margin-top: 4px;
  font-size: 13px;
}
.spot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 10px;
}
.detail-list {
  margin-top: 4px;
  overflow-wrap: anywhere;
  color: var(--ui-text-muted);
}
.detail-list > li + li {
  margin-top: 2px;
}
.modal-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  padding-top: 12px;
  border-top: 1px solid var(--strata-rule);
}
@media (max-width: 639.98px) {
  .kpi-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .steps {
    grid-template-columns: minmax(0, 1fr);
  }
  .steps li {
    border-right: 0;
    border-bottom: 1px solid var(--ui-border);
  }
  .steps li:last-child {
    border-bottom: 0;
  }
}
</style>
