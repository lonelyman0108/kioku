<script setup lang="ts">
import { DATABASE_FAILURE_NAMES, DATABASE_SOURCE_NAMES, type SetupStatus } from '@kioku/contracts'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { api } from '../api/endpoints'
import EntryFrame from '../components/strata/EntryFrame.vue'
import PropertyList from '../components/strata/PropertyList.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import { setupLost } from '../routes'
import { lockedHint } from '../setup'
import { formatTime } from '../time'
import { retryTarget } from '../unavailable'

// 配了的数据库暂时连不上：服务按退避自动重试，这一页隔一会儿问一次状态，接上了回到之前的页面。
// 不是初始化：已经初始化过的实例在这里等，不给初始化码
const POLL_MS = 10_000

const route = useRoute()
const router = useRouter()
const target = computed(() => retryTarget(route.query.next))

const status = ref<SetupStatus | null>(null)
const checkedAt = ref<string | null>(null)
const checking = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

const facts = computed(() => {
  const db = status.value?.database
  if (!db) return []
  return [
    [
      ...(db.source
        ? [{ key: 'source', label: '来源', value: DATABASE_SOURCE_NAMES[db.source] }]
        : []),
      {
        key: 'failure',
        label: '原因',
        value: db.failure ? DATABASE_FAILURE_NAMES[db.failure] : '未知',
      },
    ],
  ]
})

async function check() {
  if (timer) clearTimeout(timer)
  checking.value = true
  try {
    status.value = await api.setupStatus()
    checkedAt.value = new Date().toISOString()
    if (status.value.database.state !== 'unavailable') {
      // 接上了（或者变成了要初始化）：让守卫重新判断
      setupLost()
      await router.replace(target.value)
      return
    }
  } catch {
    // 服务本身也连不上：下一轮再问，守卫会带到连接失败页
  } finally {
    checking.value = false
  }
  timer = setTimeout(() => void check(), POLL_MS)
}

onMounted(check)
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <EntryFrame>
    <SectionHeading title="数据库不可用" :level="1" />
    <div class="mt-3 space-y-3">
      <p>服务暂时无法连接数据库，正在自动重试。连接恢复后回到之前的页面。</p>
      <PropertyList v-if="facts.length" :groups="facts" />
      <p v-if="status?.database.source" class="text-muted">
        持续无法连接时，检查数据库是否在运行，或者{{ lockedHint(status.database.source) }}
      </p>
    </div>
    <UButton class="mt-5" size="lg" block :loading="checking" @click="check">重新检查</UButton>
    <p v-if="checkedAt" class="mt-2 text-muted" role="status">
      最近检查：{{ formatTime(checkedAt) }}
    </p>
  </EntryFrame>
</template>
