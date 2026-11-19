import { runMigrateLegacy } from './commands/migrateLegacy'
import { isMainModule } from './common'

export { MIGRATE_LEGACY_HELP, runMigrateLegacy } from './commands/migrateLegacy'

if (isMainModule(import.meta.url)) {
  void runMigrateLegacy(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
