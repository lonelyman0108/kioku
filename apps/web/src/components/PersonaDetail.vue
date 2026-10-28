<script setup lang="ts">
import type { PersonaDetail, PersonaNode } from '@kioku/contracts'
import { computed } from 'vue'

import { icons } from '../icons'
import { sensitivityLabels } from '../labels'
import { lostFromBoot } from '../personas'
import { memoryRoute } from '../routes'

const props = defineProps<{
  spaceId: string
  persona: PersonaDetail
  canEdit: boolean
}>()
defineEmits<{ edit: []; remove: []; open: [personaId: string] }>()

const nameOf = (id: string) =>
  props.persona.ancestors.find((p) => p.id === id)?.name ?? props.persona.name
const nodes = computed(() => [...props.persona.own, ...props.persona.inherited])
// 被覆盖、而覆盖它的那条进不了启动上下文：会话开始时这个路径就没有了，提示一下
const lost = (node: PersonaNode) => lostFromBoot(node, nodes.value)

// 删除人格会把它的人格层记忆连带硬删除，有引用时服务端会拒绝，界面先把原因列出来
const blockers = computed(() =>
  [
    props.persona.apps.length ? `${props.persona.apps.length} 个应用以它为默认人格` : '',
    props.persona.children.length ? `${props.persona.children.length} 个人格继承它` : '',
    props.persona.storedMemories
      ? `还有 ${props.persona.storedMemories} 条人格层记忆（含已删除的）`
      : '',
  ].filter(Boolean),
)
const memoryLink = (uri: string) => memoryRoute(props.spaceId, uri)
</script>

<template>
  <div class="space-y-6 text-sm">
    <div class="space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <code class="text-xs text-muted">persona://{{ persona.slug }}/</code>
        <div v-if="canEdit" class="ml-auto flex gap-2">
          <UButton :icon="icons.edit" size="xs" variant="subtle" @click="$emit('edit')"
            >修改</UButton
          >
          <UButton
            :icon="icons.remove"
            size="xs"
            color="error"
            variant="subtle"
            :disabled="blockers.length > 0"
            @click="$emit('remove')"
            >删除</UButton
          >
        </div>
      </div>
      <p v-if="persona.description">{{ persona.description }}</p>
      <p v-if="canEdit && blockers.length" class="text-xs text-muted">
        删不掉：{{ blockers.join('；') }}。
      </p>
    </div>

    <section class="space-y-2">
      <h3 class="font-medium">继承</h3>
      <div v-if="persona.ancestors.length" class="flex flex-wrap items-center gap-1">
        <UBadge variant="subtle">{{ persona.name }}</UBadge>
        <template v-for="ancestor in persona.ancestors" :key="ancestor.id">
          <UIcon :name="icons.inherits" class="size-4 text-muted" />
          <UButton size="xs" variant="link" class="px-0" @click="$emit('open', ancestor.id)">
            {{ ancestor.name }}
          </UButton>
        </template>
      </div>
      <p v-else class="text-muted">不继承别的人格。</p>
      <p v-if="persona.children.length" class="text-muted">
        继承它的人格：
        <template v-for="(child, i) in persona.children" :key="child.id">
          <span v-if="i">、</span>
          <UButton size="xs" variant="link" class="px-0" @click="$emit('open', child.id)">
            {{ child.name }}
          </UButton>
        </template>
      </p>
    </section>

    <section class="space-y-2">
      <h3 class="font-medium">用它的应用</h3>
      <ul v-if="persona.apps.length" class="space-y-1">
        <li v-for="app in persona.apps" :key="app.id">
          <RouterLink
            :to="{ name: 'app', params: { spaceId, appId: app.id } }"
            class="text-primary hover:underline"
            >{{ app.name }}</RouterLink
          >
          <code class="ml-2 text-xs text-muted">app://{{ app.slug }}</code>
        </li>
      </ul>
      <p v-else class="text-muted">还没有应用以它为默认人格。</p>
    </section>

    <section class="space-y-2">
      <h3 class="font-medium">自己的节点</h3>
      <ul v-if="persona.own.length" class="divide-y divide-default">
        <li v-for="node in persona.own" :key="node.uri" class="space-y-1 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <RouterLink :to="memoryLink(node.uri)" class="font-mono text-xs hover:underline">{{
              node.uri
            }}</RouterLink>
            <UBadge size="sm" variant="subtle" color="neutral">P{{ node.priority }}</UBadge>
            <UBadge size="sm" variant="subtle" color="neutral">{{
              sensitivityLabels[node.sensitivity]
            }}</UBadge>
          </div>
          <p v-if="node.disclosure" class="text-xs text-muted">{{ node.disclosure }}</p>
        </li>
      </ul>
      <p v-else class="text-muted">
        还没有。设定写在 <code>persona://{{ persona.slug }}/</code> 下的记忆里。
      </p>
    </section>

    <section v-if="persona.ancestors.length" class="space-y-2">
      <h3 class="font-medium">继承来的节点</h3>
      <p class="text-xs text-muted">
        同一相对路径上，继承链里更近的人格的节点覆盖祖先的：被覆盖的不进启动上下文与召回，按 URI
        仍然读得到。
      </p>
      <ul v-if="persona.inherited.length" class="divide-y divide-default">
        <li v-for="node in persona.inherited" :key="node.uri" class="space-y-1 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <RouterLink
              :to="memoryLink(node.uri)"
              class="font-mono text-xs hover:underline"
              :class="node.overriddenBy && 'text-muted line-through'"
              >{{ node.uri }}</RouterLink
            >
            <UBadge size="sm" variant="subtle" color="neutral">P{{ node.priority }}</UBadge>
            <span class="text-xs text-muted">来自 {{ nameOf(node.personaId) }}</span>
            <span v-if="node.overriddenBy" class="text-xs text-muted">
              被 <code>{{ node.overriddenBy }}</code> 覆盖
            </span>
          </div>
          <p v-if="lost(node)" class="text-xs text-warning">
            它会进启动上下文，但覆盖它的那条 priority 是
            {{ lost(node) }}，进不了：会话开始时这个路径就没有了。
          </p>
        </li>
      </ul>
      <p v-else class="text-muted">祖先人格还没有节点。</p>
    </section>
  </div>
</template>
