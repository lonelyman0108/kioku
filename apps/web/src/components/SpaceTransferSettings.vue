<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { useSession } from '../composables/useSession'
import LoreImport from './LoreImport.vue'
import SpaceExport from './SpaceExport.vue'
import SettingsBlock from './strata/SettingsBlock.vue'

// 空间 › 导入与导出：导出当前空间，从别的工具导入。空间组只挂在空间的地址下，空间取地址里的；不是成员时外壳不渲染这一页
const route = useRoute()
const { me, space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const isOwner = computed(() => space.value?.role === 'owner')
</script>

<template>
  <div>
    <SpaceExport :space-id="spaceId" :space-name="space?.name ?? ''" :editable="isOwner" />

    <!-- 每个来源一块，标题是来源的名字 -->
    <SettingsBlock title="导入">
      <template #note>
        将其他工具的记忆导入当前空间，目前仅支持 Lore。Kioku 导出的空间文件由实例管理员在「设置 ›
        实例 › 空间」中导入为新空间。
      </template>
      <LoreImport
        :space-id="spaceId"
        :editable="isOwner"
        :is-admin="me.data.value?.isAdmin ?? false"
      />
    </SettingsBlock>
  </div>
</template>
