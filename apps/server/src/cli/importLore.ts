import { runImportLore } from './commands/importLore'
import { isMainModule } from './common'

export { IMPORT_LORE_HELP, runImportLore } from './commands/importLore'

if (isMainModule(import.meta.url)) {
  void runImportLore(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
