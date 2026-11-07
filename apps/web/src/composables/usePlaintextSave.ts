import {
  CONVERT_SCOPE_TEXT,
  ConvertibleValue,
  CreateCredentialRequest,
  placeholderAllowed,
  type ConsoleCredential,
  type CredentialStoredIn,
  type CredentialValueMatch,
  type Layer,
  type OrphanVaultItem,
  type Sensitivity,
} from '@kioku/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch, type Ref } from 'vue'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { invalidateInboxCounts } from '../inbox'
import { placeholderOf } from '../placeholders'
import {
  convertDestinations,
  itemKey,
  matchByValue,
  NEW_DESTINATION,
  replaceValues,
  suggestIdentifier,
  suggestItemIdentifiers,
  suggestName,
  vaultFieldName,
  type ConvertDestination,
  type NewCredentialFields,
} from '../plaintext'
import { saveFlags, type GateOutcome, type PlaintextSpot, type SpotChoice } from '../plaintextSave'
import { clipText } from '../text'
import { fromLocalInput } from '../time'
import { optionalExpiresProblem, orphanVaultItem, storeBlocker, writeFailureNext } from '../vault'
import { useNewCredentialStore } from './useNewCredentialStore'

// 保存记忆之前逐处处理新增的疑似明文：转存为凭据或不是凭据。转存的先建好凭据，再把正文里的值换成占位符，
// 最后才保存，明文不会先进历史。对话框只管长相，规则都在这里

// 要保存的样子：正文、坐标、标题，以及保存之后的归属与敏感级（占位符放不放得进看它们）
export interface PlaintextSaveRequest {
  content: string
  uri: string
  title: string
  layer: Layer
  sensitivity: Sensitivity
  spots: PlaintextSpot[]
  // 服务端拒绝之后才打开的：界面上的判断和服务端有出入
  rejected: boolean
  // 上一次弹窗里标了不是凭据、这份正文里还在的值（见 afterGate）：不再列出，保存时照旧带 ignorePlaintext
  ignored?: string[]
}

// 见 plaintextSave.ts 的 GateOutcome：调用方的正文这时已经不是 source 时，交给 afterGate 处理
export type PlaintextSaveResult = GateOutcome

export interface SpotRow {
  spot: PlaintextSpot
  choice: SpotChoice | null
  // 选中的去处（ConvertDestination 的 key）
  destination: string
  // 新建凭据时填的
  fresh: NewCredentialFields
  // 新建的凭据已经建好：再点保存不重建，用它的标识
  created: boolean
}

// 去处里写成明文的部分不能含这个值，和转存的接口同一条规则
const TEXTS_HAVE_VALUE = '标识、名称、字段名与网址不能包含要转存的值'

// 这次新建了的凭据写到了哪里：保存之后提示
export interface StoredCredential {
  identifier: string
  storedIn: CredentialStoredIn
}

// canConvert：能不能转存为凭据（vault.ts 的 canManageCredentials）；
// canSaveAnyway：能不能照样保存（allowPlaintext），能改这条记忆的成员都可以
export function usePlaintextSave(
  spaceId: Ref<string>,
  request: Ref<PlaintextSaveRequest | null>,
  canConvert: Ref<boolean>,
  canSaveAnyway: Ref<boolean>,
  onProceed: (result: PlaintextSaveResult) => void,
) {
  const queryClient = useQueryClient()

  const rows = ref<SpotRow[]>([])
  const matches = ref(new Map<string, CredentialValueMatch>())
  const matching = ref(false)
  const matchFailure = ref<string | null>(null)
  const unavailableConnections = ref(0)
  const unreadableCredentials = ref(0)
  // 已有凭据的标识：新建的不能和它们重复
  const taken = ref<string[]>([])
  // 给条目起的标识，按条目记：同一个条目的几个字段共用一条凭据
  const vaultIdentifiers = reactive<Record<string, string>>({})
  // 已经起好标识的条目：保存中途失败之后再点，不重建
  const createdVault = ref(new Map<string, ConsoleCredential>())
  const busy = ref(false)
  const failure = ref<string | null>(null)
  // 新建时写进了密码库、凭据却没建成：条目留在集合里
  const orphan = ref<OrphanVaultItem | null>(null)
  // 失败之后的下一步说明（集合只读、值太长），见 vault.ts 的 writeFailureNext
  const failureDetail = ref<string | null>(null)
  const stored = ref<StoredCredential[]>([])

  // 新建的凭据写到哪里，读不到时不能新建
  const newStore = useNewCredentialStore(
    spaceId,
    computed(() => request.value !== null && canConvert.value),
  )

  const scopeAllowed = computed(
    () => !!request.value && placeholderAllowed(request.value.layer, request.value.sensitivity),
  )

  // 这一处为什么不能转存，能转存时是 null
  function convertBlocker(row: SpotRow): string | null {
    if (!canConvert.value) return '仅空间所有者可转存为凭据'
    if (!scopeAllowed.value) return CONVERT_SCOPE_TEXT
    if (row.spot.value === null) return '无法定位这一处的值'
    const parsed = ConvertibleValue.safeParse(row.spot.value)
    return parsed.success ? null : (parsed.error.issues[0]?.message ?? '这个值无法转存')
  }

  function destinationsOf(row: SpotRow) {
    return convertDestinations(row.spot.value ? matches.value.get(row.spot.value) : undefined)
  }
  function selectedOf(row: SpotRow): ConvertDestination {
    return (
      destinationsOf(row).destinations.find((d) => d.key === row.destination) ?? NEW_DESTINATION
    )
  }

  // 每次打开一个序号：关掉或者换了一次保存之后，晚到的匹配结果和创建结果不算
  let runId = 0
  watch(
    request,
    (req) => {
      const id = ++runId
      busy.value = false
      failure.value = null
      failureDetail.value = null
      orphan.value = null
      stored.value = []
      matching.value = false
      matches.value = new Map()
      matchFailure.value = null
      unavailableConnections.value = 0
      unreadableCredentials.value = 0
      createdVault.value = new Map()
      for (const key of Object.keys(vaultIdentifiers)) delete vaultIdentifiers[key]
      if (!req) {
        rows.value = []
        return
      }
      rows.value = req.spots.map((spot) => ({
        spot,
        choice: null,
        destination: NEW_DESTINATION.key,
        fresh: {
          identifier: '',
          name: suggestName(req),
          field: spot.field,
          url: '',
          expires: '',
          expiresBad: false,
        },
        created: false,
      }))
      void prepare(id, req)
    },
    { immediate: true },
  )

  // 查已有的标识与同值的凭据。查不了也能转存成新建的凭据
  async function prepare(id: number, req: PlaintextSaveRequest) {
    if (!canConvert.value || !scopeAllowed.value) return
    const sid = spaceId.value
    const values = rows.value.flatMap((r) =>
      r.spot.value && !convertBlocker(r) ? [r.spot.value] : [],
    )
    matching.value = true
    const existing = queryClient
      .fetchQuery({
        queryKey: ['credentials', sid],
        queryFn: () => api.credentials(sid),
        staleTime: 60_000,
      })
      .then((list) => list.items.map((c) => c.identifier))
      .catch(() => [] as string[])
    const found = await matchByValue(values, (chunk) =>
      api.matchCredentialValues(sid, { values: chunk }),
    )
    const identifiers = await existing
    if (id !== runId) return
    matching.value = false
    if (found) {
      matches.value = found.matches
      matchFailure.value = found.failure ? readFailure(found.failure, '查找同值的凭据失败') : null
      unavailableConnections.value = found.unavailableConnections
      unreadableCredentials.value = found.unreadableCredentials
    }
    taken.value = identifiers
    // 建议的标识避开已有的，也避开这次别处建议过的
    const suggested = [...identifiers]
    for (const row of rows.value) {
      suggestItemIdentifiers(destinationsOf(row).destinations, vaultIdentifiers, suggested)
    }
    for (const row of rows.value) {
      row.fresh.identifier = suggestIdentifier(req.uri, row.spot.field, suggested)
      suggested.push(row.fresh.identifier)
      const first = destinationsOf(row).destinations[0]!
      row.destination = first.key
      // 和已有凭据同值的默认转存成它；别的要逐处选
      if (first.kind === 'credential' && !convertBlocker(row) && row.choice === null) {
        row.choice = 'convert'
      }
    }
  }

  // 这次要新建的凭据的标识：新建的每处一条，条目的每个条目一条
  const newIdentifiers = computed(() => {
    const ids: string[] = []
    const items = new Set<string>()
    for (const row of rows.value) {
      if (row.choice !== 'convert') continue
      const d = selectedOf(row)
      if (d.kind === 'new' && !row.created) ids.push(row.fresh.identifier)
      if (d.kind === 'vault' && !createdVault.value.has(itemKey(d)) && !items.has(itemKey(d))) {
        items.add(itemKey(d))
        ids.push(vaultIdentifiers[itemKey(d)] ?? '')
      }
    }
    return ids
  })

  function identifierProblem(identifier: string): string | null {
    if (taken.value.includes(identifier)) return '标识已被占用'
    if (newIdentifiers.value.filter((i) => i === identifier).length > 1) return '标识重复'
    return null
  }

  // 新建的凭据的请求，界面上先按接口的定义检查
  function newBody(row: SpotRow) {
    const url = row.fresh.url.trim()
    const expiresAt =
      row.fresh.expires && !row.fresh.expiresBad ? fromLocalInput(row.fresh.expires) : null
    return {
      identifier: row.fresh.identifier,
      name: row.fresh.name.trim(),
      source: {
        kind: 'new' as const,
        values: { [row.fresh.field]: row.spot.value ?? '' },
        ...(url ? { url } : {}),
      },
      ...(expiresAt ? { expiresAt } : {}),
    }
  }
  function vaultBody(d: Extract<ConvertDestination, { kind: 'vault' }>) {
    const identifier = vaultIdentifiers[itemKey(d)] ?? ''
    return {
      identifier,
      name: clipText(d.itemName.trim(), 100) || identifier,
      source: { kind: 'vault' as const, connectionId: d.connectionId, itemId: d.itemId },
    }
  }

  // 一处的问题：没选、转存的去处填得不对
  function rowProblem(row: SpotRow): string | null {
    if (!row.choice) return '请选择转存为凭据或不是凭据'
    if (row.choice === 'ignore') return null
    const blocker = convertBlocker(row)
    if (blocker) return blocker
    const value = row.spot.value!
    const d = selectedOf(row)
    if (d.kind === 'credential') return null
    if (d.kind === 'vault') {
      if (createdVault.value.has(itemKey(d))) return null
      const body = vaultBody(d)
      const parsed = CreateCredentialRequest.safeParse(body)
      if (!parsed.success) return parsed.error.issues[0]?.message ?? '填写内容有误'
      // 名称取条目名称，和标识一样是明文
      if ([body.identifier, body.name].some((t) => t.includes(value))) return TEXTS_HAVE_VALUE
      return identifierProblem(body.identifier)
    }
    if (row.created) return null
    const waiting = storeBlocker({ store: newStore.store.value, failed: newStore.failed.value })
    if (waiting) return waiting
    const expires = optionalExpiresProblem(row.fresh.expires, row.fresh.expiresBad)
    if (expires) return expires
    const parsed = CreateCredentialRequest.safeParse(newBody(row))
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '填写内容有误'
    const f = row.fresh
    if ([f.identifier, f.name, f.field, f.url].some((t) => t.includes(value))) {
      return TEXTS_HAVE_VALUE
    }
    return identifierProblem(f.identifier)
  }

  // 预览：这一处会换成的占位符。条目的字段名在建好之前是推出来的
  function placeholderFor(row: SpotRow): string {
    const d = selectedOf(row)
    if (d.kind === 'credential') return placeholderOf(d.identifier, d.field)
    if (d.kind === 'vault') {
      const created = createdVault.value.get(itemKey(d))
      const field =
        created?.fields.find((f) => f.itemField === d.itemField)?.name ??
        vaultFieldName(null, d.itemField)
      return placeholderOf(created?.identifier ?? vaultIdentifiers[itemKey(d)] ?? '', field)
    }
    return placeholderOf(row.fresh.identifier, row.fresh.field)
  }

  const problem = computed(() => {
    for (const row of rows.value) {
      const p = rowProblem(row)
      if (p) return p
    }
    return null
  })
  const ready = computed(() => !!request.value && !busy.value && !matching.value && !problem.value)

  // 先建好要转存的凭据，再换掉正文里的值，交给调用方保存。中途失败时建好的留着，再点不重建
  async function proceed() {
    const req = request.value
    if (!req || !ready.value) return
    const id = runId
    const sid = spaceId.value
    busy.value = true
    failure.value = null
    failureDetail.value = null
    orphan.value = null
    let createdAny = false
    try {
      for (const row of rows.value) {
        if (row.choice !== 'convert') continue
        const d = selectedOf(row)
        if (d.kind === 'vault' && !createdVault.value.has(itemKey(d))) {
          const credential = await api.createCredential(sid, vaultBody(d))
          createdAny = true
          if (id !== runId) return
          createdVault.value = new Map(createdVault.value).set(itemKey(d), credential)
        } else if (d.kind === 'new' && !row.created) {
          const done = await api.createCredential(sid, newBody(row))
          createdAny = true
          if (id !== runId) return
          row.created = true
          stored.value = [...stored.value, { identifier: done.identifier, storedIn: done.storedIn }]
        }
      }
      const replacements: { value: string; placeholder: string }[] = []
      for (const row of rows.value) {
        if (row.choice !== 'convert') continue
        const d = selectedOf(row)
        if (d.kind === 'vault') {
          const created = createdVault.value.get(itemKey(d))!
          const field = created.fields.find((f) => f.itemField === d.itemField)?.name
          if (!field) {
            failure.value = `条目「${d.itemName}」的这个字段未对应到凭据，请改选其他去处`
            return
          }
          replacements.push({
            value: row.spot.value!,
            placeholder: placeholderOf(created.identifier, field),
          })
        } else {
          replacements.push({ value: row.spot.value!, placeholder: placeholderFor(row) })
        }
      }
      const ignored = [
        ...(req.ignored ?? []),
        ...rows.value.flatMap((r) => (r.choice === 'ignore' && r.spot.value ? [r.spot.value] : [])),
      ]
      const choices = rows.value.map((r) => r.choice!)
      onProceed({
        source: req.content,
        content: replaceValues(req.content, replacements),
        flags: saveFlags(ignored.length ? [...choices, 'ignore'] : choices),
        replacements,
        ignored,
      })
    } catch (err) {
      const left = orphanVaultItem(err)
      // 留下的条目出现在条目列表里，可以起标识
      if (left) void queryClient.invalidateQueries({ queryKey: ['vault-items', sid] })
      if (id !== runId) return
      failure.value = err instanceof ApiError ? err.message : '新建凭据失败'
      failureDetail.value = writeFailureNext(err, 'create').detail
      orphan.value = left
    } finally {
      if (createdAny) {
        for (const key of ['credentials', 'vault-items']) {
          void queryClient.invalidateQueries({ queryKey: [key, sid] })
        }
        // 新建的凭据可能设了快到期的到期时间
        void invalidateInboxCounts(queryClient, sid)
      }
      if (id === runId) busy.value = false
    }
  }

  // 照样保存：正文不改，这条记忆进待处理
  function saveAnyway() {
    const req = request.value
    if (!req || !canSaveAnyway.value || busy.value) return
    onProceed({
      source: req.content,
      content: req.content,
      flags: saveFlags([], true),
      replacements: [],
      ignored: [],
    })
  }

  // 已经起好标识的条目，不能再改标识
  const lockedItems = computed(() => new Set(createdVault.value.keys()))

  return {
    rows,
    matching,
    matchFailure,
    unavailableConnections,
    unreadableCredentials,
    vaultIdentifiers,
    createdVault,
    lockedItems,
    busy,
    failure,
    failureDetail,
    orphan,
    stored,
    store: newStore.store,
    storeIssue: newStore.issue,
    storeFailed: newStore.failed,
    problem,
    ready,
    convertBlocker,
    destinationsOf,
    selectedOf,
    rowProblem,
    placeholderFor,
    proceed,
    saveAnyway,
  }
}
