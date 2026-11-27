import { RUNTIME_FAMILIES } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'

import runtimeIcon from '../components/RuntimeIcon.vue?raw'
import RuntimeIcon from '../components/RuntimeIcon.vue'
import RuntimeLabel from '../components/RuntimeLabel.vue'
import { RUNTIME_OPTIONS, runtimeHint, runtimeName } from '../runtimes'

describe('运行时选项与图标', () => {
  it('每个契约里的运行时都有展示名称、短说明与轮廓图标', () => {
    expect(RUNTIME_OPTIONS.map((o) => o.value)).toEqual([...RUNTIME_FAMILIES])
    for (const family of RUNTIME_FAMILIES) {
      expect(runtimeName(family).length).toBeGreaterThan(0)
      expect(runtimeHint(family).length).toBeGreaterThan(0)
      if (family !== 'generic') {
        expect(runtimeIcon).toContain(`${family}:`)
      }
    }
    expect(runtimeName('custom-cli')).toBe('custom-cli')
    expect(runtimeName('toString')).toBe('toString')
    expect(runtimeHint('constructor')).toBe('')
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

    const zcodeHtml = await renderToString(
      createSSRApp({ render: () => h(RuntimeLabel, { family: 'zcode', size: 16 }) }),
    )
    expect(zcodeHtml).toContain('ZCode')
    expect(zcodeHtml).toContain('<svg')
  })
})
