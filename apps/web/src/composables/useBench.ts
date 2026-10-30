import type { BenchMode } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, inject, provide, reactive, ref, watch, type InjectionKey } from 'vue'
import { useRoute, useRouter, type RouteLocationNormalizedLoaded } from 'vue-router'

import { api } from '../api/endpoints'
import { contextDefaults, contextOf } from '../benchForm'
import { ownedApps, usableKeys } from '../benchSession'
import { useSession } from './useSession'

const param = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

// 地址里的选择。只在测试台页面上读：离开时路由先变、组件后卸载，这段时间不跟着路由走
const selectionOf = (route: RouteLocationNormalizedLoaded) => ({
  spaceId: String(route.params.spaceId),
  app: param(route.query.app),
  key: param(route.query.key),
})

// 测试台各分页共享的状态：应用、Key、模式、会话上下文。页面建一份，分页组件用 useBench 取同一份
function createBench() {
  const route = useRoute()
  const router = useRouter()
  const { me } = useSession()

  const selection = reactive(selectionOf(route))
  watch(
    () => route.fullPath,
    () => {
      if (route.name === 'bench') Object.assign(selection, selectionOf(route))
    },
  )
  const spaceId = computed(() => selection.spaceId)

  const apps = useQuery({
    queryKey: computed(() => ['apps', selection.spaceId]),
    queryFn: () => api.apps(selection.spaceId),
  })
  const owned = computed(() => ownedApps(apps.data.value ?? [], me.data.value?.id))
  const appId = computed(() => {
    const list = owned.value
    return list.find((a) => a.id === selection.app)?.id ?? list[0]?.id
  })
  const app = computed(() => owned.value.find((a) => a.id === appId.value) ?? null)

  const keys = useQuery({
    queryKey: computed(() => ['keys', selection.spaceId, appId.value]),
    queryFn: () => api.keys(selection.spaceId, appId.value!),
    enabled: computed(() => Boolean(appId.value)),
  })
  const usable = computed(() => usableKeys(keys.data.value ?? []))
  const keyId = computed(() => {
    const list = usable.value
    return list.find((k) => k.id === selection.key)?.id ?? list[0]?.id
  })
  const key = computed(() => usable.value.find((k) => k.id === keyId.value) ?? null)
  const ready = computed(() => Boolean(app.value && key.value))

  // 选择记在地址里：刷新、分享都还在。模式不记：真实模式每次都要确认
  const select = (query: { app?: string; key?: string }) =>
    void router.replace({ query: { ...route.query, ...query } })
  const selectApp = (id: string) => select({ app: id, key: undefined })
  const selectKey = (id: string) => select({ key: id })

  // 地址里的应用或 Key 用不了（链接是别人的、Key 刚被吊销）时说一声，不悄悄换
  const selectionNotice = computed(() => {
    if (apps.data.value && selection.app && app.value?.id !== selection.app) {
      return '链接里的应用不是你的，或者已经删掉了：只有应用主人能用测试台。这里换成了你自己的应用。'
    }
    if (keys.data.value && selection.key && key.value?.id !== selection.key) {
      return '选中的 Key 已经失效或不属于这个应用：这里换成了它别的有效 Key。'
    }
    return null
  })

  const mode = ref<BenchMode>('rollback')
  const real = computed(() => mode.value === 'real')
  const confirmingReal = ref(false)
  // 切到真实要确认，切回回滚不用
  function requestMode(wantReal: boolean) {
    if (wantReal) confirmingReal.value = true
    else mode.value = 'rollback'
  }
  function confirmReal() {
    confirmingReal.value = false
    mode.value = 'real'
  }
  // 换了应用或 Key 就回到回滚：真实模式是对着这把 Key 确认的
  watch([spaceId, appId, keyId], () => {
    mode.value = 'rollback'
    confirmingReal.value = false
  })

  const contextForm = reactive(contextDefaults())
  const sessionContext = computed(() => contextOf(contextForm))

  return {
    spaceId,
    apps,
    owned,
    appId,
    app,
    keys,
    usable,
    keyId,
    key,
    ready,
    selectApp,
    selectKey,
    selectionNotice,
    mode,
    real,
    confirmingReal,
    requestMode,
    confirmReal,
    contextForm,
    sessionContext,
  }
}

export type Bench = ReturnType<typeof createBench>
const BENCH: InjectionKey<Bench> = Symbol('bench')

export function provideBench(): Bench {
  const bench = createBench()
  provide(BENCH, bench)
  return bench
}

export function useBench(): Bench {
  const bench = inject(BENCH)
  if (!bench) throw new Error('useBench 只能用在测试台页面里')
  return bench
}
