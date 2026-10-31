<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { currentSection, sectionQuery, type SettingsSection } from '../../settingsSections'

// 设置页的骨架：左边一列子导航，右边当前小节，窄屏时子导航是顶上的一行。小节的内容放在和 key 同名的插槽里。
// 所有小节一直挂着，只切换显示：切走再回来，填了一半的表单、选好的文件都还在。当前小节记在地址里，刷新、分享都还在
const props = defineProps<{
  title: string
  sections: readonly SettingsSection[]
  // 有未保存改动的小节：切走之后表单看不见了，在子导航上标出来
  unsaved?: readonly string[]
}>()

const route = useRoute()
const current = computed(() => currentSection(props.sections, route.query.section))

// 各小节共用一个滚动区：切走时记下位置，切回来时回到原处，没看过的从顶上开始
const scroller = ref<HTMLElement | null>(null)
const nav = ref<HTMLElement | null>(null)
const positions = new Map<string, number>()
// 窄屏的子导航横向滚动，当前小节要在屏幕里；宽屏时本来就在，不会动
function revealCurrent() {
  nav.value
    ?.querySelector('[aria-current="page"]')
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
watch(current, async (next, previous) => {
  // 离开这一页时小节也算变了，等下面这一拍的时候组件可能已经卸载，ref 成了 null
  const area = scroller.value
  if (!area) return
  positions.set(previous, area.scrollTop)
  await nextTick()
  area.scrollTop = positions.get(next) ?? 0
  revealCurrent()
})
onMounted(revealCurrent)
</script>

<template>
  <div ref="scroller" class="settings">
    <div class="settings-grid">
      <div class="settings-side">
        <h1 class="settings-title">{{ title }}</h1>
        <nav ref="nav" class="settings-nav" :aria-label="`${title}的小节`">
          <RouterLink
            v-for="section in sections"
            :key="section.key"
            :to="{ query: sectionQuery(sections, section.key) }"
            replace
            class="settings-tab"
            :aria-current="section.key === current ? 'page' : undefined"
          >
            <span>{{ section.label }}</span>
            <span v-if="unsaved?.includes(section.key)" class="tab-unsaved">未保存</span>
          </RouterLink>
        </nav>
      </div>
      <div class="settings-main">
        <section
          v-for="section in sections"
          v-show="section.key === current"
          :key="section.key"
          :aria-label="section.label"
        >
          <slot :name="section.key" />
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
  grid-template-columns: 240px minmax(0, 1fr);
  min-height: 100%;
}
/* 内容很长时子导航还在屏幕里；视口很矮放不下时它自己能滚 */
.settings-side {
  position: sticky;
  top: 0;
  align-self: start;
  max-height: calc(100svh - 52px);
  padding: 22px 0 24px;
  overflow-y: auto;
}
.settings-title {
  margin-bottom: 17px;
  padding: 0 24px 0 32px;
  font-size: 28px;
  font-weight: 500;
  line-height: 1.3;
  letter-spacing: -0.005em;
}
.settings-nav {
  border-top: 1px solid var(--strata-rule);
}
.settings-tab {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 44px;
  padding: 6px 24px 6px 32px;
  border-bottom: 1px solid var(--ui-border);
  line-height: 1.4;
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
.settings-tab:focus-visible {
  outline-offset: -2px;
}
/* 焦点框默认是墨色，压在反白的行上看不见 */
.settings-tab[aria-current='page']:focus-visible {
  outline-color: var(--strata-on-selected);
}
.tab-unsaved {
  flex: none;
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-warning);
}
.settings-tab[aria-current='page'] .tab-unsaved {
  color: var(--strata-on-selected-muted);
}
.settings-main {
  min-width: 0;
  padding: 24px 32px 56px;
  border-left: 1px solid var(--strata-rule);
}

/* 窄屏：标题跟着内容滚走，子导航贴在顶上，放不下时横向滚动 */
@media (max-width: 1023.98px) {
  .settings-grid {
    display: block;
    min-height: 0;
  }
  .settings-side {
    display: contents;
  }
  .settings-title {
    margin-bottom: 0;
    padding: 16px 16px 10px;
    font-size: 23px;
  }
  .settings-nav {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    overflow-x: auto;
    border-bottom: 1px solid var(--strata-rule);
    background: var(--ui-bg);
    scrollbar-width: none;
  }
  .settings-tab {
    flex: none;
    padding: 6px 12px;
    border-bottom: 0;
    white-space: nowrap;
  }
  .settings-tab:first-child {
    padding-left: 16px;
  }
  .settings-main {
    padding: 18px 16px 40px;
    border-left: 0;
  }
}
</style>
