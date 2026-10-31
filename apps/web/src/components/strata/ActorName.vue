<script setup lang="ts">
import type { EventActor } from '@kioku/contracts'
import { computed } from 'vue'

import { icons } from '../../icons'
import { actorLabel } from '../../labels'

// 事件的操作方。经 Key 操作的带应用标记，不靠名字区分：应用可以和成员同名
const props = defineProps<{ actor: EventActor }>()
const label = computed(() => actorLabel(props.actor))
</script>

<template>
  <span :title="label.name">
    <template v-if="label.viaApp">
      <UIcon :name="icons.bot" class="actor-app" /><span class="sr-only">应用：</span>
    </template>
    {{ label.name }}
  </span>
</template>

<style scoped>
.actor-app {
  margin-right: 4px;
  vertical-align: -2px;
  color: var(--ui-text-muted);
}
</style>
