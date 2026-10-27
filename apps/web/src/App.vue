<script setup lang="ts">
import { zh_cn } from '@nuxt/ui/locale'
</script>

<template>
  <!-- 组件自带的文案（搜索框的提示、关闭按钮、空列表等）用中文 -->
  <UApp :locale="zh_cn">
    <RouterView />
  </UApp>
</template>
