import { runStatus } from './commands/status'
import { isMainModule } from './common'

export { collectStatus, runStatus, STATUS_HELP, type StatusReport } from './commands/status'

if (isMainModule(import.meta.url)) {
  void runStatus(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
