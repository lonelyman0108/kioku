<script setup lang="ts">
import type { StrataBand } from '@kioku/contracts'

import KiokuMark from '../KiokuMark.vue'
import { isConversationBand, STACK } from './strata'

// 登录、初始化、连接失败共用的一屏：文字标在上，内容在下，页面底边压一段地层作为装饰。
// 只铺色带底色，不铺纹理：纹理表示敏感级，这里没有数据。
// 连接失败页是静态引入的（后端连不上时按需加载的文件也拿不到），这里也不能依赖按需加载的东西

// wide：内容是一张表单（浏览器授权的确认页）时放宽，默认是登录框的宽度
defineProps<{ wide?: boolean }>()

// 各色带高度比例，仅作页面底部视觉装饰
const HEIGHTS: Record<StrataBand, number> = {
  episode: 9,
  fact: 14,
  personal: 30,
  'shared-away': 13,
  persona: 14,
  primary: 20,
}

const bands = STACK.map((band, index) => ({
  band,
  height: HEIGHTS[band],
  // 和上面一类的分界。来自对话的两类和下面四类之间用虚线
  dashed: index > 0 && isConversationBand(STACK[index - 1]!) !== isConversationBand(band),
}))
</script>

<template>
  <div class="entry">
    <main class="entry-main">
      <KiokuMark :height="84" class="entry-mark" />
      <div class="entry-body" :class="{ wide }"><slot /></div>
    </main>
    <div class="entry-strata" aria-hidden="true">
      <i
        v-for="band in bands"
        :key="band.band"
        :class="{ dashed: band.dashed }"
        :style="{ flexGrow: band.height, background: `var(--layer-${band.band})` }"
      />
    </div>
  </div>
</template>

<style scoped>
.entry {
  display: flex;
  flex-direction: column;
  min-height: 100svh;
}
.entry-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 24px 48px;
}
.entry-mark {
  flex: none;
  color: var(--ui-text-highlighted);
}
.entry-body {
  width: 100%;
  max-width: 22rem;
  margin-top: 36px;
}
.entry-body.wide {
  max-width: 54rem;
}
/* 跟着内容走，不固定在视口上：窗口很矮或键盘弹出时不会盖住表单 */
.entry-strata {
  flex: none;
  display: flex;
  flex-direction: column;
  height: clamp(64px, 11vh, 108px);
  border-top: 1px solid var(--strata-rule);
}
.entry-strata i {
  flex-basis: 0;
}
/* 层之间的线退后，只有来自对话和其余几层的分界是实打实的虚线 */
.entry-strata i + i {
  border-top: 1px solid color-mix(in srgb, var(--strata-band-line) 28%, transparent);
}
.entry-strata i.dashed {
  border-top: 1px dashed var(--strata-band-line);
}
/* 深色底上满色太亮，压一点 */
.dark .entry-strata i {
  opacity: 0.85;
}
@media (max-width: 639.98px) {
  .entry-main {
    padding: 32px 20px 40px;
  }
  .entry-body {
    margin-top: 28px;
  }
}
</style>
