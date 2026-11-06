<script setup lang="ts">
import type { AppInfo, CuratedLayer, PersonaInfo, Sensitivity } from '@kioku/contracts'
import { computed } from 'vue'

import { draftUri, type CoordinateDraft } from '../coordinates'
import { layerLabels } from '../labels'
import { CURATED_STACK } from './strata/strata'
import SwatchOptions from './strata/SwatchOptions.vue'

// 新建与移动共用的几项：归属（人格、应用还要选是哪个）、位置与标识，拼成的坐标显示在下面，可以折叠。
// 归属由坐标的开头决定，所以不单独选「层」。色块跟着敏感级走：选了什么就看到什么样子
const props = defineProps<{
  personas: readonly PersonaInfo[]
  // 当前账号能写的应用：编辑者只能写自己是所有者的应用
  apps: readonly AppInfo[]
  sensitivity?: Sensitivity | null
  // 标识的输入框里提示一个从标题猜出来的
  suggestion?: string
}>()
const model = defineModel<CoordinateDraft>({ required: true })

// 每一项改的是整份草稿：使用方拿到的是新对象，不在原来的对象上改
function field<K extends keyof CoordinateDraft>(key: K) {
  return computed({
    get: () => model.value[key],
    set: (value: CoordinateDraft[K]) => (model.value = { ...model.value, [key]: value }),
  })
}
// 下拉框把 undefined 当成没选，草稿里记 null
const entity = computed({
  get: () => model.value.entity ?? undefined,
  set: (value: string | undefined) => (model.value = { ...model.value, entity: value ?? null }),
})
const position = field('position')
const identifier = field('identifier')
// 换归属时人格或应用要重新选：坐标开头变了
const layer = computed({
  get: () => model.value.layer,
  set: (value: CuratedLayer) => (model.value = { ...model.value, layer: value, entity: null }),
})

const layerOptions = computed(() =>
  CURATED_STACK.map((value) => ({
    value,
    label: layerLabels[value],
    layer: value,
    sensitivity: props.sensitivity ?? null,
    plain: !props.sensitivity,
  })),
)
const entityItems = computed(() =>
  (model.value.layer === 'persona' ? props.personas : props.apps).map((e) => ({
    label: `${e.name}（${e.slug}）`,
    value: e.slug,
  })),
)
const uri = computed(() => draftUri(model.value))
</script>

<template>
  <div class="space-y-4">
    <UFormField label="归属">
      <SwatchOptions v-model="layer" label="归属" :options="layerOptions" />
      <USelect
        v-if="layer === 'persona' || layer === 'app'"
        v-model="entity"
        :items="entityItems"
        :placeholder="layer === 'persona' ? '选择人格' : '选择应用'"
        :aria-label="layer === 'persona' ? '人格' : '应用'"
        class="mt-2 w-full"
      />
    </UFormField>
    <div class="grid gap-4 sm:grid-cols-2">
      <UFormField label="位置" help="开头与标识之间的各级，用 / 分隔，可留空">
        <UInput v-model="position" class="w-full font-mono" placeholder="例如 projects/kioku" />
      </UFormField>
      <UFormField label="标识" help="坐标的最后一段，同一位置下不能重复">
        <UInput
          v-model="identifier"
          class="w-full font-mono"
          :placeholder="suggestion || '例如 deploy_steps'"
        />
      </UFormField>
    </div>
    <details class="coordinate-preview">
      <summary>
        坐标 <code>{{ uri ?? '…' }}</code>
      </summary>
      <p>由归属、位置与标识拼成，Agent 按坐标读写。目录、列表与搜索显示标题。</p>
    </details>
  </div>
</template>

<style scoped>
.coordinate-preview {
  padding: 7px 10px;
  border: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.5;
}
.coordinate-preview summary {
  cursor: pointer;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.coordinate-preview code {
  font-family: var(--font-mono);
  color: var(--ui-text);
}
.coordinate-preview p {
  margin-top: 4px;
  color: var(--ui-text-muted);
}
</style>
