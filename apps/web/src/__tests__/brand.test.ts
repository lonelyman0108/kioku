import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// 换 logo 只动一个组件和 public 下的图标，这几条核对它们和引用它们的地方对得上
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const mark = read('../components/KiokuMark.vue')

describe('文字标', () => {
  it('只有路径，颜色跟随 currentColor，读屏读到「記憶」', () => {
    expect(mark).toContain('fill="currentColor"')
    expect(mark).toContain('role="img"')
    expect(mark).toContain('aria-label="記憶"')
    expect(mark).not.toMatch(/#[0-9a-f]{6}/i)
    expect(mark).not.toContain('<rect')
  })

  it('两个字重的路径都内联，小尺寸用半粗', () => {
    expect(mark).toContain('semibold: {')
    expect(mark).toContain('regular: {')
    expect(mark).toContain('props.height <= SEMIBOLD_MAX_HEIGHT ? VERSIONS.semibold')
  })

  it('登录页、初始化页、连接失败页的标题用文字标，不写产品名', () => {
    expect(read('../components/strata/EntryFrame.vue')).toContain('<KiokuMark')
    for (const page of ['LoginPage', 'SetupPage', 'UnavailablePage']) {
      const source = read(`../pages/${page}.vue`)
      expect(source).toContain('<EntryFrame')
      expect(source).not.toMatch(/<h1[^>]*>[^<]*Kioku/)
      expect(source).not.toMatch(/title="[^"]*Kioku/)
    }
  })
})

describe('图标', () => {
  it('index.html 里三个 link：svg 在前，png 带尺寸，再是 apple-touch-icon', () => {
    const links = [...read('../../index.html').matchAll(/<link [^>]*rel="[^"]*icon"[^>]*>/g)].map(
      (m) => m[0],
    )
    expect(links).toHaveLength(3)
    expect(links[0]).toContain('type="image/svg+xml"')
    expect(links[0]).toContain('href="/favicon.svg"')
    expect(links[1]).toContain('sizes="32x32"')
    expect(links[1]).toContain('href="/favicon-32.png"')
    expect(links[2]).toContain('rel="apple-touch-icon"')
    expect(links[2]).toContain('href="/apple-touch-icon.png"')
  })

  it('文件都在 public 下，svg 跟随系统深浅色', () => {
    for (const file of ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png']) {
      expect(existsSync(new URL(`../../public/${file}`, import.meta.url)), file).toBe(true)
    }
    expect(read('../../public/favicon.svg')).toContain('prefers-color-scheme:dark')
  })

  it('字形来源登记在 NOTICE 里：字形轮廓算字体的一部分，版权声明和 OFL 全文都要带上', () => {
    const notice = read('../../../../NOTICE')
    expect(notice).toContain('Shippori Mincho')
    expect(notice).toContain(
      'Copyright 2021 The Shippori Mincho Project Authors (https://github.com/fontdasu/ShipporiMincho)',
    )
    expect(notice).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007')
    expect(notice).toContain('PERMISSION & CONDITIONS')
    expect(notice).toContain('2) Original or Modified Versions of the Font Software may be bundled')
    expect(notice.trimEnd().endsWith('OTHER DEALINGS IN THE FONT SOFTWARE.')).toBe(true)
  })
})
