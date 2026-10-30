import type { BenchTool } from '@kioku/contracts'
import { describe, expect, it, vi } from 'vitest'

import {
  AgentModelError,
  escapeControlChars,
  normalizeToolCalls,
  parseModelJson,
  parseToolCalls,
  requestAgentTurn,
  toolDefinitions,
} from '../agentModel'

const API_KEY = 'sk-secret/key+with=marks"and\\slash'
const CONFIG = { baseUrl: 'http://model.example.com/v1', model: 'm', apiKey: API_KEY }
const INPUT = { messages: [{ role: 'user', content: '你好' }], tools: [] }

const chatBody = (message: unknown, extra: object = {}) =>
  JSON.stringify({ choices: [{ message, finish_reason: 'stop' }], ...extra })

// 假的 fetch：记下请求，返回给定的响应
function stubFetch(response: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(response())
  }) as typeof fetch
  return { calls, fetchImpl }
}

const failure = async (
  response: () => Response | Promise<Response>,
  config: typeof CONFIG = CONFIG,
) => {
  const err = await requestAgentTurn(config, INPUT, stubFetch(response).fetchImpl).catch(
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(AgentModelError)
  return (err as AgentModelError).message
}

describe('响应 JSON 里没转义的控制字符', () => {
  it('合法的 JSON 不用动，字符串外的换行和缩进留着', () => {
    const pretty = '{\n\t"a": 1,\r\n  "b": ["x"]\n}\n'
    expect(escapeControlChars(pretty)).toBe(pretty)
    expect(parseModelJson(pretty)).toEqual({ a: 1, b: ['x'] })
  })

  it('字符串里的换行、制表符与别的控制字符转义之后原样解析出来', () => {
    expect(parseModelJson('{\n  "a": "第一行\n第二行\t\r",\n  "b": "x"\n}')).toEqual({
      a: '第一行\n第二行\t\r',
      b: 'x',
    })
    const all = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join('')
    expect(parseModelJson(`["${all}"]`)).toEqual([all])
  })

  it('字符串里的转义引号不算字符串结束', () => {
    expect(parseModelJson('{"a":"前\\"后\n还在字符串里"}')).toEqual({ a: '前"后\n还在字符串里' })
  })

  it('结尾的转义反斜杠不吃掉结束的引号：后面的换行在字符串外，后一个字符串照样处理', () => {
    const text = '{"a":"x\\\\"\n,\n"b":"第一行\n第二行"}'
    expect(escapeControlChars(text)).toBe('{"a":"x\\\\"\n,\n"b":"第一行\\u000a第二行"}')
    expect(parseModelJson(text)).toEqual({ a: 'x\\', b: '第一行\n第二行' })
  })

  it('已有的转义、中文、表情、DEL 与 U+2028 都不动', () => {
    const text = '{"a":"\\n\\t\\u0041 中文 😀 \u007f  "}'
    expect(escapeControlChars(text)).toBe(text)
  })

  it('还是不合法就报错：反斜杠后面直接跟控制字符、结构本身是坏的', () => {
    expect(() => parseModelJson('{"a":"x\\\ny"}')).toThrow(SyntaxError)
    expect(() => parseModelJson('{"a":')).toThrow(SyntaxError)
    expect(() => parseModelJson('<html>\n</html>')).toThrow(SyntaxError)
  })
})

describe('工具调用', () => {
  const one = (args: unknown) =>
    parseToolCalls([
      { id: 'c', type: 'function', function: { name: 'kioku_list', arguments: args } },
    ])[0]!

  it('解析成对象', () => {
    expect(one('{"of":"core","n":{"m":[1]}}')).toEqual({
      id: 'c',
      name: 'kioku_list',
      arguments: { of: 'core', n: { m: [1] } },
      parseError: null,
    })
  })

  it.each([[''], ['   '], ['\n\t '], [undefined], [null], ['null'], [' null\n']])(
    '空的参数按 {}：%j',
    (args) => {
      expect(one(args)).toEqual({ id: 'c', name: 'kioku_list', arguments: {}, parseError: null })
    },
  )

  it('接口直接给对象也接受', () => {
    expect(one({ of: 'core' })).toMatchObject({ arguments: { of: 'core' }, parseError: null })
  })

  it('字符串里有没转义的控制字符：和响应一样容忍，多行正文不用重试', () => {
    expect(one('{"content":"第一行\n第二行\t尾巴","n":\n1}')).toEqual({
      id: 'c',
      name: 'kioku_list',
      arguments: { content: '第一行\n第二行\t尾巴', n: 1 },
      parseError: null,
    })
  })

  it.each([['{bad'], ['{"a":1'], ['tool'], ['{"a":"第一行\n第二行']])(
    '解析失败给 parseError，不抛错：%j',
    (args) => {
      expect(one(args)).toEqual({
        id: 'c',
        name: 'kioku_list',
        arguments: null,
        parseError: '工具参数不是合法的 JSON',
        rawArguments: args,
      })
    },
  )

  it.each([
    ['[]'],
    ['[1]'],
    ['3'],
    ['"text"'],
    ['"第一行\n第二行"'],
    ['true'],
    [[1]],
    [3],
    [false],
  ])('不是对象也算解析失败：%j', (args) => {
    expect(one(args)).toEqual({
      id: 'c',
      name: 'kioku_list',
      arguments: null,
      parseError: '工具参数不是 JSON 对象',
      rawArguments: typeof args === 'string' ? args : JSON.stringify(args),
    })
  })

  it('顺序不变；不合规的也留着，调用方才能补齐 tool 消息', () => {
    const calls = parseToolCalls([
      { id: 'a', function: { name: 'x', arguments: '{}' } },
      { id: 'b', type: 'custom', custom: { name: 'y' } },
      { id: 'c', function: null },
      { id: 'd', function: { name: 'z', arguments: '{}' } },
    ])
    expect(calls).toEqual([
      { id: 'a', name: 'x', arguments: {}, parseError: null },
      { id: 'b', name: '', arguments: null, parseError: '工具调用没有名字' },
      { id: 'c', name: '', arguments: null, parseError: '工具调用没有名字' },
      { id: 'd', name: 'z', arguments: {}, parseError: null },
    ])
  })
})

describe('规范化工具调用', () => {
  const call = { type: 'function', function: { name: 'x', arguments: '{}' } }
  const GENERATED = /^call_[0-9a-f]{24}$/

  it.each([[undefined], [null], ['x'], [{}], [3], [[]]])('没有工具调用时是空的：%j', (value) => {
    expect(normalizeToolCalls(value)).toEqual([])
  })

  it('id 能用的原样，连同别的字段；不合规的也留着', () => {
    const calls = [
      { id: 'a', ...call, future_field: { a: [1] } },
      { id: 'b', type: 'custom', custom: { name: 'y' } },
      { id: 'c' },
    ]
    expect(normalizeToolCalls(calls)).toEqual(calls)
  })

  it.each([
    ['缺失', {}],
    ['是 null', { id: null }],
    ['是数字', { id: 42 }],
    ['是对象', { id: { a: 1 } }],
    ['是空串', { id: '' }],
  ])('id %s：换成生成的，别的字段不动，不改上游给的对象', (_, extra) => {
    const original = { ...extra, ...call }
    const before = structuredClone(original)
    expect(normalizeToolCalls([original])).toEqual([
      { ...call, id: expect.stringMatching(GENERATED) },
    ])
    expect(original).toEqual(before)
  })

  it('id 重复：第一个留着，后面的各换一个', () => {
    const ids = normalizeToolCalls([
      { id: 'a', ...call },
      { id: 'a', ...call },
      { id: 'b', ...call },
      { id: 'a', ...call },
    ]).map((c) => c.id)
    expect(ids[0]).toBe('a')
    expect(ids[1]).toMatch(GENERATED)
    expect(ids[2]).toBe('b')
    expect(ids[3]).toMatch(GENERATED)
    expect(new Set(ids).size).toBe(4)
  })

  it.each([
    [
      '都是空串',
      [
        { id: '', ...call },
        { id: '', ...call },
      ],
    ],
    ['都缺失', [call, call]],
  ])('并行的调用 id %s：各生成一个，互不相同', (_, calls) => {
    const ids = normalizeToolCalls(calls).map((c) => c.id)
    expect(ids.every((id) => GENERATED.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(2)
  })

  it('不是对象的去掉：放不下 id，也说不出要调什么', () => {
    expect(normalizeToolCalls([null, 'x', 3, ['y'], { id: 'a', ...call }])).toEqual([
      { id: 'a', ...call },
    ])
  })
})

describe('工具定义', () => {
  it('只去掉顶层的 $schema，别的字段不动，没有说明的工具不带 description', () => {
    const inputSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        $schema: { type: 'string', pattern: '^x$' },
        when: { anyOf: [{ type: 'string' }, { type: 'null' }], format: 'date-time' },
      },
      required: ['when'],
      additionalProperties: false,
    }
    const tools: BenchTool[] = [
      { name: 'a', description: '说明', inputSchema, annotations: { readOnlyHint: true } },
      { name: 'b', inputSchema: { type: 'object', properties: {} } },
    ]
    expect(toolDefinitions(tools)).toEqual([
      {
        type: 'function',
        function: {
          name: 'a',
          description: '说明',
          parameters: {
            type: 'object',
            properties: inputSchema.properties,
            required: ['when'],
            additionalProperties: false,
          },
        },
      },
      { type: 'function', function: { name: 'b', parameters: { type: 'object', properties: {} } } },
    ])
    expect('description' in toolDefinitions(tools)[1]!.function).toBe(false)
    // 原来的定义不被改动：调用台和 MCP 用的是它
    expect(inputSchema.$schema).toBeDefined()
  })
})

describe('请求', () => {
  it('请求体只有 model、messages 与 tools，地址结尾的斜杠不重复', async () => {
    const { calls, fetchImpl } = stubFetch(() => new Response(chatBody({ role: 'assistant' })))
    const tools = toolDefinitions([{ name: 'a', inputSchema: { type: 'object' } }])
    await requestAgentTurn(
      { ...CONFIG, baseUrl: 'http://model.example.com/v1//' },
      { ...INPUT, tools },
      fetchImpl,
    )
    expect(calls[0]!.url).toBe('http://model.example.com/v1/chat/completions')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: 'm',
      messages: INPUT.messages,
      tools,
    })
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${API_KEY}`,
    )
  })

  it('没有工具时不带 tools；没有 Key 时不带 Authorization', async () => {
    const { calls, fetchImpl } = stubFetch(() => new Response(chatBody({ role: 'assistant' })))
    await requestAgentTurn({ ...CONFIG, apiKey: null }, INPUT, fetchImpl)
    expect(Object.keys(JSON.parse(calls[0]!.init.body as string)).sort()).toEqual([
      'messages',
      'model',
    ])
    expect(calls[0]!.init.headers).not.toHaveProperty('authorization')
  })

  it('助手消息原样返回，用量、结束原因与模型名都给', async () => {
    const message = {
      role: 'assistant',
      content: null,
      reasoning_content: '想一想',
      future_field: { a: [1] },
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }],
    }
    const { fetchImpl } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 12, completion_tokens: 3 },
          }),
        ),
    )
    const result = await requestAgentTurn(CONFIG, INPUT, fetchImpl)
    expect(result.message).toEqual(message)
    expect(result.toolCalls).toEqual([{ id: 'c', name: 'x', arguments: {}, parseError: null }])
    expect(result.finishReason).toBe('tool_calls')
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 3 })
    expect(result.model).toBe('m')
  })

  it('工具调用的 id 不能用：消息与 toolCalls 用同一个生成的 id，别的字段都原样', async () => {
    const message = {
      role: 'assistant',
      content: null,
      reasoning_content: '想一想',
      future_field: { a: [1] },
      tool_calls: [
        { id: 'same', type: 'function', function: { name: 'x', arguments: '{}' } },
        { id: 'same', type: 'function', function: { name: 'y', arguments: '{"a":1}' } },
        { type: 'function', function: { name: 'z', arguments: '{"b":2}' }, extra: true },
        { id: 7, type: 'function', function: { name: 'w', arguments: '{}' } },
      ],
    }
    const { fetchImpl } = stubFetch(() => new Response(chatBody(message)))
    const result = await requestAgentTurn(CONFIG, INPUT, fetchImpl)

    const sent = result.message.tool_calls as { id: string }[]
    const ids = sent.map((call) => call.id)
    expect(new Set(ids).size).toBe(4)
    expect(ids[0]).toBe('same')
    expect(result.toolCalls).toEqual([
      { id: 'same', name: 'x', arguments: {}, parseError: null },
      { id: ids[1], name: 'y', arguments: { a: 1 }, parseError: null },
      { id: ids[2], name: 'z', arguments: { b: 2 }, parseError: null },
      { id: ids[3], name: 'w', arguments: {}, parseError: null },
    ])
    expect(result.message).toEqual({
      ...message,
      tool_calls: message.tool_calls.map((call, i) => ({ ...call, id: ids[i] })),
    })
  })

  describe('放回历史的工具调用', () => {
    // 上游给的一个工具调用，id 是 c：放回历史的消息里那一项与解析的结果
    const turnWith = async (call: object) => {
      const message = { role: 'assistant', content: null, tool_calls: [{ id: 'c', ...call }] }
      const { fetchImpl } = stubFetch(() => new Response(chatBody(message)))
      const result = await requestAgentTurn(CONFIG, INPUT, fetchImpl)
      return { sent: (result.message.tool_calls as unknown[])[0], parsed: result.toolCalls[0] }
    }
    const fn = { name: 'x', arguments: '{"a":1}' }
    const parsedFn = { id: 'c', name: 'x', arguments: { a: 1 }, parseError: null }
    const noArguments = { id: 'c', name: 'x', arguments: {}, parseError: null }
    const noName = { id: 'c', name: '', arguments: null, parseError: '工具调用没有名字' }
    const notObject = (rawArguments: string) => ({
      id: 'c',
      name: 'x',
      arguments: null,
      parseError: '工具参数不是 JSON 对象',
      rawArguments,
    })
    const placeholder = { name: 'unknown_tool', arguments: '{}' }

    it.each([
      ['type 缺失', { function: fn }, { type: 'function', function: fn }, parsedFn],
      ['type 是 null', { type: null, function: fn }, { type: 'function', function: fn }, parsedFn],
      ['type 是空串', { type: '', function: fn }, { type: 'function', function: fn }, parsedFn],
      [
        'arguments 缺失',
        { type: 'function', function: { name: 'x' } },
        { type: 'function', function: { name: 'x', arguments: '{}' } },
        noArguments,
      ],
      [
        'arguments 是 null',
        { type: 'function', function: { name: 'x', arguments: null } },
        { type: 'function', function: { name: 'x', arguments: '{}' } },
        noArguments,
      ],
      [
        'arguments 是对象',
        { type: 'function', function: { name: 'x', arguments: { a: 1 } } },
        { type: 'function', function: fn },
        parsedFn,
      ],
      [
        'arguments 是数组',
        { type: 'function', function: { name: 'x', arguments: [1] } },
        { type: 'function', function: { name: 'x', arguments: '[1]' } },
        notObject('[1]'),
      ],
      [
        'arguments 是数字',
        { type: 'function', function: { name: 'x', arguments: 3 } },
        { type: 'function', function: { name: 'x', arguments: '3' } },
        notObject('3'),
      ],
      ['function 缺失', { type: 'function' }, { type: 'function', function: placeholder }, noName],
      [
        'function 是 null',
        { type: 'function', function: null },
        { type: 'function', function: placeholder },
        noName,
      ],
      [
        'function 是字符串',
        { type: 'function', function: 'x' },
        { type: 'function', function: placeholder },
        noName,
      ],
      [
        'function 是数组',
        { type: 'function', function: ['x'] },
        { type: 'function', function: placeholder },
        noName,
      ],
      [
        '名字缺失，参数留着',
        { type: 'function', function: { arguments: '{"a":1}' } },
        { type: 'function', function: { name: 'unknown_tool', arguments: '{"a":1}' } },
        { ...noName, rawArguments: '{"a":1}' },
      ],
      [
        '名字是空串',
        { type: 'function', function: { name: '', arguments: '{}' } },
        { type: 'function', function: placeholder },
        { ...noName, rawArguments: '{}' },
      ],
      [
        '名字不是字符串',
        { type: 'function', function: { name: 42, arguments: '{}' } },
        { type: 'function', function: placeholder },
        { ...noName, rawArguments: '{}' },
      ],
      ['只有 id', {}, { type: 'function', function: placeholder }, noName],
      [
        '是别的 type、没有 function：type 也写成 function，别的字段留着',
        { type: 'custom', custom: { name: 'w' } },
        { type: 'function', custom: { name: 'w' }, function: placeholder },
        noName,
      ],
    ])('%s：消息里补齐，解析的结果照旧', async (_, call, sent, parsed) => {
      const result = await turnWith(call)
      expect(result.sent).toEqual({ id: 'c', ...sent })
      expect(result.parsed).toEqual(parsed)
    })

    it.each([
      ['都齐全', { type: 'function', function: fn }],
      ['有 function 的别的 type', { type: 'builtin_function', function: fn }],
      [
        '多余的字段',
        {
          type: 'function',
          index: 0,
          future_field: { a: [1] },
          function: { ...fn, future_field: { b: [2] } },
        },
      ],
    ])('%s：原样', async (_, call) => {
      expect((await turnWith(call)).sent).toEqual({ id: 'c', ...call })
    })

    // 放回去的 arguments 不合法时，校验 JSON 的上游之后每一轮都拒绝
    const notJson = (rawArguments: string) => ({
      id: 'c',
      name: 'x',
      arguments: null,
      parseError: '工具参数不是合法的 JSON',
      rawArguments,
    })
    it.each([
      ['严格解析得过：写法也不动', ' { "a" : 1 }\n', ' { "a" : 1 }\n', parsedFn],
      ['严格解析得过的非对象：原样，解析的结果照旧报错', '[1]', '[1]', notObject('[1]')],
      ['字符串 null：原样', 'null', 'null', noArguments],
      [
        '字符串里的换行要靠容忍才解析得过：写成规范的 JSON',
        '{"a":"第一行\n第二行\t尾"}',
        '{"a":"第一行\\n第二行\\t尾"}',
        { id: 'c', name: 'x', arguments: { a: '第一行\n第二行\t尾' }, parseError: null },
      ],
      ['解析不了：换成 {}，原文只留给界面显示', '{bad', '{}', notJson('{bad')],
      ['缺了结尾：换成 {}', '{"a":1', '{}', notJson('{"a":1')],
      ['空串：解析不了，换成 {}', '', '{}', noArguments],
      ['只有空白：解析不了，换成 {}', ' \n\t', '{}', noArguments],
    ])('arguments：%s', async (_, raw, sent, parsed) => {
      const result = await turnWith({ type: 'function', function: { name: 'x', arguments: raw } })
      expect(result.sent).toEqual({
        id: 'c',
        type: 'function',
        function: { name: 'x', arguments: sent },
      })
      expect(result.parsed).toEqual(parsed)
      expect(() =>
        JSON.parse((result.sent as { function: { arguments: string } }).function.arguments),
      ).not.toThrow()
    })
  })

  it.each([[[]], ['x'], [null], [{}], [3], [[null, 'x']]])(
    'tool_calls 是 %j：从消息里去掉，别的字段原样',
    async (toolCalls) => {
      const { fetchImpl } = stubFetch(
        () =>
          new Response(
            chatBody({
              role: 'assistant',
              content: '好',
              reasoning_content: '想一想',
              tool_calls: toolCalls,
            }),
          ),
      )
      const result = await requestAgentTurn(CONFIG, INPUT, fetchImpl)
      expect(result.message).toEqual({
        role: 'assistant',
        content: '好',
        reasoning_content: '想一想',
      })
      // toEqual 不分没有与 undefined，这里要的是没有
      expect('tool_calls' in result.message).toBe(false)
      expect(result.toolCalls).toEqual([])
    },
  )

  it('耗时从发请求算到读完正文', async () => {
    const pause = () => new Promise((resolve) => setTimeout(resolve, 30))
    const { fetchImpl } = stubFetch(async () => {
      await pause()
      return {
        ok: true,
        status: 200,
        text: async () => {
          await pause()
          return chatBody({ role: 'assistant' })
        },
      } as Response
    })
    const { ms } = await requestAgentTurn(CONFIG, INPUT, fetchImpl)
    // 两段各等 30 毫秒。定时器可能早到一点，留出余量
    expect(ms).toBeGreaterThanOrEqual(50)
    expect(ms).toBeLessThan(60_000)
  })

  it('没给用量或用量不是数字时是 0；没有结束原因时是 null；没有 role 时补上', async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '好' } }],
            usage: { prompt_tokens: '12', completion_tokens: null },
          }),
        ),
    )
    const result = await requestAgentTurn(CONFIG, INPUT, fetchImpl)
    expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0 })
    expect(result.finishReason).toBeNull()
    expect(result.message).toEqual({ role: 'assistant', content: '好' })
  })

  it('role 是空串时也补上', async () => {
    const { fetchImpl } = stubFetch(() => new Response(chatBody({ role: '', content: '好' })))
    const result = await requestAgentTurn(CONFIG, INPUT, fetchImpl)
    expect(result.message).toEqual({ role: 'assistant', content: '好' })
  })

  it('时限 120 秒', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      const { fetchImpl } = stubFetch(() => new Response(chatBody({ role: 'assistant' })))
      await requestAgentTurn(CONFIG, INPUT, fetchImpl)
      expect(timeout).toHaveBeenCalledWith(120_000)
    } finally {
      timeout.mockRestore()
    }
  })

  it('响应的字符串里有控制字符时容忍', async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(
          '{\n  "choices": [{"message": {"role": "assistant", "content": "第一行\n第二行"}}]\n}\n',
        ),
    )
    const result = await requestAgentTurn(CONFIG, INPUT, fetchImpl)
    expect(result.message.content).toBe('第一行\n第二行')
  })
})

describe('报错', () => {
  it.each([400, 500])('HTTP %i 带状态码与上游原文，截断到 500 字', async (status) => {
    expect(await failure(() => new Response('上游不高兴', { status }))).toBe(
      `模型接口返回 HTTP ${status}：上游不高兴`,
    )
    const exact = 'x'.repeat(500)
    expect(await failure(() => new Response(exact, { status }))).toBe(
      `模型接口返回 HTTP ${status}：${exact}`,
    )
    expect(await failure(() => new Response('x'.repeat(2000), { status }))).toBe(
      `模型接口返回 HTTP ${status}：${exact}…`,
    )
  })

  it('截断不切开代理对', async () => {
    const message = await failure(() => new Response(`${'x'.repeat(499)}😀尾巴`, { status: 500 }))
    expect(message).toBe(`模型接口返回 HTTP 500：${'x'.repeat(499)}…`)
  })

  it.each([
    ['原样', API_KEY],
    ['JSON 里的写法', JSON.stringify(API_KEY).slice(1, -1)],
    ['网址里的写法', encodeURIComponent(API_KEY)],
  ])('上游把 Key 写进报错（%s）时换掉', async (_, form) => {
    const message = await failure(() => new Response(`无效的 Key：${form}！`, { status: 401 }))
    expect(message).toBe('模型接口返回 HTTP 401：无效的 Key：***！')
  })

  it.each([
    ['结尾的换行被 fetch 去掉了', 'sk-abc\n', 'sk-abc'],
    ['结尾的回车换行被 fetch 去掉了', 'sk-abc\r\n', 'sk-abc'],
    ['开头与结尾都有空白', ' sk-abc\t', 'sk-abc'],
    ['带着结尾换行的 JSON 写法', 'sk-abc\n', 'sk-abc\\n'],
    ['带着结尾换行的网址写法', 'sk-abc\n', 'sk-abc%0A'],
    ['去掉空白之后的 JSON 写法', 'sk"abc\n', 'sk\\"abc'],
    ['去掉空白之后的网址写法', 'sk+abc\n', 'sk%2Babc'],
    ['JSON 写法比原样长、又包含原样', 'sk\\', 'sk\\\\'],
    ['JSON 把 / 转义', 'sk/abc', 'sk\\/abc'],
    ['去掉空白之后 JSON 把 / 转义', 'sk/abc\n', 'sk\\/abc'],
  ])('保存的 Key 和上游写的不一样（%s）时也换掉', async (_, apiKey, form) => {
    const message = await failure(() => new Response(`无效的 Key：${form}！`, { status: 401 }), {
      ...CONFIG,
      apiKey,
    })
    expect(message).toBe('模型接口返回 HTTP 401：无效的 Key：***！')
  })

  it('Key 只有空白：去掉空白之后是空串，不当成一种写法', async () => {
    const message = await failure(() => new Response('上游不高兴', { status: 401 }), {
      ...CONFIG,
      apiKey: ' ',
    })
    expect(message).toBe('模型接口返回 HTTP 401：上游不高兴')
  })

  it('先去掉 Key 再截断：Key 正好跨在截断处时不留下半截', async () => {
    const message = await failure(
      () => new Response(`${'x'.repeat(495)}${API_KEY}${'y'.repeat(1000)}`, { status: 500 }),
    )
    expect(message).not.toContain(API_KEY.slice(0, 5))
    expect(message).toContain('x'.repeat(495))
  })

  it.each([
    ['不是 JSON', '<html>网关出错了</html>'],
    ['没有 choices', '{"error":{"message":"配额用完"}}'],
    ['choices 是空的', '{"choices":[]}'],
    ['消息不是对象', '{"choices":[{"message":"好"}]}'],
    ['消息是数组', '{"choices":[{"message":[]}]}'],
    ['顶层不是对象', 'null'],
  ])('2xx 但响应不对（%s）：报错带原文', async (_, body) => {
    expect(await failure(() => new Response(body))).toContain(body)
  })

  it('2xx 的响应不对时，原文里的 Key 同样换掉', async () => {
    const message = await failure(() => new Response(`{"echo":"${encodeURIComponent(API_KEY)}"}`))
    expect(message).not.toContain(encodeURIComponent(API_KEY))
  })

  it.each([
    ['不是 JSON', '模型接口的响应不是合法的 JSON', (text: string) => `<html>${text}`],
    [
      '没有助手消息',
      '模型接口的响应里没有助手消息',
      (text: string) => JSON.stringify({ error: text }),
    ],
  ])('2xx 但响应不对（%s）又很长：Key 换掉，截断到 500 字', async (_, reason, body) => {
    const tail = 'x'.repeat(2000)
    const message = await failure(() => new Response(body(`${API_KEY}${tail}`)))
    expect(message).toBe(`${reason}：${body(`***${tail}`).slice(0, 500)}…`)
  })

  it('连不上时带错误类别，不带错误原文', async () => {
    const fetchImpl = (() =>
      Promise.reject(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error(`connect ${API_KEY}`), { code: 'ECONNREFUSED' }),
        }),
      )) as typeof fetch
    const err = (await requestAgentTurn(CONFIG, INPUT, fetchImpl).catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(AgentModelError)
    expect(err.message).toContain('ECONNREFUSED')
    expect(err.message).not.toContain(API_KEY)
  })

  it('fetch 的错误文字带着 Key（Key 里有换行时会把请求头写进去）：不用它', async () => {
    const fetchImpl = (() =>
      Promise.reject(
        new TypeError(`Headers.append: "Bearer ${API_KEY}" is an invalid header value.`),
      )) as typeof fetch
    const err = (await requestAgentTurn(CONFIG, INPUT, fetchImpl).catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(AgentModelError)
    expect(err.message).not.toContain(API_KEY)
    expect(err.message).toContain('连不上模型接口')
  })

  // 一直不响应，等 signal 取消
  const hanging = ((_: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      const { signal } = init
      signal!.addEventListener('abort', () => reject(signal!.reason as Error))
    })) as typeof fetch

  it('到了时限：说清等了多久', async () => {
    const err = (await requestAgentTurn(CONFIG, { ...INPUT, timeoutMs: 20 }, hanging).catch(
      (e: unknown) => e,
    )) as Error
    expect(err).toBeInstanceOf(AgentModelError)
    expect(err.message).toBe('模型 1 秒内没有返回')
  })

  // 响应头到了，正文一直不来，等 signal 取消
  const hangingBody = ((_: string, init: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => hanging('', init),
    } as unknown as Response)) as typeof fetch

  // 路由总是带着请求的 signal，走的是两个信号合起来的那条路
  it.each([
    ['等响应', hanging],
    ['读正文', hangingBody],
  ])('带着请求的 signal，%s时到了时限：说清等了多久，不算客户端断开', async (_, fetchImpl) => {
    const signal = new AbortController().signal
    const outcome = await Promise.race([
      requestAgentTurn(CONFIG, { ...INPUT, signal, timeoutMs: 20 }, fetchImpl).catch(
        (e: unknown) => e,
      ),
      // 时限没生效时这里先到：按断言失败，不是等到用例超时
      new Promise((resolve) => setTimeout(() => resolve('时限没有生效'), 1_500)),
    ])
    expect(outcome).toBeInstanceOf(AgentModelError)
    expect((outcome as Error).message).toBe('模型 1 秒内没有返回')
  })

  it('请求的 signal 传给上游：客户端断开就取消', async () => {
    const client = new AbortController()
    const pending = requestAgentTurn(
      CONFIG,
      // 比用例的时限短：signal 没传给上游时按断言失败，不是等到用例超时
      { ...INPUT, signal: client.signal, timeoutMs: 1_500 },
      hanging,
    ).catch((e: unknown) => e)
    client.abort('Client connection prematurely closed.')
    expect(((await pending) as Error).message).toBe('请求已经断开')
  })

  it('读响应正文时断开也一样', async () => {
    const client = new AbortController()
    const pending = requestAgentTurn(
      CONFIG,
      { ...INPUT, signal: client.signal },
      stubFetch(() => {
        client.abort('断开')
        return { ok: true, status: 200, text: () => Promise.reject(new Error('body')) } as Response
      }).fetchImpl,
    ).catch((e: unknown) => e)
    expect(((await pending) as Error).message).toBe('请求已经断开')
  })
})
