import { describe, expect, it } from 'vitest'

import createMemoryModal from '../components/CreateMemoryModal.vue?raw'
import dreamSuggestionCard from '../components/DreamSuggestionCard.vue?raw'
import entryLinksPanel from '../components/EntryLinksPanel.vue?raw'
import hygieneSweepDrawer from '../components/HygieneSweepDrawer.vue?raw'
import memoryContent from '../components/MemoryContent.vue?raw'
import memoryEditor from '../components/MemoryEditor.vue?raw'
import memoryHistoryDrawer from '../components/MemoryHistoryDrawer.vue?raw'
import memoryList from '../components/MemoryList.vue?raw'
import quickCaptureModal from '../components/QuickCaptureModal.vue?raw'
import diffViewer from '../components/ui/DiffViewer.vue?raw'
import consoleSearch from '../composables/useConsoleSearch.ts?raw'
import { icons } from '../icons'
import consoleLayout from '../layouts/ConsoleLayout.vue?raw'
import inboxPage from '../pages/InboxPage.vue?raw'
import memoriesPage from '../pages/MemoriesPage.vue?raw'
import themeSource from '../theme.ts?raw'

const vueSources = import.meta.glob<string>('../**/*.{vue,ts}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('记忆布局、随手记与图标清单', () => {
  it('顶部导航仅包含记忆、待处理、凭据与设置四项，无记忆圈切换器', () => {
    expect(consoleLayout).toContain("label: '记忆'")
    expect(consoleLayout).toContain("label: '待处理'")
    expect(consoleLayout).toContain("label: '凭据'")
    expect(consoleLayout).toContain("label: '设置'")
    expect(consoleLayout).not.toContain('switchCircle')
    expect(consoleLayout).not.toContain('StrataPatterns')
  })

  it('表单输入控件在 theme.ts 默认启用 fixed 且聚焦带 2px 内框', () => {
    expect(themeSource).toContain('defaultVariants: { fixed: true }')
    expect(themeSource).toContain('focus-visible:ring-2')
  })

  it('记忆页采用默认全宽清单、按需抽屉与一键全屏展开，并支持编辑态键盘保护与筛选互斥', () => {
    expect(memoriesPage).not.toContain('grid-template-columns: 360px minmax(0, 1fr)')
    expect(memoriesPage).toContain('clamp(360px, 40%, 520px) minmax(0, 1fr)')
    expect(memoriesPage).toContain('is-peek')
    expect(memoriesPage).toContain('is-fullscreen')
    expect(memoriesPage).toContain('全屏展开')
    expect(memoriesPage).toContain('退出全屏')
    expect(memoriesPage).toContain('exitEditing')
    expect(memoriesPage).toContain('<QuickCaptureModal')
    expect(memoriesPage).toContain('projectScope')
  })

  it('记忆列表收敛多维筛选至下拉面板，统一 30px 工具栏对齐与实线/虚线左缘图例', () => {
    expect(memoryList).toContain('ENTRY_TABS')
    expect(memoryList).toContain('UPopover')
    expect(memoryList).toContain('useKbd')
    expect(memoryList).toContain('id="memories-search"')
    expect(memoryList).toContain('height: 28px')
    expect(memoryList).toContain('height: 36px')
    expect(memoryList).toContain('无项目归属')
    expect(memoryList).toContain('已关联项目')
    expect(memoryList).toContain('facets?.topics')
    expect(memoryList).toContain('facets?.projects')
    expect(memoryList).toContain('facets?.envs')
    expect(memoryList).toContain('facets?.realms')
    expect(memoryList).toContain('rail-swatch solid')
    expect(memoryList).toContain('rail-swatch dashed')
    expect(memoryList).toContain('is-pinned::before')
    expect(memoryList).toContain('is-episode::before')
    expect(memoryList).toContain('随手记')
  })

  it('新建与随手记弹窗不用表单隐式提交，随手记支持无模型追加、乐观锁撤销与 409 恢复', () => {
    expect(createMemoryModal).not.toContain('<form')
    expect(createMemoryModal).toContain('detectSecretPrefixes')
    expect(quickCaptureModal).not.toContain('<form')
    expect(quickCaptureModal).toContain('detectSecretPrefixes')
    expect(quickCaptureModal).toContain('api.capturePlan')
    expect(quickCaptureModal).toContain('applyMarkdownAppend')
    expect(quickCaptureModal).toContain('checkCaptureIntegrity')
    expect(quickCaptureModal).toContain('<DiffViewer')
    expect(quickCaptureModal).toContain('AbortController')
    expect(quickCaptureModal).toContain('api.restoreEntry')
    expect(quickCaptureModal).toContain('expectedVersion: mergedVersion')
    expect(quickCaptureModal).toContain('hasDiffChanges')
    expect(quickCaptureModal).toContain('重新匹配')
    expect(quickCaptureModal).toContain('useKbd')
    expect(quickCaptureModal).toContain('改为文末追加')
    expect(quickCaptureModal).toContain('存为新记忆')
    expect(consoleSearch).toContain('captureRoute')
    expect(consoleSearch).toContain("route.name === 'memories'")
  })

  it('编辑器支持三态分栏同步滚动、状态线轨图例、编辑态暴露、双链与会话摘要一键提炼', () => {
    expect(memoryEditor).toContain('container-type: inline-size')
    expect(memoryEditor).toContain('@container (min-width: 680px)')
    expect(memoryEditor).toContain('useMarkdownSyncScroll')
    expect(memoryEditor).toContain('EDIT_VIEW_OPTIONS')
    expect(memoryEditor).toContain('<DiffViewer')
    expect(memoryEditor).toContain('height: 36px')
    expect(memoryEditor).toContain('rail-swatch solid')
    expect(memoryEditor).toContain('rail-swatch dashed')
    expect(memoryEditor).toContain('isEditing')
    expect(memoryEditor).toContain('exitEditing')
    expect(memoryEditor).toContain('detectSecretPrefixes')
    expect(memoryEditor).toContain('promoteToEntry: true')
    expect(memoryEditor).toContain('insertWikiLink')
    expect(memoryEditor).toContain('insertCredential')
    expect(memoryEditor).toContain('<MemoryHistoryDrawer')
    expect(memoryEditor).toContain('<EntryLinksPanel')
    expect(memoryEditor).toContain('@container (min-width: 960px)')
    expect(memoryEditor).toContain('stripDuplicateLeadingHeading')
    expect(memoryEditor).toContain('extractMarkdownOutline')
    expect(memoryEditor).toContain('analyzeTitleHint')
    expect(memoryEditor).toContain('拆出至变更说明')
    expect(memoryEditor).toContain('<SaveBar')
    expect(memoryContent).toContain(':deep(details)')
    expect(entryLinksPanel).toContain('contextSnippet')
  })

  it('列表保留近改副行与常驻水位，历史工作台与通用 DiffViewer 支持单双栏、词级高亮与按需展开上下文', () => {
    expect(memoryList).toContain('近改：')
    expect(memoryList).toContain('PINNED_CHAR_BUDGET')
    expect(memoryList).toContain('pinned-budget')
    expect(memoryList).not.toContain('.list-pane.is-compact .row-disclosure')

    expect(memoryHistoryDrawer).toContain('max-w-6xl')
    expect(memoryHistoryDrawer).toContain('ring-2 ring-rule')
    expect(memoryHistoryDrawer).toContain('diffEntrySnapshots')
    expect(memoryHistoryDrawer).toContain('formatActorLabel')
    expect(memoryHistoryDrawer).toContain('对比两版')
    expect(memoryHistoryDrawer).toContain('属性变动')
    expect(memoryHistoryDrawer).toContain('<DiffViewer')

    expect(diffViewer).toContain('computeStructuredDiff')
    expect(diffViewer).toContain('buildDiffDisplayChunks')
    expect(diffViewer).toContain('buildSplitDiffPairs')
    expect(diffViewer).toContain('expandGap')
    expect(diffViewer).toContain('jumpHunk')
    expect(dreamSuggestionCard).toContain('<DiffViewer')
    expect(hygieneSweepDrawer).toContain('<DiffViewer')
  })

  it('待处理页与建议卡片具备分类筛选、五重护栏、分项应用、纯标题速审表、预清洗抽屉与 8 秒撤销', () => {
    expect(inboxPage).toContain('结构体检与预清洗')
    expect(inboxPage).toContain('存量规范整理')
    expect(inboxPage).toContain('纯标题速审表')
    expect(inboxPage).toContain('duration: 8000')
    expect(inboxPage).toContain('api.restoreEntry')
    expect(inboxPage).toContain('<HygieneSweepDrawer')

    expect(dreamSuggestionCard).toContain('checkCaptureIntegrity')
    expect(dreamSuggestionCard).toContain('title-compare')
    expect(dreamSuggestionCard).toContain('guard-strip')
    expect(dreamSuggestionCard).toContain('规范标题')
    expect(dreamSuggestionCard).toContain('原有完整内容保留在版本历史中，可随时恢复')
    expect(dreamSuggestionCard).toContain('archivedNotes')

    expect(hygieneSweepDrawer).toContain('api.previewHygieneSweep')
    expect(hygieneSweepDrawer).toContain('api.applyHygieneSweep')
    expect(hygieneSweepDrawer).toContain('疑似残缺记忆')
    expect(hygieneSweepDrawer).toContain('疑似过时记忆')
  })

  it('界面中引用的全部 icons.* 均已在 icons.ts 注册，且没有直接写死未打包的 i-lucide-*', () => {
    const registered = new Set(Object.keys(icons))
    const missing: string[] = []
    const rawIconLiterals: string[] = []
    for (const [path, source] of Object.entries(vueSources)) {
      if (path.includes('__tests__') || path.endsWith('/icons.ts')) continue
      for (const m of source.matchAll(/\bicons\.([a-zA-Z0-9_]+)/g)) {
        if (!registered.has(m[1]!)) missing.push(`${path}: icons.${m[1]}`)
      }
      if (source.includes('i-lucide-')) rawIconLiterals.push(path)
    }
    expect(missing).toEqual([])
    expect(rawIconLiterals).toEqual([])
  })
})
