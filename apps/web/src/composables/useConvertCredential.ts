import {
  ConvertibleValue,
  ConvertToCredentialRequest,
  placeholderAllowed,
  type ConsoleMemoryView,
  type ConvertedToCredential,
  type ConvertTarget,
  type CredentialValueMatch,
  type OrphanVaultItem,
} from '@kioku/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, onScopeDispose, reactive, ref, watch, type Ref } from 'vue'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import {
  convertDestinations,
  convertLeftovers,
  itemKey,
  matchByValue,
  NEW_DESTINATION,
  occurrences,
  plaintextCandidates,
  suggestIdentifier,
  suggestItemIdentifiers,
  suggestName,
  valueContext,
  vaultFieldName,
  type ConvertDestination,
  type PlaintextCandidate,
} from '../plaintext'
import { placeholderOf } from '../placeholders'
import { fromLocalInput } from '../time'
import { expiresProblem, orphanVaultItem } from '../vault'
import { refreshAfterPlaintext } from './usePlaintextActions'

// 转存为凭据的状态和规则，对话框只管长相。规则只认得出值从哪里开始，结尾是猜的，所以值默认遮盖，
// 但要显示过、核对过当前的值才能提交；显示之后还能改。
// 读这条记忆时记下版本，提交带上它：值是这时看到的，期间被改过就由服务端拒绝。
// 值只留在这里，提交成功或者关上就清掉。
// 去处：先按值查同值的凭据与密码库条目，默认选第一个对上的（已有凭据、还没起标识的条目），都没有时新建凭据
// （设了去处写进密码库，没有时由 Kioku 托管）。
// 按值查找的结果也只在这里，不进查询的缓存
export function useConvertCredential(
  spaceId: Ref<string>,
  uri: Ref<string | null>,
  onConverted: (memory: ConsoleMemoryView, result: ConvertedToCredential) => void,
) {
  const queryClient = useQueryClient()

  const memory = ref<ConsoleMemoryView | null>(null)
  const loading = ref(false)
  const loadFailure = ref<string | null>(null)
  // url 与 expires 只给新建凭据；expires 是 datetime-local 的本地时间
  const form = reactive({
    value: '',
    field: 'password',
    identifier: '',
    name: '',
    url: '',
    expires: '',
  })
  const candidates = ref<PlaintextCandidate[]>([])
  // 当前显示着值吗。核对过的那个值记在 checkedValue：隐藏之后改过，要再显示一次才算核对过
  const shown = ref(false)
  const checkedValue = ref<string | null>(null)
  const failure = ref<string | null>(null)
  // 只在 409 之后可能给：重新读取解决不了别的失败
  const canReload = ref(false)
  const submitting = ref(false)
  const result = ref<ConvertedToCredential | null>(null)
  // 新建时写进了密码库、之后的事务却失败了：条目留在集合里（CredentialWriteError.vaultItem）
  const orphan = ref<OrphanVaultItem | null>(null)

  // 每次读取一个序号：关掉或者换了一条之后，晚到的读取结果与匹配结果不算
  let loadId = 0

  // 按值查找：值到结果；正在查的值；查不了时的说明；读不了的连接数
  const matches = ref(new Map<string, CredentialValueMatch>())
  const pendingValues = ref(new Set<string>())
  const matchFailure = ref<string | null>(null)
  const unavailableConnections = ref(0)
  const unreadableCredentials = ref(0)
  // 选中的去处（ConvertDestination 的 key）。手动选过就不再跟着匹配结果换默认的
  const destination = ref<string>(NEW_DESTINATION.key)
  const destinationTouched = ref(false)
  // 给条目起的标识，按条目记
  const vaultIdentifiers = reactive<Record<string, string>>({})
  const existingIdentifiers = ref<string[]>([])

  function pick(candidate: PlaintextCandidate | undefined) {
    form.value = candidate?.value ?? ''
    form.field = candidate?.field ?? 'password'
    shown.value = false
    checkedValue.value = null
    destinationTouched.value = false
  }

  // 查还没查过、也不在查的值。结果按发出时的读取序号认：重新读取之后晚到的不算，
  // 重新读取时 pendingValues 清空，由 load 把要用的值再查一次
  async function matchValues(values: string[]) {
    const id = loadId
    const sid = spaceId.value
    const wanted = values.filter((v) => !matches.value.has(v) && !pendingValues.value.has(v))
    if (!wanted.length) return
    pendingValues.value = new Set([...pendingValues.value, ...wanted])
    const found = await matchByValue(wanted, (chunk) =>
      api.matchCredentialValues(sid, { values: chunk }),
    )
    if (id !== loadId) return
    const rest = new Set(pendingValues.value)
    for (const v of wanted) rest.delete(v)
    pendingValues.value = rest
    if (!found) return
    matches.value = new Map([...matches.value, ...found.matches])
    unavailableConnections.value = found.unavailableConnections
    unreadableCredentials.value = found.unreadableCredentials
    matchFailure.value = found.failure ? readFailure(found.failure, '查找同值的凭据失败') : null
  }

  const readMemory = (sid: string, target: string) =>
    queryClient.fetchQuery({
      queryKey: ['memory', sid, target],
      queryFn: () => api.memory(sid, target),
      staleTime: 0,
    })

  // 占位符放不进这条记忆：服务端一定拒绝，值不显示，也不让提交
  const scopeBlocked = (view: Pick<ConsoleMemoryView, 'layer' | 'sensitivity'>) =>
    !placeholderAllowed(view.layer, view.sensitivity)

  // 已经读到过时是重新读取：
  // 填好的留着；值在新的正文里还有就连同字段名留下，没有了就重新猜；都要再核对一次
  async function load() {
    const target = uri.value
    if (!target) return
    const id = ++loadId
    const sid = spaceId.value
    const previous = memory.value ? { value: form.value, field: form.field } : null
    loading.value = true
    loadFailure.value = null
    failure.value = null
    canReload.value = false
    // 重新读取（例如 409 之后）时去处可能变了（条目刚被别处起了标识）：查过的结果都不算，重新查；
    // 上一次读取发出的匹配也作废了（见 matchValues 的序号）
    pendingValues.value = new Set()
    matches.value = new Map()
    try {
      const [view, existing] = await Promise.all([
        readMemory(sid, target),
        // 建议的标识避开已有的。只是建议，读不到也不影响转存，冲突以服务端为准
        queryClient
          .fetchQuery({
            queryKey: ['credentials', sid],
            queryFn: () => api.credentials(sid),
            staleTime: 60_000,
          })
          .catch(() => null),
      ])
      if (id !== loadId) return
      memory.value = view
      if (scopeBlocked(view)) {
        candidates.value = []
        pick(undefined)
        // 只有列表读旧了才走到这里：让那一行也换成去调整
        refreshAfterPlaintext(queryClient, sid)
        return
      }
      candidates.value = plaintextCandidates(view.content ?? '')
      pick(candidates.value[0])
      existingIdentifiers.value = (existing?.items ?? []).map((c) => c.identifier)
      void matchValues(candidates.value.map((c) => c.value))
      if (previous) {
        if (occurrences(view.content ?? '', previous.value)) Object.assign(form, previous)
        // 恢复回来的值可能是手输的：上一次读取时发出的查找已经作废，这里再查一次
        void matchValues([form.value])
        return
      }
      form.identifier = suggestIdentifier(view.uri, form.field, existingIdentifiers.value)
      form.name = suggestName(view)
    } catch (err) {
      if (id === loadId) loadFailure.value = readFailure(err)
    } finally {
      if (id === loadId) loading.value = false
    }
  }

  function reset() {
    loadId++
    submitId++
    submitting.value = false
    memory.value = null
    loading.value = false
    candidates.value = []
    result.value = null
    failure.value = null
    orphan.value = null
    canReload.value = false
    loadFailure.value = null
    Object.assign(form, {
      value: '',
      field: 'password',
      identifier: '',
      name: '',
      url: '',
      expires: '',
    })
    shown.value = false
    checkedValue.value = null
    matches.value = new Map()
    pendingValues.value = new Set()
    matchFailure.value = null
    unavailableConnections.value = 0
    unreadableCredentials.value = 0
    destination.value = NEW_DESTINATION.key
    destinationTouched.value = false
    existingIdentifiers.value = []
    for (const key of Object.keys(vaultIdentifiers)) delete vaultIdentifiers[key]
  }

  // 显示着的值才算核对过
  watch([shown, () => form.value], () => {
    if (shown.value) checkedValue.value = form.value
  })

  // 值改过之后再查一次：停下来一会儿才查，免得每敲一个字发一次
  let matchTimer: ReturnType<typeof setTimeout> | null = null
  watch(
    () => form.value,
    (value) => {
      if (matchTimer) clearTimeout(matchTimer)
      if (!memory.value || !value || matches.value.has(value)) return
      matchTimer = setTimeout(() => void matchValues([value]), 400)
    },
  )
  onScopeDispose(() => {
    if (matchTimer) clearTimeout(matchTimer)
  })

  const choices = computed(() => convertDestinations(matches.value.get(form.value)))
  const matchingValue = computed(
    () =>
      pendingValues.value.has(form.value) ||
      (!!form.value &&
        !matches.value.has(form.value) &&
        !matchFailure.value &&
        ConvertibleValue.safeParse(form.value).success),
  )
  const selected = computed<ConvertDestination>(
    () => choices.value.destinations.find((d) => d.key === destination.value) ?? NEW_DESTINATION,
  )
  // 匹配结果到了、或者换了值：没手动选过就换成第一个对上的；选过的去处没有了也换
  watch(
    () => choices.value.destinations,
    (list) => {
      if (!destinationTouched.value || !list.some((d) => d.key === destination.value)) {
        destination.value = list[0]!.key
        destinationTouched.value = false
      }
      suggestItemIdentifiers(list, vaultIdentifiers, [...existingIdentifiers.value])
    },
  )
  function choose(key: string) {
    destination.value = key
    destinationTouched.value = true
  }

  const blocked = computed(() => !!memory.value && scopeBlocked(memory.value))
  const content = computed(() => memory.value?.content ?? '')
  const replaced = computed(() => occurrences(content.value, form.value))
  const context = computed(() => (shown.value ? valueContext(content.value, form.value) : null))
  const placeholder = computed(() => {
    const d = selected.value
    if (d.kind === 'credential') return placeholderOf(d.identifier, d.field)
    if (d.kind === 'vault') {
      const identifier = vaultIdentifiers[itemKey(d)]
      return identifier ? placeholderOf(identifier, vaultFieldName(null, d.itemField)) : ''
    }
    return form.identifier && form.field ? placeholderOf(form.identifier, form.field) : ''
  })

  const target = computed<ConvertTarget>(() => {
    const d = selected.value
    if (d.kind === 'credential') {
      return { kind: 'credential', credentialId: d.credentialId, field: d.field }
    }
    if (d.kind === 'vault') {
      // 名称不给时服务端用条目的名称
      return {
        kind: 'vault',
        connectionId: d.connectionId,
        itemId: d.itemId,
        itemField: d.itemField,
        identifier: vaultIdentifiers[itemKey(d)] ?? '',
      }
    }
    const url = form.url.trim()
    const expiresAt = form.expires ? fromLocalInput(form.expires) : null
    return {
      kind: 'new',
      identifier: form.identifier,
      name: form.name.trim(),
      field: form.field,
      ...(url ? { url } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    }
  })
  const body = computed(() => ({
    memoryId: memory.value?.id ?? '',
    expectedVersion: memory.value?.version ?? 0,
    value: form.value,
    target: target.value,
  }))
  // 提交前在界面上能看出来的问题，服务端照样会检查。规则直接用接口的定义，提示与服务端一致
  const problem = computed<string | null>(() => {
    if (!memory.value || blocked.value) return null
    if (selected.value.kind === 'new') {
      const expires = expiresProblem(form.expires)
      if (expires) return expires
    }
    const parsed = ConvertToCredentialRequest.safeParse(body.value)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '填写内容有误'
    if (!replaced.value) return '正文中没有这段值'
    if (checkedValue.value !== form.value) return '请先显示并核对值'
    if (matchingValue.value) return '正在查找同值的凭据'
    return null
  })
  // 重新读取进行中或者失败时，手里的是旧版本，表单也藏着：不能把看不见的值和旧版本发出去
  const canSubmit = computed(
    () =>
      !!memory.value &&
      !loading.value &&
      !loadFailure.value &&
      !blocked.value &&
      memory.value.content !== null &&
      !problem.value,
  )

  // 每次提交一个序号，和 loadId 一样：关掉或者换了空间之后，迟到的响应不碰这时的状态
  let submitId = 0
  async function submit() {
    if (submitting.value || !canSubmit.value) return
    const id = ++submitId
    const sid = spaceId.value
    const seen = memory.value!
    submitting.value = true
    failure.value = null
    orphan.value = null
    canReload.value = false
    try {
      const done = await api.convertToCredential(sid, body.value)
      // 服务端已经写了，对话框还在不在，那个空间的缓存都要刷新
      refreshAfterPlaintext(queryClient, sid, done.memory)
      // 版本变了，涉及这条记忆的整理建议随之作废；给条目起了标识，条目列表也变了
      for (const key of ['credentials', 'dream-suggestions', 'vault-items']) {
        void queryClient.invalidateQueries({ queryKey: [key, sid] })
      }
      if (id !== submitId) return
      form.value = ''
      shown.value = false
      checkedValue.value = null
      result.value = done
      onConverted(done.memory, done)
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        refreshAfterPlaintext(queryClient, sid)
      }
      // 留下的条目出现在条目列表里，可以起标识
      const left = orphanVaultItem(err)
      if (left) void queryClient.invalidateQueries({ queryKey: ['vault-items', sid] })
      if (id !== submitId) return
      failure.value = err instanceof ApiError ? err.message : '转存失败'
      orphan.value = left
      // 版本冲突和标识冲突都是 409：读一次比版本，不看文字。读到了且版本没变才不给重新读取；
      // 读取失败时分不清，留着入口，不然提示让人重新读取却没有按钮，再提交一直 409
      if (err instanceof ApiError && err.status === 409) {
        const latest = await readMemory(sid, seen.uri).catch(() => null)
        if (id !== submitId) return
        canReload.value = !latest || latest.id !== seen.id || latest.version !== seen.version
      }
    } finally {
      if (id === submitId) submitting.value = false
    }
  }

  const leftovers = computed(() => (result.value ? convertLeftovers(result.value) : []))

  return {
    memory,
    loading,
    loadFailure,
    form,
    candidates,
    shown,
    failure,
    orphan,
    canReload,
    submitting,
    result,
    matchFailure,
    unavailableConnections,
    unreadableCredentials,
    matchingValue,
    choices,
    destination,
    selected,
    vaultIdentifiers,
    choose,
    blocked,
    replaced,
    context,
    placeholder,
    problem,
    canSubmit,
    leftovers,
    pick,
    load,
    reset,
    submit,
  }
}
