import { describe, expect, it } from 'vitest'

import createMemoryModal from '../components/CreateMemoryModal.vue?raw'
import memoryEditor from '../components/MemoryEditor.vue?raw'
import memoryList from '../components/MemoryList.vue?raw'
import quickCaptureModal from '../components/QuickCaptureModal.vue?raw'
import consoleSearch from '../composables/useConsoleSearch.ts?raw'
import { icons } from '../icons'
import consoleLayout from '../layouts/ConsoleLayout.vue?raw'
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
    expect(quickCaptureModal).toContain('collapseUnchanged')
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

  it('编辑器支持容器查询分栏、状态线轨图例、编辑态暴露、双链与会话摘要一键提炼', () => {
    expect(memoryEditor).toContain('container-type: inline-size')
    expect(memoryEditor).toContain('@container (min-width: 820px)')
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
