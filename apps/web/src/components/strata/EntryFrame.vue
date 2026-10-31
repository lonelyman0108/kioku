<script setup lang="ts">
import type { Layer } from '@kioku/contracts'

import KiokuMark from '../KiokuMark.vue'
import { isConversationLayer, STACK } from './strata'

// 登录、初始化、连接失败共用的一屏：文字标在上，内容在下，页面底边压一段地层作为装饰。
// 只铺层色，不铺纹理：纹理表示敏感级，这里没有数据。
// 连接失败页是静态引入的（后端连不上时按需加载的文件也拿不到），这里也不能依赖按需加载的东西

// 每层占多高（百分比），只为好看，不代表任何数据
const HEIGHTS: Record<Layer, number> = {
  episode: 9,
  subject: 14,
  private: 27,
  owner: 13,
  app: 12,
  persona: 13,
  base: 12,
}

const bands = STACK.map((layer, index) => ({
  layer,
  height: HEIGHTS[layer],
  // 和上面一层的分界。来自对话的两层和前五层之间用虚线
  dashed: index > 0 && isConversationLayer(STACK[index - 1]!) !== isConversationLayer(layer),
}))
</script>

<template>
  <div class="entry">
    <main class="entry-main">
      <KiokuMark :height="84" class="entry-mark" />
      <div class="entry-body"><slot /></div>
    </main>
    <div class="entry-strata" aria-hidden="true">
      <i
        v-for="band in bands"
        :key="band.layer"
        :class="{ dashed: band.dashed }"
        :style="{ flexGrow: band.height, background: `var(--layer-${band.layer})` }"
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
