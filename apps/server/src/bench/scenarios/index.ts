import { BenchScenario } from '@kioku/contracts'

import { astrbotRound } from './astrbot'
import { claudeCodeSession } from './claudeCode'
import { credentialFlow } from './credentialFlow'
import { memoryCrud } from './memoryCrud'
import { permissionProbe } from './permissionProbe'

// 内置预设放在代码里，不存库；过一遍契约，写错了启动时就报出来
export const BENCH_SCENARIOS: readonly BenchScenario[] = [
  claudeCodeSession,
  astrbotRound,
  memoryCrud,
  permissionProbe,
  credentialFlow,
].map((scenario) => BenchScenario.parse(scenario))

// 适用于这个运行时类型的预设
export function scenariosForRuntime(runtimeFamily: string): BenchScenario[] {
  return BENCH_SCENARIOS.filter(
    (scenario) => !scenario.runtimes || scenario.runtimes.includes(runtimeFamily),
  )
}
