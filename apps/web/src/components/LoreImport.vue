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
  excludeLabel,
  importProblems,
  LoreFileError,
  matchesFilter,
  NODE_FILTERS,
  readLoreBackup,
  secretSelectable,
  selectionOf,
  syncGroups,
  targetStateLabels,
  tokenInClear,
  type NodeFilter,
} from '../loreBackup'
import { formatTime } from '../time'

const props = defineProps<{ spaceId: string; editable: boolean; isAdmin: boolean }>()

const queryClient = useQueryClient()

type SourceKind = LoreImportSource['kind']
const sourceTabs = [
  { label: '上传导出文件', value: 'file' },
  { label: '从地址拉取', value: 'url' },
]
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
const clearToken = computed(() => sourceKind.value === 'url' && tokenInClear(url.value))
const personaProblem = computed(() =>
  Slug.safeParse(personaSlug.value).success ? null : '只用小写字母、数字和连字符',
)
const persona = computed(() => ({ slug: personaSlug.value, name: personaName.value.trim() }))
const ready = computed(() => {
  if (busy.value || personaProblem.value || !persona.value.name) return false
  return sourceKind.value === 'file'
    ? Boolean(file.value) && !tooLarge.value
    : Boolean(url.value.trim())
})

async function currentSource(): Promise<LoreImportSource> {
  if (sourceKind.value === 'url') {
    return { kind: 'url', url: url.value.trim(), token: token.value.trim() }
  }
  backup.value ??= await readLoreBackup(file.value!)
  return { kind: 'file', backup: backup.value }
}

const messageOf = (err: unknown, fallback: string) =>
  err instanceof ApiError || err instanceof LoreFileError ? err.message : fallback

async function showPlan() {
  if (!ready.value) return
  busy.value = true
  error.value = null
  const forSpace = props.spaceId
  try {
    const next = await api.lorePlan(forSpace, {
      source: await currentSource(),
      persona: persona.value,
    })
    if (forSpace !== props.spaceId) return
    plan.value = next
    confirmStale.value = false
  } catch (err) {
    if (forSpace !== props.spaceId) return
    plan.value = null
    error.value = messageOf(err, '看计划失败')
  } finally {
    busy.value = false
  }
}

async function replan() {
  notice.value = null
  result.value = null
  await showPlan()
}

// 执行失败之后给人看的说明。计划变了（409）时什么都没写；别的错误都当成可能写了一部分，服务端报 500 时自己说了
function failureNotice(err: unknown): string {
  const message = messageOf(err, '网络出错了')
  if (err instanceof ApiError && err.status === 409) {
    return `${message}。已经重新算过计划，勾选还在。`
  }
  const partly = err instanceof ApiError && err.status === 500 ? '' : '可能已经写入了一部分。'
  return `${message}。${partly}已经重新算过计划：已写入的显示成已导入，勾选还在，再确认一次就接着做。`
}

async function applyPlan() {
  const seen = plan.value
  if (!seen || !ready.value || (seen.staleSince && !confirmStale.value)) return
  busy.value = true
  error.value = null
  notice.value = null
  const forSpace = props.spaceId
  let failure: string | null = null
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
    if (forSpace === props.spaceId) failure = failureNotice(err)
  } finally {
    busy.value = false
  }
  // 不用旧指纹重试：可能已经写了一部分，或者计划确实变了。直接重看计划，勾选还在
  if (failure) {
    notice.value = failure
    plan.value = null
    await showPlan()
  }
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
const visibleNodes = computed(() => nodes.value.filter((n) => matchesFilter(n, filter.value)))
const filterItems = computed(() =>
  NODE_FILTERS.map(({ value, label }) => ({
    value,
    label: `${label}（${nodes.value.filter((n) => matchesFilter(n, value)).length}）`,
  })),
)
const sync = computed(() => (plan.value ? syncGroups(plan.value) : null))
const bootCount = computed(
  () =>
    nodes.value.filter(
      (n) => !excludedIds.value.has(n.uuid) && n.targets.some((t) => t.boot && !isSecret(n, t)),
    ).length,
)
const credentialRefs = computed(() => [...new Set(nodes.value.flatMap((n) => n.credentialRefs))])
// 这次会写的：勾掉的不算
const willCreate = computed(
  () =>
    nodes.value
      .filter((n) => !excludedIds.value.has(n.uuid))
      .flatMap((n) => n.targets)
      .filter((t) => t.state === 'new').length,
)
const willUpdate = computed(() => {
  const skipped = new Set(
    nodes.value.filter((n) => excludedIds.value.has(n.uuid)).map((n) => n.uri),
  )
  return (plan.value?.sync.items ?? []).filter(
    (i) => i.state === 'update' && !skipped.has(i.source),
  ).length
})
// 之前的导入写到了别的人格：换了人格时 core://soul 另写一份，之前那份不再同步
const otherPersonas = computed(() => {
  const imported = plan.value?.persona.imported ?? []
  return imported.includes(plan.value?.persona.slug ?? '') ? [] : imported
})
// 文件比已写入的数据旧，但这次没有要写的：不用确认，「Lore 里已经没有」却可能只是文件旧
const olderWithoutWrites = computed(() => {
  const p = plan.value
  return Boolean(p?.dataTime && !p.staleSince && p.exportedAt < p.dataTime)
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
    if (c.uri === null) return ['在 Kioku 里删除了']
    return c.uri === target.uri ? [] : [`现在在 ${c.uri}`]
  })
  return notes.length ? notes.join('；') : null
}
// 路径或正文像有凭据的提醒：已经全是 secret 的不用再说；导入过的这里标不了，要到记忆详情里改
function credentialNote(node: LorePlanNode): string | null {
  const { path, content } = node.credentialHints
  if ((!path && !content) || node.targets.every((t) => secretNow(node, t))) return null
  const where = path ? '路径' : '正文'
  return secretSelectable(node)
    ? `${where}看起来有凭据：考虑标 secret，或者把值换成凭据占位符`
    : `${where}看起来有凭据：到记忆详情里改成 secret（会清除历史里的明文），或者把值换成凭据占位符`
}
function secretHint(node: LorePlanNode): string | undefined {
  if (!plan.value?.secretAvailable) return '这个实例没有配置主密钥，不能标 secret'
  if (!secretSelectable(node)) return '已导入：这里不起作用，要改成 secret 到记忆详情里改'
  if (excludedIds.value.has(node.uuid)) return '这次不导入'
  return undefined
}
const hasDisclosureCut = (node: LorePlanNode) =>
  plan.value?.warnings.some((w) => w.uri === node.uri && w.kind === 'disclosureTruncated') ?? false
</script>

<template>
  <UCard class="max-w-2xl shrink-0">
    <template #header>
      <h2 class="font-medium">从 Lore 导入</h2>
      <p class="mt-1 text-sm text-muted">
        把 Lore 的节点导入这个空间，映射规则和命令行相同：core://agent 进基础层，core://soul
        进人格，core://agent/&lt;运行时&gt; 进你自己的对应应用，preferences://
        进你的画像层，其余进你的私人层。 可以重复执行：导入过的不重复写，Lore 里改过的按 Lore
        同步；在 Kioku 里改过、移动过、删除了的都不动。先看计划，确认之后才写入。
      </p>
    </template>

    <p v-if="!editable" class="text-sm text-muted">只有空间 owner 能导入。</p>

    <!-- 结果：有没做成的就不显示成成功 -->
    <div v-else-if="result" class="space-y-3">
      <UAlert
        v-if="importProblems(result)"
        color="warning"
        variant="subtle"
        title="有没做成的：看下面的说明，处理之后重看计划就能接着来"
      />
      <UAlert v-else color="success" variant="subtle" title="导入完成" />
      <ul class="space-y-1 text-sm">
        <li>人格 {{ persona.slug }}：{{ result.personaCreated ? '新建' : '已有' }}</li>
        <li v-if="result.appsCreated.length">
          新建应用：{{ result.appsCreated.join('、') }}。还没有 Key：在「应用与
          Key」里为要接入的应用签发
        </li>
        <li v-if="result.appsGivenPersona.length">
          设为默认人格 {{ persona.slug }}：{{ result.appsGivenPersona.join('、') }}
        </li>
        <li v-if="result.appsOtherPersona.length">
          这些应用在用别的人格，core://soul 不会进入它们的启动上下文：{{
            result.appsOtherPersona.join('、')
          }}
        </li>
        <li>
          新建记忆 {{ result.created.length }} 条；之前导入过、跳过
          {{ result.previouslyImported.length }} 条（包括导入后在 Kioku 里删除或移动了的）
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
          >：URI 已被别的记忆占用
        </li>
        <li v-for="m in result.movedInLore" :key="`moved-${m.uri}-${m.current}`">
          跳过 <code>{{ m.uri }}</code
          >：Lore 里换了路径，<template v-if="m.current">
            之前导入的那条还在 <code>{{ m.current }}</code
            >，要跟着移动就手动移</template
          ><template v-else>之前导入的那条在 Kioku 里删除了</template>，没有在新位置再建一条
        </li>
        <li
          v-for="s in result.secretAlreadyImported"
          :key="`secret-${s.uri}-${s.current}`"
          class="text-warning"
        >
          <code>{{ s.uri }}</code> 之前导入过，现在还是明文，这次的 secret 没有生效：到记忆详情里把
          <code>{{ s.current }}</code> 改成 secret（会同时清除历史里的明文）
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
          重看计划
        </UButton>
        <UButton v-else color="neutral" variant="subtle" @click="result = null">再导入一次</UButton>
      </div>
    </div>

    <form v-else class="space-y-4" @submit.prevent="plan ? applyPlan() : showPlan()">
      <UTabs
        v-if="isAdmin"
        v-model="sourceKind"
        :items="sourceTabs"
        :content="false"
        size="sm"
        class="w-full"
      />
      <UFormField
        v-if="sourceKind === 'file'"
        label="Lore 的导出文件"
        :help="`在 Lore 的设置页导出的 JSON，不超过 ${formatBytes(LORE_FILE_MAX_BYTES)}。不要带召回事件：用不上，还会很大。文件先在浏览器里裁剪再上传：只传要用的五张表（不超过 ${formatBytes(LORE_UPLOAD_MAX_BYTES)}），Lore 的接口 Key、事件、日记与旧版本的正文都不离开浏览器`"
        :error="tooLarge ? `文件超过 ${formatBytes(LORE_FILE_MAX_BYTES)} 的上限` : undefined"
      >
        <!-- 不预览文件内容：预览要给它建 blob: 地址当图片加载，会被内容安全策略拦下 -->
        <UFileUpload
          v-model="file"
          label="选择或拖进导出文件"
          description=".json"
          accept=".json,application/json"
          layout="list"
          :file-image="false"
          class="w-full"
          :disabled="busy"
        />
      </UFormField>
      <template v-else>
        <UFormField
          label="Lore 地址"
          help="填到服务的根路径。只支持 http 与 https，不能带账号密码、查询与片段；不跟随重定向"
        >
          <UInput
            v-model="url"
            placeholder="https://lore.example.com"
            autocomplete="off"
            class="w-full"
            :disabled="busy"
          />
        </UFormField>
        <UFormField label="API Token" help="Lore 的 API_TOKEN，只用这一次，不保存">
          <UInput
            v-model="token"
            type="password"
            autocomplete="off"
            class="w-full"
            :disabled="busy"
          />
        </UFormField>
        <UAlert
          v-if="clearToken"
          color="warning"
          variant="subtle"
          title="这个地址是 http，又不是内网：Token 会明文传输，而它能清空整个 Lore。尽量换成 https"
        />
      </template>
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField
          label="人格标识"
          help="core://soul 导入成这个人格的设定，默认和命令行相同"
          :error="personaProblem ?? undefined"
        >
          <UInput v-model="personaSlug" class="w-full font-mono" :disabled="busy" />
        </UFormField>
        <UFormField label="人格名称" help="这个人格还不存在时用它新建">
          <UInput v-model="personaName" class="w-full" maxlength="64" :disabled="busy" />
        </UFormField>
      </div>

      <UAlert v-if="notice" color="warning" variant="subtle" :title="notice" />

      <div v-if="plan" class="space-y-4">
        <p class="text-sm">
          这份数据导出于 {{ formatTime(plan.exportedAt) }}：{{ plan.nodeCount }} 个节点，{{
            plan.previousVersions
          }}
          个旧版本不迁移。
        </p>
        <UAlert
          color="warning"
          variant="subtle"
          title="只导入你自己导出的文件或者你自己的 Lore"
          :description="`内容按受信来源写入。${bootCount} 个节点会进启动上下文，每次会话开始都注入，宿主当成指令读${credentialRefs.length ? `；正文引用了凭据 ${credentialRefs.join('、')}，agent 能取用这些凭据` : ''}。来路不明的内容写进来，就成了你的 agent 的指令。`"
        />
        <div v-if="plan.staleSince" class="space-y-2">
          <UAlert
            color="error"
            variant="subtle"
            :title="`这个文件比已写入的数据旧：已写入的数据时间是 ${formatTime(plan.staleSince)}`"
            description="同步只看内容是否相同，用旧文件写入会把内容改回去，这次还可能新建已经在 Lore 里删掉的节点。一般应该重新导出一份；再传一份新的导出就能同步回来。"
          />
          <UCheckbox v-model="confirmStale" label="我知道这个文件是旧的，仍然要写入" />
        </div>
        <p v-else-if="olderWithoutWrites" class="text-sm text-muted">
          这个文件比已写入的数据（{{
            formatTime(plan.dataTime!)
          }}）旧。这次没有要写的，下面列出的「Lore 里已经没有」可能只是因为文件旧。
        </p>
        <UAlert
          v-if="!plan.secretAvailable"
          color="warning"
          variant="subtle"
          title="这个实例没有配置主密钥：不能标 secret。配好 KIOKU_MASTER_KEY 再导入有 secret 的节点"
        />

        <section class="space-y-1 text-sm">
          <h3 class="font-medium">人格与应用</h3>
          <p>
            core://soul 导入为 <code>{{ plan.persona.slug }}</code>
            <template v-if="plan.persona.exists">（已有）</template>
            <template v-else>（不存在，新建为「{{ plan.persona.name }}」）</template>
          </p>
          <p v-if="otherPersonas.length" class="text-warning">
            之前的导入写到了人格 {{ otherPersonas.join('、') }}：这次会另写一份
            core://soul，之前那份不再同步。要接着同步就把人格标识改回去。
          </p>
          <p v-for="mapping in plan.apps" :key="mapping.runtime" class="break-all">
            core://agent/{{ mapping.runtime }} →
            <template v-for="(app, i) in mapping.apps" :key="app.slug"
              ><template v-if="i">、</template><code>{{ app.slug }}</code
              >{{ app.create ? `（新建，类型 ${app.runtimeFamily}）` : '（已有）' }}</template
            >
          </p>
          <p v-if="plan.appsGivenPersona.length">
            这些应用还没有默认人格，会设成 {{ plan.persona.slug }}：{{
              plan.appsGivenPersona.join('、')
            }}
          </p>
          <p v-if="plan.appsOtherPersona.length" class="text-warning">
            这些应用在用别的人格，core://soul 不会进入它们的启动上下文：{{
              plan.appsOtherPersona.join('、')
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
          <p v-if="!visibleNodes.length" class="text-sm text-muted">没有这样的节点。</p>
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
                      label="标 secret"
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
                <UBadge
                  v-if="target.boot && !secretNow(node, target)"
                  size="sm"
                  variant="subtle"
                  color="warning"
                >
                  进启动上下文
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
                disclosure 或关键词里像有凭据：secret 只加密正文，这两项仍是明文
              </p>
              <p v-if="hasDisclosureCut(node)" class="text-xs text-muted">
                disclosure 太长，写入时截断
              </p>
            </li>
          </ul>
        </section>

        <details v-if="plan.skipped.length" class="text-sm">
          <summary class="cursor-pointer font-medium">不导入（{{ plan.skipped.length }}）</summary>
          <ul class="mt-1 space-y-1 text-xs break-all text-muted">
            <li v-for="s in plan.skipped" :key="`${s.source}-${s.reason}`">
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
            <li v-for="k in plan.droppedKeywords" :key="`${k.source}-${k.keyword}`">
              <code>{{ k.source }}</code
              >「{{ k.keyword }}」：{{ k.reason }}
            </li>
          </ul>
        </details>

        <section v-if="sync" class="space-y-2 text-sm">
          <h3 class="font-medium">同步导入过的节点</h3>
          <p v-if="sync.current || sync.groups.length">
            已是最新 {{ sync.current }} 条。不想同步某个节点，就在上面勾「这次不同步」。
          </p>
          <p v-else class="text-muted">还没有导入过的节点。</p>
          <details v-for="group in sync.groups" :key="group.state" :open="group.state === 'update'">
            <summary class="cursor-pointer">{{ group.title }}（{{ group.lines.length }}）</summary>
            <ul class="mt-1 space-y-1 text-xs break-all text-muted">
              <li v-for="line in group.lines" :key="line">{{ line }}</li>
            </ul>
          </details>
        </section>

        <p class="text-sm">
          这次会新建 {{ willCreate }} 条、按 Lore 更新
          {{ willUpdate }} 条。写到一半出错时已写的留着，重看计划就能接着来。
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
            重看计划
          </UButton>
          <UButton
            type="submit"
            :icon="icons.importSpace"
            :loading="busy"
            :disabled="!ready || (Boolean(plan.staleSince) && !confirmStale)"
          >
            确认导入
          </UButton>
        </template>
        <UButton v-else type="submit" :icon="icons.search" :loading="busy" :disabled="!ready">
          看计划
        </UButton>
      </div>
    </form>
  </UCard>
</template>
