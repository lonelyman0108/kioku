<script setup lang="ts">
import type { CircleKind, EntryLinkNeighbor } from '@kioku/contracts'
import { computed } from 'vue'

import { useSession } from '../composables/useSession'
import MemoryRow from './strata/MemoryRow.vue'
import SectionHeading from './strata/SectionHeading.vue'
import { entryBand } from './strata/strata'

const props = defineProps<{
  circleId: string
  circleKind: CircleKind
  links: readonly EntryLinkNeighbor[]
}>()

const emit = defineEmits<{ open: [shortId: string, targetCircleId: string] }>()
const { me } = useSession()

function uniqueByShortId(items: readonly EntryLinkNeighbor[]): EntryLinkNeighbor[] {
  const seen = new Set<string>()
  const out: EntryLinkNeighbor[] = []
  for (const item of items) {
    if (seen.has(item.shortId)) continue
    seen.add(item.shortId)
    out.push(item)
  }
  return out
}

const outgoing = computed(() =>
  uniqueByShortId(props.links.filter((l) => l.direction === 'outgoing')),
)
const incoming = computed(() =>
  uniqueByShortId(props.links.filter((l) => l.direction === 'incoming')),
)

function kindOf(item: Pick<EntryLinkNeighbor, 'circleId' | 'circleSlug'>): CircleKind {
  if (item.circleId === props.circleId) return props.circleKind
  return (
    me.data.value?.circles.find((c) => c.id === item.circleId)?.kind ??
    (item.circleSlug === 'personal' ? 'personal' : 'shared')
  )
}

function bandOf(item: EntryLinkNeighbor) {
  return entryBand(
    {
      kind: item.kind,
      circleId: item.circleId,
      circleKind: kindOf(item),
    },
    { id: props.circleId, kind: props.circleKind },
  )
}

function circleLabel(item: EntryLinkNeighbor): string {
  return kindOf(item) === 'personal' ? '个人圈' : item.circleSlug
}
</script>

<template>
  <div v-if="outgoing.length || incoming.length" class="links-panel">
    <section v-if="outgoing.length" class="links-section">
      <SectionHeading title="出链" :level="3" />
      <ul class="links-list">
        <li v-for="item in outgoing" :key="`out-${item.shortId}`">
          <MemoryRow
            as="button"
            type="button"
            flush
            :short-id="item.shortId"
            :title="item.title"
            :band="bandOf(item)"
            :kind="item.kind"
            :sensitivity="item.sensitivity"
            @click="emit('open', item.shortId, item.circleId)"
          >
            <span class="flex items-center gap-2 text-xs text-muted">
              <span class="font-mono">{{ item.shortId }}</span>
              <span v-if="item.circleId !== circleId">{{ circleLabel(item) }}</span>
            </span>
          </MemoryRow>
        </li>
      </ul>
    </section>

    <section v-if="incoming.length" class="links-section">
      <SectionHeading title="反向链接" :level="3" />
      <ul class="links-list">
        <li v-for="item in incoming" :key="`in-${item.shortId}`">
          <MemoryRow
            as="button"
            type="button"
            flush
            :short-id="item.shortId"
            :title="item.title"
            :band="bandOf(item)"
            :kind="item.kind"
            :sensitivity="item.sensitivity"
            @click="emit('open', item.shortId, item.circleId)"
          >
            <span class="flex items-center gap-2 text-xs text-muted">
              <span class="font-mono">{{ item.shortId }}</span>
              <span v-if="item.circleId !== circleId">{{ circleLabel(item) }}</span>
            </span>
          </MemoryRow>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.links-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--ui-border);
}
.links-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.links-list {
  border-top: 1px solid var(--ui-border);
}
</style>
