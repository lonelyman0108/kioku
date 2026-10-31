<script setup lang="ts">
import type { Layer, Sensitivity } from '@kioku/contracts'

import KiokuMark from '../KiokuMark.vue'
import StrataPatterns from './StrataPatterns.vue'
import { isConversationLayer, paintCell, STACK } from './strata'

// 登录、初始化、连接失败共用的一屏：文字标在上，内容在下，页面底边压一段地层作为装饰。
// 连接失败页是静态引入的（后端连不上时按需加载的文件也拿不到），这里也不能依赖按需加载的东西

// 每层占多高（百分比）和铺什么纹理，只为好看，不代表任何数据
const PLAN: Record<Layer, { height: number; sensitivity: Sensitivity }> = {
  episode: { height: 9, sensitivity: 'private' },
  subject: { height: 14, sensitivity: 'private' },
  private: { height: 27, sensitivity: 'private' },
  owner: { height: 13, sensitivity: 'internal' },
  app: { height: 12, sensitivity: 'internal' },
  persona: { height: 13, sensitivity: 'public' },
  base: { height: 12, sensitivity: 'public' },
}

let offset = 0
const bands = STACK.map((layer, index) => {
  const { height, sensitivity } = PLAN[layer]
  const y = offset
  offset += height
  return {
    layer,
    y,
    rects: paintCell(layer, sensitivity, { x: 0, y: `${y}%`, width: '100%', height: `${height}%` }),
    // 和上面一层的分界。来自对话的两层和前五层之间用虚线
    dashed: index > 0 && isConversationLayer(STACK[index - 1]!) !== isConversationLayer(layer),
  }
})
</script>

<template>
  <div class="entry">
    <StrataPatterns />
    <main class="entry-main">
      <KiokuMark :height="84" class="entry-mark" />
      <div class="entry-body"><slot /></div>
    </main>
    <svg class="entry-strata" width="100%" aria-hidden="true" focusable="false">
      <template v-for="band in bands" :key="band.layer">
        <rect
          v-for="(r, i) in band.rects"
          :key="i"
          :x="r.x"
          :y="r.y"
          :width="r.width"
          :height="r.height"
          :style="{ fill: r.fill }"
        />
        <line
          v-if="band.y > 0"
          x1="0"
          x2="100%"
          :y1="`${band.y}%`"
          :y2="`${band.y}%`"
          :stroke-dasharray="band.dashed ? '4 3' : undefined"
          style="stroke: var(--strata-band-line)"
        />
      </template>
    </svg>
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
  display: block;
  flex: none;
  height: clamp(72px, 13vh, 128px);
  border-top: 1px solid var(--strata-rule);
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
