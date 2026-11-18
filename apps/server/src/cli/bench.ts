import { runBench } from './commands/bench'
import { isMainModule } from './common'

export { BENCH_HELP, runBench } from './commands/bench'

if (isMainModule(import.meta.url)) {
  void runBench(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
