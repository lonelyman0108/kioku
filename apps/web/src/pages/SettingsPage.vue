<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { useRoute } from 'vue-router'

import type { SettingsFrameGroup } from '../components/strata/SettingsFrame.vue'
import SettingsFrame from '../components/strata/SettingsFrame.vue'
import { useUnsavedChangesGuard } from '../composables/unsavedChanges'
import { useSectionCounts } from '../composables/useSectionCounts'
import { useSession } from '../composables/useSession'
import {
  currentSection,
  leavesSettingsPage,
  roleName,
  SETTINGS_GROUPS,
  visibleGroups,
  visibleSections,
  type SettingsGroupKey,
} from '../settingsSections'

// 三组设置共用的页面，由每组一个的路由组件（AccountSettingsPage 等）包一层，地址里的 :section 是当前小节。
// 各组是不同的路由组件：换组时换掉整页，离开前的确认各组自己注册，一页里只有一份
const props = defineProps<{ group: SettingsGroupKey }>()
const group = computed(() => props.group)
const route = useRoute()
const { me, space } = useSession()

// 空间组用地址里的空间；个人与实例页面上用会话里当前的空间
const viewer = computed(() => ({
  isAdmin: me.data.value?.isAdmin ?? false,
  role: space.value?.role ?? null,
}))
const sections = computed(() => visibleSections(group.value, viewer.value))
const current = computed(() => currentSection(sections.value, route.params.section))

// 哪些小节有未保存的改动：切走之后表单看不见了，左栏上标出来。
// 组内切小节只改地址里的 :section，各小节都还挂着，不算离开；换组、换空间时先确认
const dirty = reactive<Record<string, boolean>>({})
const anyDirty = computed(() => Object.values(dirty).some(Boolean))
useUnsavedChangesGuard(anyDirty, { leavesOn: leavesSettingsPage })

// 空间组里换空间：确认过之后小节按新空间重新挂上（下面的 key），旧空间的改动标记一起清掉
const spaceKey = computed(() => String(route.params.spaceId ?? ''))
watch(spaceKey, () => {
  for (const key of Object.keys(dirty)) delete dirty[key]
})

function asideOf(key: SettingsGroupKey): string | undefined {
  if (key === 'account') return me.data.value?.displayName
  if (key === 'space')
    return space.value ? `${space.value.name} · ${roleName(space.value.role)}` : undefined
  return '仅管理员'
}

function linkTo(key: SettingsGroupKey, section: string) {
  const name = SETTINGS_GROUPS.find((g) => g.key === key)!.route
  return key === 'space'
    ? { name, params: { spaceId: space.value?.id, section } }
    : { name, params: { section } }
}

// 小节后面的条数（成员数）
const counts = useSectionCounts(computed(() => space.value?.id ?? null))

const groups = computed<SettingsFrameGroup[]>(() =>
  visibleGroups({ ...viewer.value, hasSpace: Boolean(space.value) }).flatMap((key) => {
    const meta = SETTINGS_GROUPS.find((g) => g.key === key)!
    const list = visibleSections(key, viewer.value)
    if (!list.length) return []
    return [
      {
        key,
        label: meta.label,
        icon: meta.icon,
        to: linkTo(key, list[0]!.key),
        aside: asideOf(key),
        crumb: key === 'space' && space.value ? `${meta.label} · ${space.value.name}` : meta.label,
        sections: list.map((section) => ({
          key: section.key,
          label: section.label,
          icon: section.icon,
          to: linkTo(key, section.key),
          unsaved: key === group.value && Boolean(dirty[section.key]),
          count: counts.value[`${key}:${section.key}`],
        })),
      },
    ]
  }),
)

const componentOf = (key: string) => sections.value.find((s) => s.key === key)?.component
</script>

<template>
  <SettingsFrame :groups="groups" :group="group" :current="current?.key ?? ''">
    <template #default="{ section }">
      <component
        :is="componentOf(section)"
        :key="`${section}:${spaceKey}`"
        v-model:dirty="dirty[section]"
      />
    </template>
  </SettingsFrame>
</template>
