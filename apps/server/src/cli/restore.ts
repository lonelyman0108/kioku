import { runRestore } from './commands/restore'
import { isMainModule } from './common'

export { RESTORE_HELP, runRestore } from './commands/restore'

if (isMainModule(import.meta.url)) {
  void runRestore(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
