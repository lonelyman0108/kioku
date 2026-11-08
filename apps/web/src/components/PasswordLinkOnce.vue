<script setup lang="ts">
import type { AccountLink } from '@kioku/contracts'
import { computed } from 'vue'

import { LINK_ONCE_TEXT, passwordLinkUrl } from '../accounts'
import { useCopy } from '../composables/useCopy'
import { icons } from '../icons'
import NoteLine from './strata/NoteLine.vue'

// 设置密码链接只显示这一次：新建账号与重新生成链接共用。显示期间所在的弹窗不能点遮罩或 Esc 关掉
const props = defineProps<{ link: AccountLink; displayName: string }>()
const url = computed(() => passwordLinkUrl(props.link.token))

const copyText = useCopy()
const copy = () => copyText(url.value, '浏览器不允许自动复制，请手动选中链接后复制')
</script>

<template>
  <div class="space-y-3">
    <NoteLine tone="warning">
      设置密码链接只显示这一次，关闭后无法再次查看。
      <template #detail
        >发给 {{ displayName }}：{{ LINK_ONCE_TEXT
        }}{{ link.purpose === 'reset' ? '使用前当前密码仍然有效。' : '' }}</template
      >
    </NoteLine>
    <div class="once">
      <code data-password-link>{{ url }}</code>
      <UButton
        :icon="icons.copy"
        color="primary"
        variant="outline"
        aria-label="复制链接"
        @click="copy"
      />
    </div>
  </div>
</template>

<style scoped>
.once {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
.once code {
  flex: 1;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--strata-rule);
  font-size: 14px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
</style>
