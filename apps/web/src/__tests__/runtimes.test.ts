import { RUNTIME_FAMILIES } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'

import loreImport from '../components/LoreImport.vue?raw'
import runtimeIcon from '../components/RuntimeIcon.vue?raw'
import RuntimeIcon from '../components/RuntimeIcon.vue'
import RuntimeLabel from '../components/RuntimeLabel.vue'
import spaceExport from '../components/SpaceExport.vue?raw'
import spaceImport from '../components/SpaceImport.vue?raw'
import modalOrBare from '../components/strata/ModalOrBare.vue?raw'
import appsPage from '../pages/AppsPage.vue?raw'
import { RUNTIME_OPTIONS, runtimeHint, runtimeName } from '../runtimes'

describe('运行时选项与图标', () => {
  it('每个契约里的运行时都有展示名称、短说明与轮廓图标', () => {
    expect(RUNTIME_OPTIONS.map((o) => o.value)).toEqual([...RUNTIME_FAMILIES])
    for (const family of RUNTIME_FAMILIES) {
      expect(runtimeName(family).length).toBeGreaterThan(0)
      expect(runtimeHint(family).length).toBeGreaterThan(0)
      if (family !== 'other') {
        expect(runtimeIcon).toContain(`${family}:`)
      }
    }
    // 未知值与原型属性回退，不从原型链误取值
    expect(runtimeName('custom-cli')).toBe('custom-cli')
    expect(runtimeName('toString')).toBe('toString')
    expect(runtimeHint('constructor')).toBe('')

    expect(appsPage).toContain('role="radiogroup"')
    expect(appsPage).toContain('type="radio"')
    expect(appsPage).toContain(':dismissible="!creating"')
    expect(appsPage).toContain('<RuntimeIcon')
    expect(appsPage).toContain('<RuntimeLabel')
  })

  it('RuntimeIcon 与 RuntimeLabel 可渲染且未知运行时回退默认轮廓', async () => {
    const iconHtml = await renderToString(
      createSSRApp({ render: () => h(RuntimeIcon, { family: 'unknown', size: 20 }) }),
    )
    expect(iconHtml).toContain('width="20"')
    expect(iconHtml).toContain('height="20"')
    expect(iconHtml).toContain('<path')

    const labelHtml = await renderToString(
      createSSRApp({ render: () => h(RuntimeLabel, { family: 'agy', size: 16 }) }),
    )
    expect(labelHtml).toContain('Antigravity')
    expect(labelHtml).toContain('<svg')
  })

  it('导入与导出在设置页收为入口卡片，流程在独立弹窗中完成', () => {
    expect(spaceExport).toContain('<TransferEntryRow')
    expect(spaceExport).toContain('<UModal')
    expect(spaceExport).toContain(':dismissible="!exporting"')
    expect(loreImport).toContain('<TransferEntryRow')
    expect(loreImport).toContain('role="tablist"')
    expect(loreImport).toContain('role="tabpanel"')
    expect(spaceImport).toContain('<ModalOrBare')
    expect(modalOrBare).toContain('!props.open')
  })
})
