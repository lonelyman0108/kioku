<script setup lang="ts">
import KiokuMark from '../KiokuMark.vue'

// 登录、初始化、连接失败与授权确认共用的一屏：文字标在上，内容在下，底边以细墨线收口。
// 连接失败页是静态引入的（后端连不上时按需加载的文件也拿不到），这里不能依赖按需加载的内容
defineProps<{ wide?: boolean }>()
</script>

<template>
  <div class="entry">
    <main class="entry-main">
      <KiokuMark :height="84" class="entry-mark" />
      <div class="entry-body" :class="{ wide }"><slot /></div>
    </main>
    <div class="entry-footer" aria-hidden="true" />
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
  max-width: 48rem;
}
.entry-footer {
  flex: none;
  height: 12px;
  border-top: 1px solid var(--ui-rule);
  background: var(--ui-bg-muted);
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
