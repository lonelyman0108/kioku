import { readFileSync } from 'node:fs'

import colorsPlugin from '@nuxt/ui/runtime/plugins/colors.js?raw'
import { describe, expect, it } from 'vitest'

import { theme } from '../theme'

// 令牌写在 CSS 里，直接读文件核对对比度、色阶与零圆角约束
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
const over = (fg: string | undefined, share: number, bg: string | undefined) => {
  const under = hex(bg)
  const mixed = hex(fg).map((v, i) => Math.round(v * share + under[i]! * (1 - share)))
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

const light = block(':root,\n.light')
const dark = block('.dark')
const themes = { 浅色: light, 深色: dark }
const scale = (name: string, shade: number) =>
  new RegExp(`--color-${name}-${shade}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)?.[1]
const linkLine =
  Number(/color-mix\(in srgb, currentColor (\d+)%, transparent\)/.exec(css)?.[1]) / 100

describe('Nuxt UI 的语义色', () => {
  it('theme.colors 里的每个名字在 main.css 里都有整套色阶', () => {
    for (const [role, name] of Object.entries<string>(theme.colors)) {
      for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
        expect(scale(name, shade), `${role} ${name}-${shade}`).toBeDefined()
      }
    }
  })

  it('中性色使用自定义 paper 色阶且运行时按名称拼变量', () => {
    expect(theme.colors.neutral).toBe('paper')
    expect(colorsPlugin).toMatch(/color-\$\{[^}]*value[^}]*\}-\$\{shade\}/)
  })
})

describe('文字链接', () => {
  it('两种写法的下划线保持同一透明度', () => {
    expect(linkLine).toBeGreaterThan(0)
    expect(JSON.stringify(theme.button.compoundVariants)).toContain(
      `decoration-current/${linkLine * 100}`,
    )
  })
})

describe('两套主题的令牌', () => {
  it('已移除旧版色带与权限格子令牌', () => {
    expect(css).not.toMatch(/--layer-/)
    expect(css).not.toMatch(/--access-/)
    expect(css).not.toMatch(/--strata-/)
  })

  it('圆角归零且阴影清空', () => {
    expect(light['--ui-radius']).toMatch(/^0(rem|px)?$/)
    expect(css).toContain('--shadow-*: initial;')
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

      it('次级文字在悬停底色上过 4.5:1', () => {
        expect(contrast(t['--ui-text-muted'], t['--ui-bg-elevated'])).toBeGreaterThanOrEqual(4.5)
      })

      it('选中行与反色按钮上的文字过 4.5:1', () => {
        expect(contrast(t['--ui-on-selected'], t['--ui-selected'])).toBeGreaterThanOrEqual(4.5)
        expect(contrast(t['--ui-on-selected-muted'], t['--ui-selected'])).toBeGreaterThanOrEqual(
          4.5,
        )
        expect(contrast(t['--ui-text-inverted'], t['--ui-bg-inverted'])).toBeGreaterThanOrEqual(4.5)
      })

      it('文字链接的下划线不低于 3:1', () => {
        for (const text of [t['--ui-text'], t['--ui-text-muted']]) {
          const line = over(text, linkLine, t['--ui-bg'])
          expect(contrast(line, t['--ui-bg']), text).toBeGreaterThanOrEqual(3)
        }
        const hovered = over(t['--ui-text'], linkLine, t['--ui-bg-elevated'])
        expect(contrast(hovered, t['--ui-bg-elevated'])).toBeGreaterThanOrEqual(3)
      })
    })
  }

  for (const color of ['brick', 'ochre', 'moss', 'lake']) {
    it(`${color} 当文字用时过 4.5:1`, () => {
      expect(contrast(scale(color, 500), light['--ui-bg'])).toBeGreaterThanOrEqual(4.5)
      expect(contrast(scale(color, 400), dark['--ui-bg'])).toBeGreaterThanOrEqual(4.5)
    })
  }

  it('主色是墨：浅色主题 900、深色主题 100，和正文同色', () => {
    expect(light['--ui-primary']).toBe('var(--ui-color-primary-900)')
    expect(dark['--ui-primary']).toBe('var(--ui-color-primary-100)')
    expect(scale('ink', 900)!.toLowerCase()).toBe(light['--ui-text'])
    expect(scale('ink', 100)!.toLowerCase()).toBe(dark['--ui-text'])
  })
})
