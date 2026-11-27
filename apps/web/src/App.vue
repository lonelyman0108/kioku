<script setup lang="ts">
import { zh_cn } from '@nuxt/ui/locale'
</script>

<template>
  <!-- 组件自带的文案（搜索框的提示、关闭按钮、空列表等）用中文；通知贴底居中并默认收拢叠层，避免遮挡右侧操作按钮 -->
  <UApp :locale="zh_cn" :toaster="{ position: 'bottom-center', expand: false, max: 3 }">
    <RouterView />
  </UApp>
</template>
