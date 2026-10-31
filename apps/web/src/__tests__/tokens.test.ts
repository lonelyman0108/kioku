import { readFileSync } from 'node:fs'

import colorsPlugin from '@nuxt/ui/runtime/plugins/colors.js?raw'
import { describe, expect, it } from 'vitest'

import { STACK } from '../components/strata/strata'
import { theme } from '../theme'

// 令牌写在 CSS 里，这里直接读文件核对对比度：改颜色时不用开浏览器就知道过没过线。
// 不能 import ?raw：vitest 默认把 CSS 文件换成空字符串
const css = readFileSync(new URL('../assets/css/main.css', import.meta.url), 'utf8')

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`)
  expect(start, `main.css 里要有 ${selector}`).toBeGreaterThanOrEqual(0)
  const body = css.slice(start, css.indexOf('\n}', start))
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  )
}

const hex = (value: string | undefined): [number, number, number] => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value ?? '')
  expect(m, `应当是六位十六进制颜色：${value}`).not.toBeNull()
  return [parseInt(m![1]!, 16), parseInt(m![2]!, 16), parseInt(m![3]!, 16)]
}
const luminance = (rgb: [number, number, number]) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string | undefined, b: string | undefined) => {
  const [x, y] = [luminance(hex(a)), luminance(hex(b))]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const light = block(':root,\n.light')
const dark = block('.dark')
const themes = { 浅色: light, 深色: dark }
const scale = (name: string, shade: number) =>
  new RegExp(`--color-${name}-${shade}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)?.[1]

describe('Nuxt UI 的语义色', () => {
  it('theme.colors 里的每个名字在 main.css 里都有整套色阶', () => {
    for (const [role, name] of Object.entries<string>(theme.colors)) {
      for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
        expect(scale(name, shade), `${role} ${name}-${shade}`).toBeDefined()
      }
    }
  })

  it('中性色写的是自定义色阶：插件运行时还要按名字拼变量，否则断言成 stone 的那一处就不成立了', () => {
    expect(theme.colors.neutral).toBe('paper')
    expect(colorsPlugin).toMatch(/color-\$\{[^}]*value[^}]*\}-\$\{shade\}/)
  })
})

describe('两套主题的令牌', () => {
  it('编码用到的令牌两边都有', () => {
    const names = (t: Record<string, string>) =>
      Object.keys(t).filter((k) => k.startsWith('--strata-') || k.startsWith('--layer-'))
    expect(names(dark).sort()).toEqual(names(light).sort())
    for (const layer of STACK) {
      expect(light[`--layer-${layer}`]).toBeDefined()
      expect(dark[`--layer-${layer}`]).toBeDefined()
    }
  })

  it('圆角归零', () => {
    expect(light['--ui-radius']).toMatch(/^0(rem|px)?$/)
  })

  for (const [name, t] of Object.entries(themes)) {
    describe(name, () => {
      it('文字在页面底色上过 4.5:1', () => {
        for (const token of [
          '--ui-text-dimmed',
          '--ui-text-muted',
          '--ui-text-toned',
          '--ui-text',
          '--ui-text-highlighted',
        ]) {
          expect(contrast(t[token], t['--ui-bg']), token).toBeGreaterThanOrEqual(4.5)
        }
      })

      it('次级文字在悬停的底色上也过线', () => {
        expect(contrast(t['--ui-text-muted'], t['--ui-bg-elevated'])).toBeGreaterThanOrEqual(4.5)
      })

      it('压在层色上的文字过线', () => {
        for (const layer of STACK) {
          expect(
            contrast(t['--strata-on-layer'], t[`--layer-${layer}`]),
            layer,
          ).toBeGreaterThanOrEqual(4.5)
        }
      })

      it('选中行与机密实心块上的文字过线', () => {
        expect(contrast(t['--strata-on-selected'], t['--strata-selected'])).toBeGreaterThanOrEqual(
          4.5,
        )
        expect(
          contrast(t['--strata-on-selected-muted'], t['--strata-selected']),
        ).toBeGreaterThanOrEqual(4.5)
        expect(contrast(t['--strata-on-solid'], t['--strata-solid'])).toBeGreaterThanOrEqual(4.5)
      })

      it('只读的淡色和只能按 URI 读取的实心块分得开，上面的文字过线', () => {
        const bg = hex(t['--ui-bg'])
        const share = parseInt(t['--strata-tint']!) / 100
        for (const layer of STACK) {
          const tint = hex(t[`--layer-${layer}`]).map((v, i) =>
            Math.round(v * share + bg[i]! * (1 - share)),
          )
          const color = `#${tint.map((v) => v.toString(16).padStart(2, '0')).join('')}`
          expect(contrast(color, t['--strata-solid']), layer).toBeGreaterThanOrEqual(1.7)
          expect(contrast(t['--ui-text-highlighted'], color), layer).toBeGreaterThanOrEqual(4.5)
        }
        expect(contrast(t['--strata-solid'], t['--ui-bg'])).toBeGreaterThanOrEqual(1.5)
      })

      it('反色按钮的文字过线', () => {
        expect(contrast(t['--ui-text-inverted'], t['--ui-bg-inverted'])).toBeGreaterThanOrEqual(4.5)
      })
    })
  }

  // Nuxt UI 的语义色：浅色主题取 500，深色主题取 400，都会被当成文字用
  for (const color of ['brick', 'ochre', 'moss', 'lake']) {
    it(`${color} 当文字用时过线`, () => {
      expect(contrast(scale(color, 500), light['--ui-bg'])).toBeGreaterThanOrEqual(4.5)
      expect(contrast(scale(color, 400), dark['--ui-bg'])).toBeGreaterThanOrEqual(4.5)
    })
  }

  it('主色是墨：浅色主题的 900、深色主题的 100，和正文同色', () => {
    expect(light['--ui-primary']).toBe('var(--ui-color-primary-900)')
    expect(dark['--ui-primary']).toBe('var(--ui-color-primary-100)')
    expect(scale('ink', 900)!.toLowerCase()).toBe(light['--ui-text'])
    expect(scale('ink', 100)!.toLowerCase()).toBe(dark['--ui-text'])
  })
})
