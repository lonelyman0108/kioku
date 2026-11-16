<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { useDirtyParts } from '../composables/useDirtyParts'
import { useSession } from '../composables/useSession'
import ExtractionBudget from './ExtractionBudget.vue'
import MyDreamSettings from './MyDreamSettings.vue'
import SpaceAdvancedExtraction from './SpaceAdvancedExtraction.vue'
import SettingsSummaryStrip from './strata/SettingsSummaryStrip.vue'

// 空间 › 抽取与整理：抽取预算（空间所有者可改）、当前账号的整理开关，以及抽取与整理的高级项（空间所有者可改）。空间组只挂在空间的地址下，空间取地址里的；不是成员时外壳不渲染这一页
const dirtyModel = defineModel<boolean>('dirty', { default: false })
const route = useRoute()
const { space } = useSession()
const spaceId = computed(() =>
  typeof route.params.spaceId === 'string' ? route.params.spaceId : '',
)
const isOwner = computed(() => space.value?.role === 'owner')
// 预算与高级项各有一个保存条，任意一块有改动就算有
const dirty = useDirtyParts(dirtyModel, ['budget', 'advanced'])

const scopeItems = computed(() => [
  {
    label: '当前权限',
    value: isOwner.value ? '空间所有者' : '空间成员',
    sub: isOwner.value ? '可调整预算、高级规则与个人整理' : '仅可开关个人整理偏好',
    tone: isOwner.value ? ('ok' as const) : ('warn' as const),
  },
  {
    label: '保存方式',
    value: '分块明确标示',
    sub: '整理开关即时生效，预算与规则需点保存',
  },
])
</script>

<template>
  <div class="extraction-page">
    <SettingsSummaryStrip :items="scopeItems" class="summary" />
    <ExtractionBudget v-model:dirty="dirty.budget" :space-id="spaceId" :editable="isOwner" />
    <MyDreamSettings :space-id="spaceId" />
    <SpaceAdvancedExtraction v-model:dirty="dirty.advanced" :space-id="spaceId" />
  </div>
</template>

<style scoped>
.extraction-page {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.summary {
  max-width: 64rem;
}
</style>
