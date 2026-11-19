import {
  SENSITIVITIES,
  type CircleKind,
  type ConsoleEntryView,
  type MemberRole,
} from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, type Ref } from 'vue'

import { api } from '../api/endpoints'
import { useSession } from './useSession'

// 成员在管理界面里能对词条做什么：
// owner 都能写；editor 最高到 private，viewer 只读。跨圈关联只读，若条目位于别的记忆圈则按对应记忆圈角色判断
export function useMemoryPermissions(circleId: Ref<string>) {
  const { me, circle } = useSession()
  const activeCircle = computed(
    () =>
      me.data.value?.circles.find((c) => c.id === circleId.value) ??
      (circle.value?.id === circleId.value ? circle.value : null),
  )
  const circleKind = computed<CircleKind>(() => activeCircle.value?.kind ?? 'shared')
  const role = computed<MemberRole>(() => activeCircle.value?.role ?? 'viewer')
  const clients = useQuery({
    queryKey: computed(() => ['clients', circleId.value] as const),
    queryFn: ({ queryKey: [, cid] }) => api.clients(cid),
  })
  const canWrite = computed(() => role.value === 'owner' || role.value === 'editor')
  const canEditPersonas = computed(() => role.value === 'owner')
  const canEditVocabulary = computed(() => role.value === 'owner' || role.value === 'editor')
  const sensitivities = computed(() =>
    SENSITIVITIES.filter((s) => role.value === 'owner' || s !== 'secret'),
  )

  function roleForCircle(targetCircleId?: string): MemberRole {
    if (!targetCircleId || targetCircleId === circleId.value) return role.value
    return me.data.value?.circles.find((c) => c.id === targetCircleId)?.role ?? 'viewer'
  }

  function kindForCircle(targetCircleId?: string, fallbackSlug?: string | null): CircleKind {
    if (!targetCircleId || targetCircleId === circleId.value) return circleKind.value
    return (
      me.data.value?.circles.find((c) => c.id === targetCircleId)?.kind ??
      (fallbackSlug === 'personal' ? 'personal' : 'shared')
    )
  }

  function canWriteEntry(entry: Pick<ConsoleEntryView, 'sensitivity' | 'circleId'>): boolean {
    const r = roleForCircle(entry.circleId)
    if (r === 'viewer') return false
    if (entry.sensitivity === 'secret' && r !== 'owner') return false
    return true
  }

  // 不能改时给出原因，显示在编辑器上方
  function readOnlyReason(
    entry: Pick<ConsoleEntryView, 'sensitivity' | 'circleId'>,
  ): string | null {
    const r = roleForCircle(entry.circleId)
    if (r === 'viewer') return '当前账号是此记忆圈的查看者，无法修改。'
    if (entry.sensitivity === 'secret' && r !== 'owner') {
      return '机密记忆仅记忆圈所有者可修改。'
    }
    return null
  }

  return {
    circle: activeCircle,
    circleKind,
    clients,
    role,
    canWrite,
    canEditPersonas,
    canEditVocabulary,
    sensitivities,
    kindForCircle,
    canWriteEntry,
    readOnlyReason,
  }
}
