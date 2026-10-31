<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  PLAINTEXT_CREDENTIAL,
  type ConsoleMemoryView,
  type Layer,
  type Sensitivity,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useCopy } from '../composables/useCopy'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { useNow } from '../composables/useNow'
import { hasUnsavedChanges, useUnsavedChangesGuard } from '../composables/unsavedChanges'
import { icons } from '../icons'
import { buildKeywordIndex } from '../keywords'
import { provenanceLabels, sensitivityLabels } from '../labels'
import type { CredentialLinks } from '../markdown'
import {
  BOOT_HINT,
  expiryState,
  isBootNode,
  looksPlaintext,
  missingDisclosureTone,
  originScopeLabel,
  overriddenNode,
  plaintextValues,
  recallText,
} from '../memoryDetail'
import { placeholderOf } from '../placeholders'
import {
  hiddenAgain,
  revealedAfterWrite,
  stillRevealed,
  withRevealed,
  type RevealedContent,
} from '../secretContent'
import {
  earliestValidTo,
  formatRelative,
  formatShort,
  formatTime,
  fromLocalInput,
  isExpired,
  toLocalInput,
  validToTooSoon,
} from '../time'
import Hint from './Hint.vue'
import MemoryContent from './MemoryContent.vue'
import MemoryHistory from './MemoryHistory.vue'
import MoveMemoryModal from './MoveMemoryModal.vue'
import NoteLine from './strata/NoteLine.vue'
import PropertyList, { type Property } from './strata/PropertyList.vue'
import StrataStrip from './strata/StrataStrip.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import StrataTag from './strata/StrataTag.vue'
import SwatchOptions from './strata/SwatchOptions.vue'
import UriPath from './strata/UriPath.vue'

const props = defineProps<{ spaceId: string; uri: string }>()
const emit = defineEmits<{
  deleted: [uri: string]
  createChild: [parentUri: string]
  moved: [memory: ConsoleMemoryView, from: string]
  // 保存或恢复了旧版本：层、敏感级、priority、disclosure 可能变了。before 是改之前的那一版
  changed: [memory: ConsoleMemoryView, before: ConsoleMemoryView]
  open: [uri: string]
  // 读到了这条记忆在哪一层：页面在窄柱上标出来
  layer: [layer: Layer]
}>()
const toast = useToast()
const queryClient = useQueryClient()
const router = useRouter()

const queryKey = computed(() => ['memory', props.spaceId, props.uri])
const memory = useQuery({
  queryKey,
  queryFn: () => api.memory(props.spaceId, props.uri),
})

const form = reactive({
  content: '',
  disclosure: '',
  priority: 2,
  sensitivity: 'private' as Sensitivity,
  glossary: [] as string[],
  // 有效到，datetime-local 输入框的本地时间；空表示一直有效
  validTo: '',
})

// 表单是从哪一版载入的：改动与保存时的版本号都以它为准，而不是缓存里最新的那份。
// 否则后台重新拉取到别人改过的新版本，会悄悄覆盖还没保存的修改，或者让保存绕过冲突检查
const base = ref<ConsoleMemoryView | null>(null)

// 显式查看拿到的机密正文，只放在这里，不写进查询的缓存（见 secretContent.ts）。这个组件按 URI 重建，切走就丢
const revealed = ref<RevealedContent | null>(null)
const revealing = ref(false)

// 有效到在输入框里的样子：只到分钟，没改过时和载入的那一版比较也按分钟
const validToInput = (m: ConsoleMemoryView) => (m.validTo ? toLocalInput(m.validTo) : '')

function load(next: ConsoleMemoryView) {
  // 换了一条或有了新版本，查看过的就不算了，要再查看一次
  if (!stillRevealed(next, revealed.value)) revealed.value = null
  const m = withRevealed(next, revealed.value)
  base.value = m
  form.content = m.content ?? ''
  form.disclosure = m.disclosure ?? ''
  form.priority = m.priority
  form.sensitivity = m.sensitivity
  form.glossary = [...m.glossary]
  form.validTo = validToInput(m)
}

const dirty = computed(() => {
  const m = base.value
  if (!m) return false
  return (
    form.content !== (m.content ?? '') ||
    form.disclosure !== (m.disclosure ?? '') ||
    form.priority !== m.priority ||
    form.sensitivity !== m.sensitivity ||
    form.glossary.join('\n') !== m.glossary.join('\n') ||
    form.validTo !== validToInput(m)
  )
})

// 现在的时间，每半分钟更新一次：开着的这条到了有效到时显示已过期
const now = useNow(30_000)
const expiredNow = computed(() => !!base.value && isExpired(base.value.validTo, now.value))

// 有未保存的改动时保留它们，提示在别处被改过，保存时由 id 与版本号检查冲突。
// 没有改动时跟上服务器：换成了另一条（删除后在同一个 URI 重建），或者有了更新的版本；
// 同一条但比表单那一版还旧的数据不理会，例如保存之前发出的重新拉取晚到了
watch(
  () => memory.data.value,
  (m) => {
    if (!m) return
    if (!base.value) return load(m)
    if (dirty.value) return
    if (m.id !== base.value.id || m.version >= base.value.version) adopt(m)
  },
  { immediate: true },
)

// 载入服务器上的一版；比表单那一版新时通知页面，树上的标记与列表跟着变（别处改过、或从历史里恢复了）
function adopt(m: ConsoleMemoryView) {
  const b = base.value
  const newer = !!b && (m.id !== b.id || m.version > b.version)
  load(m)
  if (newer) emit('changed', m, b)
}

// 服务器上最新的那一版。表单有改动时上面的监听会跳过新版本，开始或取消编辑时要从它载入
function latest(): ConsoleMemoryView | null {
  const [m, b] = [memory.data.value, base.value]
  if (!m || !b) return m ?? b
  return m.id !== b.id || m.version >= b.version ? m : b
}

// 有未保存的修改时，切到别的记忆、别的页面、退出登录或关掉标签页之前先确认（见 unsavedChanges.ts）。
// 换视图或筛选条件时编辑器还在，不用确认
const { leaving } = useUnsavedChangesGuard(dirty, {
  leavesOn: (to, from) =>
    to.query.uri !== from.query.uri || to.params.spaceId !== from.params.spaceId,
})
const changedElsewhere = computed(() => {
  const [m, b] = [memory.data.value, base.value]
  return !!m && !!b && (m.id !== b.id || m.version !== b.version)
})

const permissions = useMemoryPermissions(computed(() => props.spaceId))

// 被召回的次数：保留期内的明细加上清理时并入的累计；secret 不进召回，不用查
const recallable = computed(() => !!base.value && base.value.sensitivity !== 'secret')
const recallStat = useQuery({
  queryKey: computed(() => ['memory-recall', props.spaceId, base.value?.id] as const),
  queryFn: ({ queryKey: [, spaceId, id] }) => api.memoryRecallStat(spaceId, id!),
  enabled: recallable,
})
const readOnly = computed(() => (base.value ? permissions.readOnlyReason(base.value) : null))

// 默认是阅读状态，点「编辑」才改原文
const mode = ref<'read' | 'edit'>('read')
const preview = ref(false)
// 编辑时载入了新版本，查看过的正文不算了：回到阅读状态，再查看一次才能编辑
watch(
  () => base.value?.contentHidden,
  (hidden) => {
    if (hidden) mode.value = 'read'
  },
)

// 查看机密的正文：服务端记一次访问。结果只放在这个组件里
async function revealContent() {
  const m = base.value
  if (!m || revealing.value) return
  revealing.value = true
  try {
    const view = await api.revealMemory(props.spaceId, m.id)
    // 等结果的时候这条又有了更新的版本，这份已经旧了：再点一次
    const now = base.value
    if (!now || view.id !== now.id || view.version < now.version) return
    revealed.value = { id: view.id, version: view.version, content: view.content ?? '' }
    adopt(view)
  } catch (err) {
    failed(err, '查看失败')
  } finally {
    revealing.value = false
  }
}
// 收起查看过的正文：再看要再查看一次。这一版不变，版本号和表单都还对得上
function hideContent() {
  const m = base.value
  if (!m) return
  revealed.value = null
  load(hiddenAgain(m))
}
// 有效到最早能选的时间（见 earliestValidTo）：开始编辑、聚焦选择器与保存之前重新算
const minValidTo = ref('')
function startEditing() {
  const m = latest()
  if (m) adopt(m)
  // 表单靠读到的正文来编辑：机密要先查看（可能刚发现有了新版本，查看过的不算了）
  if (base.value?.contentHidden) return
  minValidTo.value = earliestValidTo()
  historyOpen.value = false
  mode.value = 'edit'
}
// 点「去补全」：进入编辑，光标放到触发场景
const disclosureInput = ref<{ inputRef: HTMLInputElement | null } | null>(null)
function fillDisclosure() {
  startEditing()
  void nextTick(() => disclosureInput.value?.inputRef?.focus())
}
function cancelEditing() {
  if (dirty.value && !window.confirm('放弃未保存的改动？')) return
  const m = latest()
  if (m) adopt(m)
  mode.value = 'read'
}

// 正文里出现别的记忆的关键词时标出来，点了过去
const glossary = useQuery({
  queryKey: computed(() => ['memory-glossary', props.spaceId]),
  queryFn: () => api.glossaryIndex(props.spaceId),
  staleTime: 60_000,
})
const keywordIndex = computed(() =>
  glossary.data.value ? buildKeywordIndex(glossary.data.value.entries) : null,
)

// 凭据占位符按记忆的主人解析，而只有私人层的记忆能引用凭据：读得到的私人层记忆就是自己的，
// 拿自己的凭据来画徽章；别的层不解析
const ownsCredentials = computed(() => base.value?.layer === 'private')
const credentials = useQuery({
  queryKey: computed(() => ['credentials', props.spaceId] as const),
  queryFn: ({ queryKey: [, spaceId] }) => api.credentials(spaceId),
  enabled: ownsCredentials,
  staleTime: 60_000,
})
const credentialLinks = computed<CredentialLinks | null>(() => {
  const items = credentials.data.value?.items
  if (!ownsCredentials.value || !items) return null
  return {
    // 徽章是真的链接：中键、在新标签页打开也能到凭据页
    href: (id) =>
      router.resolve({ name: 'credentials', params: { spaceId: props.spaceId }, query: { id } })
        .href,
    byIdentifier: new Map(
      items.map((c) => [
        c.identifier,
        { id: c.id, name: c.name, fields: c.fields.map((f) => f.name) },
      ]),
    ),
  }
})
function openCredential(id: string) {
  void router.push({ name: 'credentials', params: { spaceId: props.spaceId }, query: { id } })
}

// 插入凭据引用：服务端只收私人层、敏感级至少 private 的记忆里的占位符
const canReference = computed(
  () => ownsCredentials.value && (form.sensitivity === 'private' || form.sensitivity === 'secret'),
)
const contentInput = ref<{ textareaRef: HTMLTextAreaElement | null } | null>(null)
const picking = ref(false)
// 打开选择框时记下光标的位置与当时的正文：焦点移到选择框之后，正文框的选区就读不准了；
// 选择框开着时正文被换掉（例如跟上了别处保存的新版本），原来的位置就不对了，改为插在末尾
const caret = ref<{ start: number; end: number; content: string } | null>(null)
// 字段选「整条」时用 WHOLE：下拉框的选项不能用空字符串当值
const WHOLE = '*'
const pick = reactive({ credentialId: undefined as string | undefined, field: WHOLE })
const pickItems = computed(() =>
  (credentials.data.value?.items ?? []).map((c) => ({
    label: `${c.name}（${c.identifier}）`,
    value: c.id,
  })),
)
const picked = computed(() => credentials.data.value?.items.find((c) => c.id === pick.credentialId))
const fieldItems = computed(() => [
  { label: '整条凭据', value: WHOLE },
  ...(picked.value?.fields ?? []).map((f) => ({ label: f.name, value: f.name })),
])
const pickedPlaceholder = computed(() =>
  picked.value
    ? placeholderOf(picked.value.identifier, pick.field === WHOLE ? null : pick.field)
    : '',
)
// 换了凭据，原来选的字段可能没有了
watch(
  () => pick.credentialId,
  () => (pick.field = WHOLE),
)
function startPicking() {
  const el = contentInput.value?.textareaRef
  caret.value = el
    ? { start: el.selectionStart, end: el.selectionEnd, content: form.content }
    : null
  pick.credentialId = undefined
  pick.field = WHOLE
  picking.value = true
}
function insertPlaceholder() {
  const text = pickedPlaceholder.value
  if (!text) return
  const at = caret.value
  const [start, end] =
    at && at.content === form.content
      ? [at.start, at.end]
      : [form.content.length, form.content.length]
  form.content = form.content.slice(0, start) + text + form.content.slice(end)
  picking.value = false
  // 选择框关掉、焦点回到按钮之后，再把光标放回正文里插入的位置后面
  afterPick = start + text.length
}
let afterPick: number | null = null
function restoreCaret() {
  const at = afterPick
  afterPick = null
  if (at === null) return
  // 组件库在下一个宏任务才把焦点还给按钮，要排在它后面
  setTimeout(() => {
    const el = contentInput.value?.textareaRef
    el?.focus()
    el?.setSelectionRange(at, at)
  }, 50)
}

const historyOpen = ref(false)
const moveOpen = ref(false)
// 移动或改层之后把结果写进缓存：只改层时编辑器跟上新的层，移动后打开新 URI 时不用再读一次
async function onMoved(next: ConsoleMemoryView, from: string) {
  const key = ['memory', props.spaceId, next.uri]
  // 移动不改正文，查看过的接着算
  if (revealed.value?.id === next.id) revealed.value = { ...revealed.value, version: next.version }
  // 先取消进行中的重新拉取，免得晚到的旧数据盖掉移动的结果
  await queryClient.cancelQueries({ queryKey: key, exact: true })
  queryClient.setQueryData(key, next)
  // 只改了层时还停在这一条上：先载入结果，否则监听会把它当成别处的新版本，再通知页面一次
  if (next.uri === props.uri) load(next)
  void queryClient.invalidateQueries({ queryKey: ['memory-history', props.spaceId, next.id] })
  emit('moved', next, from)
}

const canCreateChild = computed(() => permissions.canWriteUri(props.uri))
const sensitivityOptions = computed(() =>
  permissions.sensitivities.value.map((value) => ({
    value,
    label: sensitivityLabels[value],
    layer: base.value?.layer ?? null,
    sensitivity: value,
  })),
)
const saving = ref(false)
// 要删除的那一版，在打开确认框时记下：确认期间编辑器可能载入了删除后重建的另一条，不能把它一起删掉
const deleting = ref<ConsoleMemoryView | null>(null)

function failed(err: unknown, fallback: string) {
  toast.add({ title: err instanceof ApiError ? err.message : fallback, color: 'error' })
}

// 保存前看正文像不像有明文凭据：改了正文、或从 secret 降级时提醒。降级之后正文会进历史、全文检索和向量，
// 服务端会拒绝带着明文降级，确认之后才带上 allowPlaintext 强制（只有空间 owner 能改 secret，也就只有他会走到这里）
const plaintextWarning = ref<{ downgrade: boolean } | null>(null)
// 写成一整句：模板里中文换行会多出一个空格
const PLAINTEXT_DOWNGRADE_TEXT =
  '降级后，正文将写入历史、全文索引和向量，无法撤回。请先将凭据转存，并确认正文不含密码或 Token。'
const PLAINTEXT_TEXT =
  '正文疑似包含密码或 Token（例如「密码：…」）。建议转存为凭据，正文改用占位符。'
function requestSave() {
  const m = base.value
  if (!m || saving.value) return
  const downgrade = m.sensitivity === 'secret' && form.sensitivity !== 'secret'
  const contentChanged = form.content !== (m.content ?? '')
  if ((downgrade || contentChanged) && PLAINTEXT_CREDENTIAL.test(form.content)) {
    plaintextWarning.value = { downgrade }
    return
  }
  void save()
}
function confirmPlaintext() {
  // 确认框关闭的动画期间再点一次：已经在保存了，不再发第二个请求
  const warning = plaintextWarning.value
  if (!warning || saving.value) return
  plaintextWarning.value = null
  void save(warning.downgrade)
}

async function save(allowPlaintext = false) {
  const m = base.value
  if (!m || saving.value) return
  // 记下这次提交的值：请求期间又改过的字段，保存之后保留新改的内容
  const sent = { ...form, glossary: [...form.glossary] }
  const validToChanged = sent.validTo !== validToInput(m)
  const validTo = sent.validTo ? fromLocalInput(sent.validTo) : null
  if (validToChanged && sent.validTo && !validTo) {
    toast.add({ title: '有效期的日期和时间不完整', color: 'error' })
    return
  }
  // 编辑得久了，开始编辑时能选的最早时间现在可能已经太近；没改的有效到原样不发，不用查
  if (validToChanged && validTo && validToTooSoon(sent.validTo)) {
    minValidTo.value = earliestValidTo()
    toast.add({ title: '有效期须晚于当前时间至少一分钟', color: 'error' })
    return
  }
  saving.value = true
  try {
    const next = await api.updateMemory(props.spaceId, {
      uri: m.uri,
      // 带上表单载入时的 id 与版本号：别人改过、或删除后重建了之后返回 409，不会悄悄覆盖
      expectedId: m.id,
      expectedVersion: m.version,
      ...(sent.content !== (m.content ?? '') ? { content: sent.content } : {}),
      // 只在改了的时候发：服务端会检查写进去的 disclosure，规则之前写着的不该挡住改别的
      ...((sent.disclosure.trim() || null) !== (m.disclosure ?? null)
        ? { disclosure: sent.disclosure.trim() || null }
        : {}),
      priority: sent.priority,
      sensitivity: sent.sensitivity,
      glossaryAdd: sent.glossary.filter((k) => !m.glossary.includes(k)),
      glossaryRemove: m.glossary.filter((k) => !sent.glossary.includes(k)),
      // 只在改了的时候发：输入框只到分钟，原样发回去会抹掉原来的秒
      ...(validToChanged ? { validTo } : {}),
      ...(allowPlaintext ? { allowPlaintext: true } : {}),
    })
    // 正在进行的重新拉取可能带回保存之前的版本，先取消，再把保存结果写进缓存
    await queryClient.cancelQueries({ queryKey: queryKey.value })
    queryClient.setQueryData(queryKey.value, next)
    revealed.value = revealedAfterWrite(next, sent.content)
    const saved = withRevealed(next, revealed.value)
    base.value = saved
    if (form.content === sent.content) form.content = saved.content ?? ''
    if (form.disclosure === sent.disclosure) form.disclosure = next.disclosure ?? ''
    if (form.priority === sent.priority) form.priority = next.priority
    if (form.sensitivity === sent.sensitivity) form.sensitivity = next.sensitivity
    if (form.glossary.join('\n') === sent.glossary.join('\n')) form.glossary = [...next.glossary]
    if (form.validTo === sent.validTo) form.validTo = validToInput(next)
    toast.add({ title: '已保存', color: 'success' })
    // 保存期间没有再改，就回到阅读状态
    if (!dirty.value) mode.value = 'read'
    void queryClient.invalidateQueries({ queryKey: ['memory-history', props.spaceId, next.id] })
    emit('changed', next, m)
  } catch (err) {
    failed(err, '保存失败')
    // 版本冲突时立刻重新拉取，好显示「载入新版本」
    if (err instanceof ApiError && err.status === 409) void memory.refetch()
  } finally {
    saving.value = false
  }
}

async function remove() {
  const m = deleting.value
  if (!m) return
  try {
    // 带上确认的那一版的 id 与版本号：期间被改过、或删除后重建了的记忆不会被一起删掉
    await api.deleteMemory(props.spaceId, props.uri, m)
    deleting.value = null
    toast.add({ title: '已删除', color: 'success' })
    // 已经删除了，离开时不再提示未保存的修改
    leaving.value = true
    hasUnsavedChanges.value = false
    emit('deleted', props.uri)
  } catch (err) {
    failed(err, '删除失败')
    // 版本冲突：关掉确认框并重新读取，看过新的那一版再决定删不删
    if (err instanceof ApiError && err.status === 409) {
      deleting.value = null
      void memory.refetch()
    }
  }
}

const copy = useCopy()

// 窄屏上打开一条之后，页面把焦点放到这里
const titleEl = ref<HTMLElement | null>(null)
defineExpose({ focusTitle: () => titleEl.value?.focus() })

// 标签和条带跟着表单走：改敏感级时就能看到改了之后的样子
const shownSensitivity = computed(() =>
  mode.value === 'edit' ? form.sensitivity : (base.value?.sensitivity ?? 'private'),
)
const shownPriority = computed(() =>
  mode.value === 'edit' ? form.priority : (base.value?.priority ?? 0),
)

const expiry = computed(() => expiryState(base.value?.validTo ?? null, now.value))
const bootNode = computed(() => !!base.value && isBootNode(base.value, now.value))
const disclosureTone = computed(() =>
  base.value ? missingDisclosureTone(base.value, now.value) : null,
)
const plaintext = computed(() => {
  const m = base.value
  return m && looksPlaintext(m) ? plaintextValues(m) : null
})

watch(
  () => base.value?.layer,
  (layer) => {
    if (layer) emit('layer', layer)
  },
  { immediate: true },
)

// 人格层的节点要说清覆盖了祖先的哪个节点：按 URI 里的标识找到人格，再读它的继承关系
const personaSlug = computed(() => /^persona:\/\/([^/]+)\//.exec(props.uri)?.[1] ?? null)
const personas = useQuery({
  queryKey: computed(() => ['personas', props.spaceId]),
  queryFn: () => api.personas(props.spaceId),
  enabled: computed(() => personaSlug.value !== null),
})
const personaId = computed(
  () => personas.data.value?.find((p) => p.slug === personaSlug.value)?.id ?? null,
)
const persona = useQuery({
  queryKey: computed(() => ['persona', props.spaceId, personaId.value] as const),
  queryFn: ({ queryKey: [, spaceId, id] }) => api.persona(spaceId, id!),
  enabled: computed(() => personaId.value !== null),
})
const overrides = computed(() => overriddenNode(persona.data.value, props.uri))

const appName = (id: string) => permissions.apps.data.value?.find((a) => a.id === id)?.name
const properties = computed<Property[][]>(() => {
  const m = base.value
  if (!m) return []
  return [
    [
      { key: 'layer', label: '层' },
      { key: 'sensitivity', label: '敏感级' },
      { key: 'priority', label: '优先级' },
    ],
    [
      { key: 'disclosure', label: '触发场景', stacked: true },
      { key: 'glossary', label: '关键词', stacked: true },
      { key: 'validity', label: '有效期' },
    ],
    [
      { key: 'provenance', label: '来源', value: provenanceLabels[m.provenance] },
      { key: 'origin', label: '范围', value: originScopeLabel(m.originScope, appName) },
      { key: 'version', label: '版本', value: m.version },
      { key: 'created', label: '创建' },
      { key: 'updated', label: '更新' },
      {
        key: 'recall',
        label: '召回',
        // 改成机密之后不再显示次数：查询停了，缓存里还留着之前的
        value: recallText(
          recallable.value ? recallStat.data.value : undefined,
          { secret: !recallable.value, boot: bootNode.value },
          now.value,
        ),
      },
    ],
  ]
})
</script>

<template>
  <article class="memory-detail">
    <StrataStrip v-if="base" :layer="base.layer" :sensitivity="shownSensitivity" />
    <header class="detail-head">
      <div class="detail-nav"><slot name="nav" /></div>
      <div class="detail-uri">
        <h1 ref="titleEl" tabindex="-1">{{ base?.uri ?? uri }}</h1>
        <UButton
          :icon="icons.copy"
          size="xs"
          color="neutral"
          variant="ghost"
          aria-label="复制 URI"
          @click="copy(base?.uri ?? uri)"
        />
      </div>
      <template v-if="base">
        <div class="detail-tag">
          <StrataTag :layer="base.layer" :sensitivity="shownSensitivity" />
          <span class="tag-priority">P{{ shownPriority }}</span>
          <span v-if="bootNode" class="inline-flex items-center gap-1.5">
            <span class="boot-flag">启动加载</span>
            <Hint>{{ BOOT_HINT }}</Hint>
          </span>
          <span
            v-if="base.validTo"
            :class="{ 'text-warning': expiry === 'soon' || expiry === 'expired' }"
            :title="`有效期至 ${formatTime(base.validTo)}`"
          >
            {{ expiredNow ? '已过期' : `${formatShort(base.validTo)} 到期` }}
          </span>
        </div>
        <div class="detail-actions">
          <template v-if="mode === 'read'">
            <UTooltip
              v-if="!readOnly"
              :text="base.contentHidden ? '先查看正文' : undefined"
              :disabled="!base.contentHidden"
            >
              <UButton size="sm" :disabled="base.contentHidden" @click="startEditing">编辑</UButton>
            </UTooltip>
            <UButton
              size="sm"
              color="primary"
              variant="outline"
              :class="{ 'bg-elevated': historyOpen }"
              :aria-pressed="historyOpen"
              @click="historyOpen = !historyOpen"
            >
              历史
            </UButton>
            <UButton
              v-if="!readOnly"
              size="sm"
              color="primary"
              variant="outline"
              @click="moveOpen = true"
            >
              移动或改层
            </UButton>
            <UButton
              v-if="canCreateChild"
              size="sm"
              color="primary"
              variant="outline"
              @click="emit('createChild', uri)"
            >
              新建子节点
            </UButton>
            <UButton
              v-if="!readOnly"
              size="sm"
              color="error"
              variant="outline"
              @click="deleting = base"
            >
              删除
            </UButton>
          </template>
          <template v-else>
            <span v-if="dirty" class="dirty-flag">未保存</span>
            <UButton
              size="sm"
              :loading="saving"
              :disabled="!dirty || !form.content.trim()"
              @click="requestSave"
            >
              保存
            </UButton>
            <UButton size="sm" color="primary" variant="outline" @click="cancelEditing">
              取消
            </UButton>
          </template>
        </div>
      </template>
    </header>

    <div v-if="memory.isPending.value" class="detail-read space-y-3">
      <USkeleton class="h-6 w-1/2" />
      <USkeleton class="h-40 w-full" />
    </div>
    <div v-else-if="!base" class="detail-read">
      <NoteLine tone="error">
        {{ memory.error.value instanceof ApiError ? memory.error.value.message : '读取失败' }}
      </NoteLine>
    </div>
    <div v-else class="detail-main">
      <div class="detail-read">
        <!-- 已经载入过时，重新拉取失败（例如别处删除了它）也保留表单，免得丢掉正在编辑的内容 -->
        <NoteLine v-if="memory.isError.value" tone="warning">
          刷新失败：{{
            memory.error.value instanceof ApiError ? memory.error.value.message : '读取失败'
          }}
        </NoteLine>
        <NoteLine v-else-if="changedElsewhere && dirty" tone="warning">
          这条记忆已在别处修改，或已删除并重新创建。保存将提示冲突，可先复制当前改动，再载入新版本。
          <template #actions>
            <UButton
              size="sm"
              color="primary"
              variant="outline"
              @click="memory.data.value && adopt(memory.data.value)"
            >
              载入新版本
            </UButton>
          </template>
        </NoteLine>
        <NoteLine v-if="readOnly">{{ readOnly }}</NoteLine>
        <NoteLine v-if="expiredNow" tone="warning">
          这条记忆已过期，不再召回，也不进启动加载。可在「已过期」中恢复生效。
        </NoteLine>
        <NoteLine v-else-if="expiry === 'soon' && mode === 'read'" tone="warning">
          这条记忆将于 {{ formatTime(base.validTo!) }} 到期，到期后不再召回，也不进启动加载。
        </NoteLine>

        <!-- 编辑：就地改原文，可以并排预览 -->
        <template v-if="mode === 'edit'">
          <div class="edit-head">
            <p class="edit-help">
              Markdown。密码与 Token 存为凭据，正文只放占位符。<Hint
                >写清背景、原因和适用条件。</Hint
              >
            </p>
            <div class="edit-tools">
              <UTooltip
                :text="canReference ? undefined : '仅私人层中敏感级不低于私密的记忆可引用凭据'"
                :disabled="canReference"
              >
                <UButton
                  size="sm"
                  color="neutral"
                  variant="outline"
                  :disabled="!canReference"
                  @click="startPicking"
                >
                  插入凭据引用
                </UButton>
              </UTooltip>
              <!-- 不放进表单字段里：表单字段会把自己的标签给里面的第一个控件 -->
              <USwitch v-model="preview" size="sm" label="预览" />
            </div>
          </div>
          <div class="grid gap-3" :class="preview ? 'xl:grid-cols-2' : ''">
            <UTextarea
              ref="contentInput"
              v-model="form.content"
              :rows="18"
              autoresize
              :maxrows="40"
              class="w-full font-mono"
              aria-label="正文"
            />
            <div v-if="preview" class="edit-preview">
              <MemoryContent
                :content="form.content"
                :credentials="credentialLinks"
                @credential="openCredential"
              />
            </div>
          </div>
        </template>

        <MemoryHistory
          v-else-if="historyOpen"
          :space-id="spaceId"
          :memory-id="base.id"
          :can-restore="!readOnly && mode === 'read'"
        />

        <!-- 阅读：状态提示和渲染后的正文 -->
        <template v-else>
          <NoteLine v-if="plaintext" tone="error">
            正文疑似包含明文凭据<Hint>建议转存为凭据，正文改用占位符。</Hint>
            <template v-if="!readOnly" #actions>
              <UButton
                size="sm"
                color="primary"
                variant="outline"
                :to="{ name: 'credentials', params: { spaceId } }"
              >
                查看凭据
              </UButton>
            </template>
          </NoteLine>
          <NoteLine
            v-if="disclosureTone"
            :tone="disclosureTone === 'warning' ? 'warning' : 'neutral'"
          >
            未设触发场景<Hint>补全后召回更准确。</Hint>
            <template v-if="!readOnly && !base.contentHidden" #actions>
              <UButton size="sm" color="primary" variant="outline" @click="fillDisclosure">
                去补全
              </UButton>
            </template>
          </NoteLine>
          <NoteLine v-if="overrides">
            覆盖「{{ overrides.persona }}」的同名节点
            <template #actions>
              <button type="button" class="override-link" @click="emit('open', overrides!.uri)">
                <UriPath :uri="overrides.uri" />
              </button>
            </template>
          </NoteLine>
          <template v-if="base.contentHidden">
            <div class="secret-mask" role="img" aria-label="机密内容已加密存储">
              <i style="width: 94%" />
              <i style="width: 82%" />
              <i style="width: 88%" />
              <i style="width: 46%" />
            </div>
            <NoteLine>
              机密内容已加密存储
              <template #actions>
                <UButton
                  size="sm"
                  color="primary"
                  variant="outline"
                  :loading="revealing"
                  @click="revealContent"
                >
                  查看正文
                </UButton>
                <Hint>查看会记录一次访问。</Hint>
              </template>
            </NoteLine>
          </template>
          <template v-else>
            <NoteLine v-if="base.sensitivity === 'secret'">
              查看会记录一次访问。
              <template #actions>
                <UButton size="sm" color="primary" variant="outline" @click="hideContent">
                  隐藏正文
                </UButton>
              </template>
            </NoteLine>
            <MemoryContent
              :content="base.content ?? ''"
              :keywords="keywordIndex"
              :self="base.uri"
              :credentials="credentialLinks"
              :plaintext="plaintext"
              @open="(uri) => emit('open', uri)"
              @credential="openCredential"
            />
          </template>
        </template>
      </div>

      <aside class="detail-side">
        <!-- 编辑时属性栏也可以改 -->
        <div v-if="mode === 'edit'" class="edit-fields">
          <div class="edit-layer">
            <span>层</span>
            <StrataSwatch :layer="base.layer" plain label="layer" />
          </div>
          <UFormField label="优先级" help="0 最重要">
            <UInputNumber v-model="form.priority" :min="0" :max="99" class="w-full" />
          </UFormField>
          <div>
            <p class="edit-label">敏感级</p>
            <SwatchOptions
              v-model="form.sensitivity"
              label="敏感级"
              :options="sensitivityOptions"
            />
          </div>
          <UFormField label="触发场景">
            <template #hint><Hint>什么场景下应该想起这条记忆</Hint></template>
            <UInput ref="disclosureInput" v-model="form.disclosure" class="w-full" />
          </UFormField>
          <UFormField label="关键词">
            <template #hint><Hint>召回时按关键词命中，至少两个字</Hint></template>
            <UInputTags v-model="form.glossary" class="w-full" />
          </UFormField>
          <UFormField label="有效期">
            <template #hint>
              <Hint>
                仅对阶段性内容设置；到期后不再召回，也不进启动加载，历史中仍可查看，之后可在「已过期」中恢复生效。留空表示长期有效。
              </Hint>
            </template>
            <UInput
              v-model="form.validTo"
              type="datetime-local"
              :min="minValidTo"
              aria-label="有效期"
              class="w-full"
              @focus="minValidTo = earliestValidTo()"
            />
            <UButton
              v-if="form.validTo"
              class="mt-1"
              size="sm"
              color="neutral"
              variant="ghost"
              @click="form.validTo = ''"
            >
              改为长期有效
            </UButton>
          </UFormField>
          <PropertyList
            :groups="[
              [
                { key: 'version', label: '版本', value: base.version },
                { key: 'updated', label: '更新' },
              ],
            ]"
          >
            <template #version
              ><span class="font-mono">{{ base.version }}</span></template
            >
            <template #updated>
              <time :datetime="base.updatedAt" :title="formatTime(base.updatedAt)">
                {{ formatRelative(base.updatedAt) }}
              </time>
            </template>
          </PropertyList>
        </div>
        <PropertyList v-else :groups="properties">
          <template #layer><StrataSwatch :layer="base.layer" plain label="layer" /></template>
          <template #sensitivity>
            <StrataSwatch :layer="base.layer" :sensitivity="base.sensitivity" label="sensitivity" />
          </template>
          <template #priority>
            <span class="me-1.5 font-mono">P{{ base.priority }}</span>
            <span v-if="bootNode" class="boot-flag" :title="BOOT_HINT"> 启动加载 </span>
          </template>
          <template #disclosure>
            <template v-if="!disclosureTone">{{ base.disclosure }}</template>
            <span v-else :class="disclosureTone === 'warning' ? 'text-warning' : 'text-muted'">
              未设触发场景
            </span>
          </template>
          <template #glossary>
            <span v-if="base.glossary.length" class="keywords">
              <span v-for="keyword in base.glossary" :key="keyword">{{ keyword }}</span>
            </span>
            <span v-else class="text-muted">–</span>
          </template>
          <template #validity>
            <span
              :class="{ 'text-warning': expiry === 'soon' || expiry === 'expired' }"
              :title="base.validTo ? formatTime(base.validTo) : undefined"
            >
              {{ base.validTo ? formatShort(base.validTo) : '长期有效' }}
            </span>
          </template>
          <template #version
            ><span class="font-mono">{{ base.version }}</span></template
          >
          <template #created>
            <time :datetime="base.createdAt" :title="formatTime(base.createdAt)">
              {{ formatRelative(base.createdAt) }}
            </time>
          </template>
          <template #updated>
            <time :datetime="base.updatedAt" :title="formatTime(base.updatedAt)">
              {{ formatRelative(base.updatedAt) }}
            </time>
          </template>
        </PropertyList>
      </aside>
    </div>

    <template v-if="base">
      <MoveMemoryModal v-model:open="moveOpen" :space-id="spaceId" :memory="base" @done="onMoved" />

      <UModal v-model:open="picking" title="插入凭据引用" @after:leave="restoreCaret">
        <template #body>
          <div class="space-y-4">
            <p v-if="!pickItems.length" class="text-sm text-muted">
              暂无凭据。请先在「凭据」页新建。
            </p>
            <template v-else>
              <UFormField label="凭据">
                <USelect v-model="pick.credentialId" :items="pickItems" class="w-full" />
              </UFormField>
              <UFormField label="字段" help="引用整条时，Agent 获取全部字段">
                <USelect v-model="pick.field" :items="fieldItems" class="w-full" />
              </UFormField>
              <p v-if="pickedPlaceholder" class="text-sm">
                将插入 <code>{{ pickedPlaceholder }}</code>
              </p>
            </template>
          </div>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="picking = false">取消</UButton>
            <UButton :disabled="!pickedPlaceholder" @click="insertPlaceholder">插入</UButton>
          </div>
        </template>
      </UModal>

      <UModal
        :open="plaintextWarning !== null"
        :title="
          plaintextWarning?.downgrade
            ? '正文疑似包含明文凭据，仍要降级？'
            : '正文疑似包含明文凭据，仍要保存？'
        "
        @update:open="(v) => !v && (plaintextWarning = null)"
      >
        <template #body>
          <p class="text-sm">
            {{ plaintextWarning?.downgrade ? PLAINTEXT_DOWNGRADE_TEXT : PLAINTEXT_TEXT
            }}<Hint v-if="plaintextWarning?.downgrade">
              检测规则可能误判。确认正文不含明文后，可继续降级。
            </Hint>
          </p>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="plaintextWarning = null">
              返回修改
            </UButton>
            <UButton
              :color="plaintextWarning?.downgrade ? 'error' : 'primary'"
              @click="confirmPlaintext"
            >
              {{ plaintextWarning?.downgrade ? '确认不含明文并降级' : '仍然保存' }}
            </UButton>
          </div>
        </template>
      </UModal>

      <UModal
        :open="deleting !== null"
        title="删除这条记忆？"
        @update:open="(v) => !v && (deleting = null)"
      >
        <template #body>
          <p class="text-sm">
            删除 <code>{{ props.uri }}</code
            >。历史事件将保留，可在「已删除」中恢复；子节点不受影响。
          </p>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="deleting = null">取消</UButton>
            <UButton color="error" @click="remove">删除</UButton>
          </div>
        </template>
      </UModal>
    </template>
  </article>
</template>

<style scoped>
.memory-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
.memory-detail > * {
  flex: none;
}
.detail-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 24px;
  padding: 14px 32px 15px;
  border-bottom: 1px solid var(--ui-border-accented);
}
.detail-nav {
  grid-column: 1;
  min-width: 0;
}
.detail-uri {
  grid-column: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 1px;
  min-width: 0;
}
.detail-uri h1 {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 21px;
  font-weight: 500;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.detail-tag {
  grid-column: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 14px;
  margin-top: 9px;
  font-size: 13px;
  line-height: 1.5;
}
.tag-priority {
  font-family: var(--font-mono);
  font-weight: 500;
}
.boot-flag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--strata-rule);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
.detail-actions {
  grid-column: 2;
  grid-row: 1 / span 3;
  align-self: start;
  display: flex;
  align-items: center;
  gap: 6px;
}
.dirty-flag {
  margin-right: 4px;
  font-size: 13px;
  color: var(--ui-warning);
  white-space: nowrap;
}
.memory-detail > .detail-main {
  flex: 1 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 290px;
  align-items: stretch;
}
.detail-read {
  min-width: 0;
  padding: 20px 40px 56px 32px;
}
.detail-side {
  min-width: 0;
  padding: 12px 32px 40px 20px;
  border-left: 1px solid var(--ui-border);
}
.keywords {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.keywords span {
  padding: 0 6px;
  border: 1px solid var(--ui-border-accented);
  font-size: 13px;
  line-height: 1.55;
}
.override-link {
  display: block;
  max-width: 20em;
  font-size: 14px;
}
.override-link:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.secret-mask {
  display: flex;
  flex-direction: column;
  gap: 13px;
  padding: 6px 0 26px;
}
.secret-mask i {
  display: block;
  height: 14px;
  background: var(--strata-solid);
}
.edit-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 16px;
  margin-bottom: 7px;
}
.edit-help {
  font-size: 13px;
  color: var(--ui-text-muted);
}
.edit-tools {
  display: flex;
  align-items: center;
  gap: 12px;
}
.edit-preview {
  min-width: 0;
  padding: 12px 16px;
  border: 1px solid var(--ui-border);
  overflow: auto;
}
.edit-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px;
}
.edit-layer {
  display: grid;
  grid-template-columns: 3.75rem minmax(0, 1fr);
  column-gap: 10px;
  align-items: baseline;
  font-size: 14px;
}
.edit-layer > span:first-child {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.edit-label {
  margin-bottom: 4px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.25rem;
}

/* 详情放不下两栏时，属性栏放到正文下面，操作放到标题下面 */
@media (max-width: 1240px) {
  .detail-head {
    grid-template-columns: minmax(0, 1fr);
  }
  .detail-actions {
    grid-column: 1;
    grid-row: auto;
    flex-wrap: wrap;
    margin-top: 11px;
  }
  .memory-detail > .detail-main {
    grid-template-columns: minmax(0, 1fr);
  }
  .detail-side {
    padding: 6px 32px 40px;
    border-left: 0;
    border-top: 1px solid var(--ui-border-accented);
  }
}
@media (max-width: 1023.98px) {
  .detail-head {
    padding: 12px 16px 14px;
  }
  .detail-uri h1 {
    font-size: 18px;
  }
  .detail-read {
    padding: 16px 16px 28px;
  }
  .detail-side {
    padding: 6px 16px 32px;
  }
}
</style>
