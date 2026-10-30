import type { BenchScenarioInput } from '@kioku/contracts'

import { BENCH_GROUP_CONTEXT, GUIDANCE_START } from './shared'

// AstrBot 群聊一轮：群聊 bot 不调记忆工具，每轮按群与发言人的上下文注入，回复之后把这一轮放进缓冲。
// Key 写不了对象层与情节层、或者没配抽取模型时 turn.end 什么都不写，照样不报错，所以不断言进了缓冲
export const astrbotRound: BenchScenarioInput = {
  id: 'astrbot-group-round',
  title: 'AstrBot 群聊一轮',
  description: '带群与发言人的会话开始、每轮召回与 turn.end。第一次见到的平台账号会新建对象。',
  runtimes: ['astrbot'],
  steps: [
    {
      kind: 'lifecycle',
      label: '会话开始',
      body: { event: 'session.start', sessionId: 'bench-session', context: BENCH_GROUP_CONTEXT },
      expect: { error: false, contains: [GUIDANCE_START] },
    },
    {
      kind: 'lifecycle',
      label: '这一轮的召回',
      body: {
        event: 'prompt.submit',
        sessionId: 'bench-session',
        context: BENCH_GROUP_CONTEXT,
        prompt: '测试台的群友问：今天大家聊什么？',
      },
      expect: { error: false },
    },
    {
      kind: 'recall',
      label: 'REST 召回',
      body: { query: '测试台的群友', context: BENCH_GROUP_CONTEXT },
      expect: { error: false },
    },
    {
      kind: 'lifecycle',
      label: '这一轮结束',
      body: {
        event: 'turn.end',
        sessionId: 'bench-session',
        context: BENCH_GROUP_CONTEXT,
        user: '测试台的群友问：今天大家聊什么？',
        reply: '测试台的回复：随便聊聊。',
      },
      expect: { error: false },
    },
  ],
}
