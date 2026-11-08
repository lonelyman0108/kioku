<script setup lang="ts">
import type { CredentialCapability, KeyScopes } from '@kioku/contracts'
import { computed } from 'vue'

import { icons } from '../../icons'
import { scopeTags } from '../../labels'

// 访问密钥的签发范围：读几类、写几类、至哪一级、凭据能力与跨人格写入，一个标签一块。
// 标签里面不断行，放不下时整个标签换到下一行，不会断成「至私 / 密」。
// credentials 传进来时写它（签发弹窗里按范围算出的实际能力），不传写签发时选的
const props = defineProps<{
  scopes: KeyScopes
  credentials?: CredentialCapability | undefined
}>()

const tags = computed(() => scopeTags(props.scopes, props.credentials ?? props.scopes.credentials))
</script>

<template>
  <ul class="scope-tags">
    <li v-for="tag in tags" :key="tag.key">
      <UIcon
        v-if="tag.key === 'credentials'"
        :name="icons.credentials"
        class="tag-icon"
        aria-hidden="true"
      />
      <span>{{ tag.prefix }}</span
      ><b v-if="tag.value">{{ tag.value }}</b
      ><span>{{ tag.suffix }}</span>
    </li>
  </ul>
</template>

<style scoped>
.scope-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}
.scope-tags li {
  display: inline-flex;
  align-items: center;
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 18px;
  white-space: pre;
  color: var(--ui-text-toned);
}
.scope-tags b {
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.tag-icon {
  flex: none;
  width: 12px;
  height: 12px;
  margin-right: 3px;
}
</style>
