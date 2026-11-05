<script setup lang="ts">
import { LAYERS } from '@kioku/contracts'

import { DASHES, TEXTURES, accessFill, dashId, type TextureScale } from './strata'

const SCALES: TextureScale[] = ['lg', 'sm']
</script>

<template>
  <!--
    全站唯一一套纹理：内部圆点、私密斜线，再加权限格子下沿的虚线条（每层一种颜色，缺口是透明的）。
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
      <template v-for="layer in LAYERS" :key="layer">
        <pattern
          v-for="scale in SCALES"
          :id="dashId(layer, scale)"
          :key="scale"
          :width="DASHES[scale].on + DASHES[scale].off"
          height="10"
          patternUnits="userSpaceOnUse"
        >
          <rect :width="DASHES[scale].on" height="10" :style="{ fill: accessFill(layer) }" />
        </pattern>
      </template>
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
</style>
