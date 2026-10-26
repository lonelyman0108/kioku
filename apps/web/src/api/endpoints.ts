import {
  AppInfo,
  CreatedKey,
  EmbeddingSettingsView,
  EmbeddingTestResult,
  HealthResponse,
  KeyInfo,
  Me,
  MemoryChildren,
  MemoryView,
  PersonaInfo,
  SetupStatus,
  type CreateAppRequest,
  type CreateKeyRequest,
  type CreateMemoryRequest,
  type CreatePersonaRequest,
  type MoveMemoryRequest,
  type SetupRequest,
  type UpdateAppRequest,
  type UpdateEmbeddingSettings,
  type UpdateMemoryRequest,
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

  apps: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/apps`, { schema: z.array(AppInfo) }),
  createApp: (
    spaceId: string,
    body: Partial<CreateAppRequest> & Pick<CreateAppRequest, 'slug' | 'name' | 'runtimeFamily'>,
  ) => request('POST', `/spaces/${spaceId}/apps`, { body, schema: AppInfo }),
  updateApp: (spaceId: string, appId: string, body: UpdateAppRequest) =>
    request('PATCH', `/spaces/${spaceId}/apps/${appId}`, { body, schema: AppInfo }),
  keys: (spaceId: string, appId: string) =>
    request('GET', `/spaces/${spaceId}/apps/${appId}/keys`, { schema: z.array(KeyInfo) }),
  createKey: (spaceId: string, appId: string, body: CreateKeyRequest) =>
    request('POST', `/spaces/${spaceId}/apps/${appId}/keys`, { body, schema: CreatedKey }),
  revokeKey: (spaceId: string, appId: string, keyId: string) =>
    request('DELETE', `/spaces/${spaceId}/apps/${appId}/keys/${keyId}`),

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
  deleteMemory: (spaceId: string, uri: string) =>
    request('DELETE', `/spaces/${spaceId}/memories`, { query: { uri } }),
  moveMemory: (spaceId: string, body: MoveMemoryRequest) =>
    request('POST', `/spaces/${spaceId}/memories/move`, { body, schema: MemoryView }),

  embeddingSettings: () => request('GET', '/settings/embedding', { schema: EmbeddingSettingsView }),
  saveEmbeddingSettings: (body: UpdateEmbeddingSettings) =>
    request('PUT', '/settings/embedding', { body, schema: EmbeddingSettingsView }),
  testEmbedding: () => request('POST', '/settings/embedding/test', { schema: EmbeddingTestResult }),
}
