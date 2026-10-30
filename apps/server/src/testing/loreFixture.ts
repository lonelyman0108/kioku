import { LORE_BACKUP_FORMAT } from '@kioku/contracts'
import type postgres from 'postgres'

// 在测试库里建一个只含导入用到的几张表的 Lore，结构取自 Lore 的 000_initial_schema.sql
export const LORE_SCHEMA = `
  drop schema if exists lore_fixture cascade;
  create schema lore_fixture;
  set search_path = lore_fixture;
  create table nodes (uuid text primary key, created_at timestamptz not null default now());
  create table memories (id bigserial primary key, node_uuid text not null, content text,
    deprecated boolean not null default false, migrated_to text, created_at timestamptz not null default now());
  create table edges (id bigserial primary key, parent_uuid text not null, child_uuid text not null,
    priority integer not null default 0, disclosure text, created_at timestamptz not null default now());
  create table paths (domain text not null, path text not null, edge_id integer not null,
    created_at timestamptz not null default now(), primary key (domain, path));
  create table glossary_keywords (id bigserial primary key, keyword text not null, node_uuid text not null,
    created_at timestamptz not null default now());
  create table recall_events (id bigserial primary key, query_text text not null, node_uri text not null);
`

export interface LoreSeed {
  priority?: number
  disclosure?: string
  keywords?: string[]
  old?: string[]
}

// 一个节点：正文的旧版本、当前版本、路径与关键词。uuid 是 uuid- 加 URI
export async function seedLoreNode(
  lore: postgres.Sql,
  uri: string,
  content: string,
  extra: LoreSeed = {},
): Promise<void> {
  const [domain, path] = uri.split('://') as [string, string]
  const uuid = `uuid-${uri}`
  await lore`insert into nodes (uuid, created_at) values (${uuid}, '2025-03-01T00:00:00Z')`
  for (const old of extra.old ?? []) {
    await lore`insert into memories (node_uuid, content, deprecated, created_at)
      values (${uuid}, ${old}, true, '2025-03-02T00:00:00Z')`
  }
  await lore`insert into memories (node_uuid, content, created_at)
    values (${uuid}, ${content}, '2025-04-01T00:00:00Z')`
  const [edge] = await lore<{ id: number }[]>`
    insert into edges (parent_uuid, child_uuid, priority, disclosure)
    values ('root', ${uuid}, ${extra.priority ?? 2}, ${extra.disclosure ?? null}) returning id`
  await lore`insert into paths (domain, path, edge_id) values (${domain}, ${path}, ${edge!.id})`
  for (const keyword of extra.keywords ?? []) {
    await lore`insert into glossary_keywords (keyword, node_uuid) values (${keyword}, ${uuid})`
  }
}

export type LoreExportRows = Record<string, Record<string, unknown>[]>

export interface LoreExport {
  format: string
  created_at: string
  tables: LoreExportRows
  stats?: Record<string, number>
}

// Lore 的导出：列和 Lore 的 web/server/lore/ops/backup.ts 相同，经 JSON 往返，所以类型和真实文件一样
// （bigserial 是字符串、integer 是数字、timestamptz 是毫秒的 ISO 时间），不手写。只有导入要用的五张表
export async function exportLore(lore: postgres.Sql, createdAt: string): Promise<LoreExport> {
  const [nodes, memories, edges, paths, keywords] = await lore.begin((tx) => [
    tx`SELECT uuid, created_at FROM nodes`,
    tx`SELECT id, node_uuid, content, deprecated, migrated_to, created_at FROM memories`,
    tx`SELECT id, parent_uuid, child_uuid, priority, disclosure, created_at FROM edges`,
    tx`SELECT domain, path, edge_id, created_at FROM paths`,
    tx`SELECT id, keyword, node_uuid, created_at FROM glossary_keywords`,
  ])
  return JSON.parse(
    JSON.stringify({
      format: LORE_BACKUP_FORMAT,
      created_at: createdAt,
      tables: { nodes, memories, edges, paths, glossary_keywords: keywords },
    }),
  ) as LoreExport
}

// 浏览器上传之前裁掉的：废弃版本的正文
export function withoutDeprecatedContent(backup: LoreExport): LoreExport {
  return {
    ...backup,
    tables: {
      ...backup.tables,
      memories: backup.tables.memories!.map(({ content, ...row }) =>
        row.deprecated ? row : { ...row, content },
      ),
    },
  }
}
