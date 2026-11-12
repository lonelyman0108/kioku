import type { MemberRole } from '@kioku/contracts'
import { defineAsyncComponent, type Component } from 'vue'
import type { RouteLocationNormalized } from 'vue-router'

import { icons } from './icons'

// 设置分三组：个人（当前账号）、空间（地址里的空间，个人与实例页面上是会话里当前的空间）、实例（只给实例管理员）。
// 三组共用一个骨架，标题下面的分页列出看得到的组，左栏是当前组的小节，右边是当前小节。加小节只在 SETTINGS_SECTIONS 里加一项、写一个组件

export const SETTINGS_GROUPS = [
  { key: 'account', label: '个人', icon: icons.account, route: 'account-settings' },
  { key: 'space', label: '空间', icon: icons.space, route: 'space-settings' },
  { key: 'instance', label: '实例', icon: icons.instance, route: 'instance-settings' },
] as const

export type SettingsGroupKey = (typeof SETTINGS_GROUPS)[number]['key']

// 判断小节给不给看用到的：实例管理员、当前账号在这一组的空间里的角色（个人与实例组里是会话里当前的空间）
export interface SettingsViewer {
  isAdmin: boolean
  role: MemberRole | null
}

export interface SettingsSection {
  group: SettingsGroupKey
  // 地址里的一段
  key: string
  label: string
  icon: string
  // 小节的内容，按需加载。有未保存的改动时经 v-model:dirty 报给页面
  component: Component
  visible?: (viewer: SettingsViewer) => boolean
}

const lazy = (load: () => Promise<{ default: Component }>) => defineAsyncComponent(load)

// 组内的顺序就是左栏的顺序
export const SETTINGS_SECTIONS = [
  {
    group: 'account',
    key: 'account',
    label: '账号与登录',
    icon: icons.accountLogin,
    component: lazy(() => import('./components/AccountLoginSettings.vue')),
  },
  {
    group: 'account',
    key: 'appearance',
    label: '外观',
    icon: icons.appearance,
    component: lazy(() => import('./components/AppearanceSettings.vue')),
  },
  {
    group: 'space',
    key: 'general',
    label: '概况',
    icon: icons.general,
    component: lazy(() => import('./components/SpaceGeneralSettings.vue')),
  },
  {
    group: 'space',
    key: 'members',
    label: '成员',
    icon: icons.members,
    component: lazy(() => import('./components/SpaceMembers.vue')),
  },
  {
    group: 'space',
    key: 'recall',
    label: '召回与启动加载',
    icon: icons.tuning,
    component: lazy(() => import('./components/SpaceRecallSettings.vue')),
  },
  {
    group: 'space',
    key: 'extraction',
    label: '抽取与整理',
    icon: icons.extraction,
    component: lazy(() => import('./components/SpaceExtractionSettings.vue')),
  },
  {
    group: 'space',
    key: 'transfer',
    label: '导入与导出',
    icon: icons.transfer,
    component: lazy(() => import('./components/SpaceTransferSettings.vue')),
  },
  {
    group: 'instance',
    key: 'accounts',
    label: '账号',
    icon: icons.accounts,
    component: lazy(() => import('./components/InstanceAccounts.vue')),
  },
  {
    group: 'instance',
    key: 'spaces',
    label: '空间',
    icon: icons.spaces,
    component: lazy(() => import('./components/InstanceSpaces.vue')),
  },
  {
    group: 'instance',
    key: 'models',
    label: '模型',
    icon: icons.models,
    component: lazy(() => import('./components/ModelSettings.vue')),
  },
  {
    group: 'instance',
    key: 'security',
    label: '安全',
    icon: icons.security,
    component: lazy(() => import('./components/MasterKeySettings.vue')),
  },
  {
    group: 'instance',
    key: 'data',
    label: '数据与保留',
    icon: icons.data,
    component: lazy(() => import('./components/DataSettings.vue')),
  },
  {
    group: 'instance',
    key: 'prompts',
    label: '提示词与默认值',
    icon: icons.prompts,
    component: lazy(() => import('./components/InstancePromptSettings.vue')),
  },
  {
    group: 'instance',
    key: 'system',
    label: '系统信息',
    icon: icons.system,
    component: lazy(() => import('./components/SystemInfoSettings.vue')),
  },
] as const satisfies readonly SettingsSection[]

type SectionOf<G extends SettingsGroupKey> = Extract<
  (typeof SETTINGS_SECTIONS)[number],
  { group: G }
>['key']
export type AccountSectionKey = SectionOf<'account'>
export type SpaceSectionKey = SectionOf<'space'>
export type InstanceSectionKey = SectionOf<'instance'>

// 这一组里给当前账号看的小节
export function visibleSections(
  group: SettingsGroupKey,
  viewer: SettingsViewer,
): readonly SettingsSection[] {
  return (SETTINGS_SECTIONS as readonly SettingsSection[]).filter(
    (section) => section.group === group && (section.visible?.(viewer) ?? true),
  )
}

// 分页列哪几组：个人一直有；空间组要有空间；实例组只给实例管理员
export function visibleGroups(viewer: SettingsViewer & { hasSpace: boolean }): SettingsGroupKey[] {
  return SETTINGS_GROUPS.filter(
    (group) =>
      (group.key !== 'space' || viewer.hasSpace) && (group.key !== 'instance' || viewer.isAdmin),
  ).map((group) => group.key)
}

// 设置页里的导航算不算离开：同一组里换空间算，换小节不算（各小节都还挂着）。
// 换组是换路由组件，由离开路由的确认处理，不经过这里
export const leavesSettingsPage = (
  to: Pick<RouteLocationNormalized, 'params'>,
  from: Pick<RouteLocationNormalized, 'params'>,
): boolean => to.params.spaceId !== from.params.spaceId

// 当前看哪一节：地址里的小节不存在、看不到（链接过期、手写、权限变了）时看第一个看得到的
export function currentSection(
  sections: readonly SettingsSection[],
  value: unknown,
): SettingsSection | undefined {
  return sections.find((section) => section.key === value) ?? sections[0]
}

// 从别的页面链到某一节
// 带上空的 query：从旧地址跳过来时，vue-router 会把旧地址的 ?section= 原样带上
export const accountSettingsRoute = (section?: AccountSectionKey) => ({
  name: 'account-settings',
  params: section ? { section } : {},
  query: {},
})
export const instanceSettingsRoute = (section?: InstanceSectionKey) => ({
  name: 'instance-settings',
  params: section ? { section } : {},
  query: {},
})
export const spaceSettingsRoute = (spaceId: string, section?: SpaceSectionKey) => ({
  name: 'space-settings',
  params: section ? { spaceId, section } : { spaceId },
  query: {},
})

// 小节合并之前的地址（?section=）：书签和别处的旧链接还能到合并后的那一节
const LEGACY_INSTANCE: Record<string, InstanceSectionKey> = {
  embedding: 'models',
  extraction: 'models',
  'master-key': 'security',
  backup: 'data',
  retention: 'data',
  recall: 'data',
}
const LEGACY_SPACE: Record<string, SpaceSectionKey> = {
  budget: 'extraction',
  dream: 'extraction',
  export: 'transfer',
  import: 'transfer',
  lore: 'transfer',
}
const legacyKey = <K extends string>(map: Record<string, K>, value: unknown): K | undefined =>
  typeof value === 'string' && Object.hasOwn(map, value) ? map[value] : undefined

// /settings?section=：认得的小节去实例组，其余（包括不带小节）去个人组
export function legacySettingsRedirect(query: Record<string, unknown>) {
  const section = legacyKey(LEGACY_INSTANCE, query.section)
  return section ? instanceSettingsRoute(section) : accountSettingsRoute()
}

// /spaces/:spaceId/settings?section=：认得的小节换成合并后的；不认得的去掉参数。没有这个参数时为 null，不用跳
export function legacySpaceSettingsRedirect(spaceId: string, query: Record<string, unknown>) {
  if (query.section === undefined) return null
  return spaceSettingsRoute(spaceId, legacyKey(LEGACY_SPACE, query.section))
}

const ROLE_NAMES: Record<MemberRole, string> = {
  owner: '所有者',
  editor: '编辑者',
  viewer: '查看者',
}
export const roleName = (role: MemberRole) => ROLE_NAMES[role]
