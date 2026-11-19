import {
  ConvertibleValue,
  ConvertToCredentialRequest,
  placeholderAllowed,
  type CircleKind,
  type ConsoleEntryView,
  type ConvertedToCredential,
  type ConvertTarget,
  type CredentialValueMatch,
  type Me,
  type OrphanVaultItem,
} from '@kioku/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, onScopeDispose, reactive, ref, watch, type Ref } from 'vue'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { entryText } from '../memoryDetail'
import { placeholderOf } from '../placeholders'
import {
  convertDestinations,
  convertLeftovers,
  itemKey,
  matchByValue,
  NEW_DESTINATION,
  occurrences,
  plaintextCandidates,
  suggestEntryIdentifier,
  suggestItemIdentifiers,
  suggestName,
  valueContext,
  vaultFieldName,
  type ConvertDestination,
  type PlaintextCandidate,
} from '../plaintext'
import { ME_KEY } from '../query'
import { fromLocalInput } from '../time'
import {
  hasWriteReason,
  optionalExpiresProblem,
  orphanVaultItem,
  storeBlocker,
  writeFailureNext,
} from '../vault'
import { useNewCredentialStore } from './useNewCredentialStore'
import { refreshAfterPlaintext } from './usePlaintextActions'

// 转存为凭据的状态和规则，对话框只管长相。规则只认得出值从哪里开始，结尾是猜的，所以值默认遮盖，
// 但要显示过、核对过当前的值才能提交；显示之后还能改。
// 读这条记忆时记下版本，提交带上它：值是这时看到的，期间被改过就由服务端拒绝。
// 值只留在这里，提交成功或者关上就清掉。
// 去处：先按值查同值的凭据与密码库条目，默认选第一个对上的（已有凭据、还没起标识的条目），都没有时新建凭据
// （设了去处写进密码库，没有时由 Kioku 托管）。
// 按值查找的结果也只在这里，不进查询的缓存
export function useConvertCredential(
  circleId: Ref<string>,
  shortId: Ref<string | null>,
  onConverted: (entry: ConsoleEntryView, result: ConvertedToCredential) => void,
) {
  const queryClient = useQueryClient()

  const entry = ref<ConsoleEntryView | null>(null)
  const loading = ref(false)
  const loadFailure = ref<string | null>(null)
  const form = reactive({
    value: '',
    field: 'password',
    identifier: '',
    name: '',
    url: '',
    expires: '',
    expiresBad: false,
  })
  const newStore = useNewCredentialStore(
    circleId,
    computed(() => shortId.value !== null),
  )
  const candidates = ref<PlaintextCandidate[]>([])
  const shown = ref(false)
  const checkedValue = ref<string | null>(null)
  const failure = ref<string | null>(null)
  const canReload = ref(false)
  const submitting = ref(false)
  const result = ref<ConvertedToCredential | null>(null)
  const orphan = ref<OrphanVaultItem | null>(null)
  const failureDetail = ref<string | null>(null)

  let loadId = 0

  const matches = ref(new Map<string, CredentialValueMatch>())
  const pendingValues = ref(new Set<string>())
  const matchFailure = ref<string | null>(null)
  const unavailableConnections = ref(0)
  const unreadableCredentials = ref(0)
  const destination = ref<string>(NEW_DESTINATION.key)
  const destinationTouched = ref(false)
  const vaultIdentifiers = reactive<Record<string, string>>({})
  const existingIdentifiers = ref<string[]>([])

  function pick(candidate: PlaintextCandidate | undefined) {
    form.value = candidate?.value ?? ''
    form.field = candidate?.field ?? 'password'
    shown.value = false
    checkedValue.value = null
    destinationTouched.value = false
  }

  async function matchValues(values: string[]) {
    const id = loadId
    const cid = circleId.value
    const wanted = values.filter((v) => !matches.value.has(v) && !pendingValues.value.has(v))
    if (!wanted.length) return
    pendingValues.value = new Set([...pendingValues.value, ...wanted])
    const found = await matchByValue(wanted, (chunk) =>
      api.matchCredentialValues(cid, { values: chunk }),
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

  const readEntry = (cid: string, sid: string) =>
    queryClient.fetchQuery({
      queryKey: ['entry', cid, sid],
      queryFn: () => api.entry(cid, sid, { allVariants: true }),
      staleTime: 0,
    })

  // 判断词条所在的记忆圈类型：优先从会话缓存认，回退按 circleSlug === 'personal' 判断
  function resolveCircleKind(view: Pick<ConsoleEntryView, 'circleId' | 'circleSlug'>): CircleKind {
    const me = queryClient.getQueryData<Me | null>(ME_KEY)
    const found = me?.circles.find((c) => c.id === view.circleId)?.kind
    if (found) return found
    return view.circleSlug === 'personal' ? 'personal' : 'shared'
  }

  // 占位符放不进这条记忆：服务端一定拒绝，值不显示，也不让提交
  const entryCircleKind = computed<CircleKind>(() =>
    entry.value ? resolveCircleKind(entry.value) : 'shared',
  )
  const scopeBlocked = (
    view: Pick<ConsoleEntryView, 'circleId' | 'circleSlug' | 'kind' | 'sensitivity'>,
  ) => !placeholderAllowed(resolveCircleKind(view), view.kind, view.sensitivity)

  async function load() {
    const target = shortId.value
    if (!target) return
    const id = ++loadId
    const cid = circleId.value
    const previous = entry.value ? { value: form.value, field: form.field } : null
    loading.value = true
    loadFailure.value = null
    failure.value = null
    canReload.value = false
    pendingValues.value = new Set()
    matches.value = new Map()
    try {
      const [view, existing] = await Promise.all([
        readEntry(cid, target),
        queryClient
          .fetchQuery({
            queryKey: ['credentials', cid],
            queryFn: () => api.credentials(cid),
            staleTime: 60_000,
          })
          .catch(() => null),
      ])
      if (id !== loadId) return
      entry.value = view
      if (scopeBlocked(view)) {
        candidates.value = []
        pick(undefined)
        refreshAfterPlaintext(queryClient, cid)
        return
      }
      const joined = entryText(view)
      candidates.value = plaintextCandidates(joined)
      pick(candidates.value[0])
      existingIdentifiers.value = (existing?.items ?? []).map((c) => c.identifier)
      void matchValues(candidates.value.map((c) => c.value))
      if (previous) {
        if (occurrences(joined, previous.value)) Object.assign(form, previous)
        void matchValues([form.value])
        return
      }
      form.identifier = suggestEntryIdentifier(
        { title: view.title, shortId: view.shortId },
        form.field,
        existingIdentifiers.value,
      )
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
    entry.value = null
    loading.value = false
    candidates.value = []
    result.value = null
    failure.value = null
    failureDetail.value = null
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
      expiresBad: false,
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

  watch([shown, () => form.value], () => {
    if (shown.value) checkedValue.value = form.value
  })

  let matchTimer: ReturnType<typeof setTimeout> | null = null
  watch(
    () => form.value,
    (value) => {
      if (matchTimer) clearTimeout(matchTimer)
      if (!entry.value || !value || matches.value.has(value)) return
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

  const blocked = computed(() => !!entry.value && scopeBlocked(entry.value))
  const content = computed(() => (entry.value ? entryText(entry.value) : ''))
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
      return {
        kind: 'vault',
        connectionId: d.connectionId,
        itemId: d.itemId,
        itemField: d.itemField,
        identifier: vaultIdentifiers[itemKey(d)] ?? '',
      }
    }
    const url = form.url.trim()
    const expiresAt = form.expires && !form.expiresBad ? fromLocalInput(form.expires) : null
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
    entryId: entry.value?.id ?? '',
    expectedVersion: entry.value?.version ?? 0,
    value: form.value,
    target: target.value,
  }))

  const problem = computed<string | null>(() => {
    if (!entry.value || blocked.value) return null
    if (selected.value.kind === 'new') {
      const blocker = storeBlocker({
        store: newStore.store.value,
        failed: newStore.failed.value,
      })
      if (blocker) return blocker
      const expires = optionalExpiresProblem(form.expires, form.expiresBad)
      if (expires) return expires
    }
    const parsed = ConvertToCredentialRequest.safeParse(body.value)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '填写内容有误'
    if (!replaced.value) return '正文中没有这段值'
    if (checkedValue.value !== form.value) return '请先显示并核对值'
    if (matchingValue.value) return '正在查找同值的凭据'
    return null
  })
  const canSubmit = computed(
    () =>
      !!entry.value &&
      !loading.value &&
      !loadFailure.value &&
      !blocked.value &&
      !entry.value.contentHidden &&
      !problem.value,
  )

  let submitId = 0
  async function submit() {
    if (submitting.value || !canSubmit.value) return
    const id = ++submitId
    const cid = circleId.value
    const seen = entry.value!
    submitting.value = true
    failure.value = null
    failureDetail.value = null
    orphan.value = null
    canReload.value = false
    try {
      const done = await api.convertToCredential(cid, body.value)
      refreshAfterPlaintext(queryClient, cid, done.entry)
      for (const key of ['credentials', 'dream-suggestions', 'vault-items']) {
        void queryClient.invalidateQueries({ queryKey: [key, cid] })
      }
      if (id !== submitId) return
      form.value = ''
      shown.value = false
      checkedValue.value = null
      result.value = done
      onConverted(done.entry, done)
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        refreshAfterPlaintext(queryClient, cid)
      }
      const left = orphanVaultItem(err)
      if (left) void queryClient.invalidateQueries({ queryKey: ['vault-items', cid] })
      if (id !== submitId) return
      failure.value = err instanceof ApiError ? err.message : '转存失败'
      orphan.value = left
      const next = writeFailureNext(err, 'create')
      failureDetail.value = next.detail
      if (hasWriteReason(err)) {
        canReload.value = next.reload
        return
      }
      if (err instanceof ApiError && err.status === 409) {
        const latest = await readEntry(cid, seen.shortId).catch(() => null)
        if (id !== submitId) return
        canReload.value = !latest || latest.id !== seen.id || latest.version !== seen.version
      }
    } finally {
      if (id === submitId) submitting.value = false
    }
  }

  const leftovers = computed(() => (result.value ? convertLeftovers(result.value) : []))

  return {
    entry,
    entryCircleKind,
    loading,
    loadFailure,
    form,
    candidates,
    shown,
    failure,
    failureDetail,
    orphan,
    store: newStore.store,
    storeIssue: newStore.issue,
    storeFailed: newStore.failed,
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
