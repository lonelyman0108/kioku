<script setup lang="ts">
import { TEXTURES } from './strata'
</script>

<template>
  <!--
    全站唯一一套纹理：内部圆点、私密斜线，再加一种纸色的缺口，把权限格子下沿的条挖成虚线。
    lg 用在大图形，sm 用在小色块。
    颜色走 CSS 变量，主题切换时跟着变。外壳里挂一次；不能 display: none，否则有的浏览器引用不到
  -->
  <svg class="strata-patterns" width="0" height="0" aria-hidden="true" focusable="false">
    <defs>
      <pattern :id="TEXTURES.dots.lg" width="7" height="7" patternUnits="userSpaceOnUse">
        <circle class="strata-texture" cx="1.75" cy="1.75" r="1.05" />
        <circle class="strata-texture" cx="5.25" cy="5.25" r="1.05" />
      </pattern>
      <pattern
        :id="TEXTURES.lines.lg"
        width="6"
        height="6"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect class="strata-texture" width="1.35" height="6" />
      </pattern>
      <pattern :id="TEXTURES.dots.sm" width="4" height="4" patternUnits="userSpaceOnUse">
        <circle class="strata-texture" cx="1" cy="1" r="0.75" />
        <circle class="strata-texture" cx="3" cy="3" r="0.75" />
      </pattern>
      <pattern
        :id="TEXTURES.lines.sm"
        width="3.4"
        height="3.4"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect class="strata-texture" width="1.05" height="3.4" />
      </pattern>
      <pattern :id="TEXTURES.gaps.lg" width="10" height="10" patternUnits="userSpaceOnUse">
        <rect class="strata-gap" x="6" width="4" height="10" />
      </pattern>
      <pattern :id="TEXTURES.gaps.sm" width="4" height="4" patternUnits="userSpaceOnUse">
        <rect class="strata-gap" x="2" width="2" height="4" />
      </pattern>
    </defs>
  </svg>
</template>

<style scoped>
.strata-patterns {
  position: absolute;
  overflow: hidden;
}
.strata-texture {
  fill: var(--strata-texture);
}
.strata-gap {
  fill: var(--ui-bg);
}
</style>
