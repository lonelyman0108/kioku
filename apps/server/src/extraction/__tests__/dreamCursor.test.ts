import { describe, expect, it } from 'vitest'

import { nextCursor } from '../dream'

// 微秒数：以秒为单位写，好读一些
const at = (seconds: number) => String(seconds * 1_000_000)
const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const C = '00000000-0000-0000-0000-00000000000c'
const MIN = '00000000-0000-0000-0000-000000000000'

describe('Dream 的游标', () => {
  it('位置推进到这一批的最后一条，但不越过读取时刻往前五分钟；越不过去的那几条记进 seen', () => {
    const settled = at(1_000)
    // 都比 settled 早：位置就是最后一条，seen 是空的
    expect(
      nextCursor(
        null,
        [
          { id: A, version: 1, micros: at(10) },
          { id: B, version: 1, micros: at(20) },
        ],
        settled,
      ),
    ).toEqual({ micros: at(20), id: B, seen: {} })
    // 最后一条比 settled 晚：位置停在 settled，晚于它的记进 seen
    expect(
      nextCursor(
        null,
        [
          { id: A, version: 1, micros: at(900) },
          { id: B, version: 2, micros: at(1_100) },
          { id: C, version: 3, micros: at(1_200) },
        ],
        settled,
      ),
    ).toEqual({ micros: settled, id: MIN, seen: { [B]: [2, at(1_100)], [C]: [3, at(1_200)] } })
  })

  it('位置不往回退；以前记下的、已经在新位置之前的从 seen 里去掉，同一条的新版本盖掉旧的', () => {
    const previous = {
      micros: at(500),
      id: A,
      seen: { [A]: [1, at(600)] as [number, string], [B]: [1, at(2_000)] as [number, string] },
    }
    // 这一批只有晚提交、排在原来位置之前的那条：位置照旧
    expect(nextCursor(previous, [{ id: C, version: 1, micros: at(400) }], at(300))).toEqual({
      micros: at(500),
      id: A,
      seen: previous.seen,
    })
    // 位置推进到 1500：A 那一版已经在位置之前，从 seen 里去掉；B 改过（版本 2）
    expect(
      nextCursor(
        previous,
        [
          { id: C, version: 1, micros: at(1_500) },
          { id: B, version: 2, micros: at(2_500) },
        ],
        at(1_500),
      ),
    ).toEqual({ micros: at(1_500), id: MIN, seen: { [C]: [1, at(1_500)], [B]: [2, at(2_500)] } })
  })
})
