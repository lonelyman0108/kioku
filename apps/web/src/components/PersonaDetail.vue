<script setup lang="ts">
import type { PersonaDetail, PersonaNode } from '@kioku/contracts'
import { computed } from 'vue'

import { icons } from '../icons'
import { sensitivityLabels } from '../labels'
import { lostFromBoot } from '../personas'
import { memoryRoute } from '../routes'
import Hint from './Hint.vue'

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
    props.persona.apps.length ? `${props.persona.apps.length} 个应用将其设为默认人格` : '',
    props.persona.children.length ? `${props.persona.children.length} 个人格继承此人格` : '',
    props.persona.storedMemories
      ? `仍有 ${props.persona.storedMemories} 条人格层记忆（含已删除）`
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
        无法删除：{{ blockers.join('；') }}
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
      <p v-else class="text-muted">未继承其他人格</p>
      <p v-if="persona.children.length" class="text-muted">
        子人格：
        <template v-for="(child, i) in persona.children" :key="child.id">
          <span v-if="i">、</span>
          <UButton size="xs" variant="link" class="px-0" @click="$emit('open', child.id)">
            {{ child.name }}
          </UButton>
        </template>
      </p>
    </section>

    <section class="space-y-2">
      <h3 class="font-medium">使用此人格的应用</h3>
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
      <p v-else class="text-muted">暂无应用将其设为默认人格</p>
    </section>

    <section class="space-y-2">
      <h3 class="font-medium">自身节点</h3>
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
        暂无节点。设定写在 <code>persona://{{ persona.slug }}/</code> 下的记忆中。
      </p>
    </section>

    <section v-if="persona.ancestors.length" class="space-y-2">
      <h3 class="font-medium">继承的节点</h3>
      <p class="text-xs text-muted">
        相同相对路径上，继承链中更近的人格节点覆盖祖先节点。
        <Hint>被覆盖的节点不进入启动加载与召回，仍可按 URI 读取。</Hint>
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
              已被 <code>{{ node.overriddenBy }}</code> 覆盖
            </span>
          </div>
          <p v-if="lost(node)" class="text-xs text-warning">
            此节点本应进入启动加载，但覆盖它的节点优先级为 P{{
              lost(node)
            }}，无法进入启动加载，会话开始时此路径将缺失。
          </p>
        </li>
      </ul>
      <p v-else class="text-muted">祖先人格暂无节点</p>
    </section>
  </div>
</template>
