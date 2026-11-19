<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { useSession } from '../composables/useSession'
import LoreImport from './LoreImport.vue'
import SpaceExport from './SpaceExport.vue'
import SpaceImport from './SpaceImport.vue'
import SettingsBlock from './strata/SettingsBlock.vue'

// 记忆圈 › 导入与导出：导出当前记忆圈，从别的工具导入到当前记忆圈，把导出文件导入进记忆圈。记忆圈组只挂在记忆圈地址下
const route = useRoute()
const { me, circle } = useSession()
const circleId = computed(() => String(route.params.circleId))
const isOwner = computed(() => circle.value?.role === 'owner')
</script>

<template>
  <div>
    <SpaceExport :circle-id="circleId" :circle-name="circle?.name ?? ''" :editable="isOwner" />

    <!-- 每个来源一块，标题是来源的名字 -->
    <SettingsBlock title="导入">
      <template #note>
        将其他工具的数据导入当前记忆圈，目前仅支持 Lore。Kioku
        导出的记忆圈文件在下方「导入记忆圈」导入。
      </template>
      <LoreImport
        :circle-id="circleId"
        :editable="isOwner"
        :is-admin="me.data.value?.isAdmin ?? false"
      />
    </SettingsBlock>

    <SpaceImport />
  </div>
</template>
