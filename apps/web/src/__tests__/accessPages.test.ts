import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

import apps from '../apps?raw'
import appKeys from '../components/AppKeys.vue?raw'
import appSimulator from '../components/AppSimulator.vue?raw'
import convertModal from '../components/ConvertCredentialModal.vue?raw'
import dreamSuggestions from '../components/DreamSuggestions.vue?raw'
import inboxBindings from '../components/InboxBindings.vue?raw'
import inboxPlaintext from '../components/InboxPlaintext.vue?raw'
import inboxReview from '../components/InboxReview.vue?raw'
import keyMatrix from '../components/KeyMatrix.vue?raw'
import memoryEditor from '../components/MemoryEditor.vue?raw'
import recallDebugPanel from '../components/RecallDebugPanel.vue?raw'
import subjectBindings from '../components/SubjectBindings.vue?raw'
import useInboxCounts from '../composables/useInboxCounts?raw'
import usePlaintextActions from '../composables/usePlaintextActions?raw'
import dream from '../dream?raw'
import consoleLayout from '../layouts/ConsoleLayout.vue?raw'
import appDetailPage from '../pages/AppDetailPage.vue?raw'
import appsPage from '../pages/AppsPage.vue?raw'
import inboxPage from '../pages/InboxPage.vue?raw'
import overviewPage from '../pages/OverviewPage.vue?raw'
import recallPage from '../pages/RecallPage.vue?raw'
import { routes } from '../routes'
import subjectQueries from '../subjectQueries?raw'

// 没有组件测试的环境，所以看源码本身：长相改过，这些约束不能跟着丢

interface TemplateNode {
  type: number
  tag?: string
  children?: TemplateNode[]
  props?: {
    name: string
    arg?: { content: string }
    value?: { content: string }
    exp?: { content: string }
  }[]
}
const ELEMENT = 1
const elementsOf = (source: string): TemplateNode[] => {
  const walk = (node: TemplateNode): TemplateNode[] => [
    ...(node.type === ELEMENT ? [node] : []),
    ...(node.children ?? []).flatMap(walk),
  ]
  return walk(parse(source).descriptor.template!.ast as unknown as TemplateNode)
}
const attr = (el: TemplateNode, name: string) =>
  el.props?.find((p) => p.name === name)?.value?.content
const bound = (el: TemplateNode, name: string) =>
  el.props?.find((p) => p.name === 'bind' && p.arg?.content === name)?.exp?.content
const handler = (el: TemplateNode, event: string) =>
  el.props?.find((p) => p.name === 'on' && p.arg?.content === event)?.exp?.content
const textOf = (el: TemplateNode): string =>
  (el.children ?? [])
    .map((c) => (c as unknown as { content?: unknown }).content)
    .filter((c) => typeof c === 'string')
    .join('')
    .trim()
const buttonOf = (source: string, label: string) =>
  elementsOf(source).find((el) => el.tag === 'UButton' && textOf(el) === label)!

describe('这几个页面的长相', () => {
  const pages = {
    inboxPage,
    inboxBindings,
    inboxReview,
    inboxPlaintext,
    dreamSuggestions,
    subjectBindings,
    convertModal,
    appsPage,
    appDetailPage,
    appKeys,
    keyMatrix,
    appSimulator,
    recallPage,
    recallDebugPanel,
  }

  it('没有彩色徽章和多余的 hover:underline，也不再套老外壳', () => {
    for (const [name, source] of Object.entries(pages)) {
      expect(source, name).not.toContain('sensitivityColors')
      expect(source, name).not.toContain('<UBadge')
      expect(source, name).not.toContain('hover:underline')
      expect(source, name).not.toContain('UDashboardPanel')
    }
  })
})

describe('路由和入口', () => {
  const children = routes.find((r) => r.path === '/')!.children!

  it('待处理有自己的路由', () => {
    expect(children.find((r) => r.name === 'inbox')?.path).toBe('spaces/:spaceId/inbox')
  })

  it('旧的 review 地址带着分类跳过来', () => {
    const redirect = children.find((r) => r.name === 'review')!.redirect as (to: unknown) => unknown
    const go = (query: Record<string, string>) => redirect({ params: { spaceId: 's1' }, query })
    expect(go({})).toEqual({ name: 'inbox', params: { spaceId: 's1' }, query: { tab: 'review' } })
    expect(go({ tab: 'dream' })).toEqual({
      name: 'inbox',
      params: { spaceId: 's1' },
      query: { tab: 'dream' },
    })
  })

  it('导航指向待处理，角标用共享的条数', () => {
    expect(consoleLayout).toContain(
      "link('inbox', icons.review), count: inboxCounts.data.value?.total",
    )
    expect(consoleLayout).toContain('useInboxCounts(')
  })

  it('条数不跟着每个页面重取：有 staleTime，空间未知时不查', () => {
    expect(useInboxCounts).toContain('staleTime: 60_000')
    expect(useInboxCounts).toContain('enabled: computed(() => Boolean(spaceId.value))')
  })

  it('概览的四类都链到待处理', () => {
    expect(overviewPage).toContain("query: { tab: 'binding' }")
    expect(overviewPage).toContain("query: { tab: 'review' }")
    expect(overviewPage).toContain("query: { tab: 'dream' }")
    expect(overviewPage).toContain("query: { tab: 'plaintext' }")
    expect(overviewPage).not.toContain("name: 'review'")
    expect(overviewPage).not.toContain('<SubjectBindings')
  })
})

describe('处理完待办之后条数失效', () => {
  it('绑定（确认、拒绝走 refreshSubjectCaches）', () => {
    expect(subjectBindings).toContain('refreshSubjectCaches(queryClient, spaceId)')
    expect(subjectQueries).toContain("'inbox-counts'")
  })

  it('确认和删除', () => {
    const act = /async function act\([\s\S]*?\n\}/.exec(inboxReview)![0]
    expect(act).toContain("'inbox-counts'")
  })

  it('整理建议：执行、拒绝、作废，整理完有新建议', () => {
    const refresh = /function refresh\(spaceId: string\) \{[\s\S]*?\n\}/.exec(dreamSuggestions)![0]
    expect(refresh).toContain("'inbox-counts'")
    const reject = /async function reject\([\s\S]*?\n\}/.exec(dreamSuggestions)![0]
    expect(reject).toContain('invalidateInboxCounts(queryClient, spaceId)')
    const apply = /async function apply\([\s\S]*?\n\}/.exec(dreamSuggestions)![0]
    expect(apply).toContain('invalidateInboxCounts(queryClient, spaceId)')
    expect(dreamSuggestions).toContain('invalidateInboxCounts(queryClient, props.spaceId)')
  })

  it('忽略、撤销忽略和转存', () => {
    const refresh = /export function refreshAfterPlaintext\([\s\S]*?\n\}/.exec(
      usePlaintextActions,
    )![0]
    expect(refresh).toContain("'inbox-counts'")
    expect(usePlaintextActions).toContain('refreshAfterPlaintext(queryClient, sid, memory)')
    expect(convertModal).toContain('refreshAfterPlaintext(queryClient, sid, done.memory)')
  })
})

describe('待处理', () => {
  it('切到别的分类时不卸载：KeepAlive 不能放在条件分支里', () => {
    const elements = elementsOf(inboxPage)
    const keep = elements.find((el) => el.tag === 'KeepAlive')!
    expect(keep.props ?? []).toEqual([])
    const panels = (keep.children ?? []).filter((c) => c.type === ELEMENT).map((c) => c.tag)
    expect(panels).toEqual(['InboxBindings', 'InboxReview', 'DreamSuggestions', 'InboxPlaintext'])
  })

  it('账号绑定：确认的说明和二次确认的后果还在', () => {
    expect(inboxBindings).toContain('<SubjectBindings')
    expect(inboxBindings).toContain(
      '确认后，该账号的私聊视为本人对话，此操作不可撤销。如无法辨认，请拒绝。',
    )
    expect(inboxBindings).toContain('对方在 Bot 私聊中使用绑定码发起申请')
    expect(inboxBindings).toContain('仅列出前 {{ items.length }} 个，处理后显示其余的。')
    expect(subjectBindings).toContain('此操作不可撤销')
    expect(subjectBindings).toContain('原联系人随即删除')
    expect(subjectBindings).toContain('如无法辨认这些账号，或绑定码并非本人申请，请拒绝')
    expect(handler(buttonOf(subjectBindings, '确认'), 'click')).toBe('confirming = binding')
  })

  it('待确认内容：勾选时记下版本，分批提交，删除要确认，查看者没有操作', () => {
    expect(inboxReview).toContain('next.set(item.id, item.version)')
    expect(inboxReview).toContain('const BATCH = 100')
    expect(inboxReview).toContain('从对话中抽取的内容删除后，无法在管理界面恢复。')
    const elements = elementsOf(inboxReview)
    const remove = elements.filter((el) => el.tag === 'UButton' && /删除/.test(textOf(el)))
    expect(remove.map((el) => handler(el, 'click'))).toEqual([
      'deleting = chosen()',
      'deleting = [item]',
      "deleting && act('delete', deleting)",
    ])
    const checks = elements.filter((el) => el.tag === 'UCheckbox')
    for (const check of checks) {
      expect(check.props?.find((p) => p.name === 'if')?.exp?.content).toContain('canAct')
    }
  })

  it('整理建议：会删掉记忆的先确认，后果的文字还在', () => {
    expect(dreamSuggestions).toContain('destructive(item) ? (confirming = item) : apply(item)')
    expect(dreamSuggestions).toContain('suggestionKinds[item.kind].effect')
    expect(dreamSuggestions).toContain('suggestionKinds[confirming.kind].effect')
    expect(dreamSuggestions).toContain(
      '包含当前账号无权写入的记忆（如其他成员应用的应用层），需由有权限的成员处理。',
    )
    expect(dreamSuggestions).toContain('正文疑似包含明文凭据')
    expect(dream).toContain('其余几条删除')
  })
})

describe('疑似明文', () => {
  it('列表分待处理和已忽略，都走接口的筛选', () => {
    expect(inboxPlaintext).toContain("{ label: '待处理', value: 'true' }")
    expect(inboxPlaintext).toContain("{ label: '已忽略', value: 'ignored' }")
    expect(inboxPlaintext).toContain('plaintext: f.plaintext')
  })

  it('忽略和撤销都带着列表里看到的版本', () => {
    expect(usePlaintextActions).toContain('expectedVersion: target.version')
    expect(handler(buttonOf(inboxPlaintext, '忽略'), 'click')).toBe('actions.ignore(item)')
    expect(handler(buttonOf(inboxPlaintext, '撤销忽略'), 'click')).toBe('actions.unignore(item)')
  })

  it('没有写权限时没有操作', () => {
    const elements = elementsOf(inboxPlaintext)
    const actions = elements.find((el) => attr(el, 'class') === 'plain-actions')!
    expect(actions.props?.find((p) => p.name === 'if')?.exp?.content).toBe(
      '!permissions.readOnlyReason(item)',
    )
  })

  it('记忆详情接上转存和忽略，复用同一个对话框；只读时没有操作', () => {
    expect(memoryEditor).toContain('<ConvertCredentialModal')
    expect(handler(buttonOf(memoryEditor, '转存为凭据'), 'click')).toBe('convertOpen = true')
    expect(handler(buttonOf(memoryEditor, '忽略'), 'click')).toBe('setPlaintextIgnored(true)')
    expect(handler(buttonOf(memoryEditor, '撤销忽略'), 'click')).toBe('setPlaintextIgnored(false)')
    expect(memoryEditor).toContain('v-else-if="base.plaintextIgnored"')
    expect(memoryEditor.match(/<template v-if="!readOnly" #actions>/g)).toHaveLength(2)
    expect(inboxPlaintext).toContain('<ConvertCredentialModal')
  })
})

describe('转存对话框', () => {
  const elements = elementsOf(convertModal)

  it('没有表单和提交按钮：回车的隐式提交会跳过核对', () => {
    expect(elements.filter((el) => el.tag === 'form')).toEqual([])
    expect(elements.filter((el) => attr(el, 'type') === 'submit')).toEqual([])
    expect(convertModal).not.toContain('@submit')
    expect(handler(buttonOf(convertModal, '转存为凭据'), 'click')).toBe('submit')
  })

  it('值默认遮盖，能显示，也能改', () => {
    const input = elements.find((el) => bound(el, 'type') === "shown ? 'text' : 'password'")!
    expect(input.tag).toBe('UInput')
    expect(input.props?.find((p) => p.name === 'model')?.exp?.content).toBe('form.value')
    expect(attr(input, 'autocomplete')).toBe('new-password')
    expect(convertModal).toContain('const shown = ref(false)')
    expect(
      handler(
        elements.find((el) => bound(el, 'aria-pressed') === 'shown')!,
        'click',
      ),
    ).toBe('shown = !shown')
  })

  it('显示过当前的值才能提交；隐藏之后改过要再显示一次', () => {
    expect(convertModal).toContain(
      "if (checkedValue.value !== form.value) return '请先显示并核对值'",
    )
    expect(convertModal).toMatch(
      /watch\(\[shown, \(\) => form\.value\], \(\) => \{\s+if \(shown\.value\) checkedValue\.value = form\.value/,
    )
    expect(convertModal).toContain('if (submitting.value || problem.value || !memory.value) return')
    expect(bound(buttonOf(convertModal, '转存为凭据'), 'disabled')).toBe(
      '!memory || Boolean(problem)',
    )
  })

  it('前后文只在显示时给：遮盖时不露出值的后半段', () => {
    expect(convertModal).toContain(
      'const context = computed(() => (shown.value ? valueContext(content.value, form.value) : null))',
    )
  })

  it('规则用接口的定义，提示和服务端一致；错误按服务端的文字显示', () => {
    expect(convertModal).toContain('ConvertToCredentialRequest.safeParse(body.value)')
    expect(convertModal).toContain(
      "failure.value = err instanceof ApiError ? err.message : '转存失败'",
    )
  })

  it('提交带着打开时读到的版本', () => {
    expect(convertModal).toContain('expectedVersion: memory.value?.version ?? 0')
    expect(convertModal).toContain('staleTime: 0')
  })

  it('值不留在组件里：提交成功和关上时都清掉', () => {
    const submit = /async function submit\(\) \{[\s\S]*?\n\}/.exec(convertModal)![0]
    expect(submit).toContain("form.value = ''")
    const reset = /function reset\(\) \{[\s\S]*?\n\}/.exec(convertModal)![0]
    expect(reset).toContain("value: ''")
    expect(convertModal).toMatch(/watch\(open, \(isOpen\) => \{\s+reset\(\)/)
  })

  it('结果里写出遗留：历史里的版本和别的记忆', () => {
    expect(convertModal).toContain('convertLeftovers(result.value)')
    expect(convertModal).toContain('v-for="item in leftovers"')
  })

  it('提交期间不能关', () => {
    const modal = elements.find((el) => el.tag === 'UModal')!
    expect(bound(modal, 'dismissible')).toBe('!submitting')
    expect(bound(modal, 'close')).toBe('!submitting')
    expect(convertModal).toContain('if (!submitting.value) open.value = false')
  })
})

describe('应用', () => {
  it('只有应用所有者和空间所有者能看 Key', () => {
    expect(appKeys).toContain('enabled: computed(() => props.isAppOwner || props.isSpaceOwner)')
    expect(appKeys).toContain('仅应用所有者可查看和签发 Key')
    expect(appDetailPage).toContain(
      'const canSeeKeys = computed(() => isAppOwner.value || isSpaceOwner.value)',
    )
    expect(appDetailPage).toContain('enabled: canSeeKeys')
    expect(appsPage).toContain('isSpaceOwner.value || app.ownerAccountId === me.data.value?.id')
    expect(appsPage).toContain('仅应用所有者可查看 Key')
  })

  it('明文 Key 显示期间不能点遮罩、按 Esc 或右上角关掉', () => {
    const modal = elementsOf(appKeys).find((el) => attr(el, 'title') === '签发 API Key')!
    expect(bound(modal, 'dismissible')).toBe('!issued')
    expect(bound(modal, 'close')).toBe('!issued')
    expect(handler(buttonOf(appKeys, '我已保存'), 'click')).toBe('closeIssue')
  })

  it('签发按钮只给能签发的，吊销不看角色', () => {
    expect(appKeys).toContain('<template v-if="canIssue" #actions>')
    expect(appDetailPage).toContain(':can-issue="canManage"')
    expect(appDetailPage).toContain(
      "canManage = computed(() => isAppOwner.value && role.value !== 'viewer')",
    )
  })

  it('吊销的后果还在', () => {
    expect(appKeys).toContain('后，使用它的客户端将立即失去访问权限。')
  })

  it('转移会吊销 Key、删除有限制：后果都还在，只有有权限的人看得到按钮', () => {
    expect(appDetailPage).toContain('全部吊销，新所有者需重新签发')
    expect(appDetailPage).toContain('应用读取的个人画像层与私人层改为')
    expect(appDetailPage).toContain("'已转移，原有 Key 已全部吊销'")
    expect(appDetailPage).toContain('仍有应用层记忆时无法删除。')
    expect(appDetailPage).toContain('已删除但仍可恢复的应用层记忆也算在内，需先移到其他命名空间。')
    expect(appDetailPage).toContain('使用这些 Key 的客户端将立即失去访问权限。')
    const elements = elementsOf(appDetailPage)
    const directive = (el: TemplateNode) => el.props?.find((p) => p.name === 'if')?.exp?.content
    expect(directive(buttonOf(appDetailPage, '转移应用'))).toBe('isSpaceOwner')
    expect(directive(buttonOf(appDetailPage, '删除应用'))).toBe('canDelete')
    expect(elements.some((el) => el.tag === 'AppSimulator' && directive(el) === 'isAppOwner')).toBe(
      true,
    )
  })

  it('权限范围的数据都来自接口：矩阵和五根小岩芯用同一个查询的结果', () => {
    expect(keyMatrix).toContain('api.keyMatrix(props.spaceId, props.appId, props.keyInfo.id)')
    expect(keyMatrix).toContain('<AccessMatrix :rows="current.rows" />')
    expect(keyMatrix).toContain(':rows="rowsOf(c)"')
    expect(keyMatrix).not.toContain('issuedScopeRows')
    expect(appKeys).toContain(':rows="rowsOf(key.id)"')
    expect(appsPage).toContain(':rows="rowsOf(key.id)"')
    expect(recallDebugPanel).toContain(':rows="rowsOf(option.key.id)"')
  })

  it('签发上限和当前有效上限不同时要说，Key 那一行和权限范围都说', () => {
    expect(apps).toContain('已按所有者当前角色收紧')
    expect(appKeys).toContain('effectiveNote(key)')
    expect(appKeys).toContain('签发范围：{{ scopesSummary(key.scopes) }}')
    expect(keyMatrix).toContain('v-if="isNarrowed(keyInfo)"')
  })

  it('已吊销的单独列，岩芯不上色', () => {
    expect(appKeys).toContain('<StrataCore :scopes="key.scopes" revoked')
    expect(appKeys).toContain('已吊销 {{ formatShort(key.revokedAt!) }}')
  })

  it('已作废的 Key 不能选，也不去查矩阵：接口返回 404', () => {
    expect(appKeys).toContain('.filter((key) => key.effectiveScopes)')
    expect(appKeys).toContain("key.effectiveScopes ? 'button' : 'div'")
    expect(appDetailPage).toContain('usableKeys(keys.data.value ?? [])')
  })

  it('启动加载预览留在应用详情，链到召回调试和测试台，都带上 Key', () => {
    expect(bound(buttonOf(appSimulator, '召回调试'), 'to')).toBe(
      "{ name: 'recall', params: { spaceId }, query: { key: keyId } }",
    )
    expect(appSimulator).toContain('api.bootPreview(')
    expect(appSimulator).not.toContain('api.recallDebug')
  })

  it('换了应用、Key 或应用设置时清掉上一次的结果，旧的请求作废', () => {
    expect(appSimulator).toMatch(
      /\[\(\) => props\.spaceId, \(\) => props\.appId, \(\) => props\.keyId, \(\) => props\.settings\],\s+\(\) => \{\s+current\.value = null\s+preview\.value = null/,
    )
    expect(appSimulator).toContain('if (id === current.value) apply(result)')
  })
})

describe('召回调试', () => {
  it('只列当前账号是所有者的应用的有效 Key，和服务端一个规则', () => {
    expect(recallDebugPanel).toContain('ownedApps(apps.data.value ?? [], me.data.value?.id)')
    expect(recallDebugPanel).toContain('usableKeys(keyResults.value[i]?.data ?? [])')
  })

  it('没有自己的应用、没有有效 Key 时给出说明', () => {
    expect(recallDebugPanel).toContain('当前账号暂无应用，无法调试')
    expect(recallDebugPanel).toContain('暂无有效 Key。签发后可调试。')
  })

  it('地址里的 Key 不在列表里时不用它', () => {
    expect(recallDebugPanel).toContain(
      'options.value.find((option) => option.key.id === route.query.key) ?? options.value[0] ?? null',
    )
  })

  it('换了 Key 或应用设置时清掉结果，旧的请求作废', () => {
    expect(recallDebugPanel).toMatch(
      /watch\(\[\(\) => props\.spaceId, \(\) => selected\.value\?\.key\.id, settings\], \(\) => \{\s+current\.value = null\s+debug\.value = null/,
    )
    expect(recallDebugPanel).toContain('if (id === current.value) debug.value = result')
  })

  it('三组都在，阈值线贯穿', () => {
    expect(recallDebugPanel).toContain('<b>将注入</b>')
    expect(recallDebugPanel).toContain('<b>未注入</b>')
    expect(recallDebugPanel).toContain('<b>未进入当前 Key 的召回</b>')
    expect(recallDebugPanel).toContain("'--threshold': `${axis.threshold}%`")
    expect(recallDebugPanel.match(/left: var\(--threshold\)/g)!.length).toBeGreaterThanOrEqual(2)
    expect(recallDebugPanel).toContain('<summary>注入内容</summary>')
  })

  it('召回页挂着调试，统计的说明还在', () => {
    expect(recallPage).toContain('<RecallDebugPanel')
    expect(recallPage).toContain('更早的事件只保留每条记忆的累计次数')
    expect(recallPage).toContain('不含机密内容（不参与召回）和启动加载的节点')
    expect(recallPage).toContain('仅显示最早的 {{ data.never.length }} 条')
  })
})
