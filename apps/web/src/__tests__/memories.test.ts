import { describe, expect, it } from 'vitest'

import createMemoryModal from '../components/CreateMemoryModal.vue?raw'
import memoryEditor from '../components/MemoryEditor.vue?raw'
import memoryList from '../components/MemoryList.vue?raw'
import consoleLayout from '../layouts/ConsoleLayout.vue?raw'
import memoriesPage from '../pages/MemoriesPage.vue?raw'
import { icons } from '../icons'

const vueSources = import.meta.glob<string>('../**/*.{vue,ts}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('记忆双栏界面与图标清单', () => {
  it('顶部导航仅包含记忆、待处理、凭据与设置四项，无记忆圈切换器', () => {
    expect(consoleLayout).toContain("label: '记忆'")
    expect(consoleLayout).toContain("label: '待处理'")
    expect(consoleLayout).toContain("label: '凭据'")
    expect(consoleLayout).toContain("label: '设置'")
    expect(consoleLayout).not.toContain('switchCircle')
    expect(consoleLayout).not.toContain('StrataPatterns')
  })

  it('记忆页采用双栏布局，列表支持四分页与筛选，新建弹窗不用表单隐式提交', () => {
    expect(memoriesPage).toContain('grid-template-columns: 360px minmax(0, 1fr)')
    expect(memoryList).toContain('ENTRY_TABS')
    expect(memoryList).toContain('facets.projects')
    expect(memoryList).toContain('facets.envs')
    expect(memoryList).toContain('facets.realms')
    expect(createMemoryModal).not.toContain('<form')
    expect(createMemoryModal).toContain('detectSecretPrefixes')
  })

  it('编辑器支持双链、凭据插入、轻量明文提醒、历史抽屉与会话摘要一键提炼', () => {
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
