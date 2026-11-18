import { parseArgs } from 'node:util'

import { LORE_IMPORT_UNAVAILABLE } from '../../importer/lore'
import { runCli, UsageError } from '../common'

export const IMPORT_LORE_HELP = `从 Lore 导入记忆。

用法：kioku-ctl import-lore [选项]
      node dist/import-lore.mjs [选项]

说明：${LORE_IMPORT_UNAVAILABLE}

  -h, --help  显示帮助`

function parseImportLoreOptions(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values
  } catch (err) {
    throw new UsageError((err as Error).message)
  }
}

async function importLoreMain(argv: string[]): Promise<number> {
  const values = parseImportLoreOptions(argv)
  if (values.help) {
    console.log(IMPORT_LORE_HELP)
    return 0
  }
  console.error(LORE_IMPORT_UNAVAILABLE)
  return 1
}

export function runImportLore(argv: string[]): Promise<number> {
  return runCli(IMPORT_LORE_HELP, importLoreMain, argv)
}
