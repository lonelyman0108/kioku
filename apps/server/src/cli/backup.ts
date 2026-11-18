import { runBackup } from './commands/backup'
import { isMainModule } from './common'

export { BACKUP_HELP, runBackup } from './commands/backup'

if (isMainModule(import.meta.url)) {
  void runBackup(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
