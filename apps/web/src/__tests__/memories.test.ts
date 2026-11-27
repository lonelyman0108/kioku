import { describe, expect, it } from 'vitest'

import endpointsSource from '../api/endpoints.ts?raw'
import accountDataSettings from '../components/AccountDataSettings.vue?raw'
import bootPreviewDrawer from '../components/BootPreviewDrawer.vue?raw'
import consequenceModal from '../components/ConsequenceModal.vue?raw'
import createMemoryModal from '../components/CreateMemoryModal.vue?raw'
import dataTransferPanel from '../components/DataTransferPanel.vue?raw'
import dreamSuggestionCard from '../components/DreamSuggestionCard.vue?raw'
import entryLinksPanel from '../components/EntryLinksPanel.vue?raw'
import hygieneSweepDrawer from '../components/HygieneSweepDrawer.vue?raw'
import memoryContent from '../components/MemoryContent.vue?raw'
import memoryEditor from '../components/MemoryEditor.vue?raw'
import memoryHistoryDrawer from '../components/MemoryHistoryDrawer.vue?raw'
import memoryList from '../components/MemoryList.vue?raw'
import modelSettings from '../components/ModelSettings.vue?raw'
import quickCaptureModal from '../components/QuickCaptureModal.vue?raw'
import sceneScopePicker from '../components/SceneScopePicker.vue?raw'
import singleTidyDrawer from '../components/SingleTidyDrawer.vue?raw'
import diffViewer from '../components/ui/DiffViewer.vue?raw'
import emptyState from '../components/ui/EmptyState.vue?raw'
import noteLine from '../components/ui/NoteLine.vue?raw'
import shortIdLine from '../components/ui/ShortIdLine.vue?raw'
import wikiText from '../components/ui/WikiText.vue?raw'
import consoleSearch from '../composables/useConsoleSearch.ts?raw'
import { icons } from '../icons'
import consoleLayout from '../layouts/ConsoleLayout.vue?raw'
import credentialsPage from '../pages/CredentialsPage.vue?raw'
import inboxPage from '../pages/InboxPage.vue?raw'
import memoriesPage from '../pages/MemoriesPage.vue?raw'
import settingsPage from '../pages/SettingsPage.vue?raw'
import themeSource from '../theme.ts?raw'

const vueSources = import.meta.glob<string>('../**/*.{vue,ts}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('记忆布局、随手记与图标清单', () => {
  it('顶部导航仅包含记忆、整理、凭据与设置四项，无记忆圈切换器', () => {
    expect(consoleLayout).toContain("label: '记忆'")
    expect(consoleLayout).toContain("label: '整理'")
    expect(consoleLayout).toContain("label: '凭据'")
    expect(consoleLayout).toContain("label: '设置'")
    expect(consoleLayout).not.toContain('switchCircle')
    expect(consoleLayout).not.toContain('StrataPatterns')
  })

  it('表单输入控件在 theme.ts 默认启用 fixed 且聚焦带 2px 内框', () => {
    expect(themeSource).toContain('defaultVariants: { fixed: true }')
    expect(themeSource).toContain('focus-visible:ring-2')
  })

  it('记忆页采用默认居中清单、可拖动分隔栏与平滑展开抽屉，并支持编辑态键盘保护与筛选互斥', () => {
    expect(memoriesPage).not.toContain('grid-template-columns: 360px minmax(0, 1fr)')
    expect(memoriesPage).toContain('var(--list-width, 380px) minmax(0, 1fr)')
    expect(memoriesPage).toContain('role="separator"')
    expect(memoriesPage).toContain('pane-splitter')
    expect(memoriesPage).toContain('detail-reveal')
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
    expect(memoryContent).toContain('width-full')
    expect(memoryEditor).not.toContain('宽幅阅读')
    expect(memoryEditor).toContain('--canvas-max')
    expect(memoryEditor).toContain('edit-meta-grid')
    expect(memoryEditor).toContain('rail-splitter')
    expect(memoryEditor).toContain('readRailWidth')
    expect(memoryEditor).toContain('rail-history-disclosure')
    expect(entryLinksPanel).toContain('contextSnippet')
    expect(entryLinksPanel).toContain('stripInlineMarkdown')
  })

  it('宽屏采用居中画布对齐，整理页采用全宽待确认列表，设置采用双栏侧边导航结构，弹窗与抽屉幅面匹配内容密度', () => {
    expect(consoleLayout).toContain('console-header-inner')
    expect(memoriesPage).toContain('margin-inline: auto')
    expect(credentialsPage).toContain('credentials-shell')
    expect(credentialsPage).toContain('margin-inline: auto')
    expect(inboxPage).toContain('command-bar')
    expect(inboxPage).toContain('ledger-table')
    expect(inboxPage).toContain('margin-inline: auto')
    expect(settingsPage).toContain('settings-workspace')
    expect(settingsPage).toContain('settings-vnav')
    expect(settingsPage).toContain('margin-inline: auto')
    expect(quickCaptureModal).toContain('max-w-5xl')
    expect(hygieneSweepDrawer).toContain('max-w-[960px]')
    expect(createMemoryModal).toContain('attrs-collapse')
  })

  it('列表保留近改副行与分层常驻水位，支持自定义客户端与终端启动加载预览，历史工作台与 DiffViewer 完整', () => {
    expect(memoryList).toContain('近改：')
    expect(memoryList).toContain('GLOBAL_FULL_CHAR_CAP')
    expect(memoryList).toContain('pinned-budget')
    expect(memoryList).toContain('facets?.runtimes')
    expect(memoryList).toContain('预览终端加载')
    expect(memoryList).not.toMatch(
      /\.list-pane\.is-compact\s+\.row-disclosure\s*\{[^}]*display:\s*none/,
    )
    expect(memoriesPage).toContain('<BootPreviewDrawer')
    expect(sceneScopePicker).toContain('自定义客户端')
    expect(memoryEditor).toContain('pinPopoverOpen')
    expect(memoryEditor).toContain('editBootWarnings')
    expect(bootPreviewDrawer).toContain('api.previewBoot')
    expect(bootPreviewDrawer).toContain('ring-2 ring-rule')

    expect(memoryHistoryDrawer).toContain('max-w-[1640px]')
    expect(memoryHistoryDrawer).toContain('ring-2 ring-rule')
    expect(memoryHistoryDrawer).toContain('diffEntrySnapshots')
    expect(memoryHistoryDrawer).toContain('formatActorLabel')
    expect(memoryHistoryDrawer).toContain('item.snapshot != null')
    expect(memoryHistoryDrawer).toContain('previousItemId')
    expect(memoryHistoryDrawer).toContain('对比基准')
    expect(memoryHistoryDrawer).toContain('设为基准')
    expect(memoryHistoryDrawer).not.toContain('选入对比')
    expect(memoryHistoryDrawer).not.toMatch(/font-size:\s*1[01](?:\.\d+)?px/)
    expect(memoryHistoryDrawer).toContain('属性变动')
    expect(memoryHistoryDrawer).toContain('<DiffViewer')

    expect(diffViewer).toContain('computeStructuredDiff')
    expect(diffViewer).toContain('buildDiffDisplayChunks')
    expect(diffViewer).toContain('buildSplitDiffPairs')
    expect(diffViewer).toContain('expandGap')
    expect(diffViewer).toContain('jumpHunk')
    expect(diffViewer).toContain('gapRangeText')
    expect(diffViewer).toContain('ResizeObserver')
    expect(diffViewer).not.toMatch(/font-size:\s*1[01](?:\.\d+)?px/)
    expect(dreamSuggestionCard).toContain('<DiffViewer')
    expect(hygieneSweepDrawer).toContain('<DiffViewer')
  })

  it('整理页采用四列待确认列表、行内双栏审校面板、高风险展开护栏、批量安全应用、结构检查抽屉与 8 秒撤销，且消除逐卡免责套话', () => {
    expect(inboxPage).toContain('结构检查')
    expect(inboxPage).toContain('规范整理')
    expect(inboxPage).toContain('增量整理')
    expect(inboxPage).toContain('批量应用安全项')
    expect(inboxPage).toContain('展开核对')
    expect(inboxPage).toContain('layout="inspector"')
    expect(inboxPage).toContain('ledger-footnote')
    expect(inboxPage).toContain('dreamKindIcons')
    expect(inboxPage).toContain('.inspector-row > td::before')
    expect(inboxPage).toContain('duration: 8000')
    expect(inboxPage).toContain('api.restoreEntry')
    expect(inboxPage).toContain('<HygieneSweepDrawer')

    expect(dreamSuggestionCard).toContain('checkCaptureIntegrity')
    expect(dreamSuggestionCard).toContain('title-compare')
    expect(dreamSuggestionCard).toContain('guard-strip')
    expect(dreamSuggestionCard).toContain('规范标题')
    expect(dreamSuggestionCard).toContain('整理依据')
    expect(dreamSuggestionCard).not.toContain('原有完整内容保留在版本历史中')
    expect(dreamSuggestionCard).toContain('archivedNotes')

    expect(singleTidyDrawer).not.toContain('原有完整内容会保留在版本历史中')
    expect(hygieneSweepDrawer).not.toContain('原有完整内容均保存在版本历史中')
    expect(hygieneSweepDrawer).toContain('api.previewHygieneSweep')
    expect(hygieneSweepDrawer).toContain('api.applyHygieneSweep')
    expect(hygieneSweepDrawer).toContain('疑似残缺记忆')
    expect(hygieneSweepDrawer).toContain('疑似过时记忆')
    expect(hygieneSweepDrawer).toContain('悬空断链')
    expect(hygieneSweepDrawer).toContain('brokenLinks')
  })

  it('具备跨记忆查重与关联、反链提示、单条主动整理抽屉、三模式独立定时与思考等级参数预览', () => {
    expect(inboxPage).toContain('查重与关联')
    expect(inboxPage).toContain("mode: 'cross_memory'")
    expect(inboxPage).toContain('redirectedBacklinkCount')
    expect(inboxPage).toContain('link_entries')
    expect(inboxPage).toContain('adjust_boot_mode')
    expect(inboxPage).toContain('popover-schedules')

    expect(dreamSuggestionCard).toContain('affectedBacklinkCount')
    expect(dreamSuggestionCard).toContain('proposedLinks')
    expect(dreamSuggestionCard).toContain('proposedBootMode')
    expect(dreamSuggestionCard).toContain('重定向至保留目标')
    expect(dreamSuggestionCard).toContain('scope-review')
    expect(dreamSuggestionCard).toContain('将写入场景')
    expect(dreamSuggestionCard).toContain('来源设备')
    expect(dreamSuggestionCard).toContain('全局通用')
    expect(dreamSuggestionCard).toContain('effectiveDisclosure')
    expect(dreamSuggestionCard).toContain('entry.deviceKey')
    expect(dreamSuggestionCard).not.toMatch(/font-size:\s*1[01](?:\.\d+)?px/)
    expect(sceneScopePicker).toContain('自定义主机标识')
    expect(sceneScopePicker).toContain('仅标主机标识')

    expect(memoryEditor).toContain('<SingleTidyDrawer')
    expect(memoryEditor).toContain('<QuickCaptureModal')
    expect(memoryEditor).toContain(':target-entry')
    expect(memoryEditor).toContain('按说明修订')
    expect(memoryEditor).toContain('规范此条')
    expect(memoryEditor).toContain('查重与关联')
    expect(memoryEditor).toContain('pendingSuggestionCount')

    expect(quickCaptureModal).toContain('targetEntry')
    expect(quickCaptureModal).toContain("mode: 'refine'")
    expect(quickCaptureModal).toContain('按说明修订')
    expect(quickCaptureModal).toContain('adoptMeta')
    expect(quickCaptureModal).toContain('proposedEnvs')
    expect(quickCaptureModal).toContain('<SceneScopePicker')
    expect(quickCaptureModal).toContain('duration: 8000')

    expect(dreamSuggestionCard).not.toContain('<form')
    expect(dreamSuggestionCard).toContain('useSession')
    expect(dreamSuggestionCard).toContain('api.reviseInboxSuggestion')
    expect(dreamSuggestionCard).toContain('REVISABLE_DREAM_KINDS')
    expect(dreamSuggestionCard).toContain('按说明修订')
    expect(dreamSuggestionCard).toContain('revise-bar')
    expect(dreamSuggestionCard).toContain('revise-preview-panel')

    expect(endpointsSource).toContain('reviseInboxSuggestion')
    expect(endpointsSource).toContain('ReviseSuggestionResponse')

    expect(singleTidyDrawer).toContain('api.previewSingleTidy')
    expect(singleTidyDrawer).toContain('api.applySingleTidy')
    expect(singleTidyDrawer).toContain('api.crossCheckEntry')
    expect(singleTidyDrawer).toContain('stageToInbox')
    expect(singleTidyDrawer).toContain('<DiffViewer')
    expect(singleTidyDrawer).toContain('<DreamSuggestionCard')

    expect(memoryList).toContain('批量整理')
    expect(memoryList).toContain('规范所选')
    expect(memoryList).toContain('查重与关联')
    expect(memoriesPage).toContain('onBatchOrganize')

    expect(modelSettings).toContain('reasoningEffortWireValues')
    expect(modelSettings).toContain('overrideSummaryText')
    expect(modelSettings).not.toContain('taskOverridesOpen.value = true')
    expect(modelSettings).toContain('crossMemory')
    expect(modelSettings).toContain('schedule-list')

    expect(noteLine).toContain('icons.warning')
    expect(emptyState).toContain('empty-icon')
    expect(shortIdLine).toContain('复制')
    expect(consequenceModal).toContain('actionIcon')
    expect(entryLinksPanel).toContain('icons.backlink')
    expect(consoleSearch).toContain('createEntryRoute')
    expect(consoleSearch).toContain('effectiveBootMode')
    expect(accountDataSettings).toContain('parseUserAgent')
    expect(dataTransferPanel).toContain('icons.fileDown')
    expect(dataTransferPanel).toContain('icons.fileUp')
  })

  it('常驻预算支持分组筛选与超限指引，双链统一呈现图标与标题芯片，全站界面淡化记忆短 ID', () => {
    expect(memoriesPage).toContain('PINNED_GROUPS')
    expect(memoriesPage).toContain('pinnedGroup')
    expect(memoriesPage).toContain('linkedTitles')
    expect(memoriesPage).toContain('resetAllFilters')

    expect(memoryList).toContain('global_full')
    expect(memoryList).toContain('scoped_full')
    expect(memoryList).toContain('全局全文')
    expect(memoryList).toContain('场景全文')
    expect(memoryList).toContain('<WikiText')
    expect(memoryList).toContain('.entry-row[data-short-id]')
    expect(memoryList).toContain('--wiki-chip-bg')
    expect(memoryList).not.toContain('class="row-id"')

    expect(wikiText).toContain('icons.linkChain')
    expect(wikiText).toContain('wiki-chip')
    expect(wikiText).toContain('markMissing')
    expect(wikiText).not.toContain(':global(.entry-row.selected)')
    expect(memoryContent).toContain('kioku-wikilink-icon')

    expect(memoryEditor).toContain('<WikiText')
    expect(memoryEditor).toContain('status-copy-id')
    expect(memoryEditor).toContain('status-id-code')
    expect(memoryEditor).toContain('head-change-line')
    expect(memoryEditor).not.toContain('<ShortIdLine')
    expect(memoryEditor).toContain(':entry-title="entry.title"')

    expect(memoryHistoryDrawer).toContain('entryTitle')
    expect(memoryHistoryDrawer).toContain('<WikiText')
    expect(memoryHistoryDrawer).toContain('snapshotWikiLinks')
    expect(memoryHistoryDrawer).not.toContain('`版本历史 · ${shortId}`')

    expect(dreamSuggestionCard).toContain('<WikiText')
    expect(dreamSuggestionCard).not.toContain('<label class="link-check-label">')
    expect(entryLinksPanel).toContain('<WikiText')
    expect(entryLinksPanel).not.toContain('{{ item.shortId }}')
    expect(bootPreviewDrawer).not.toContain('class="item-id')
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
