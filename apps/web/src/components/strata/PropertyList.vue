<script setup lang="ts">
export interface Property {
  key: string
  label: string
  value?: string | number | null
  // 值比较长时标签占一行，值另起一行
  stacked?: boolean
}

// 属性列表：标签在左、值在右，组之间一条细线。值要放别的内容时用和 key 同名的插槽
defineProps<{ groups: Property[][] }>()
</script>

<template>
  <dl class="divide-y divide-default">
    <div v-for="(group, index) in groups" :key="index" class="py-2 first:pt-0 last:pb-0">
      <div
        v-for="item in group"
        :key="item.key"
        class="grid items-baseline gap-x-2.5 py-0.5 text-sm/6"
        :class="item.stacked ? 'grid-cols-1' : 'grid-cols-[3.75rem_minmax(0,1fr)]'"
      >
        <dt class="text-xs/6 whitespace-nowrap text-muted">{{ item.label }}</dt>
        <dd class="min-w-0 wrap-anywhere">
          <slot :name="item.key" :item="item">{{ item.value ?? '–' }}</slot>
        </dd>
      </div>
    </div>
  </dl>
</template>
