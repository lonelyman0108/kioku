<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { RouteLocationRaw } from 'vue-router'

import { icons } from '../../icons'

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

// 设置页的骨架：标题下面一行分页换组，左栏只列当前这一组的小节，右边是当前小节；
// 窄屏时顶上是两行，分页一行、小节一行（放不下时横向滚动），标题只留给读屏。
// 标题、分页与左栏都不随内容滚动：滚的只有右边这一栏，切小节时导航不会在指针下面挪位置，也没有东西盖在表单上。
// 只有当前这一组的小节挂在页面上，内容由页面放进默认插槽（按小节的 key 调用）；组里的小节一直挂着，只切换显示：
// 切走再回来，填了一半的表单、选好的文件都还在。别的组是别的页面，离开时由页面确认未保存的改动
const props = defineProps<{
  groups: readonly SettingsFrameGroup[]
  group: string
  current: string
}>()

const active = computed(() => props.groups.find((g) => g.key === props.group))
const panes = computed(() => active.value?.sections ?? [])
const currentPane = computed(() => panes.value.find((s) => s.key === props.current))

// 各小节共用一个滚动区（右边那一栏）：切走时记下位置，切回来时回到原处，没看过的从顶上开始
const scroller = ref<HTMLElement | null>(null)
const nav = ref<HTMLElement | null>(null)
const positions = new Map<string, number>()
// 窄屏的小节那一行横向滚动，当前小节要在屏幕里；宽屏时本来就在，不会动
function revealCurrent() {
  nav.value
    ?.querySelector('[aria-current="page"]')
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
watch(
  () => props.current,
  async (next, previous) => {
    // 离开这一页时小节也算变了，等下面这一拍的时候组件可能已经卸载，ref 成了 null
    const area = scroller.value
    if (!area) return
    positions.set(previous, area.scrollTop)
    await nextTick()
    area.scrollTop = positions.get(next) ?? 0
    revealCurrent()
  },
)
onMounted(revealCurrent)
</script>

<template>
  <div class="settings">
    <h1 class="settings-title">设置</h1>
    <!-- 换组是换页面，照常留历史记录；当前这一组的分页就是现在这一页，点了不动 -->
    <nav class="settings-groups" aria-label="设置的分组">
      <RouterLink
        v-for="g in groups"
        :key="g.key"
        :to="g.key === group && currentPane ? currentPane.to : g.to"
        class="group-tab"
        :aria-current="g.key === group ? 'page' : undefined"
      >
        <UIcon :name="g.icon" class="group-icon" />
        <span class="group-label">{{ g.label }}</span>
        <span v-if="g.aside" class="group-aside" :title="g.aside">{{ g.aside }}</span>
      </RouterLink>
    </nav>
    <div class="settings-grid">
      <div class="settings-side">
        <!-- 组内切小节不留历史记录，返回键直接离开设置页 -->
        <nav ref="nav" class="settings-nav" aria-label="设置的小节">
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
      <div ref="scroller" class="settings-main">
        <div class="settings-body">
          <p v-if="active && currentPane" class="settings-crumb">
            <span>{{ active.crumb ?? active.label }}</span>
            <UIcon :name="icons.chevronRight" class="crumb-icon" />
            <span>{{ currentPane.label }}</span>
          </p>
          <section
            v-for="section in panes"
            v-show="section.key === current"
            :key="section.key"
            :aria-label="section.label"
          >
            <h2 class="settings-heading">{{ section.label }}</h2>
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
.settings-title {
  flex: none;
  padding: 20px 24px 6px;
  font-size: 24px;
  font-weight: 500;
  line-height: 1.3;
}
/* 分页：一条墨线托着，当前组是粗的墨线加粗体；小节用反白，两级分得开 */
.settings-groups {
  display: flex;
  flex: none;
  min-height: 45px;
  padding: 0 8px;
  border-bottom: 1px solid var(--strata-rule);
}
.group-tab {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 3px 16px 0;
  border-bottom: 3px solid transparent;
  line-height: 1.4;
  white-space: nowrap;
  color: var(--ui-text-muted);
}
.group-tab:hover {
  background: var(--ui-bg-muted);
  color: var(--ui-text);
}
.group-tab[aria-current='page'] {
  border-bottom-color: var(--strata-rule);
  font-weight: 600;
  color: var(--ui-text);
}
.group-tab:focus-visible {
  outline-offset: -2px;
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
  max-width: 18em;
  overflow: hidden;
  font-size: 12px;
  font-weight: 400;
  text-overflow: ellipsis;
  color: var(--ui-text-muted);
}
.settings-grid {
  display: grid;
  flex: 1;
  grid-template-rows: minmax(0, 1fr);
  grid-template-columns: 264px minmax(0, 1fr);
  min-height: 0;
}
/* 左栏不跟着内容滚；视口很矮放不下时它自己能滚 */
.settings-side {
  min-height: 0;
  padding-bottom: 40px;
  overflow-y: auto;
}
.settings-tab {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 38px;
  padding: 4px 24px;
  border-bottom: 1px solid var(--ui-border);
  line-height: 1.4;
  color: var(--ui-text-toned);
}
.tab-icon {
  display: inline-block;
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--ui-text-dimmed);
}
.tab-label {
  min-width: 0;
}
.settings-tab:hover {
  background: var(--ui-bg-muted);
}
.settings-tab[aria-current='page'],
.settings-tab[aria-current='page']:hover {
  border-bottom-color: var(--strata-selected);
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
  padding: 22px 40px 56px;
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
  margin: 6px 0 20px;
  font-size: 22px;
  font-weight: 500;
  line-height: 1.3;
}

/* 窄屏：顶上两行，第一行分页，第二行当前组的小节，放不下时横向滚动；标题只留给读屏，把高度让给内容 */
@media (max-width: 1023.98px) {
  .settings-title {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .settings-groups {
    padding: 0 4px;
  }
  .group-tab {
    flex: none;
    gap: 6px;
    padding: 3px 12px 0;
  }
  /* 三个分页要排进一行：只有当前组显示后面那一句，放不下时省略；别的组那一句只留给读屏 */
  .group-tab[aria-current='page'] {
    flex: 0 1 auto;
  }
  .group-tab:not([aria-current='page']) .group-aside {
    position: absolute;
    width: 1px;
    height: 1px;
    clip-path: inset(50%);
  }
  .settings-grid {
    display: flex;
    flex-direction: column;
  }
  .settings-side {
    flex: none;
    padding-bottom: 0;
    overflow: visible;
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
    border-bottom: 0;
    white-space: nowrap;
  }
  .settings-tab:first-child {
    padding-left: 16px;
  }
  .settings-tab[aria-current='page'] {
    border-bottom: 0;
  }
  .settings-main {
    flex: 1;
    border-left: 0;
  }
  .settings-body {
    padding: 14px 16px 40px;
  }
}
</style>
