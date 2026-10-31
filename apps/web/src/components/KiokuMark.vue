<script setup lang="ts">
import { computed } from 'vue'

// Kioku 的标记：K 由七条横切面组成，对应七层。全站只有这一个组件，换 logo 只改这里和 public/favicon.svg
const props = withDefaults(defineProps<{ size?: number }>(), { size: 20 })

// 96 网格的线条在小尺寸下会糊，小于等于 20px 用 16 网格的版本
const GRID_16 =
  'M1 1h4v1H1zM11 1h4v1H11zM1 3h4v1H1zM9 3h4v1H9zM1 5h4v1H1zM7 5h4v1H7zM1 7h8v1H1zM1 9h4v1H1zM7 9h4v1H7zM1 11h4v1H1zM9 11h4v1H9zM1 13h4v1H1zM11 13h4v1H11z'
const GRID_96 =
  'M1 1h24v10H1zM67 1h28v10H67zM1 15h24v10H1zM53 15h28v10H53zM1 29h24v10H1zM39 29h28v10H39zM1 43h52v10H1zM1 57h24v10H1zM39 57h28v10H39zM1 71h24v10H1zM53 71h28v10H53zM1 85h24v10H1zM67 85h28v10H67z'
const small = computed(() => props.size <= 20)
</script>

<template>
  <svg
    :width="size"
    :height="size"
    :viewBox="small ? '0 0 16 16' : '0 0 96 96'"
    fill="currentColor"
    shape-rendering="crispEdges"
    aria-hidden="true"
  >
    <path :d="small ? GRID_16 : GRID_96" />
  </svg>
</template>
