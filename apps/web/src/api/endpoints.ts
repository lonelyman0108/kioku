import {
  ActivityDays,
  ActivityEvent,
  ActivityFacets,
  ActivityList,
  AppAdvancedView,
  AppInfo,
  BackupObjectList,
  BackupQueued,
  BackupRunStatus,
  BackupSettingsView,
  BackupTestResult,
  BenchAgentInfo,
  BenchAgentTurnResult,
  BenchRunResult,
  BenchScenarioList,
  BenchToolList,
  BootPreview,
  ConsoleCredential,
  ConsoleCredentialList,
  ConsoleMemoryChildren,
  ConsoleMemoryView,
  ConsoleSearchResponse,
  ConversationDetail,
  ConversationList,
  ConvertedToCredential,
  CreatedCredential,
  CredentialEventList,
  CredentialReferenceList,
  CredentialValueMatches,
  CredentialValues,
  CreatedKey,
  DeletedCredentialList,
  DeletedMemoryList,
  DreamApplied,
  DreamMemberSettings,
  DreamQueued,
  DreamRunList,
  DreamRunStatus,
  DreamSuggestionList,
  EmbeddingRebuildResult,
  EmbeddingSettingsView,
  EmbeddingStatus,
  EmbeddingTestResult,
  ExpiredMemoryList,
  ExtractionSettingsView,
  ExtractionUsage,
  ExtractionTestResult,
  MasterKeyStatus,
  GlossaryIndex,
  GroupPersonaRuleList,
  HealthResponse,
  InboxCounts,
  KeyAccessMatrix,
  KeyInfo,
  LoreImportPlan,
  LoreImportResult,
  Me,
  MemoryHistory,
  MemoryList,
  MemoryRecallStat,
  PersonaDetail,
  PersonaInfo,
  RecallDebug,
  RecallEventList,
  RecallSettings,
  RecallStats,
  RetentionResumed,
  RetentionView,
  ReviewList,
  ReviewResult,
  SetupStatus,
  SpaceImportPreview,
  SpaceImportResult,
  SpaceOverview,
  SubjectDetail,
  SubjectInfo,
  SubjectList,
  SystemInfo,
  VaultCheckResult,
  VaultConnectResult,
  VaultConnection,
  VaultConnectionList,
  VaultItemList,
  type ApplyDreamSuggestion,
  type BenchAgentTurnRequest,
  type BenchRunRequest,
  type BootPreviewRequest,
  type ConversationListQuery,
  type ConvertToCredentialRequest,
  type CreateAppRequest,
  type ConnectVaultRequest,
  type CreateCredentialRequest,
  type CredentialListQuery,
  type CreateKeyRequest,
  type ConsoleCreateMemoryRequest,
  type MatchCredentialValuesRequest,
  type CreatePersonaRequest,
  type GroupPersonaRules,
  type LoreImportApplyRequest,
  type LoreImportPlanRequest,
  type MemoryListQuery,
  type MoveMemoryRequest,
  type PlaintextIgnoreRequest,
  type ReactivateRequest,
  type RestoreRequest,
  type ReviewQuery,
  type RetentionSettings,
  type ReviewRequest,
  type SetupRequest,
  type SubjectListQuery,
  type UpdateAppRequest,
  type UpdateBackupSettings,
  type ReconnectVaultRequest,
  type SetVaultDestinationRequest,
  type UpdateCredentialRequest,
  type UpdateEmbeddingSettings,
  type UpdateExtractionSettings,
  type ExtractionBudget,
  type ConsoleUpdateMemoryRequest,
  type UpdatePersonaRequest,
  type UpdateSubjectRequest,
  InstanceAdvancedView,
  SpaceAdvancedView,
  type UpdateAppAdvanced,
  type UpdateInstanceAdvanced,
  type UpdateSpaceAdvanced,
  CreatedSpace,
  InstanceSpace,
  SpaceDetail,
  SpaceInfo,
  SpaceLimitView,
  SpaceMember,
  type AddMemberRequest,
  type CreateSpaceRequest,
  type MemberRole,
} from '@kioku/contracts'
import {
  AccountLink,
  AdminAccount,
  AdminAccountList,
  CreatedAccount,
  DeviceGrantApproved,
  DeviceGrantInfo,
  LoginSessionList,
  PasswordLinkInfo,
  type ChangePasswordRequest,
  type CreateAccountRequest,
  type DeviceGrantApprove,
  type UpdateAccountRequest,
} from '@kioku/contracts'
import { z } from 'zod'

import { download, request } from './client'

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
    request('GET', `/spaces/${spaceId}/members`, { schema: z.array(SpaceMember) }),
  // 空间与成员
  space: (spaceId: string) => request('GET', `/spaces/${spaceId}`, { schema: SpaceDetail }),
  renameSpace: (spaceId: string, name: string) =>
    request('PATCH', `/spaces/${spaceId}`, { body: { name }, schema: SpaceInfo }),
  deleteSpace: (spaceId: string, confirmName: string) =>
    request('DELETE', `/spaces/${spaceId}`, { body: { confirmName } }),
  createSpace: (body: CreateSpaceRequest) =>
    request('POST', '/spaces', { body, schema: CreatedSpace }),
  addMember: (spaceId: string, body: AddMemberRequest) =>
    request('POST', `/spaces/${spaceId}/members`, { body, schema: SpaceMember }),
  updateMember: (spaceId: string, accountId: string, role: MemberRole) =>
    request('PATCH', `/spaces/${spaceId}/members/${accountId}`, {
      body: { role },
      schema: SpaceMember,
    }),
  removeMember: (spaceId: string, accountId: string) =>
    request('DELETE', `/spaces/${spaceId}/members/${accountId}`),
  transferOwnership: (spaceId: string, accountId: string) =>
    request('POST', `/spaces/${spaceId}/transfer-ownership`, {
      body: { accountId },
      schema: z.array(SpaceMember),
    }),
  instanceSpaces: () => request('GET', '/instance/spaces', { schema: z.array(InstanceSpace) }),
  spaceLimit: () => request('GET', '/instance/space-limit', { schema: SpaceLimitView }),
  saveSpaceLimit: (maxOwnedSpaces: number) =>
    request('PUT', '/instance/space-limit', { body: { maxOwnedSpaces }, schema: SpaceLimitView }),
  systemInfo: () => request('GET', '/instance/system', { schema: SystemInfo }),
  saveUpdateCheck: (enabled: boolean) =>
    request('PUT', '/instance/update-check', { body: { enabled }, schema: SystemInfo }),
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
  benchTools: (spaceId: string, appId: string, keyId: string) =>
    request('GET', `/spaces/${spaceId}/apps/${appId}/keys/${keyId}/bench/tools`, {
      schema: BenchToolList,
    }),
  benchRun: (spaceId: string, appId: string, keyId: string, body: BenchRunRequest) =>
    request('POST', `/spaces/${spaceId}/apps/${appId}/keys/${keyId}/bench/run`, {
      body,
      schema: BenchRunResult,
    }),
  benchScenarios: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/bench/scenarios`, { schema: BenchScenarioList }),
  benchAgent: (spaceId: string, appId: string, keyId: string) =>
    request('GET', `/spaces/${spaceId}/apps/${appId}/keys/${keyId}/bench/agent`, {
      schema: BenchAgentInfo,
    }),
  benchAgentTurn: (
    spaceId: string,
    appId: string,
    keyId: string,
    body: BenchAgentTurnRequest,
    signal: AbortSignal,
  ) =>
    request('POST', `/spaces/${spaceId}/apps/${appId}/keys/${keyId}/bench/agent/turn`, {
      body,
      schema: BenchAgentTurnResult,
      signal,
    }),

  memory: (spaceId: string, uri: string) =>
    request('GET', `/spaces/${spaceId}/memories`, { query: { uri }, schema: ConsoleMemoryView }),
  // 显式查看机密的正文（记一次访问）。结果不要放进 useQuery 的缓存，见 secretContent.ts
  revealMemory: (spaceId: string, memoryId: string) =>
    request('POST', `/spaces/${spaceId}/memories/reveal`, {
      body: { memoryId },
      schema: ConsoleMemoryView,
    }),
  memoryChildren: (spaceId: string, of: string) =>
    request('GET', `/spaces/${spaceId}/memories/children`, {
      query: { of },
      schema: ConsoleMemoryChildren,
    }),
  createMemory: (
    spaceId: string,
    body: Partial<ConsoleCreateMemoryRequest> & Pick<ConsoleCreateMemoryRequest, 'uri' | 'content'>,
  ) => request('POST', `/spaces/${spaceId}/memories`, { body, schema: ConsoleMemoryView }),
  updateMemory: (spaceId: string, body: ConsoleUpdateMemoryRequest) =>
    request('PATCH', `/spaces/${spaceId}/memories`, { body, schema: ConsoleMemoryView }),
  deleteMemory: (spaceId: string, uri: string, expected: { id: string; version: number }) =>
    request('DELETE', `/spaces/${spaceId}/memories`, {
      query: { uri, expectedId: expected.id, expectedVersion: expected.version },
    }),
  moveMemory: (spaceId: string, body: MoveMemoryRequest) =>
    request('POST', `/spaces/${spaceId}/memories/move`, { body, schema: ConsoleMemoryView }),
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
    request('POST', `/spaces/${spaceId}/memories/restore`, { body, schema: ConsoleMemoryView }),
  undeleteMemory: (spaceId: string, memoryId: string) =>
    request('POST', `/spaces/${spaceId}/memories/undelete`, {
      body: { memoryId },
      schema: ConsoleMemoryView,
    }),
  expiredMemories: (spaceId: string, cursor?: string) =>
    request('GET', `/spaces/${spaceId}/memories/expired`, {
      query: { cursor },
      schema: ExpiredMemoryList,
    }),
  reactivateMemory: (spaceId: string, body: ReactivateRequest) =>
    request('POST', `/spaces/${spaceId}/memories/reactivate`, { body, schema: ConsoleMemoryView }),
  ignorePlaintext: (spaceId: string, body: PlaintextIgnoreRequest) =>
    request('POST', `/spaces/${spaceId}/memories/ignore-plaintext`, {
      body,
      schema: ConsoleMemoryView,
    }),
  unignorePlaintext: (spaceId: string, body: PlaintextIgnoreRequest) =>
    request('POST', `/spaces/${spaceId}/memories/unignore-plaintext`, {
      body,
      schema: ConsoleMemoryView,
    }),
  convertToCredential: (spaceId: string, body: ConvertToCredentialRequest) =>
    request('POST', `/spaces/${spaceId}/memories/convert-to-credential`, {
      body,
      schema: ConvertedToCredential,
    }),

  // attention：只列待处理的「凭据」一类（快到期、已到期、需要轮换），和条数同一个条件
  credentials: (spaceId: string, query: CredentialListQuery = {}) =>
    request('GET', `/spaces/${spaceId}/credentials`, {
      query: { attention: query.attention },
      schema: ConsoleCredentialList,
    }),
  // 按值查找同值的凭据与密码库条目：值只在请求体里，结果不进缓存
  matchCredentialValues: (spaceId: string, body: MatchCredentialValuesRequest) =>
    request('POST', `/spaces/${spaceId}/credentials/match`, {
      body,
      schema: CredentialValueMatches,
    }),
  deletedCredentials: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/credentials/deleted`, { schema: DeletedCredentialList }),
  credential: (spaceId: string, id: string) =>
    request('GET', `/spaces/${spaceId}/credentials/${id}`, { schema: ConsoleCredential }),
  createCredential: (spaceId: string, body: CreateCredentialRequest) =>
    request('POST', `/spaces/${spaceId}/credentials`, { body, schema: CreatedCredential }),
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
  // sinceValueChange：只列上次改值以来交出值的访问事件
  credentialEvents: (spaceId: string, id: string, cursor?: string, sinceValueChange = false) =>
    request('GET', `/spaces/${spaceId}/credentials/${id}/events`, {
      query: { cursor, sinceValueChange: sinceValueChange ? 'true' : undefined },
      schema: CredentialEventList,
    }),
  credentialReferences: (spaceId: string, id: string) =>
    request('GET', `/spaces/${spaceId}/credentials/${id}/references`, {
      schema: CredentialReferenceList,
    }),
  // 密码库连接：只给连接的所有者。主密码只在请求体里，不进缓存
  vaultConnections: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/vault-connections`, { schema: VaultConnectionList }),
  connectVault: (spaceId: string, body: ConnectVaultRequest) =>
    request('POST', `/spaces/${spaceId}/vault-connections`, { body, schema: VaultConnectResult }),
  reconnectVault: (spaceId: string, id: string, body: ReconnectVaultRequest) =>
    request('POST', `/spaces/${spaceId}/vault-connections/${id}/reconnect`, {
      body,
      schema: VaultConnectResult,
    }),
  checkVault: (spaceId: string, id: string) =>
    request('POST', `/spaces/${spaceId}/vault-connections/${id}/check`, {
      schema: VaultCheckResult,
    }),
  disconnectVault: (spaceId: string, id: string) =>
    request('POST', `/spaces/${spaceId}/vault-connections/${id}/disconnect`, {
      schema: VaultConnection,
    }),
  vaultItems: (spaceId: string, id: string) =>
    request('GET', `/spaces/${spaceId}/vault-connections/${id}/items`, { schema: VaultItemList }),
  // 新凭据的去处：设在一个连接上，同一个成员别的连接上的去处一起清掉；响应是这个成员的全部连接
  setVaultDestination: (spaceId: string, id: string, body: SetVaultDestinationRequest) =>
    request('PUT', `/spaces/${spaceId}/vault-connections/${id}/destination`, {
      body,
      schema: VaultConnectionList,
    }),
  clearVaultDestination: (spaceId: string, id: string) =>
    request('DELETE', `/spaces/${spaceId}/vault-connections/${id}/destination`, {
      schema: VaultConnectionList,
    }),

  overview: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/overview`, { schema: SpaceOverview }),
  inboxCounts: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/inbox/counts`, { schema: InboxCounts }),
  // 会话按最近活动从新到旧；按应用或联系人筛
  conversations: (spaceId: string, query: ConversationListQuery) =>
    request('GET', `/spaces/${spaceId}/conversations`, { query, schema: ConversationList }),
  conversation: (spaceId: string, id: string) =>
    request('GET', `/spaces/${spaceId}/conversations/${id}`, { schema: ConversationDetail }),
  subjects: (spaceId: string, query: SubjectListQuery) =>
    request('GET', `/spaces/${spaceId}/subjects`, { query, schema: SubjectList }),
  subject: (spaceId: string, id: string) =>
    request('GET', `/spaces/${spaceId}/subjects/${id}`, { schema: SubjectDetail }),
  updateSubject: (spaceId: string, id: string, body: UpdateSubjectRequest) =>
    request('PATCH', `/spaces/${spaceId}/subjects/${id}`, { body, schema: SubjectInfo }),
  mergeSubject: (spaceId: string, id: string, from: string) =>
    request('POST', `/spaces/${spaceId}/subjects/${id}/merge`, {
      body: { from },
      schema: SubjectInfo,
    }),
  deleteFact: (spaceId: string, subjectId: string, factId: string, version: number) =>
    request('DELETE', `/spaces/${spaceId}/subjects/${subjectId}/facts/${factId}`, {
      query: { version },
    }),
  reactivateFact: (spaceId: string, subjectId: string, factId: string, version: number) =>
    request('POST', `/spaces/${spaceId}/subjects/${subjectId}/facts/${factId}/reactivate`, {
      body: { version },
    }),
  confirmBinding: (spaceId: string, bindingId: string) =>
    request('POST', `/spaces/${spaceId}/subject-bindings/${bindingId}/confirm`, {
      schema: SubjectInfo,
    }),
  rejectBinding: (spaceId: string, bindingId: string) =>
    request('POST', `/spaces/${spaceId}/subject-bindings/${bindingId}/reject`),
  reviewQueue: (spaceId: string, query: ReviewQuery) =>
    request('GET', `/spaces/${spaceId}/review`, { query, schema: ReviewList }),
  review: (spaceId: string, body: ReviewRequest) =>
    request('POST', `/spaces/${spaceId}/review`, { body, schema: ReviewResult }),
  dreamSuggestions: (spaceId: string, cursor?: string) =>
    request('GET', `/spaces/${spaceId}/dream/suggestions`, {
      query: { cursor },
      schema: DreamSuggestionList,
    }),
  applyDreamSuggestion: (spaceId: string, id: string, body: ApplyDreamSuggestion) =>
    request('POST', `/spaces/${spaceId}/dream/suggestions/${id}/apply`, {
      body,
      schema: DreamApplied,
    }),
  rejectDreamSuggestion: (spaceId: string, id: string) =>
    request('POST', `/spaces/${spaceId}/dream/suggestions/${id}/reject`),
  startDream: (spaceId: string) =>
    request('POST', `/spaces/${spaceId}/dream/runs`, { schema: DreamQueued }),
  dreamRun: (spaceId: string, runId: string) =>
    request('GET', `/spaces/${spaceId}/dream/runs/${runId}`, { schema: DreamRunStatus }),
  dreamRuns: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/dream/runs`, { schema: DreamRunList }),
  // 自己在这个空间里的 Dream 设置（只有本人能看、能改）
  dreamSettings: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/me/dream`, { schema: DreamMemberSettings }),
  saveDreamSettings: (spaceId: string, body: DreamMemberSettings) =>
    request('PUT', `/spaces/${spaceId}/me/dream`, { body, schema: DreamMemberSettings }),
  groupPersonas: (spaceId: string, appId: string) =>
    request('GET', `/spaces/${spaceId}/apps/${appId}/group-personas`, {
      schema: GroupPersonaRuleList,
    }),
  saveGroupPersonas: (spaceId: string, appId: string, body: GroupPersonaRules) =>
    request('PUT', `/spaces/${spaceId}/apps/${appId}/group-personas`, {
      body,
      schema: GroupPersonaRuleList,
    }),
  // 变更记录：列表、按天计数与筛选计数用同一套筛选（多个值用逗号连起来，见 activity.ts 的 filterQuery）
  activity: (spaceId: string, filter: Record<string, string | undefined>, cursor?: string) =>
    request('GET', `/spaces/${spaceId}/activity`, {
      query: { ...filter, cursor },
      schema: ActivityList,
    }),
  activityDays: (spaceId: string, filter: Record<string, string | undefined>, tz: string) =>
    request('GET', `/spaces/${spaceId}/activity/days`, {
      query: { ...filter, tz },
      schema: ActivityDays,
    }),
  activityFacets: (spaceId: string, filter: Record<string, string | undefined>) =>
    request('GET', `/spaces/${spaceId}/activity/facets`, {
      query: filter,
      schema: ActivityFacets,
    }),
  activityEvent: (spaceId: string, eventId: number) =>
    request('GET', `/spaces/${spaceId}/activity/${eventId}`, { schema: ActivityEvent }),
  // 高级设置：实例默认（实例管理员）、空间的覆盖（成员可看，所有者可改）、应用的覆盖（应用所有者可改）
  instanceAdvanced: () => request('GET', '/settings/advanced', { schema: InstanceAdvancedView }),
  saveInstanceAdvanced: (body: UpdateInstanceAdvanced) =>
    request('PUT', '/settings/advanced', { body, schema: InstanceAdvancedView }),
  spaceAdvanced: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/settings/advanced`, { schema: SpaceAdvancedView }),
  saveSpaceAdvanced: (spaceId: string, body: UpdateSpaceAdvanced) =>
    request('PUT', `/spaces/${spaceId}/settings/advanced`, { body, schema: SpaceAdvancedView }),
  appAdvanced: (spaceId: string, appId: string) =>
    request('GET', `/spaces/${spaceId}/apps/${appId}/settings/advanced`, {
      schema: AppAdvancedView,
    }),
  saveAppAdvanced: (spaceId: string, appId: string, body: UpdateAppAdvanced) =>
    request('PUT', `/spaces/${spaceId}/apps/${appId}/settings/advanced`, {
      body,
      schema: AppAdvancedView,
    }),
  extractionBudget: (spaceId: string) =>
    request('GET', `/spaces/${spaceId}/extraction-budget`, { schema: ExtractionUsage }),
  saveExtractionBudget: (spaceId: string, body: ExtractionBudget) =>
    request('PUT', `/spaces/${spaceId}/extraction-budget`, { body, schema: ExtractionUsage }),
  // 导出文件是用口令加密的二进制文件，整个下载下来交给浏览器保存
  exportSpace: (spaceId: string, passphrase: string) =>
    download('POST', `/spaces/${spaceId}/export`, { passphrase }),
  // 导入之前先检查：是谁导出的、有多少，导入后哪些归你；不写库
  inspectSpaceImport: (file: File, passphrase: string) => {
    const form = new FormData()
    form.set('file', file)
    form.set('passphrase', passphrase)
    return request('POST', '/spaces/import/inspect', { body: form, schema: SpaceImportPreview })
  },
  importSpace: (file: File, passphrase: string, name: string) => {
    const form = new FormData()
    form.set('file', file)
    form.set('passphrase', passphrase)
    if (name.trim()) form.set('name', name.trim())
    return request('POST', '/spaces/import', { body: form, schema: SpaceImportResult })
  },
  lorePlan: (spaceId: string, body: LoreImportPlanRequest) =>
    request('POST', `/spaces/${spaceId}/lore-import/plan`, { body, schema: LoreImportPlan }),
  loreApply: (spaceId: string, body: LoreImportApplyRequest) =>
    request('POST', `/spaces/${spaceId}/lore-import/apply`, { body, schema: LoreImportResult }),

  embeddingSettings: () => request('GET', '/settings/embedding', { schema: EmbeddingSettingsView }),
  saveEmbeddingSettings: (body: UpdateEmbeddingSettings) =>
    request('PUT', '/settings/embedding', { body, schema: EmbeddingSettingsView }),
  saveNextEmbedding: (body: UpdateEmbeddingSettings) =>
    request('PUT', '/settings/embedding/next', { body, schema: EmbeddingSettingsView }),
  abortNextEmbedding: () => request('DELETE', '/settings/embedding/next'),
  retryNextEmbedding: () =>
    request('POST', '/settings/embedding/next/retry', { schema: EmbeddingRebuildResult }),
  switchEmbedding: () =>
    request('POST', '/settings/embedding/switch', { schema: EmbeddingSettingsView }),
  testEmbedding: () => request('POST', '/settings/embedding/test', { schema: EmbeddingTestResult }),
  embeddingStatus: () => request('GET', '/settings/embedding/status', { schema: EmbeddingStatus }),
  rebuildEmbeddings: () =>
    request('POST', '/settings/embedding/rebuild', { schema: EmbeddingRebuildResult }),

  masterKeyStatus: () => request('GET', '/settings/master-key', { schema: MasterKeyStatus }),

  retentionSettings: () => request('GET', '/settings/retention', { schema: RetentionView }),
  saveRetentionDays: (body: RetentionSettings) =>
    request('PUT', '/settings/retention', { body, schema: RetentionView }),
  resumeRetention: () =>
    request('POST', '/settings/retention/resume', { schema: RetentionResumed }),

  extractionSettings: () =>
    request('GET', '/settings/extraction', { schema: ExtractionSettingsView }),
  saveExtractionSettings: (body: UpdateExtractionSettings) =>
    request('PUT', '/settings/extraction', { body, schema: ExtractionSettingsView }),
  clearExtractionSettings: () => request('DELETE', '/settings/extraction'),
  testExtraction: () =>
    request('POST', '/settings/extraction/test', { schema: ExtractionTestResult }),

  backupSettings: () => request('GET', '/settings/backup', { schema: BackupSettingsView }),
  saveBackupSettings: (body: UpdateBackupSettings) =>
    request('PUT', '/settings/backup', { body, schema: BackupSettingsView }),
  clearBackupSettings: () => request('DELETE', '/settings/backup'),
  testBackup: () => request('POST', '/settings/backup/test', { schema: BackupTestResult }),
  runBackup: () => request('POST', '/settings/backup/run', { schema: BackupQueued }),
  backupRun: (runId: string) =>
    request('GET', `/settings/backup/runs/${runId}`, { schema: BackupRunStatus }),
  backupObjects: () => request('GET', '/settings/backup/objects', { schema: BackupObjectList }),

  // 账号：个人的资料、密码与登录设备；设置密码链接（不用登录）；实例管理员管理账号
  updateProfile: (displayName: string) =>
    request('PATCH', '/auth/profile', { body: { displayName }, schema: Me }),
  changePassword: (body: ChangePasswordRequest) => request('POST', '/auth/password', { body }),
  loginSessions: () => request('GET', '/auth/sessions', { schema: LoginSessionList }),
  signOutSession: (sessionId: string) => request('DELETE', `/auth/sessions/${sessionId}`),
  signOutOtherSessions: () => request('POST', '/auth/sessions/sign-out-others'),
  inspectPasswordLink: (token: string) =>
    request('POST', '/auth/password-link/inspect', { body: { token }, schema: PasswordLinkInfo }),
  usePasswordLink: (token: string, password: string) =>
    request('POST', '/auth/password-link', { body: { token, password }, schema: Me }),
  accounts: () => request('GET', '/instance/accounts', { schema: AdminAccountList }),
  createAccount: (body: CreateAccountRequest) =>
    request('POST', '/instance/accounts', { body, schema: CreatedAccount }),
  regenerateAccountLink: (accountId: string) =>
    request('POST', `/instance/accounts/${accountId}/link`, { schema: AccountLink }),
  updateAccount: (accountId: string, body: UpdateAccountRequest) =>
    request('PATCH', `/instance/accounts/${accountId}`, { body, schema: AdminAccount }),

  // 浏览器授权的确认页：都是点了才发的 POST，确认码在请求体里，不进地址，也不进 useQuery 的缓存
  lookupDeviceGrant: (userCode: string) =>
    request('POST', '/device/grants/lookup', { body: { userCode }, schema: DeviceGrantInfo }),
  approveDeviceGrant: (body: DeviceGrantApprove) =>
    request('POST', '/device/grants/approve', { body, schema: DeviceGrantApproved }),
  denyDeviceGrant: (userCode: string) =>
    request('POST', '/device/grants/deny', { body: { userCode } }),
}
