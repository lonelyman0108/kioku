import {
  ApiKeyListResponse,
  ApiKeyView,
  ApplySuggestionResponse,
  CredentialListResponse,
  CredentialMeta,
  DatabaseCheck,
  DatabaseConnected,
  DeviceGrantApproveResponse,
  DeviceGrantLookupResponse,
  EntryDetailResponse,
  EntryHistoryResponse,
  EntryListResponse,
  HealthResponse,
  ImportApplyResponse,
  ImportPreviewResponse,
  InboxResponse,
  IssuedApiKeyResponse,
  MeResponse,
  ModelsSettingsResponse,
  RebuildEmbeddingsResponse,
  RevealCredentialResponse,
  SessionsResponse,
  SetupStatusResponse,
  TestModelResponse,
  TriggerDreamResponse,
  type ApplySuggestionRequest,
  type ChangePasswordRequest,
  type CreateApiKeyRequest,
  type CreateCredentialRequest,
  type CreateEntryRequest,
  type DatabaseCheckRequest,
  type DatabaseProvisionRequest,
  type DeviceGrantApproveRequest,
  type EntryListQuery,
  type ExportDataRequest,
  type ExportFormat,
  type ImportApplyRequest,
  type ImportPreviewRequest,
  type RestoreEntryRequest,
  type RotateApiKeyRequest,
  type SetupRequest,
  type TestModelRequest,
  type UpdateApiKeyRequest,
  type UpdateCredentialRequest,
  type UpdateEntryRequest,
  type UpdateModelsSettingsRequest,
  type UpdateProfileRequest,
} from '@kioku/contracts'

import { download, request } from './client'

export const api = {
  // 健康检查与初始化
  health: () => request('GET', '/health', { schema: HealthResponse }),
  setupStatus: () => request('GET', '/setup/status', { schema: SetupStatusResponse }),
  setup: (body: SetupRequest) => request('POST', '/setup', { body, schema: MeResponse }),
  checkDatabase: (body: DatabaseCheckRequest) =>
    request('POST', '/setup/database/check', { body, schema: DatabaseCheck }),
  connectDatabase: (body: DatabaseCheckRequest) =>
    request('POST', '/setup/database', { body, schema: DatabaseConnected }),
  provisionDatabase: (body: DatabaseProvisionRequest) =>
    request('POST', '/setup/database/provision', { body, schema: DatabaseConnected }),

  // 认证与会话
  login: (username: string, password: string) =>
    request('POST', '/auth/login', { body: { username, password }, schema: MeResponse }),
  logout: () => request('POST', '/auth/logout'),
  me: () => request('GET', '/auth/me', { schema: MeResponse }),
  updateProfile: (body: UpdateProfileRequest) =>
    request('PATCH', '/auth/me', { body, schema: MeResponse }),
  changePassword: (body: ChangePasswordRequest) => request('POST', '/auth/password', { body }),
  sessions: () => request('GET', '/auth/sessions', { schema: SessionsResponse }),
  revokeSession: (id: string) => request('DELETE', `/auth/sessions/${encodeURIComponent(id)}`),

  // 记忆词条与历史
  entries: (query: Partial<EntryListQuery> = {}) =>
    request('GET', '/console/entries', {
      query: query as Record<string, string | number | undefined>,
      schema: EntryListResponse,
    }),
  createEntry: (body: Partial<CreateEntryRequest> & Pick<CreateEntryRequest, 'content'>) =>
    request('POST', '/console/entries', { body, schema: EntryDetailResponse }),
  entry: (shortId: string) =>
    request('GET', `/console/entries/${encodeURIComponent(shortId)}`, {
      schema: EntryDetailResponse,
    }),
  updateEntry: (shortId: string, body: UpdateEntryRequest) =>
    request('PATCH', `/console/entries/${encodeURIComponent(shortId)}`, {
      body,
      schema: EntryDetailResponse,
    }),
  deleteEntry: (shortId: string, permanent = false) =>
    request('DELETE', `/console/entries/${encodeURIComponent(shortId)}`, {
      query: permanent ? { permanent: 'true' } : undefined,
    }),
  restoreEntry: (shortId: string, body: RestoreEntryRequest = {}) =>
    request('POST', `/console/entries/${encodeURIComponent(shortId)}/restore`, {
      body,
      schema: EntryDetailResponse,
    }),
  entryHistory: (shortId: string) =>
    request('GET', `/console/entries/${encodeURIComponent(shortId)}/history`, {
      schema: EntryHistoryResponse,
    }),

  // 待处理整理建议
  inbox: () => request('GET', '/console/inbox', { schema: InboxResponse }),
  applySuggestion: (id: string, body: ApplySuggestionRequest = {}) =>
    request('POST', `/console/inbox/${encodeURIComponent(id)}/apply`, {
      body,
      schema: ApplySuggestionResponse,
    }),
  dismissSuggestion: (id: string) =>
    request('POST', `/console/inbox/${encodeURIComponent(id)}/dismiss`),
  runDream: () => request('POST', '/console/dream/run', { schema: TriggerDreamResponse }),

  // 托管凭据（明文值只在显式查看时返回，不进 TanStack Query 缓存）
  credentials: () => request('GET', '/console/credentials', { schema: CredentialListResponse }),
  createCredential: (body: CreateCredentialRequest) =>
    request('POST', '/console/credentials', { body, schema: CredentialMeta }),
  updateCredential: (id: string, body: UpdateCredentialRequest) =>
    request('PATCH', `/console/credentials/${encodeURIComponent(id)}`, {
      body,
      schema: CredentialMeta,
    }),
  revealCredential: (id: string) =>
    request('POST', `/console/credentials/${encodeURIComponent(id)}/reveal`, {
      schema: RevealCredentialResponse,
    }),
  deleteCredential: (id: string) =>
    request('DELETE', `/console/credentials/${encodeURIComponent(id)}`),

  // 访问密钥
  keys: () => request('GET', '/console/keys', { schema: ApiKeyListResponse }),
  createKey: (body: Partial<CreateApiKeyRequest> & Pick<CreateApiKeyRequest, 'name'>) =>
    request('POST', '/console/keys', { body, schema: IssuedApiKeyResponse }),
  updateKey: (id: string, body: UpdateApiKeyRequest) =>
    request('PATCH', `/console/keys/${encodeURIComponent(id)}`, {
      body,
      schema: ApiKeyView,
    }),
  rotateKey: (id: string, body: RotateApiKeyRequest = {}) =>
    request('POST', `/console/keys/${encodeURIComponent(id)}/rotate`, {
      body,
      schema: IssuedApiKeyResponse,
    }),
  deleteKey: (id: string) => request('DELETE', `/console/keys/${encodeURIComponent(id)}`),

  // 模型配置与数据导出
  modelsSettings: () =>
    request('GET', '/console/settings/models', { schema: ModelsSettingsResponse }),
  saveModelsSettings: (body: UpdateModelsSettingsRequest) =>
    request('PUT', '/console/settings/models', { body, schema: ModelsSettingsResponse }),
  testModel: (body: TestModelRequest) =>
    request('POST', '/console/settings/models/test', { body, schema: TestModelResponse }),
  backfillEmbeddings: () =>
    request('POST', '/console/settings/embedding/backfill', {
      schema: RebuildEmbeddingsResponse,
    }),
  exportData: (format: ExportFormat) => download('GET', `/console/export?format=${format}`),
  exportBundle: (body: ExportDataRequest) => download('POST', '/console/export', body),
  previewImport: (body: ImportPreviewRequest, signal?: AbortSignal) =>
    request('POST', '/console/import/preview', { body, schema: ImportPreviewResponse, signal }),
  applyImport: (body: ImportApplyRequest, signal?: AbortSignal) =>
    request('POST', '/console/import/apply', { body, schema: ImportApplyResponse, signal }),

  // 浏览器授权确认（确认码只走请求体，不进地址与查询缓存）
  lookupDeviceGrant: (userCode: string) =>
    request('POST', '/device/grants/lookup', {
      body: { userCode },
      schema: DeviceGrantLookupResponse,
    }),
  approveDeviceGrant: (body: DeviceGrantApproveRequest) =>
    request('POST', '/device/grants/approve', { body, schema: DeviceGrantApproveResponse }),
  denyDeviceGrant: (userCode: string) =>
    request('POST', '/device/grants/deny', { body: { userCode } }),
}
