export interface LoreNode {
  uuid: string
  uri: string
  aliases: string[]
  priority: number
  disclosure: string | null
  content: string | null
  createdAt: Date
  updatedAt: Date
  previousVersions: number
  keywords: string[]
}

export interface LoreSnapshot {
  nodes: LoreNode[]
  recallEvents: null
}

export const LORE_IMPORT_UNAVAILABLE = 'Lore 迁入工具正在适配记忆圈架构'
