import {
  ActivityList,
  AppInfo,
  BootPreview,
  ConsoleCredential,
  ConsoleCredentialList,
  ConsoleSearchResponse,
  CredentialEventList,
  CredentialProvider,
  CredentialReferenceList,
  CredentialValues,
  CreatedKey,
  DeletedMemoryList,
  DomainLayers,
  EmbeddingCoverage,
  EmbeddingRebuildResult,
  EmbeddingSettingsView,
  EmbeddingTestResult,
  ExtractionSettingsView,
  ExtractionTestResult,
  GlossaryIndex,
  HealthResponse,
  KeyAccessMatrix,
  KeyInfo,
  Me,
  MemberInfo,
  MemoryChildren,
  MemoryHistory,
  MemoryList,
  MemoryRecallStat,
  MemoryView,
  PersonaDetail,
  PersonaInfo,
  RecallDebug,
  RecallEventList,
  RecallSettings,
  RecallStats,
  SetupStatus,
  SpaceOverview,
  type BootPreviewRequest,
  type CreateAppRequest,
  type CreateCredentialProviderRequest,
  type CreateCredentialRequest,
  type CreateKeyRequest,
  type CreateMemoryRequest,
  type CreatePersonaRequest,
  type MemoryListQuery,
  type MoveMemoryRequest,
  type PlainLayer,
  type RestoreRequest,
  type SetupRequest,
  type UpdateAppRequest,
  type UpdateCredentialProviderRequest,
  type UpdateCredentialRequest,
  type UpdateEmbeddingSettings,
  type UpdateExtractionSettings,
  type UpdateMemoryRequest,
  type UpdatePersonaRequest,
} from '@kioku/contracts'
import { z } from 'zod'

import { request } from './client'

export const api = {
  health: () => request('GET', '/health', { schema: HealthResponse }),

  setupStatus: () => request('GET', '/setup/status', { schema: SetupStatus }),
  setup: (body: SetupRequest) => request('POST', '/setup', { body, schema: Me }),
  login: (username: string, password: string) =>
    request('POST', '/auth/login', { body: { username, password }, schema: Me }),
  logout: () => request('POST', '/auth/logout'),
  me: () => request('GET', '/auth/me', { schema: Me }),

  personas: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/personas`, { schema: z.array(PersonaInfo) }),
  createPersona: (
    spaceId: string,
    body: Partial<CreatePersonaRequest> & Pick<CreatePersonaRequest, 'slug' | 'name'>,
  ) => request('POST', `/spaces/${spaceId}/personas`, { body, schema: PersonaInfo }),
  persona: (spaceId: string, personaId: string) =>
    request('GET', `/spaces/${spaceId}/personas/${personaId}`, { schema: PersonaDetail }),
  updatePersona: (spaceId: string, personaId: string, body: UpdatePersonaRequest) =>
    request('PATCH', `/spaces/${spaceId}/personas/${personaId}`, { body, schema: PersonaInfo }),
  deletePersona: (spaceId: string, personaId: string) =>
    request('DELETE', `/spaces/${spaceId}/personas/${personaId}`),
  members: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/members`, { schema: z.array(MemberInfo) }),

  apps: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/apps`, { schema: z.array(AppInfo) }),
  createApp: (
    spaceId: string,
    body: Partial<CreateAppRequest> & Pick<CreateAppRequest, 'slug' | 'name' | 'runtimeFamily'>,
  ) => request('POST', `/spaces/${spaceId}/apps`, { body, schema: AppInfo }),
  updateApp: (spaceId: string, appId: string, body: UpdateAppRequest) =>
    request('PATCH', `/spaces/${spaceId}/apps/${appId}`, { body, schema: AppInfo }),
  deleteApp: (spaceId: string, appId: string) =>
    request('DELETE', `/spaces/${spaceId}/apps/${appId}`),
  keys: (spaceId: string, appId: string) =>
    request('GET', `/spaces/${spaceId}/apps/${appId}/keys`, { schema: z.array(KeyInfo) }),
  createKey: (spaceId: string, appId: string, body: CreateKeyRequest) =>
    request('POST', `/spaces/${spaceId}/apps/${appId}/keys`, { body, schema: CreatedKey }),
  revokeKey: (spaceId: string, appId: string, keyId: string) =>
    request('DELETE', `/spaces/${spaceId}/apps/${appId}/keys/${keyId}`),
  recallStats: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/recall/stats`, { schema: RecallStats }),
  recallEvents: (spaceId: string, query: { appId?: string; cursor?: string }) =>
    request('GET', `/spaces/${spaceId}/recall/events`, { query, schema: RecallEventList }),
  memoryRecallStat: (spaceId: string, memoryId: string) =>
    request('GET', `/spaces/${spaceId}/recall/memory`, {
      query: { id: memoryId },
      schema: MemoryRecallStat,
    }),
  recallSettings: () => request('GET', '/settings/recall', { schema: RecallSettings }),
  saveRecallSettings: (body: RecallSettings) =>
    request('PUT', '/settings/recall', { body, schema: RecallSettings }),
  bootPreview: (spaceId: string, appId: string, keyId: string, body: BootPreviewRequest) =>
    request('POST', `/spaces/${spaceId}/apps/${appId}/keys/${keyId}/preview`, {
      body,
      schema: BootPreview,
    }),
  recallDebug: (spaceId: string, appId: string, keyId: string, query: string) =>
    request('POST', `/spaces/${spaceId}/apps/${appId}/keys/${keyId}/debug`, {
      body: { query },
      schema: RecallDebug,
    }),
  keyMatrix: (spaceId: string, appId: string, keyId: string) =>
    request('GET', `/spaces/${spaceId}/apps/${appId}/keys/${keyId}/matrix`, {
      schema: KeyAccessMatrix,
    }),

  memory: (spaceId: string, uri: string) =>
    request('GET', `/spaces/${spaceId}/memories`, { query: { uri }, schema: MemoryView }),
  memoryChildren: (spaceId: string, of: string) =>
    request('GET', `/spaces/${spaceId}/memories/children`, {
      query: { of },
      schema: MemoryChildren,
    }),
  memoryDomains: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/memories/domains`, {
      schema: z.array(z.object({ domain: z.string(), count: z.number() })),
    }),
  createMemory: (
    spaceId: string,
    body: Partial<CreateMemoryRequest> & Pick<CreateMemoryRequest, 'uri' | 'content'>,
  ) => request('POST', `/spaces/${spaceId}/memories`, { body, schema: MemoryView }),
  updateMemory: (spaceId: string, body: UpdateMemoryRequest) =>
    request('PATCH', `/spaces/${spaceId}/memories`, { body, schema: MemoryView }),
  deleteMemory: (spaceId: string, uri: string, expected: { id: string; version: number }) =>
    request('DELETE', `/spaces/${spaceId}/memories`, {
      query: { uri, expectedId: expected.id, expectedVersion: expected.version },
    }),
  moveMemory: (spaceId: string, body: MoveMemoryRequest) =>
    request('POST', `/spaces/${spaceId}/memories/move`, { body, schema: MemoryView }),
  // 列表的筛选都是可选的；查询参数原样是字符串
  memoryList: (spaceId: string, query: Partial<Record<keyof MemoryListQuery, string | number>>) =>
    request('GET', `/spaces/${spaceId}/memories/list`, { query, schema: MemoryList }),
  searchMemories: (spaceId: string, query: string) =>
    request('POST', `/spaces/${spaceId}/memories/search`, {
      body: { query },
      schema: ConsoleSearchResponse,
    }),
  glossaryIndex: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/memories/glossary`, { schema: GlossaryIndex }),
  memoryHistory: (spaceId: string, id: string) =>
    request('GET', `/spaces/${spaceId}/memories/history`, { query: { id }, schema: MemoryHistory }),
  deletedMemories: (spaceId: string, cursor?: string) =>
    request('GET', `/spaces/${spaceId}/memories/deleted`, {
      query: { cursor },
      schema: DeletedMemoryList,
    }),
  restoreMemory: (spaceId: string, body: RestoreRequest) =>
    request('POST', `/spaces/${spaceId}/memories/restore`, { body, schema: MemoryView }),
  undeleteMemory: (spaceId: string, memoryId: string) =>
    request('POST', `/spaces/${spaceId}/memories/undelete`, {
      body: { memoryId },
      schema: MemoryView,
    }),

  credentials: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/credentials`, { schema: ConsoleCredentialList }),
  deletedCredentials: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/credentials/deleted`, { schema: ConsoleCredentialList }),
  credential: (spaceId: string, id: string) =>
    request('GET', `/spaces/${spaceId}/credentials/${id}`, { schema: ConsoleCredential }),
  createCredential: (spaceId: string, body: CreateCredentialRequest) =>
    request('POST', `/spaces/${spaceId}/credentials`, { body, schema: ConsoleCredential }),
  updateCredential: (spaceId: string, id: string, body: UpdateCredentialRequest) =>
    request('PATCH', `/spaces/${spaceId}/credentials/${id}`, { body, schema: ConsoleCredential }),
  deleteCredential: (spaceId: string, id: string, expectedVersion: number) =>
    request('DELETE', `/spaces/${spaceId}/credentials/${id}`, { query: { expectedVersion } }),
  undeleteCredential: (spaceId: string, id: string) =>
    request('POST', `/spaces/${spaceId}/credentials/${id}/undelete`, {
      schema: ConsoleCredential,
    }),
  revealCredential: (spaceId: string, id: string) =>
    request('POST', `/spaces/${spaceId}/credentials/${id}/reveal`, { schema: CredentialValues }),
  credentialEvents: (spaceId: string, id: string, cursor?: string) =>
    request('GET', `/spaces/${spaceId}/credentials/${id}/events`, {
      query: { cursor },
      schema: CredentialEventList,
    }),
  credentialReferences: (spaceId: string, id: string) =>
    request('GET', `/spaces/${spaceId}/credentials/${id}/references`, {
      schema: CredentialReferenceList,
    }),
  credentialProviders: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/credential-providers`, {
      schema: z.array(CredentialProvider),
    }),
  createCredentialProvider: (spaceId: string, body: CreateCredentialProviderRequest) =>
    request('POST', `/spaces/${spaceId}/credential-providers`, {
      body,
      schema: CredentialProvider,
    }),
  updateCredentialProvider: (spaceId: string, id: string, body: UpdateCredentialProviderRequest) =>
    request('PATCH', `/spaces/${spaceId}/credential-providers/${id}`, {
      body,
      schema: CredentialProvider,
    }),
  deleteCredentialProvider: (spaceId: string, id: string) =>
    request('DELETE', `/spaces/${spaceId}/credential-providers/${id}`),

  overview: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/overview`, { schema: SpaceOverview }),
  activity: (spaceId: string, cursor?: string) =>
    request('GET', `/spaces/${spaceId}/activity`, { query: { cursor }, schema: ActivityList }),
  domainLayers: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/domain-layers`, { schema: DomainLayers }),
  saveDomainLayers: (spaceId: string, defaults: Record<string, PlainLayer>) =>
    request('PUT', `/spaces/${spaceId}/domain-layers`, {
      body: { defaults },
      schema: DomainLayers,
    }),

  embeddingSettings: () => request('GET', '/settings/embedding', { schema: EmbeddingSettingsView }),
  saveEmbeddingSettings: (body: UpdateEmbeddingSettings) =>
    request('PUT', '/settings/embedding', { body, schema: EmbeddingSettingsView }),
  testEmbedding: () => request('POST', '/settings/embedding/test', { schema: EmbeddingTestResult }),
  embeddingStatus: () =>
    request('GET', '/settings/embedding/status', { schema: EmbeddingCoverage }),
  rebuildEmbeddings: () =>
    request('POST', '/settings/embedding/rebuild', { schema: EmbeddingRebuildResult }),

  extractionSettings: () =>
    request('GET', '/settings/extraction', { schema: ExtractionSettingsView }),
  saveExtractionSettings: (body: UpdateExtractionSettings) =>
    request('PUT', '/settings/extraction', { body, schema: ExtractionSettingsView }),
  clearExtractionSettings: () => request('DELETE', '/settings/extraction'),
  testExtraction: () =>
    request('POST', '/settings/extraction/test', { schema: ExtractionTestResult }),
}
