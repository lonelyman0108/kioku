<script setup lang="ts">
import { COLOR_PREFERENCES, useColorPreference } from '../composables/useColorPreference'
import SettingsRow from './strata/SettingsRow.vue'

// 外观：点一下就生效，不用保存
const colorPreference = useColorPreference()
</script>

<template>
  <div class="max-w-[40rem]">
    <SettingsRow label="主题" description="保存在当前浏览器">
      <div class="flex gap-1" role="group" aria-label="主题">
        <UButton
          v-for="option in COLOR_PREFERENCES"
          :key="option.value"
          :label="option.label"
          :icon="option.icon"
          :variant="colorPreference.current() === option.value ? 'solid' : 'subtle'"
          :color="colorPreference.current() === option.value ? 'primary' : 'neutral'"
          size="sm"
          :aria-pressed="colorPreference.current() === option.value"
          @click="colorPreference.set(option.value)"
        />
      </div>
    </SettingsRow>
  </div>
</template>
