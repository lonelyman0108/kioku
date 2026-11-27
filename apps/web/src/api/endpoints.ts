import {
  ApiKeyListResponse,
  ApiKeyView,
  ApplySuggestionResponse,
  BootPreviewResponse,
  CancelTaskResponse,
  CapturePlanResponse,
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
  HygieneSweepApplyResponse,
  HygieneSweepPreviewResponse,
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
  SingleCrossCheckResponse,
  SingleTidyApplyResponse,
  SingleTidyPreviewResponse,
  TestModelResponse,
  TriggerDreamResponse,
  type ApplySuggestionRequest,
  type BootPreviewRequest,
  type CapturePlanRequest,
  type ChangePasswordRequest,
  type CreateApiKeyRequest,
  type CreateCredentialRequest,
  type CreateEntryRequest,
  type DatabaseCheckRequest,
  type DatabaseProvisionRequest,
  type DeviceGrantApproveRequest,
  type EntryHistoryQuery,
  type EntryListQuery,
  type ExportDataRequest,
  type ExportFormat,
  type HygieneSweepApplyRequest,
  type ImportApplyRequest,
  type ImportPreviewRequest,
  type RestoreEntryRequest,
  type RotateApiKeyRequest,
  type SetupRequest,
  type SingleTidyApplyRequest,
  type TestModelRequest,
  type TriggerDreamRequest,
  type UpdateApiKeyRequest,
  type UpdateCredentialRequest,
  type UpdateEntryRequest,
  type UpdateModelsSettingsRequest,
  type UpdateProfileRequest,
} from '@kioku/contracts'

import { ApiError, download, request, requestRaw } from './client'

async function streamSingleTidyPreview(
  shortId: string,
  options: {
    signal?: AbortSignal
    onStage?: (stage: string, message: string) => void
  } = {},
): Promise<SingleTidyPreviewResponse> {
  const res = await requestRaw(
    'POST',
    `/console/entries/${encodeURIComponent(shortId)}/tidy/preview`,
    {
      headers: { accept: 'text/event-stream' },
      signal: options.signal,
    },
  )

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream') || !res.body) {
    return SingleTidyPreviewResponse.parse(await res.json())
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = 'message'
  let dataLines: string[] = []
  let finalResult: SingleTidyPreviewResponse | null = null
  let streamFinished = false

  const dispatchEvent = () => {
    const data = dataLines.join('\n')
    const eventName = currentEvent
    currentEvent = 'message'
    dataLines = []
    if (!data || eventName === 'heartbeat') return
    if (eventName === 'stage') {
      try {
        const parsed = JSON.parse(data) as { stage?: string; message?: string }
        if (parsed.message) options.onStage?.(parsed.stage ?? 'llm', parsed.message)
      } catch {
        // 忽略无效阶段事件
      }
      return
    }
    if (eventName === 'error') {
      let msg = '单条规范整理失败'
      let status = 500
      try {
        const parsed = JSON.parse(data) as { error?: string; status?: number }
        if (parsed.error) msg = parsed.error
        if (typeof parsed.status === 'number') status = parsed.status
      } catch {
        // 忽略
      }
      throw new ApiError(status, msg)
    }
    if (eventName === 'result') {
      finalResult = SingleTidyPreviewResponse.parse(JSON.parse(data))
    }
  }

  const processLine = (rawLine: string) => {
    const line = rawLine.replace(/\r$/, '')
    if (line === '') {
      dispatchEvent()
    } else if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5))
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        streamFinished = true
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let idx = buffer.indexOf('\n')
      while (idx !== -1) {
        processLine(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 1)
        idx = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.length > 0) {
      for (const tailLine of buffer.split('\n')) {
        processLine(tailLine)
      }
    }
    if (dataLines.length) dispatchEvent()
  } finally {
    if (!streamFinished) {
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }

  if (!finalResult) {
    throw new ApiError(502, '规范整理连接意外中断，未收到完整结果')
  }
  return finalResult
}

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
  capturePlan: (
    body: Partial<CapturePlanRequest> & Pick<CapturePlanRequest, 'text'>,
    signal?: AbortSignal,
  ) => request('POST', '/console/entries/capture', { body, schema: CapturePlanResponse, signal }),
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
  entryHistory: (shortId: string, query?: Partial<EntryHistoryQuery>) =>
    request('GET', `/console/entries/${encodeURIComponent(shortId)}/history`, {
      query: query
        ? {
            limit: query.limit,
            version: query.version,
            includeSnapshots:
              query.includeSnapshots === undefined
                ? undefined
                : query.includeSnapshots
                  ? 'true'
                  : 'false',
          }
        : { includeSnapshots: 'true' },
      schema: EntryHistoryResponse,
    }),
  previewHygieneSweep: () =>
    request('POST', '/console/entries/hygiene/preview', {
      schema: HygieneSweepPreviewResponse,
    }),
  applyHygieneSweep: (body: HygieneSweepApplyRequest = {}) =>
    request('POST', '/console/entries/hygiene/apply', {
      body,
      schema: HygieneSweepApplyResponse,
    }),
  previewBoot: (body: BootPreviewRequest = {}) =>
    request('POST', '/console/boot/preview', {
      body,
      schema: BootPreviewResponse,
    }),
  previewSingleTidy: (
    shortId: string,
    options?: { signal?: AbortSignal; onStage?: (stage: string, message: string) => void },
  ) => streamSingleTidyPreview(shortId, options),
  applySingleTidy: (shortId: string, body: SingleTidyApplyRequest) =>
    request('POST', `/console/entries/${encodeURIComponent(shortId)}/tidy/apply`, {
      body,
      schema: SingleTidyApplyResponse,
    }),
  crossCheckEntry: (shortId: string, signal?: AbortSignal) =>
    request('POST', `/console/entries/${encodeURIComponent(shortId)}/cross-check`, {
      schema: SingleCrossCheckResponse,
      signal,
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
  runDream: (body?: Partial<TriggerDreamRequest>) =>
    request('POST', '/console/dream/run', {
      ...(body ? { body } : {}),
      schema: TriggerDreamResponse,
    }),
  cancelDream: () => request('POST', '/console/dream/cancel', { schema: CancelTaskResponse }),

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
  cancelEmbeddingBackfill: () =>
    request('POST', '/console/settings/embedding/backfill/cancel', {
      schema: CancelTaskResponse,
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
