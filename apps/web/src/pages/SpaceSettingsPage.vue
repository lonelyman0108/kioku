<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'

import ExtractionBudget from '../components/ExtractionBudget.vue'
import LoreImport from '../components/LoreImport.vue'
import MyDreamSettings from '../components/MyDreamSettings.vue'
import SpaceExport from '../components/SpaceExport.vue'
import SettingsBlock from '../components/strata/SettingsBlock.vue'
import SettingsFrame from '../components/strata/SettingsFrame.vue'
import { useUnsavedChangesGuard } from '../composables/unsavedChanges'
import { useSession } from '../composables/useSession'
import { SPACE_SECTIONS } from '../settingsSections'

const route = useRoute()
const { me, space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const isOwner = computed(() => space.value?.role === 'owner')

// 抽取预算有未保存的改动时，离开这一页、换空间、退出登录或关掉标签页之前先确认。
// 切换小节只改地址里的参数，表单都还挂着，不算离开
const budgetDirty = ref(false)
useUnsavedChangesGuard(budgetDirty, {
  leavesOn: (to, from) => to.params.spaceId !== from.params.spaceId,
})
const unsaved = computed(() => (budgetDirty.value ? ['budget'] : []))
</script>

<template>
  <SettingsFrame title="空间设置" :sections="SPACE_SECTIONS" :unsaved="unsaved">
    <template #budget>
      <ExtractionBudget v-model:dirty="budgetDirty" :space-id="spaceId" :editable="isOwner" />
    </template>

    <template #dream>
      <MyDreamSettings :space-id="spaceId" />
    </template>

    <template #export>
      <SpaceExport :space-id="spaceId" :space-name="space?.name ?? ''" :editable="isOwner" />
    </template>

    <!-- 每个来源一块，标题是来源的名字 -->
    <template #import>
      <SettingsBlock title="导入">
        <template #note>
          将其他工具的记忆导入当前空间，目前仅支持 Lore。Kioku
          导出的空间文件由实例管理员在「实例设置 › 导入空间」中导入为新空间。
        </template>
        <LoreImport
          :space-id="spaceId"
          :editable="isOwner"
          :is-admin="me.data.value?.isAdmin ?? false"
        />
      </SettingsBlock>
    </template>
  </SettingsFrame>
</template>
