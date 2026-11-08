<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { useSession } from '../composables/useSession'
import ExtractionBudget from './ExtractionBudget.vue'
import MyDreamSettings from './MyDreamSettings.vue'

// 空间 › 抽取与整理：抽取预算（空间所有者可改）与当前账号的整理开关。空间组只挂在空间的地址下，空间取地址里的；不是成员时外壳不渲染这一页
const dirty = defineModel<boolean>('dirty', { default: false })
const route = useRoute()
const { space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const isOwner = computed(() => space.value?.role === 'owner')
</script>

<template>
  <div>
    <ExtractionBudget v-model:dirty="dirty" :space-id="spaceId" :editable="isOwner" />
    <MyDreamSettings :space-id="spaceId" />
  </div>
</template>
