import { stripDuplicateLeadingHeading } from '@kioku/contracts'
import { marked, type Tokens } from 'marked'
import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

export interface MarkdownBlockAnchorSource {
  charOffset: number
  kind: string
  headingLevel?: number
  listItemOffsets?: number[]
}

export interface ScrollAnchorPair {
  src: number
  pre: number
}

// 提取源码中与预览 DOM 对应的顶层块（及列表项）精确字符偏移，兼顾被剥离的重复首行 H1
export function extractMarkdownBlockOffsets(
  fullSource: string,
  titleToStrip = '',
): { previewStartOffset: number; blocks: MarkdownBlockAnchorSource[] } {
  const normalizedFull = fullSource.replace(/\r\n/g, '\n')
  const previewSource = titleToStrip
    ? stripDuplicateLeadingHeading(titleToStrip, normalizedFull)
    : normalizedFull
  const previewStartOffset = Math.max(0, normalizedFull.length - previewSource.length)

  const blocks: MarkdownBlockAnchorSource[] = []
  let tokens: ReturnType<typeof marked.lexer>
  try {
    tokens = marked.lexer(previewSource, { gfm: true })
  } catch {
    return { previewStartOffset, blocks }
  }

  let cursor = 0
  for (const token of tokens) {
    const raw = token.raw ?? ''
    if (token.type !== 'space' && token.type !== 'def') {
      const entry: MarkdownBlockAnchorSource = {
        charOffset: previewStartOffset + cursor,
        kind: token.type,
      }
      if (token.type === 'heading') {
        entry.headingLevel = (token as Tokens.Heading).depth
      } else if (token.type === 'list') {
        const listToken = token as Tokens.List
        const itemOffsets: number[] = []
        let itemCursor = 0
        for (const item of listToken.items) {
          const itemRaw = item.raw ?? ''
          const found = raw.indexOf(itemRaw, itemCursor)
          const pos = found >= 0 ? found : itemCursor
          itemOffsets.push(previewStartOffset + cursor + pos)
          itemCursor = pos + itemRaw.length
        }
        entry.listItemOffsets = itemOffsets
      }
      blocks.push(entry)
    }
    cursor += raw.length
  }
  return { previewStartOffset, blocks }
}

// 按文档顺序构造严格单调不减的滚动锚点表，首尾对齐 (0, 0) 与 (srcMax, preMax)
export function buildMonotonicAnchors(
  pairs: readonly ScrollAnchorPair[],
  srcMax: number,
  preMax: number,
): ScrollAnchorPair[] {
  const maxS = Math.max(0, srcMax)
  const maxP = Math.max(0, preMax)
  const clamped = pairs.map((p) => ({
    src: Math.min(maxS, Math.max(0, p.src)),
    pre: Math.min(maxP, Math.max(0, p.pre)),
  }))

  const out: ScrollAnchorPair[] = [{ src: 0, pre: 0 }]
  for (const pair of clamped) {
    const last = out.at(-1)!
    if (pair.src < last.src || pair.pre < last.pre) continue
    if (pair.src === last.src && pair.pre === last.pre) continue
    if (pair.src === last.src) {
      // 同一源码位置保留最先出现的预览偏移，避免段内退化跳变
      continue
    }
    out.push(pair)
  }

  const tail = out.at(-1)!
  if (tail.src < maxS || tail.pre < maxP) {
    if (tail.src === maxS) {
      out[out.length - 1] = { src: maxS, pre: maxP }
    } else {
      out.push({ src: maxS, pre: maxP })
    }
  }
  return out
}

// 分段线性插值：在两个相邻锚点间平滑换算滚动偏移，避免软换行或长代码块造成的漂移
export function interpolateScroll(
  anchors: readonly ScrollAnchorPair[],
  value: number,
  from: 'src' | 'pre',
): number {
  const to: 'src' | 'pre' = from === 'src' ? 'pre' : 'src'
  if (!anchors.length) return 0
  if (anchors.length === 1) return anchors[0]![to]
  const first = anchors[0]!
  const last = anchors.at(-1)!
  if (value <= first[from]) return first[to]
  if (value >= last[from]) return last[to]

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i]!
    const b = anchors[i + 1]!
    if (value >= a[from] && value <= b[from]) {
      const span = b[from] - a[from]
      if (span <= 0.001) return a[to]
      const ratio = (value - a[from]) / span
      return a[to] + ratio * (b[to] - a[to])
    }
  }
  return last[to]
}

const MIRROR_STYLE_PROPS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'tabSize',
  'textIndent',
] as const

// 用同宽同字体的离屏镜像层实测 textarea 软折行后的精确像素 Y 坐标
function measureTextareaOffsets(
  textarea: HTMLTextAreaElement,
  offsets: readonly number[],
  mirror: HTMLDivElement,
): number[] {
  if (!offsets.length) return []
  const style = getComputedStyle(textarea)
  mirror.style.boxSizing = 'border-box'
  mirror.style.width = `${textarea.clientWidth}px`
  mirror.style.borderWidth = '0px'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.wordWrap = 'break-word'
  mirror.style.overflowWrap = 'break-word'
  for (const prop of MIRROR_STYLE_PROPS) {
    mirror.style[prop] = style[prop]
  }

  const text = textarea.value.replace(/\r\n/g, '\n')
  const sortedUnique = [...new Set(offsets.map((n) => Math.min(text.length, Math.max(0, n))))].sort(
    (a, b) => a - b,
  )

  const frag = document.createDocumentFragment()
  const markers = new Map<number, HTMLSpanElement>()
  let cursor = 0
  for (const offset of sortedUnique) {
    if (offset > cursor) {
      frag.append(document.createTextNode(text.slice(cursor, offset)))
    }
    const span = document.createElement('span')
    span.textContent = '\u200b'
    frag.append(span)
    markers.set(offset, span)
    cursor = offset
  }
  if (cursor < text.length) {
    frag.append(document.createTextNode(text.slice(cursor)))
  }
  // 补一个尾空行，防止末尾换行高度被折叠
  frag.append(document.createTextNode('\n\u200b'))

  mirror.replaceChildren(frag)

  const paddingTop = parseFloat(style.paddingTop) || 0
  const mirrorScrollH = mirror.scrollHeight
  const realScrollH = textarea.scrollHeight
  const scale =
    mirrorScrollH > 0 &&
    realScrollH > 0 &&
    Math.abs(mirrorScrollH - realScrollH) / realScrollH < 0.25
      ? realScrollH / mirrorScrollH
      : 1

  return offsets.map((rawOff) => {
    const clamped = Math.min(text.length, Math.max(0, rawOff))
    const marker = markers.get(clamped)
    if (!marker) return 0
    return Math.max(0, (marker.offsetTop - paddingTop) * scale)
  })
}

export function useMarkdownSyncScroll(options: {
  enabled: Ref<boolean>
  active: Ref<boolean>
  content: Ref<string>
  title: Ref<string>
  getSourceEl: () => HTMLTextAreaElement | null
  getPreviewEl: () => HTMLElement | null
}) {
  let mirror: HTMLDivElement | null = null
  let anchors: ScrollAnchorPair[] = []
  let anchorsDirty = true
  let activeDriver: 'source' | 'preview' | null = null
  let driverTimer: ReturnType<typeof setTimeout> | null = null
  let expectedSrc: number | null = null
  let expectedPre: number | null = null
  let resizeObserver: ResizeObserver | null = null
  let boundSrc: HTMLTextAreaElement | null = null
  let boundPre: HTMLElement | null = null

  function ensureMirror(): HTMLDivElement {
    if (!mirror) {
      mirror = document.createElement('div')
      mirror.setAttribute('aria-hidden', 'true')
      mirror.style.position = 'fixed'
      mirror.style.top = '-99999px'
      mirror.style.left = '-99999px'
      mirror.style.visibility = 'hidden'
      mirror.style.pointerEvents = 'none'
      mirror.style.zIndex = '-1'
      mirror.style.overflow = 'hidden'
      document.body.appendChild(mirror)
    }
    return mirror
  }

  function markDirty() {
    anchorsDirty = true
  }

  function setDriver(side: 'source' | 'preview') {
    activeDriver = side
    if (driverTimer) clearTimeout(driverTimer)
    driverTimer = setTimeout(() => {
      activeDriver = null
      expectedSrc = null
      expectedPre = null
    }, 180)
  }

  function computeAnchors(srcEl: HTMLTextAreaElement, preEl: HTMLElement): ScrollAnchorPair[] {
    const srcMax = Math.max(0, srcEl.scrollHeight - srcEl.clientHeight)
    const preMax = Math.max(0, preEl.scrollHeight - preEl.clientHeight)
    if (srcMax === 0 || preMax === 0) {
      return buildMonotonicAnchors([], srcMax, preMax)
    }

    const mdRoot = preEl.querySelector<HTMLElement>('.kioku-markdown') ?? preEl
    const preRect = preEl.getBoundingClientRect()
    const preScrollTop = preEl.scrollTop
    const prePaddingTop = parseFloat(getComputedStyle(preEl).paddingTop) || 0
    const relTop = (el: Element) =>
      Math.max(0, el.getBoundingClientRect().top - preRect.top + preScrollTop - prePaddingTop)

    const { previewStartOffset, blocks } = extractMarkdownBlockOffsets(
      options.content.value,
      options.title.value,
    )
    const renderedChildren = [...mdRoot.children]

    const candidateOffsets: number[] = []
    const candidatePreYs: number[] = []

    if (previewStartOffset > 0) {
      candidateOffsets.push(previewStartOffset)
      candidatePreYs.push(0)
    }

    if (blocks.length > 0 && renderedChildren.length === blocks.length) {
      // 顶层块一一对应，并在长列表内部继续细化到每个 <li> 锚点
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i]!
        const el = renderedChildren[i]!
        candidateOffsets.push(block.charOffset)
        candidatePreYs.push(relTop(el))

        if (block.kind === 'list' && block.listItemOffsets?.length) {
          const liEls = [...el.children].filter((child) => child.tagName === 'LI')
          if (liEls.length === block.listItemOffsets.length) {
            for (let k = 1; k < liEls.length; k++) {
              candidateOffsets.push(block.listItemOffsets[k]!)
              candidatePreYs.push(relTop(liEls[k]!))
            }
          }
        }
      }
    } else {
      // 回退路径：按全部标题元素逐级对齐，保证原始 HTML 混排时依然不漂移
      const headingBlocks = blocks.filter((b) => b.kind === 'heading')
      const headingEls = [...mdRoot.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      const count = Math.min(headingBlocks.length, headingEls.length)
      for (let i = 0; i < count; i++) {
        candidateOffsets.push(headingBlocks[i]!.charOffset)
        candidatePreYs.push(relTop(headingEls[i]!))
      }
    }

    const measuredSrcYs = measureTextareaOffsets(srcEl, candidateOffsets, ensureMirror())
    const pairs: ScrollAnchorPair[] = measuredSrcYs.map((src, idx) => ({
      src,
      pre: candidatePreYs[idx] ?? 0,
    }))
    return buildMonotonicAnchors(pairs, srcMax, preMax)
  }

  function getAnchors(srcEl: HTMLTextAreaElement, preEl: HTMLElement): ScrollAnchorPair[] {
    if (anchorsDirty) {
      anchors = computeAnchors(srcEl, preEl)
      anchorsDirty = false
    }
    return anchors
  }

  function onSourceScroll() {
    if (!options.enabled.value || !options.active.value) return
    const srcEl = boundSrc
    const preEl = boundPre
    if (!srcEl || !preEl) return
    if (expectedSrc !== null && Math.abs(srcEl.scrollTop - expectedSrc) <= 2) {
      expectedSrc = null
      return
    }
    if (activeDriver === 'preview') return
    setDriver('source')
    const table = getAnchors(srcEl, preEl)
    const target = interpolateScroll(table, srcEl.scrollTop, 'src')
    expectedPre = target
    preEl.scrollTop = target
  }

  function onPreviewScroll() {
    if (!options.enabled.value || !options.active.value) return
    const srcEl = boundSrc
    const preEl = boundPre
    if (!srcEl || !preEl) return
    if (expectedPre !== null && Math.abs(preEl.scrollTop - expectedPre) <= 2) {
      expectedPre = null
      return
    }
    if (activeDriver === 'source') return
    setDriver('preview')
    const table = getAnchors(srcEl, preEl)
    const target = interpolateScroll(table, preEl.scrollTop, 'pre')
    expectedSrc = target
    srcEl.scrollTop = target
  }

  const onSourceIntent = () => setDriver('source')
  const onPreviewIntent = () => setDriver('preview')

  function unbind() {
    if (boundSrc) {
      boundSrc.removeEventListener('scroll', onSourceScroll)
      boundSrc.removeEventListener('wheel', onSourceIntent)
      boundSrc.removeEventListener('pointerdown', onSourceIntent)
      boundSrc.removeEventListener('touchstart', onSourceIntent)
      boundSrc.removeEventListener('keydown', onSourceIntent)
      boundSrc = null
    }
    if (boundPre) {
      boundPre.removeEventListener('scroll', onPreviewScroll)
      boundPre.removeEventListener('wheel', onPreviewIntent)
      boundPre.removeEventListener('pointerdown', onPreviewIntent)
      boundPre.removeEventListener('touchstart', onPreviewIntent)
      boundPre = null
    }
    resizeObserver?.disconnect()
    resizeObserver = null
  }

  function bind() {
    unbind()
    if (!options.active.value) return
    const srcEl = options.getSourceEl()
    const preEl = options.getPreviewEl()
    if (!srcEl || !preEl) return
    boundSrc = srcEl
    boundPre = preEl
    anchorsDirty = true

    srcEl.addEventListener('scroll', onSourceScroll, { passive: true })
    srcEl.addEventListener('wheel', onSourceIntent, { passive: true })
    srcEl.addEventListener('pointerdown', onSourceIntent, { passive: true })
    srcEl.addEventListener('touchstart', onSourceIntent, { passive: true })
    srcEl.addEventListener('keydown', onSourceIntent, { passive: true })

    preEl.addEventListener('scroll', onPreviewScroll, { passive: true })
    preEl.addEventListener('wheel', onPreviewIntent, { passive: true })
    preEl.addEventListener('pointerdown', onPreviewIntent, { passive: true })
    preEl.addEventListener('touchstart', onPreviewIntent, { passive: true })

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => markDirty())
      resizeObserver.observe(srcEl)
      resizeObserver.observe(preEl)
    }
  }

  watch(
    () => options.active.value,
    async (isActive) => {
      if (!isActive) {
        unbind()
        return
      }
      await nextTick()
      bind()
    },
    { immediate: true },
  )

  watch([() => options.content.value, () => options.title.value], async () => {
    markDirty()
    if (!options.active.value) return
    await nextTick()
    if (!boundSrc || !boundPre) bind()
  })

  onBeforeUnmount(() => {
    unbind()
    if (driverTimer) clearTimeout(driverTimer)
    mirror?.remove()
    mirror = null
  })

  return {
    invalidate: markDirty,
    rebind: bind,
  }
}
