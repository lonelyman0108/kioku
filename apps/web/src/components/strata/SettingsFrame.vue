<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { RouteLocationRaw } from 'vue-router'

import { icons } from '../../icons'
import FlagTag from './FlagTag.vue'

export interface SettingsFrameSection {
  key: string
  label: string
  icon: string
  to: RouteLocationRaw
  // 有未保存的改动：切走之后表单看不见了，在左栏标出来
  unsaved?: boolean
  // 小节后面的条数（成员数、账号数），没有时不显示
  count?: number
}
export interface SettingsFrameGroup {
  key: string
  label: string
  icon: string
  // 换到这一组时去哪：组里第一个看得到的小节
  to: RouteLocationRaw
  // 分页上组名后面的一句：当前账号、空间与角色、仅管理员
  aside?: string
  // 右边面包屑里组的名字，默认是 label
  crumb?: string
  sections: SettingsFrameSection[]
}
// 设置页的骨架：宽屏左边是统一双级目录树，窄屏顶上是分组与小节两行横向切换条。
// 标题与左栏都不随内容滚动：滚的只有右边这一栏，切小节时导航不会在指针下面挪位置，也没有东西盖在表单上。
// 只有当前这一组的小节挂在页面上，内容由页面放进默认插槽（按小节的 key 调用）；组里的小节一直挂着，只切换显示：
// 切走再回来，填了一半的表单、选好的文件都还在。别的组是别的页面，离开时由页面确认未保存的改动
const props = defineProps<{
  groups: readonly SettingsFrameGroup[]
  group: string
  current: string
  spaceId?: string
}>()

const active = computed(() => props.groups.find((g) => g.key === props.group))
const panes = computed(() => active.value?.sections ?? [])
const currentPane = computed(() => panes.value.find((s) => s.key === props.current))

// 各小节共用一个滚动区（右边那一栏）：切走时按组、空间与小节记下位置，切回来时回到原处
const scroller = ref<HTMLElement | null>(null)
const treeNav = ref<HTMLElement | null>(null)
const mobileNav = ref<HTMLElement | null>(null)
const positions = new Map<string, number>()

const posKey = (group: string, spaceId: string | undefined, section: string) =>
  `${group}:${spaceId ?? ''}:${section}`

// 窄屏横向滚动条与左栏树中都要把当前小节滚动进可见范围
function revealCurrent() {
  for (const el of [treeNav.value, mobileNav.value]) {
    el?.querySelector('[aria-current="page"]')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }
}

watch(
  [() => props.current, () => props.spaceId],
  async ([next, nextSpace], [previous, prevSpace]) => {
    // 离开这一页时小节也算变了，等下面这一拍的时候组件可能已经卸载，ref 成了 null
    const area = scroller.value
    if (!area) return
    positions.set(posKey(props.group, prevSpace, previous), area.scrollTop)
    await nextTick()
    area.scrollTop = positions.get(posKey(props.group, nextSpace, next)) ?? 0
    revealCurrent()
  },
)
onMounted(revealCurrent)
</script>

<template>
  <div class="settings">
    <!-- 窄屏顶上保留两组横向导航，宽屏由左侧统一双级树承载 -->
    <div class="narrow-chrome">
      <h1 class="narrow-title">设置</h1>
      <nav class="settings-groups" aria-label="设置的分组">
        <RouterLink
          v-for="g in groups"
          :key="g.key"
          :to="g.key === group && currentPane ? currentPane.to : g.to"
          :replace="g.key === group"
          class="group-tab"
          :aria-current="g.key === group ? 'page' : undefined"
        >
          <UIcon :name="g.icon" class="group-icon" />
          <span class="group-label">{{ g.label }}</span>
          <span v-if="g.aside" class="group-aside" :title="g.aside">{{ g.aside }}</span>
        </RouterLink>
      </nav>
      <nav ref="mobileNav" class="settings-nav" aria-label="设置的小节">
        <RouterLink
          v-for="section in panes"
          :key="section.key"
          :to="section.to"
          replace
          class="settings-tab"
          :aria-current="section.key === current ? 'page' : undefined"
        >
          <UIcon :name="section.icon" class="tab-icon" />
          <span class="tab-label">{{ section.label }}</span>
          <span v-if="section.unsaved" class="tab-unsaved">未保存</span>
          <span v-else-if="section.count" class="tab-count">{{ section.count }}</span>
        </RouterLink>
      </nav>
    </div>

    <div class="settings-grid">
      <!-- 宽屏统一双级目录树 -->
      <aside class="settings-side">
        <div class="side-header">
          <h1 class="settings-title">设置</h1>
        </div>

        <nav ref="treeNav" class="settings-tree" aria-label="设置目录">
          <div v-for="g in groups" :key="g.key" class="tree-group">
            <div class="tree-group-head">
              <span class="tree-group-title">
                <UIcon :name="g.icon" class="tree-group-icon" aria-hidden="true" />
                <span>{{ g.label }}</span>
              </span>
              <span v-if="g.aside" class="tree-group-aside" :title="g.aside">{{ g.aside }}</span>
            </div>
            <RouterLink
              v-for="section in g.sections"
              :key="`${g.key}:${section.key}`"
              :to="section.to"
              :replace="g.key === group"
              class="settings-tab"
              :aria-current="g.key === group && section.key === current ? 'page' : undefined"
            >
              <UIcon :name="section.icon" class="tab-icon" />
              <span class="tab-label">{{ section.label }}</span>
              <span v-if="section.unsaved" class="tab-unsaved">未保存</span>
              <span v-else-if="section.count" class="tab-count">{{ section.count }}</span>
            </RouterLink>
          </div>
        </nav>
      </aside>

      <div ref="scroller" class="settings-main">
        <div class="settings-body">
          <header v-if="active && currentPane" class="body-head">
            <div>
              <p class="settings-crumb">
                <span>{{ active.crumb ?? active.label }}</span>
                <UIcon :name="icons.chevronRight" class="crumb-icon" />
                <span>{{ currentPane.label }}</span>
              </p>
              <h2 class="settings-heading">{{ currentPane.label }}</h2>
            </div>
            <FlagTag v-if="active.aside" class="scope-pill">{{ active.aside }}</FlagTag>
          </header>
          <section
            v-for="section in panes"
            v-show="section.key === current"
            :key="section.key"
            :aria-label="section.label"
          >
            <slot :section="section.key" />
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.narrow-chrome {
  display: none;
}
.settings-grid {
  display: grid;
  flex: 1;
  grid-template-rows: minmax(0, 1fr);
  grid-template-columns: 272px minmax(0, 1fr);
  min-height: 0;
}
/* 左栏统一双级树不跟着右边滚；高度不够时自己能滚 */
.settings-side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  background: var(--ui-bg-muted);
}
.side-header {
  padding: 18px 16px 14px;
  border-bottom: 1px solid var(--ui-border);
}
.settings-title {
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
}
.settings-tree {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 14px 10px 36px;
}
.tree-group {
  display: flex;
  flex-direction: column;
}
.tree-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 10px 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.tree-group-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}
.tree-group-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
}
.tree-group-aside {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings-tab {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 5px 12px;
  border: 1px solid transparent;
  line-height: 1.4;
  color: var(--ui-text-toned);
}
.tab-icon {
  display: inline-block;
  flex: none;
  width: 15px;
  height: 15px;
  color: var(--ui-text-dimmed);
}
.tab-label {
  min-width: 0;
}
.settings-tab:hover {
  background: var(--ui-bg);
  color: var(--ui-text);
}
.settings-tab[aria-current='page'],
.settings-tab[aria-current='page']:hover {
  border-color: var(--strata-selected);
  background: var(--strata-selected);
  color: var(--strata-on-selected);
  font-weight: 600;
}
.settings-tab[aria-current='page'] .tab-icon {
  color: var(--strata-on-selected);
}
.settings-tab:focus-visible {
  outline-offset: -2px;
}
/* 焦点框默认是墨色，压在反白的行上看不见 */
.settings-tab[aria-current='page']:focus-visible {
  outline-color: var(--strata-on-selected);
}
.tab-unsaved,
.tab-count {
  flex: none;
  margin-left: auto;
  font-size: 12px;
  font-weight: 400;
}
.tab-unsaved {
  color: var(--ui-warning);
}
.tab-count {
  font-family: var(--font-mono);
  color: var(--ui-text-dimmed);
}
.settings-tab[aria-current='page'] :is(.tab-unsaved, .tab-count) {
  color: var(--strata-on-selected-muted);
}
.settings-main {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  border-left: 1px solid var(--strata-rule);
}
.settings-body {
  max-width: 1180px;
  padding: 22px 36px 56px;
}
.body-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px 16px;
  padding-bottom: 12px;
  margin-bottom: 20px;
  border-bottom: 2px solid var(--strata-rule);
}
.settings-crumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.crumb-icon {
  width: 12px;
  height: 12px;
}
.settings-heading {
  margin-top: 4px;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.3;
}
.scope-pill {
  margin-bottom: 2px;
}

/* 窄屏：顶上保留分组与小节两行横向切换条，左栏隐藏，把宽度留给表单 */
@media (max-width: 1023.98px) {
  .narrow-chrome {
    display: block;
    flex: none;
  }
  .narrow-title {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .settings-groups {
    display: flex;
    min-height: 44px;
    padding: 0 4px;
    border-bottom: 1px solid var(--strata-rule);
  }
  .group-tab {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 3px 12px 0;
    border-bottom: 3px solid transparent;
    line-height: 1.4;
    white-space: nowrap;
    color: var(--ui-text-muted);
  }
  .group-tab[aria-current='page'] {
    flex: 0 1 auto;
    border-bottom-color: var(--strata-rule);
    font-weight: 600;
    color: var(--ui-text);
  }
  .group-tab:not([aria-current='page']) .group-aside {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .group-icon {
    display: inline-block;
    flex: none;
    width: 16px;
    height: 16px;
  }
  .group-label {
    flex: none;
  }
  .group-aside {
    min-width: 0;
    max-width: 16em;
    overflow: hidden;
    font-size: 12px;
    font-weight: 400;
    text-overflow: ellipsis;
    color: var(--ui-text-muted);
  }
  .settings-grid {
    display: flex;
    flex-direction: column;
  }
  .settings-side {
    display: none;
  }
  .settings-nav {
    display: flex;
    overflow-x: auto;
    border-bottom: 1px solid var(--strata-rule);
    scrollbar-width: none;
  }
  .settings-tab {
    flex: none;
    gap: 6px;
    min-height: 44px;
    padding: 6px 12px;
    border: 0;
    white-space: nowrap;
  }
  .settings-tab:first-child {
    padding-left: 16px;
  }
  .settings-main {
    flex: 1;
    border-left: 0;
  }
  .settings-body {
    padding: 16px 16px 40px;
  }
}
</style>
