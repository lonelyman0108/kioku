<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { useDirtyParts } from '../composables/useDirtyParts'
import { useSession } from '../composables/useSession'
import ExtractionBudget from './ExtractionBudget.vue'
import MyDreamSettings from './MyDreamSettings.vue'
import SpaceAdvancedExtraction from './SpaceAdvancedExtraction.vue'

// 空间 › 抽取与整理：抽取预算（空间所有者可改）、当前账号的整理开关，以及抽取与整理的高级项（空间所有者可改）。空间组只挂在空间的地址下，空间取地址里的；不是成员时外壳不渲染这一页
const dirtyModel = defineModel<boolean>('dirty', { default: false })
const route = useRoute()
const { space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const isOwner = computed(() => space.value?.role === 'owner')
// 预算与高级项各有一个保存条，任意一块有改动就算有
const dirty = useDirtyParts(dirtyModel, ['budget', 'advanced'])
</script>

<template>
  <div>
    <ExtractionBudget v-model:dirty="dirty.budget" :space-id="spaceId" :editable="isOwner" />
    <MyDreamSettings :space-id="spaceId" />
    <SpaceAdvancedExtraction v-model:dirty="dirty.advanced" :space-id="spaceId" class="mt-8" />
  </div>
</template>
