import {
  ConvertToCredentialRequest,
  placeholderAllowed,
  type ConsoleMemoryView,
  type ConvertedToCredential,
} from '@kioku/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch, type Ref } from 'vue'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import {
  convertLeftovers,
  occurrences,
  plaintextCandidates,
  suggestIdentifier,
  suggestName,
  valueContext,
  type PlaintextCandidate,
} from '../plaintext'
import { placeholderOf } from '../placeholders'
import { refreshAfterPlaintext } from './usePlaintextActions'

// 转存为凭据的状态和规则，对话框只管长相。规则只认得出值从哪里开始，结尾是猜的，所以值默认遮盖，
// 但要显示过、核对过当前的值才能提交；显示之后还能改。
// 读这条记忆时记下版本，提交带上它：值是这时看到的，期间被改过就由服务端拒绝。
// 值只留在这里，提交成功或者关上就清掉
export function useConvertCredential(
  spaceId: Ref<string>,
  uri: Ref<string | null>,
  onConverted: (memory: ConsoleMemoryView, result: ConvertedToCredential) => void,
) {
  const queryClient = useQueryClient()

  const memory = ref<ConsoleMemoryView | null>(null)
  const loading = ref(false)
  const loadFailure = ref<string | null>(null)
  const form = reactive({ value: '', field: 'password', identifier: '', name: '' })
  const candidates = ref<PlaintextCandidate[]>([])
  // 当前显示着值吗。核对过的那个值记在 checkedValue：隐藏之后改过，要再显示一次才算核对过
  const shown = ref(false)
  const checkedValue = ref<string | null>(null)
  const failure = ref<string | null>(null)
  // 只有服务端上的版本比看到的新时才给：重新读取解决不了别的失败
  const canReload = ref(false)
  const submitting = ref(false)
  const result = ref<ConvertedToCredential | null>(null)

  function pick(candidate: PlaintextCandidate | undefined) {
    form.value = candidate?.value ?? ''
    form.field = candidate?.field ?? 'password'
    shown.value = false
    checkedValue.value = null
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

  // 每次读取一个序号：关掉或者换了一条之后，晚到的结果不算。已经读到过时是重新读取：
  // 填好的留着；值在新的正文里还有就连同字段名留下，没有了就重新猜；都要再核对一次
  let loadId = 0
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
      if (previous) {
        if (occurrences(view.content ?? '', previous.value)) Object.assign(form, previous)
        return
      }
      form.identifier = suggestIdentifier(
        view.uri,
        form.field,
        (existing?.items ?? []).map((c) => c.identifier),
      )
      form.name = suggestName(view.uri)
    } catch (err) {
      if (id === loadId) loadFailure.value = readFailure(err)
    } finally {
      if (id === loadId) loading.value = false
    }
  }

  function reset() {
    loadId++
    memory.value = null
    loading.value = false
    candidates.value = []
    result.value = null
    failure.value = null
    canReload.value = false
    loadFailure.value = null
    Object.assign(form, { value: '', field: 'password', identifier: '', name: '' })
    shown.value = false
    checkedValue.value = null
  }

  // 显示着的值才算核对过
  watch([shown, () => form.value], () => {
    if (shown.value) checkedValue.value = form.value
  })

  const blocked = computed(() => !!memory.value && scopeBlocked(memory.value))
  const content = computed(() => memory.value?.content ?? '')
  const replaced = computed(() => occurrences(content.value, form.value))
  const context = computed(() => (shown.value ? valueContext(content.value, form.value) : null))
  const placeholder = computed(() =>
    form.identifier && form.field ? placeholderOf(form.identifier, form.field) : '',
  )

  const body = computed(() => ({
    memoryId: memory.value?.id ?? '',
    expectedVersion: memory.value?.version ?? 0,
    value: form.value,
    identifier: form.identifier,
    name: form.name.trim(),
    field: form.field,
  }))
  // 提交前在界面上能看出来的问题，服务端照样会检查。规则直接用接口的定义，提示与服务端一致
  const problem = computed<string | null>(() => {
    if (!memory.value || blocked.value) return null
    const parsed = ConvertToCredentialRequest.safeParse(body.value)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '填写内容有误'
    if (!replaced.value) return '正文中没有这段值'
    if (checkedValue.value !== form.value) return '请先显示并核对值'
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

  async function submit() {
    if (submitting.value || !canSubmit.value) return
    const sid = spaceId.value
    const seen = memory.value!
    submitting.value = true
    failure.value = null
    canReload.value = false
    try {
      const done = await api.convertToCredential(sid, body.value)
      form.value = ''
      shown.value = false
      checkedValue.value = null
      result.value = done
      refreshAfterPlaintext(queryClient, sid, done.memory)
      // 版本变了，涉及这条记忆的整理建议随之作废
      for (const key of ['credentials', 'dream-suggestions']) {
        void queryClient.invalidateQueries({ queryKey: [key, sid] })
      }
      onConverted(done.memory, done)
    } catch (err) {
      failure.value = err instanceof ApiError ? err.message : '转存失败'
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        refreshAfterPlaintext(queryClient, sid)
      }
      // 版本冲突和标识冲突都是 409：读一次比版本，不看文字
      if (err instanceof ApiError && err.status === 409) {
        const latest = await readMemory(sid, seen.uri).catch(() => null)
        canReload.value = !!latest && (latest.id !== seen.id || latest.version !== seen.version)
      }
    } finally {
      submitting.value = false
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
    canReload,
    submitting,
    result,
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
