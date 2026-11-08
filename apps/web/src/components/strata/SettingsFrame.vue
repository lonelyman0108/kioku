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
  // 组标题右边的一句：当前账号、空间与角色、仅管理员
  aside?: string
  // 右边面包屑里组的名字，默认是 label
  crumb?: string
  sections: SettingsFrameSection[]
}

// 设置页的骨架：左栏按组列出小节，右边是当前小节，窄屏时左栏是顶上横向滚动的一行。
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

// 各小节共用一个滚动区：切走时记下位置，切回来时回到原处，没看过的从顶上开始
const scroller = ref<HTMLElement | null>(null)
const nav = ref<HTMLElement | null>(null)
const positions = new Map<string, number>()
// 窄屏的左栏横向滚动，当前小节要在屏幕里；宽屏时本来就在，不会动
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
  <div ref="scroller" class="settings">
    <div class="settings-grid">
      <div class="settings-side">
        <h1 class="settings-title">设置</h1>
        <nav ref="nav" class="settings-nav" aria-label="设置的小节">
          <div v-for="g in groups" :key="g.key" class="settings-group">
            <div class="group-head">
              <UIcon :name="g.icon" class="group-icon" />
              <span class="group-label">{{ g.label }}</span>
              <span v-if="g.aside" class="group-aside" :title="g.aside">{{ g.aside }}</span>
            </div>
            <!-- 组内切小节不留历史记录，返回键直接离开设置页；换组是换页面，照常留 -->
            <RouterLink
              v-for="section in g.sections"
              :key="section.key"
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
      </div>
      <div class="settings-main">
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
</template>

<style scoped>
.settings {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}
.settings-grid {
  display: grid;
  grid-template-columns: 264px minmax(0, 1fr);
  min-height: 100%;
}
/* 内容很长时左栏还在屏幕里；视口很矮放不下时它自己能滚 */
.settings-side {
  position: sticky;
  top: 0;
  align-self: start;
  max-height: calc(100svh - 52px);
  padding: 20px 0 40px;
  overflow-y: auto;
}
.settings-title {
  padding: 0 24px 4px;
  font-size: 24px;
  font-weight: 500;
  line-height: 1.3;
}
.settings-group {
  margin-top: 16px;
}
.group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 4px 24px 6px;
  border-bottom: 1px solid var(--strata-rule);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.group-icon {
  flex: none;
  width: 16px;
  height: 16px;
}
.group-label {
  flex: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text);
}
.group-aside {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  max-width: 1180px;
  padding: 22px 40px 56px;
  border-left: 1px solid var(--strata-rule);
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

/* 窄屏：左栏换成贴在顶上的一行，放不下时横向滚动；组之间一条竖线，组名打头 */
@media (max-width: 1023.98px) {
  .settings-grid {
    display: block;
    min-height: 0;
  }
  .settings-side {
    display: contents;
  }
  .settings-title {
    padding: 16px 16px 10px;
    font-size: 23px;
  }
  .settings-nav {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    overflow-x: auto;
    border-top: 1px solid var(--strata-rule);
    border-bottom: 1px solid var(--strata-rule);
    background: var(--ui-bg);
    scrollbar-width: none;
  }
  .settings-group {
    display: flex;
    flex: none;
    margin-top: 0;
  }
  .settings-group + .settings-group {
    border-left: 1px solid var(--ui-border-accented);
  }
  .group-head {
    flex: none;
    padding: 0 6px 0 12px;
    border-bottom: 0;
  }
  .settings-group:first-child .group-head {
    padding-left: 16px;
  }
  .group-icon,
  .group-aside {
    display: none;
  }
  .group-label {
    font-size: 12px;
    color: var(--ui-text-muted);
  }
  .settings-tab {
    flex: none;
    gap: 6px;
    min-height: 44px;
    padding: 6px 12px;
    border-bottom: 0;
    white-space: nowrap;
  }
  .settings-tab[aria-current='page'] {
    border-bottom: 0;
  }
  .settings-main {
    padding: 14px 16px 40px;
    border-left: 0;
  }
}
</style>
