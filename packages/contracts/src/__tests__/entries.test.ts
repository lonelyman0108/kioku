import { describe, expect, it } from 'vitest'

import {
  applyCapturePatch,
  applyMarkdownAppend,
  bootModeToPinned,
  buildSearchTags,
  CapturePlanRequest,
  checkCaptureIntegrity,
  CreateEntryRequest,
  deriveEntryTitle,
  Disclosure,
  DISCLOSURE_MAX,
  effectiveBootMode,
  ENTRY_CONTENT_MAX,
  ENTRY_TITLE_NEW_MAX,
  EntryListQuery,
  extractMarkdownHeadings,
  extractMarkdownOutline,
  extractMarkdownSection,
  extractProjectSlugs,
  firstMarkdownHeading,
  hasEpisodeSignals,
  normalizeProjectSlug,
  normalizeSlugList,
  parseEpisodeSignals,
  resolveBootMode,
  RestoreEntryRequest,
  serializeEpisodeSignals,
  UpdateEntryRequest,
} from '../entries'

describe('entries contracts', () => {
  it('extracts first markdown heading outside code fences and rejects credential placeholders', () => {
    const body = [
      '```markdown',
      '# 围栏里的标题应跳过',
      '```',
      '',
      '## 真正的标题 ##',
      '正文内容',
    ].join('\n')
    expect(firstMarkdownHeading(body)).toBe('真正的标题')
    expect(firstMarkdownHeading('# 包含 {{cred:secret}} 的标题')).toBeNull()
    expect(deriveEntryTitle(undefined, body, 'm-234abc')).toBe('真正的标题')
    expect(deriveEntryTitle('显式标题', body, 'm-234abc')).toBe('显式标题')
    expect(deriveEntryTitle(undefined, '纯正文无标题', 'm-234abc')).toBe('m-234abc')
  })

  it('normalizes scene slugs, projects and search tags', () => {
    expect(normalizeSlugList([' Mac ', 'linux', 'mac', ''])).toEqual(['linux', 'mac'])
    expect(normalizeProjectSlug({ repoName: 'org/Kioku_Repo' })).toBe('kioku_repo')
    expect(normalizeProjectSlug({ dirName: '/Users/dev/My App' })).toBe('my-app')
    expect(
      extractProjectSlugs({ repoName: 'org/sample-app', dirName: '/work/sample-app-wt' }),
    ).toEqual(['sample-app', 'sample-app-wt'])
    expect(extractProjectSlugs({ repoName: 'org/kioku', dirName: '/work/kioku' })).toEqual([
      'kioku',
    ])
    expect(resolveBootMode({ bootMode: 'index', isPinned: false })).toBe('index')
    expect(resolveBootMode({ isPinned: true })).toBe('full')
    expect(resolveBootMode({ isPinned: false })).toBe('none')
    expect(effectiveBootMode({ isPinned: true })).toBe('full')
    expect(effectiveBootMode({ isPinned: true, bootMode: 'index' })).toBe('index')
    expect(bootModeToPinned('none')).toBe(false)
    expect(bootModeToPinned('index')).toBe(true)
    expect(bootModeToPinned('full')).toBe(true)
    expect(
      buildSearchTags({
        shortId: 'm-234abc'.toUpperCase(),
        topics: ['docker', 'deploy'],
        envs: ['mac'],
        realms: ['work'],
        projects: ['kioku'],
        runtimes: ['claudecode'],
      }),
    ).toBe('m-234abc docker deploy mac work kioku claudecode')
  })

  it('validates entry create, update and list query schemas', () => {
    const created = CreateEntryRequest.parse({
      content: '# 标题\n正文',
      envs: ['Mac', 'linux', 'mac'],
      realms: ['Work'],
      isPinned: true,
    })
    expect(created.envs).toEqual(['linux', 'mac'])
    expect(created.realms).toEqual(['work'])
    expect(created.isPinned).toBe(true)

    const updated = UpdateEntryRequest.parse({
      expectedVersion: 2,
      promoteToEntry: true,
      validTo: '2027-01-01T00:00:00Z',
    })
    expect(updated.promoteToEntry).toBe(true)

    const query = EntryListQuery.parse({
      q: 'docker',
      mode: 'lookup',
      projectScope: 'unassigned',
      limit: '20',
    })
    expect(query).toEqual({
      tab: 'all',
      q: 'docker',
      mode: 'lookup',
      projectScope: 'unassigned',
      limit: 20,
    })

    const captureReq = CapturePlanRequest.parse({
      text: '  方案对比优先用表格呈现  ',
    })
    expect(captureReq).toEqual({
      text: '方案对比优先用表格呈现',
      mode: 'auto',
    })
  })

  it('extracts H2 headings and applies deterministic markdown append and local patches', () => {
    const doc = [
      '## 提交规范',
      '- 使用中文提交说明',
      '',
      '```markdown',
      '## 围栏内标题应忽略',
      '```',
      '',
      '## 调试方式',
      '- 使用 chrome-devtools，参考 [[m-234abc]] 与 {{cred:dev-token}}',
    ].join('\n')

    expect(extractMarkdownHeadings(doc)).toEqual(['提交规范', '调试方式'])

    const inserted = applyMarkdownAppend(doc, '评审文档优先表格呈现', '提交规范')
    expect(inserted.matchedHeading).toBe('提交规范')
    expect(inserted.content).toContain('```\n- 评审文档优先表格呈现\n\n## 调试方式')
    expect(inserted.content.indexOf('评审文档优先表格呈现')).toBeLessThan(
      inserted.content.indexOf('## 调试方式'),
    )

    const replaced = applyCapturePatch(doc, {
      kind: 'replace',
      oldText: '- 使用中文提交说明',
      newText: '- 提交说明使用中文并附 gitmoji',
    })
    expect(replaced.ok).toBe(true)
    if (replaced.ok) {
      expect(replaced.content).toContain('- 提交说明使用中文并附 gitmoji')
      expect(replaced.content).toContain('[[m-234abc]]')
      expect(replaced.content).toContain('{{cred:dev-token}}')
    }

    const missingOld = applyCapturePatch(doc, {
      kind: 'replace',
      oldText: '不存在的旧段落',
      newText: '新段落',
    })
    expect(missingOld.ok).toBe(false)

    const okIntegrity = checkCaptureIntegrity(doc, inserted.content)
    expect(okIntegrity).toEqual({
      intact: true,
      linksBefore: 1,
      linksAfter: 1,
      missingLinks: [],
      credsBefore: 1,
      credsAfter: 1,
      missingCreds: [],
      severeShrink: false,
    })

    const brokenIntegrity = checkCaptureIntegrity(doc, '## 提交规范\n- 只剩一行')
    expect(brokenIntegrity.intact).toBe(false)
    expect(brokenIntegrity.missingLinks).toEqual(['m-234abc'])
    expect(brokenIntegrity.missingCreds).toEqual(['dev-token'])
  })

  it('handles CRLF, duplicate headings, zero-diff replace, overflow, aliased links, field creds and shrink checks', () => {
    expect(RestoreEntryRequest.parse({ version: 2, expectedVersion: 3 })).toEqual({
      version: 2,
      expectedVersion: 3,
    })

    const crlfDoc = [
      '## Deploy',
      '### 子步骤',
      '- 第一步',
      '',
      '## Deploy',
      '- 重复标题应去重',
    ].join('\r\n')
    expect(extractMarkdownHeadings(crlfDoc)).toEqual(['Deploy'])

    const appendedCrlf = applyMarkdownAppend(crlfDoc, '第一行\r\n第二行', 'deploy')
    expect(appendedCrlf.matchedHeading).toBe('Deploy')
    expect(appendedCrlf.content).not.toContain('\r')
    expect(appendedCrlf.content).toContain('- 第一步\n第一行\n第二行\n\n## Deploy')

    expect(applyMarkdownAppend('', '首条记录').content).toBe('- 首条记录')

    const noopReplace = applyCapturePatch('## 规则\n- 保持一致', {
      kind: 'replace',
      oldText: '- 保持一致',
      newText: '- 保持一致',
    })
    expect(noopReplace).toMatchObject({ ok: false, unchanged: true })

    const emptyNew = applyCapturePatch('## 规则\n- 旧行', {
      kind: 'replace',
      oldText: '- 旧行',
      newText: '   ',
    })
    expect(emptyNew.ok).toBe(false)

    const fallbackTrim = applyCapturePatch('## 规则\n- 目标行\n- 尾行', {
      kind: 'replace',
      oldText: '\n\n  - 目标行  \n\n',
      newText: '\n\n- 更新行\n\n',
    })
    expect(fallbackTrim).toEqual({
      ok: true,
      content: '## 规则\n- 更新行\n- 尾行',
      matchedHeading: null,
    })

    const overflow = applyCapturePatch('a'.repeat(ENTRY_CONTENT_MAX), {
      kind: 'append',
      text: '超出上限',
    })
    expect(overflow).toMatchObject({ ok: false, overflow: true })

    const richBefore = `${'说明文字'.repeat(60)}\n参考 [[m-234abc|部署文档]] 与 {{cred:db-main#password}}`
    const droppedField = `${'说明文字'.repeat(60)}\n参考 [[m-234abc|部署文档]] 与 {{cred:db-main}}`
    const fieldCheck = checkCaptureIntegrity(richBefore, droppedField)
    expect(fieldCheck.intact).toBe(false)
    expect(fieldCheck.missingCreds).toEqual(['db-main#password'])

    const shrunk = checkCaptureIntegrity(richBefore, '参考 [[m-234abc]] {{cred:db-main#password}}')
    expect(shrunk.severeShrink).toBe(true)
    expect(shrunk.intact).toBe(false)

    const shortBefore = '短文本 [[m-234abc]]'
    const shortAfter = '[[m-234abc]]'
    expect(checkCaptureIntegrity(shortBefore, shortAfter).severeShrink).toBe(false)
  })

  it('extracts markdown outline and sections and validates patch mutual exclusion and new title limit', () => {
    const doc = [
      '导语段落',
      '',
      '## 当前拓扑',
      '- 主路由负责拨号与路由',
      '- 核心交换负责万兆汇聚',
      '',
      '## 关键禁令',
      '```markdown',
      '## 围栏里的标题应跳过',
      '```',
      '- 严禁破坏既有端口规划',
    ].join('\n')

    const outline = extractMarkdownOutline(doc)
    expect(outline).toHaveLength(2)
    expect(outline[0]?.heading).toBe('当前拓扑')
    expect(outline[0]?.preview).toContain('主路由负责拨号与路由')
    expect(outline[1]?.heading).toBe('关键禁令')
    expect(outline[1]?.preview).toContain('严禁破坏既有端口规划')

    expect(extractMarkdownSection(doc, '关键禁令')?.content).toContain('严禁破坏既有端口规划')
    expect(extractMarkdownSection(doc, '## 关键禁令')?.heading).toBe('关键禁令')
    expect(extractMarkdownSection(doc, '禁令')?.heading).toBe('关键禁令')
    expect(extractMarkdownSection(doc, '不存在的小节')).toBeNull()

    // 多个 H1 紧随 H2 时不得吞入后续一级标题段落
    const multiH1Doc = '## 小节甲\n内容甲\n# 分节一\n不应被吞入\n# 分节二\n尾部'
    expect(extractMarkdownSection(multiH1Doc, '小节甲')?.content).toBe('## 小节甲\n内容甲')

    // insert_under_heading 兼容带 ## 前缀的标题
    const patchedWithHashes = applyCapturePatch(doc, {
      kind: 'insert_under_heading',
      heading: '## 当前拓扑',
      text: '- 补充链路说明',
    })
    expect(patchedWithHashes.ok).toBe(true)

    // EntrySummary 允许从多行输入框粘贴换行并自动折叠为空格，仍拦截控制字符与凭据占位符
    const multiLineCreated = CreateEntryRequest.parse({
      title: '概要换行测试',
      summary: '第一行结论\n第二行补充',
      content: '正文',
    })
    expect(multiLineCreated.summary).toBe('第一行结论 第二行补充')

    expect(
      CreateEntryRequest.safeParse({
        title: '长'.repeat(ENTRY_TITLE_NEW_MAX + 1),
        content: '正文',
      }).success,
    ).toBe(false)

    expect(
      UpdateEntryRequest.safeParse({
        content: '全量正文',
        patch: { kind: 'append', text: '追加内容' },
      }).success,
    ).toBe(false)

    expect(
      UpdateEntryRequest.safeParse({
        patch: { kind: 'replace', oldText: '旧', newText: '新' },
        changeSummary: '更新配置项',
        verified: true,
      }).success,
    ).toBe(true)
  })

  it('serializes and parses structured episode signals within disclosure limits and strips credentials', () => {
    const encoded = serializeEpisodeSignals({
      directives: [
        '按职责拆分 PR；合并后清理分支',
        '避免 | 管道符干扰',
        '按职责拆分 PR；合并后清理分支',
      ],
      facts: ['本地测试库端口 55432', '不要泄露 {{cred:prod-db}} 占位符'],
    })
    expect(encoded).toBeTruthy()
    expect(encoded!.length).toBeLessThanOrEqual(DISCLOSURE_MAX)
    expect(Disclosure.safeParse(encoded).success).toBe(true)
    expect(hasEpisodeSignals(encoded)).toBe(true)

    const decoded = parseEpisodeSignals(encoded)
    expect(decoded.directives).toEqual(['按职责拆分 PR，合并后清理分支', '避免 ， 管道符干扰'])
    expect(decoded.facts).toEqual(['本地测试库端口 55432', '不要泄露 占位符'])

    expect(serializeEpisodeSignals({ directives: [], facts: [] })).toBeNull()
    expect(hasEpisodeSignals(null)).toBe(false)
    expect(hasEpisodeSignals('普通的旧版自由文本触发场景')).toBe(false)
    expect(parseEpisodeSignals('普通的旧版自由文本触发场景')).toEqual({ directives: [], facts: [] })

    // 超长信号自动裁剪至 DISCLOSURE_MAX 以内且仍可合法通过 Disclosure 校验
    const longEncoded = serializeEpisodeSignals({
      directives: Array.from({ length: 6 }, (_, i) => `长期偏好条目${i + 1}：${'细则'.repeat(45)}`),
      facts: Array.from({ length: 6 }, (_, i) => `环境事实条目${i + 1}：${'说明'.repeat(45)}`),
    })
    expect(longEncoded).toBeTruthy()
    expect(longEncoded!.length).toBeLessThanOrEqual(DISCLOSURE_MAX)
    expect(Disclosure.safeParse(longEncoded).success).toBe(true)
    const parsedLong = parseEpisodeSignals(longEncoded)
    expect(parsedLong.directives.length).toBeGreaterThan(0)
    expect(parsedLong.facts.length).toBeGreaterThan(0)
  })
})
