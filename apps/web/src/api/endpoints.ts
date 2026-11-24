import {
  ActivityDays,
  ActivityEvent,
  ActivityFacets,
  ActivityList,
  AdminAccount,
  AdminAccountList,
  AdminCircleList,
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
  CircleAdvancedView,
  CircleDetail,
  CircleImportPreview,
  CircleImportResult,
  CircleInfo,
  CircleLimitView,
  CircleMember,
  CircleMemberList,
  CircleOverview,
  CirclePrivacySettings,
  ClientAdvancedView,
  ClientGroupRuleList,
  ClientInfo,
  ConsoleCredential,
  ConsoleCredentialList,
  ConsoleEntryView,
  ConsoleSearchResponse,
  ConversationDetail,
  ConversationList,
  ConvertedToCredential,
  CreatedAccount,
  CreatedCircle,
  CreatedCredential,
  CredentialEventList,
  CredentialReferenceList,
  CredentialValueMatches,
  CredentialValues,
  DatabaseCheck,
  DatabaseConnected,
  DatabaseInspection,
  DeletedCredentialList,
  DeletedEntryList,
  DeviceGrantApproved,
  DeviceGrantInfo,
  DreamApplied,
  DreamBindingView,
  DreamMemberSettings,
  DreamQueued,
  DreamRunList,
  DreamRunStatus,
  DreamSuggestionList,
  EmbeddingRebuildResult,
  EmbeddingSettingsView,
  EmbeddingStatus,
  EmbeddingTestResult,
  EntryBrowseResponse,
  EntryHistory,
  EntryList,
  EntryRecallStat,
  ExpiredEntryList,
  ExtractionBindingView,
  ExtractionUsage,
  FacetDimensionView,
  FacetTermView,
  FacetVocabularyView,
  GlossaryIndex,
  HealthResponse,
  InboxCounts,
  InstanceAdvancedView,
  IssuedKey,
  KeyAccessMatrix,
  KeyInfo,
  LegacyUpgradeRequest,
  LegacyUpgradeResult,
  LegacyUpgradeStatus,
  LoginSessionList,
  LoreImportPlan,
  LoreImportResult,
  MasterKeyStatus,
  Me,
  ModelChainTestResult,
  ModelProfileTestResult,
  ModelProviderView,
  ModelRegistryView,
  AccountLink,
  PasswordLinkInfo,
  PersonaDetail,
  PersonaInfo,
  PersonaTrait,
  PrivacyBindingView,
  RecallDebug,
  RecallEventList,
  RecallSettings,
  RecallStats,
  RetentionResumed,
  RetentionView,
  ReviewList,
  ReviewResult,
  SetupStatus,
  SubjectDetail,
  SubjectInfo,
  SubjectList,
  SystemInfo,
  VaultCheckResult,
  VaultConnectResult,
  VaultConnection,
  VaultConnectionList,
  VaultItemList,
  type AddCircleMemberRequest,
  type ApplyDreamSuggestion,
  type BenchAgentTurnRequest,
  type BenchRunRequest,
  type BootPreviewRequest,
  type BrowseGroupBy,
  type ChangePasswordRequest,
  type ClientGroupRules,
  type ConnectVaultRequest,
  type ConsoleCreateEntryRequest,
  type ConsoleTransferEntryRequest,
  type ConsoleUpdateEntryRequest,
  type ConversationListQuery,
  type ConvertToCredentialRequest,
  type CreateAccountRequest,
  type CreateCircleRequest,
  type CreateClientRequest,
  type CreateCredentialRequest,
  type CreateFacetDimensionRequest,
  type CreateFacetTermRequest,
  type CreateKeyRequest,
  type CreatePersonaRequest,
  type CredentialListQuery,
  type DatabaseCheckRequest,
  type DatabaseProvisionRequest,
  type DeviceGrantApprove,
  type EntryKind,
  type EntryListQuery,
  type ExtractionBudget,
  type LoreImportApplyRequest,
  type LoreImportPlanRequest,
  type MatchCredentialValuesRequest,
  type MemberRole,
  type PlaintextIgnoreRequest,
  type PromoteFactRequest,
  type ProtectEntryRequest,
  type ReactivateRequest,
  type RecallDebugRequest,
  type ReconnectVaultRequest,
  type RedactEntryRequest,
  type RestoreRequest,
  type RetentionSettings,
  type ReviewQuery,
  type ReviewRequest,
  type RotateKeyRequest,
  type SetVaultDestinationRequest,
  type SetupRequest,
  type SubjectListQuery,
  type UpdateAccountRequest,
  type UpdateBackupSettings,
  type UpdateCircleAdvanced,
  type UpdateCirclePrivacySettings,
  type UpdateCircleRequest,
  type UpdateClientAdvanced,
  type UpdateClientRequest,
  type UpdateCredentialRequest,
  type UpdateDreamBinding,
  type UpdateEmbeddingSettings,
  type UpdateExtractionBinding,
  type UpdateFacetDimensionRequest,
  type UpdateFacetTermRequest,
  type UpdateInstanceAdvanced,
  type UpdatePersonaRequest,
  type UpdatePrivacyBinding,
  type UpdateSubjectRequest,
  type UpsertModelProvider,
  type UpsertPersonaTraitRequest,
} from '@kioku/contracts'
import { z } from 'zod'

import { download, request } from './client'

export const api = {
  health: () => request('GET', '/health', { schema: HealthResponse }),

  setupStatus: () => request('GET', '/setup/status', { schema: SetupStatus }),
  setup: (body: SetupRequest) => request('POST', '/setup', { body, schema: Me }),
  // 初始化的数据库这一步：都带初始化码，放在请求体里
  inspectDatabase: (setupCode: string) =>
    request('POST', '/setup/database/inspect', {
      body: { setupCode },
      schema: DatabaseInspection,
    }),
  checkDatabase: (body: DatabaseCheckRequest) =>
    request('POST', '/setup/database/check', { body, schema: DatabaseCheck }),
  connectDatabase: (body: DatabaseCheckRequest) =>
    request('POST', '/setup/database', { body, schema: DatabaseConnected }),
  provisionDatabase: (body: DatabaseProvisionRequest) =>
    request('POST', '/setup/database/provision', { body, schema: DatabaseConnected }),
  legacyUpgradeStatus: () =>
    request('GET', '/legacy-upgrade/status', { schema: LegacyUpgradeStatus }),
  previewLegacyUpgrade: (body: LegacyUpgradeRequest) =>
    request('POST', '/legacy-upgrade/preview', { body, schema: LegacyUpgradeResult }),
  applyLegacyUpgrade: (body: LegacyUpgradeRequest) =>
    request('POST', '/legacy-upgrade/apply', { body, schema: LegacyUpgradeResult }),
  login: (username: string, password: string) =>
    request('POST', '/auth/login', { body: { username, password }, schema: Me }),
  logout: () => request('POST', '/auth/logout'),
  me: () => request('GET', '/auth/me', { schema: Me }),

  // 记忆圈与成员
  circle: (circleId: string) => request('GET', `/circles/${circleId}`, { schema: CircleDetail }),
  updateCircle: (circleId: string, body: UpdateCircleRequest) =>
    request('PATCH', `/circles/${circleId}`, { body, schema: CircleInfo }),
  renameCircle: (circleId: string, name: string) =>
    request('PATCH', `/circles/${circleId}`, { body: { name }, schema: CircleInfo }),
  deleteCircle: (circleId: string, confirmName: string) =>
    request('DELETE', `/circles/${circleId}`, { body: { confirmName } }),
  createCircle: (body: Partial<CreateCircleRequest> & Pick<CreateCircleRequest, 'name'>) =>
    request('POST', '/circles', { body, schema: CreatedCircle }),
  members: async (circleId: string) =>
    (await request('GET', `/circles/${circleId}/members`, { schema: CircleMemberList })).members,
  addMember: (circleId: string, body: AddCircleMemberRequest) =>
    request('POST', `/circles/${circleId}/members`, { body, schema: CircleMember }),
  updateMember: (circleId: string, accountId: string, role: MemberRole) =>
    request('PATCH', `/circles/${circleId}/members/${accountId}`, {
      body: { role },
      schema: CircleMember,
    }),
  removeMember: (circleId: string, accountId: string) =>
    request('DELETE', `/circles/${circleId}/members/${accountId}`),
  transferOwnership: async (circleId: string, accountId: string) =>
    (
      await request('POST', `/circles/${circleId}/transfer-ownership`, {
        body: { accountId },
        schema: CircleMemberList,
      })
    ).members,
  instanceCircles: async () =>
    (await request('GET', '/instance/circles', { schema: AdminCircleList })).circles,
  circleLimit: () => request('GET', '/instance/circle-limit', { schema: CircleLimitView }),
  saveCircleLimit: (maxOwnedCircles: number) =>
    request('PUT', '/instance/circle-limit', {
      body: { maxOwnedCircles },
      schema: CircleLimitView,
    }),
  systemInfo: () => request('GET', '/instance/system', { schema: SystemInfo }),
  saveUpdateCheck: (enabled: boolean) =>
    request('PUT', '/instance/update-check', { body: { enabled }, schema: SystemInfo }),

  // 切面词表
  facets: (circleId: string) =>
    request('GET', `/circles/${circleId}/facets`, { schema: FacetVocabularyView }),
  createFacetDimension: (
    circleId: string,
    body: Partial<CreateFacetDimensionRequest> & Pick<CreateFacetDimensionRequest, 'key' | 'name'>,
  ) =>
    request('POST', `/circles/${circleId}/facets/dimensions`, { body, schema: FacetDimensionView }),
  updateFacetDimension: (circleId: string, key: string, body: UpdateFacetDimensionRequest) =>
    request('PATCH', `/circles/${circleId}/facets/dimensions/${encodeURIComponent(key)}`, {
      body,
      schema: FacetDimensionView,
    }),
  deleteFacetDimension: (circleId: string, key: string) =>
    request('DELETE', `/circles/${circleId}/facets/dimensions/${encodeURIComponent(key)}`),
  createFacetTerm: (
    circleId: string,
    body: Partial<CreateFacetTermRequest> &
      Pick<CreateFacetTermRequest, 'dimensionKey' | 'slug' | 'label'>,
  ) => request('POST', `/circles/${circleId}/facets/terms`, { body, schema: FacetTermView }),
  updateFacetTerm: (circleId: string, termId: string, body: UpdateFacetTermRequest) =>
    request('PATCH', `/circles/${circleId}/facets/terms/${termId}`, {
      body,
      schema: FacetTermView,
    }),
  deleteFacetTerm: (circleId: string, termId: string) =>
    request('DELETE', `/circles/${circleId}/facets/terms/${termId}`),

  // 独立人格与设定段
  personas: (circleId: string) =>
    request('GET', `/circles/${circleId}/personas`, { schema: z.array(PersonaInfo) }),
  createPersona: (
    circleId: string,
    body: Partial<CreatePersonaRequest> & Pick<CreatePersonaRequest, 'slug' | 'name'>,
  ) => request('POST', `/circles/${circleId}/personas`, { body, schema: PersonaInfo }),
  persona: (circleId: string, personaId: string) =>
    request('GET', `/circles/${circleId}/personas/${personaId}`, { schema: PersonaDetail }),
  updatePersona: (circleId: string, personaId: string, body: UpdatePersonaRequest) =>
    request('PATCH', `/circles/${circleId}/personas/${personaId}`, { body, schema: PersonaInfo }),
  deletePersona: (circleId: string, personaId: string) =>
    request('DELETE', `/circles/${circleId}/personas/${personaId}`),
  upsertPersonaTrait: (circleId: string, personaId: string, body: UpsertPersonaTraitRequest) =>
    request('PUT', `/circles/${circleId}/personas/${personaId}/traits`, {
      body,
      schema: PersonaTrait,
    }),
  deletePersonaTrait: (circleId: string, personaId: string, traitKey: string) =>
    request(
      'DELETE',
      `/circles/${circleId}/personas/${personaId}/traits/${encodeURIComponent(traitKey)}`,
    ),

  // 接入实例、按群规则与访问密钥
  clients: (circleId: string) =>
    request('GET', `/circles/${circleId}/clients`, { schema: z.array(ClientInfo) }),
  createClient: (
    circleId: string,
    body: Partial<CreateClientRequest> &
      Pick<CreateClientRequest, 'slug' | 'name' | 'runtimeFamily'>,
  ) => request('POST', `/circles/${circleId}/clients`, { body, schema: ClientInfo }),
  updateClient: (circleId: string, clientId: string, body: UpdateClientRequest) =>
    request('PATCH', `/circles/${circleId}/clients/${clientId}`, { body, schema: ClientInfo }),
  deleteClient: (circleId: string, clientId: string) =>
    request('DELETE', `/circles/${circleId}/clients/${clientId}`),
  clientGroupRules: (circleId: string, clientId: string) =>
    request('GET', `/circles/${circleId}/clients/${clientId}/group-rules`, {
      schema: ClientGroupRuleList,
    }),
  saveClientGroupRules: (circleId: string, clientId: string, body: ClientGroupRules) =>
    request('PUT', `/circles/${circleId}/clients/${clientId}/group-rules`, {
      body,
      schema: ClientGroupRuleList,
    }),
  keys: (circleId: string, clientId: string) =>
    request('GET', `/circles/${circleId}/clients/${clientId}/keys`, { schema: z.array(KeyInfo) }),
  createKey: (circleId: string, clientId: string, body: CreateKeyRequest) =>
    request('POST', `/circles/${circleId}/clients/${clientId}/keys`, { body, schema: IssuedKey }),
  rotateKey: (circleId: string, clientId: string, keyId: string, body: RotateKeyRequest = {}) =>
    request('POST', `/circles/${circleId}/clients/${clientId}/keys/${keyId}/rotate`, {
      body,
      schema: IssuedKey,
    }),
  revokeKey: (circleId: string, clientId: string, keyId: string) =>
    request('DELETE', `/circles/${circleId}/clients/${clientId}/keys/${keyId}`),
  keyMatrix: (circleId: string, clientId: string, keyId: string) =>
    request('GET', `/circles/${circleId}/clients/${clientId}/keys/${keyId}/matrix`, {
      schema: KeyAccessMatrix,
    }),
  bootPreview: (circleId: string, clientId: string, keyId: string, body: BootPreviewRequest) =>
    request('POST', `/circles/${circleId}/clients/${clientId}/keys/${keyId}/preview`, {
      body,
      schema: BootPreview,
    }),
  recallDebug: (
    circleId: string,
    clientId: string,
    keyId: string,
    body: Partial<RecallDebugRequest> & Pick<RecallDebugRequest, 'query'>,
  ) =>
    request('POST', `/circles/${circleId}/clients/${clientId}/keys/${keyId}/debug`, {
      body,
      schema: RecallDebug,
    }),
  benchTools: (circleId: string, clientId: string, keyId: string) =>
    request('GET', `/circles/${circleId}/clients/${clientId}/keys/${keyId}/bench/tools`, {
      schema: BenchToolList,
    }),
  benchRun: (circleId: string, clientId: string, keyId: string, body: BenchRunRequest) =>
    request('POST', `/circles/${circleId}/clients/${clientId}/keys/${keyId}/bench/run`, {
      body,
      schema: BenchRunResult,
    }),
  benchScenarios: (circleId: string) =>
    request('GET', `/circles/${circleId}/bench/scenarios`, { schema: BenchScenarioList }),
  benchAgent: (circleId: string, clientId: string, keyId: string) =>
    request('GET', `/circles/${circleId}/clients/${clientId}/keys/${keyId}/bench/agent`, {
      schema: BenchAgentInfo,
    }),
  benchAgentTurn: (
    circleId: string,
    clientId: string,
    keyId: string,
    body: BenchAgentTurnRequest,
    signal: AbortSignal,
  ) =>
    request('POST', `/circles/${circleId}/clients/${clientId}/keys/${keyId}/bench/agent/turn`, {
      body,
      schema: BenchAgentTurnResult,
      signal,
    }),

  // 召回分析
  recallStats: (circleId: string) =>
    request('GET', `/circles/${circleId}/recall/stats`, { schema: RecallStats }),
  recallEvents: (circleId: string, query: { clientId?: string; cursor?: string }) =>
    request('GET', `/circles/${circleId}/recall/events`, { query, schema: RecallEventList }),
  entryRecallStat: (circleId: string, entryId: string) =>
    request('GET', `/circles/${circleId}/recall/entry`, {
      query: { id: entryId },
      schema: EntryRecallStat,
    }),
  recallSettings: () => request('GET', '/settings/recall', { schema: RecallSettings }),
  saveRecallSettings: (body: RecallSettings) =>
    request('PUT', '/settings/recall', { body, schema: RecallSettings }),

  // 词条（记忆）与变体切片
  entry: (circleId: string, id: string, query?: { circle?: string; allVariants?: boolean }) =>
    request('GET', `/circles/${circleId}/entries`, {
      query: {
        id,
        circle: query?.circle,
        allVariants: query?.allVariants === undefined ? undefined : String(query.allVariants),
      },
      schema: ConsoleEntryView,
    }),
  // 显式查看机密的正文（记一次访问）。结果不要放进 useQuery 的缓存，见 secretContent.ts
  revealEntry: (circleId: string, entryId: string) =>
    request('POST', `/circles/${circleId}/entries/reveal`, {
      body: { entryId },
      schema: ConsoleEntryView,
    }),
  browseEntries: (
    circleId: string,
    query: {
      groupBy?: BrowseGroupBy
      circle?: string
      kind?: EntryKind
      topic?: string
      query?: string
      limit?: number
    } = {},
  ) =>
    request('GET', `/circles/${circleId}/entries/browse`, { query, schema: EntryBrowseResponse }),
  createEntry: (circleId: string, body: Partial<ConsoleCreateEntryRequest>) =>
    request('POST', `/circles/${circleId}/entries`, { body, schema: ConsoleEntryView }),
  updateEntry: (circleId: string, body: ConsoleUpdateEntryRequest) =>
    request('PATCH', `/circles/${circleId}/entries`, { body, schema: ConsoleEntryView }),
  deleteEntry: (circleId: string, id: string, expectedVersion?: number) =>
    request('DELETE', `/circles/${circleId}/entries`, { query: { id, expectedVersion } }),
  transferEntry: (circleId: string, body: ConsoleTransferEntryRequest) =>
    request('POST', `/circles/${circleId}/entries/transfer`, { body, schema: ConsoleEntryView }),
  // 列表的筛选都是可选的；查询参数原样是字符串或数字
  entryList: (circleId: string, query: Partial<Record<keyof EntryListQuery, string | number>>) =>
    request('GET', `/circles/${circleId}/entries/list`, { query, schema: EntryList }),
  searchEntries: (
    circleId: string,
    query: string,
    options?: number | { limit?: number; allCircles?: boolean },
  ) => {
    const opts = typeof options === 'number' ? { limit: options } : (options ?? {})
    const body: Record<string, unknown> = { query }
    if (opts.limit !== undefined) body.limit = opts.limit
    if (opts.allCircles !== undefined) body.allCircles = opts.allCircles
    return request('POST', `/circles/${circleId}/entries/search`, {
      body,
      schema: ConsoleSearchResponse,
    })
  },
  glossaryIndex: (circleId: string) =>
    request('GET', `/circles/${circleId}/entries/glossary`, { schema: GlossaryIndex }),
  entryHistory: (circleId: string, id: string) =>
    request('GET', `/circles/${circleId}/entries/history`, { query: { id }, schema: EntryHistory }),
  deletedEntries: (circleId: string, cursor?: string) =>
    request('GET', `/circles/${circleId}/entries/deleted`, {
      query: { cursor },
      schema: DeletedEntryList,
    }),
  restoreEntry: (circleId: string, body: RestoreRequest) =>
    request('POST', `/circles/${circleId}/entries/restore`, { body, schema: ConsoleEntryView }),
  undeleteEntry: (circleId: string, entryId: string) =>
    request('POST', `/circles/${circleId}/entries/undelete`, {
      body: { entryId },
      schema: ConsoleEntryView,
    }),
  expiredEntries: (circleId: string, cursor?: string) =>
    request('GET', `/circles/${circleId}/entries/expired`, {
      query: { cursor },
      schema: ExpiredEntryList,
    }),
  reactivateEntry: (circleId: string, body: ReactivateRequest) =>
    request('POST', `/circles/${circleId}/entries/reactivate`, { body, schema: ConsoleEntryView }),
  ignorePlaintext: (circleId: string, body: PlaintextIgnoreRequest) =>
    request('POST', `/circles/${circleId}/entries/ignore-plaintext`, {
      body,
      schema: ConsoleEntryView,
    }),
  unignorePlaintext: (circleId: string, body: PlaintextIgnoreRequest) =>
    request('POST', `/circles/${circleId}/entries/unignore-plaintext`, {
      body,
      schema: ConsoleEntryView,
    }),
  redactEntry: (circleId: string, body: RedactEntryRequest) =>
    request('POST', `/circles/${circleId}/entries/redact`, {
      body,
      schema: ConsoleEntryView,
    }),
  protectEntry: (circleId: string, body: ProtectEntryRequest) =>
    request('POST', `/circles/${circleId}/entries/protect`, {
      body,
      schema: ConsoleEntryView,
    }),
  convertToCredential: (circleId: string, body: ConvertToCredentialRequest) =>
    request('POST', `/circles/${circleId}/entries/convert-to-credential`, {
      body,
      schema: ConvertedToCredential,
    }),

  // attention：只列待处理的「凭据」一类（快到期、已到期、需要轮换），和条数同一个条件
  credentials: (circleId: string, query: CredentialListQuery = {}) =>
    request('GET', `/circles/${circleId}/credentials`, {
      query: { attention: query.attention },
      schema: ConsoleCredentialList,
    }),
  // 按值查找同值的凭据与密码库条目：值只在请求体里，结果不进缓存
  matchCredentialValues: (circleId: string, body: MatchCredentialValuesRequest) =>
    request('POST', `/circles/${circleId}/credentials/match`, {
      body,
      schema: CredentialValueMatches,
    }),
  deletedCredentials: (circleId: string) =>
    request('GET', `/circles/${circleId}/credentials/deleted`, { schema: DeletedCredentialList }),
  credential: (circleId: string, id: string) =>
    request('GET', `/circles/${circleId}/credentials/${id}`, { schema: ConsoleCredential }),
  createCredential: (circleId: string, body: CreateCredentialRequest) =>
    request('POST', `/circles/${circleId}/credentials`, { body, schema: CreatedCredential }),
  updateCredential: (circleId: string, id: string, body: UpdateCredentialRequest) =>
    request('PATCH', `/circles/${circleId}/credentials/${id}`, { body, schema: ConsoleCredential }),
  deleteCredential: (circleId: string, id: string, expectedVersion: number) =>
    request('DELETE', `/circles/${circleId}/credentials/${id}`, { query: { expectedVersion } }),
  undeleteCredential: (circleId: string, id: string) =>
    request('POST', `/circles/${circleId}/credentials/${id}/undelete`, {
      schema: ConsoleCredential,
    }),
  revealCredential: (circleId: string, id: string) =>
    request('POST', `/circles/${circleId}/credentials/${id}/reveal`, { schema: CredentialValues }),
  // sinceValueChange：只列上次改值以来交出值的访问事件
  credentialEvents: (circleId: string, id: string, cursor?: string, sinceValueChange = false) =>
    request('GET', `/circles/${circleId}/credentials/${id}/events`, {
      query: { cursor, sinceValueChange: sinceValueChange ? 'true' : undefined },
      schema: CredentialEventList,
    }),
  credentialReferences: (circleId: string, id: string) =>
    request('GET', `/circles/${circleId}/credentials/${id}/references`, {
      schema: CredentialReferenceList,
    }),
  // 密码库连接：只给连接的所有者。主密码只在请求体里，不进缓存
  vaultConnections: (circleId: string) =>
    request('GET', `/circles/${circleId}/vault-connections`, { schema: VaultConnectionList }),
  connectVault: (circleId: string, body: ConnectVaultRequest) =>
    request('POST', `/circles/${circleId}/vault-connections`, { body, schema: VaultConnectResult }),
  reconnectVault: (circleId: string, id: string, body: ReconnectVaultRequest) =>
    request('POST', `/circles/${circleId}/vault-connections/${id}/reconnect`, {
      body,
      schema: VaultConnectResult,
    }),
  checkVault: (circleId: string, id: string) =>
    request('POST', `/circles/${circleId}/vault-connections/${id}/check`, {
      schema: VaultCheckResult,
    }),
  disconnectVault: (circleId: string, id: string) =>
    request('POST', `/circles/${circleId}/vault-connections/${id}/disconnect`, {
      schema: VaultConnection,
    }),
  vaultItems: (circleId: string, id: string) =>
    request('GET', `/circles/${circleId}/vault-connections/${id}/items`, { schema: VaultItemList }),
  // 新凭据的去处：设在一个连接上，同一个成员别的连接上的去处一起清掉；响应是这个成员的全部连接
  setVaultDestination: (circleId: string, id: string, body: SetVaultDestinationRequest) =>
    request('PUT', `/circles/${circleId}/vault-connections/${id}/destination`, {
      body,
      schema: VaultConnectionList,
    }),
  clearVaultDestination: (circleId: string, id: string) =>
    request('DELETE', `/circles/${circleId}/vault-connections/${id}/destination`, {
      schema: VaultConnectionList,
    }),

  overview: (circleId: string) =>
    request('GET', `/circles/${circleId}/overview`, { schema: CircleOverview }),
  inboxCounts: (circleId: string) =>
    request('GET', `/circles/${circleId}/inbox/counts`, { schema: InboxCounts }),
  // 会话按最近活动从新到旧；按接入实例或联系人筛
  conversations: (circleId: string, query: ConversationListQuery) =>
    request('GET', `/circles/${circleId}/conversations`, { query, schema: ConversationList }),
  conversation: (circleId: string, id: string) =>
    request('GET', `/circles/${circleId}/conversations/${id}`, { schema: ConversationDetail }),
  subjects: (circleId: string, query: SubjectListQuery) =>
    request('GET', `/circles/${circleId}/subjects`, { query, schema: SubjectList }),
  subject: (circleId: string, id: string) =>
    request('GET', `/circles/${circleId}/subjects/${id}`, { schema: SubjectDetail }),
  updateSubject: (circleId: string, id: string, body: UpdateSubjectRequest) =>
    request('PATCH', `/circles/${circleId}/subjects/${id}`, { body, schema: SubjectInfo }),
  mergeSubject: (circleId: string, id: string, from: string) =>
    request('POST', `/circles/${circleId}/subjects/${id}/merge`, {
      body: { from },
      schema: SubjectInfo,
    }),
  deleteFact: (circleId: string, subjectId: string, factId: string, version: number) =>
    request('DELETE', `/circles/${circleId}/subjects/${subjectId}/facts/${factId}`, {
      query: { version },
    }),
  reactivateFact: (circleId: string, subjectId: string, factId: string, version: number) =>
    request('POST', `/circles/${circleId}/subjects/${subjectId}/facts/${factId}/reactivate`, {
      body: { version },
    }),
  promoteFact: (
    circleId: string,
    subjectId: string,
    factId: string,
    body: Partial<PromoteFactRequest> & Pick<PromoteFactRequest, 'targetCircleId'>,
  ) =>
    request('POST', `/circles/${circleId}/subjects/${subjectId}/facts/${factId}/promote`, {
      body,
      schema: ConsoleEntryView,
    }),
  confirmBinding: (circleId: string, bindingId: string) =>
    request('POST', `/circles/${circleId}/subject-bindings/${bindingId}/confirm`, {
      schema: SubjectInfo,
    }),
  rejectBinding: (circleId: string, bindingId: string) =>
    request('POST', `/circles/${circleId}/subject-bindings/${bindingId}/reject`),
  reviewQueue: (circleId: string, query: ReviewQuery = {}) =>
    request('GET', `/circles/${circleId}/review`, { query, schema: ReviewList }),
  review: (circleId: string, body: ReviewRequest) =>
    request('POST', `/circles/${circleId}/review`, { body, schema: ReviewResult }),
  dreamSuggestions: (circleId: string, cursor?: string) =>
    request('GET', `/circles/${circleId}/dream/suggestions`, {
      query: { cursor },
      schema: DreamSuggestionList,
    }),
  applyDreamSuggestion: (circleId: string, id: string, body: ApplyDreamSuggestion) =>
    request('POST', `/circles/${circleId}/dream/suggestions/${id}/apply`, {
      body,
      schema: DreamApplied,
    }),
  rejectDreamSuggestion: (circleId: string, id: string) =>
    request('POST', `/circles/${circleId}/dream/suggestions/${id}/reject`),
  startDream: (circleId: string) =>
    request('POST', `/circles/${circleId}/dream/runs`, { schema: DreamQueued }),
  dreamRun: (circleId: string, runId: string) =>
    request('GET', `/circles/${circleId}/dream/runs/${runId}`, { schema: DreamRunStatus }),
  dreamRuns: (circleId: string) =>
    request('GET', `/circles/${circleId}/dream/runs`, { schema: DreamRunList }),
  // 自己在这个记忆圈里的 Dream 设置（只有本人能看、能改）
  dreamSettings: (circleId: string) =>
    request('GET', `/circles/${circleId}/me/dream`, { schema: DreamMemberSettings }),
  saveDreamSettings: (circleId: string, body: DreamMemberSettings) =>
    request('PUT', `/circles/${circleId}/me/dream`, { body, schema: DreamMemberSettings }),

  // 变更记录：列表、按天计数与筛选计数用同一套筛选（多个值用逗号连起来，见 activity.ts 的 filterQuery）
  activity: (circleId: string, filter: Record<string, string | undefined>, cursor?: string) =>
    request('GET', `/circles/${circleId}/activity`, {
      query: { ...filter, cursor },
      schema: ActivityList,
    }),
  activityDays: (circleId: string, filter: Record<string, string | undefined>, tz: string) =>
    request('GET', `/circles/${circleId}/activity/days`, {
      query: { ...filter, tz },
      schema: ActivityDays,
    }),
  activityFacets: (circleId: string, filter: Record<string, string | undefined>) =>
    request('GET', `/circles/${circleId}/activity/facets`, {
      query: filter,
      schema: ActivityFacets,
    }),
  activityEvent: (circleId: string, eventId: number) =>
    request('GET', `/circles/${circleId}/activity/${eventId}`, { schema: ActivityEvent }),

  // 高级设置：实例默认（实例管理员）、记忆圈的覆盖（成员可看，所有者可改）、接入实例的覆盖（所有者可改）
  instanceAdvanced: () => request('GET', '/settings/advanced', { schema: InstanceAdvancedView }),
  saveInstanceAdvanced: (body: UpdateInstanceAdvanced) =>
    request('PUT', '/settings/advanced', { body, schema: InstanceAdvancedView }),
  circleAdvanced: (circleId: string) =>
    request('GET', `/circles/${circleId}/settings/advanced`, { schema: CircleAdvancedView }),
  saveCircleAdvanced: (circleId: string, body: UpdateCircleAdvanced) =>
    request('PUT', `/circles/${circleId}/settings/advanced`, { body, schema: CircleAdvancedView }),
  clientAdvanced: (circleId: string, clientId: string) =>
    request('GET', `/circles/${circleId}/clients/${clientId}/settings/advanced`, {
      schema: ClientAdvancedView,
    }),
  saveClientAdvanced: (circleId: string, clientId: string, body: UpdateClientAdvanced) =>
    request('PUT', `/circles/${circleId}/clients/${clientId}/settings/advanced`, {
      body,
      schema: ClientAdvancedView,
    }),
  extractionBudget: (circleId: string) =>
    request('GET', `/circles/${circleId}/extraction-budget`, { schema: ExtractionUsage }),
  saveExtractionBudget: (circleId: string, body: ExtractionBudget) =>
    request('PUT', `/circles/${circleId}/extraction-budget`, { body, schema: ExtractionUsage }),

  // 导出文件是用口令加密的二进制文件，整个下载下来交给浏览器保存
  exportCircle: (circleId: string, passphrase: string) =>
    download('POST', `/circles/${circleId}/export`, { passphrase }),
  // 导入之前先检查：是谁导出的、属于个人圈还是共享圈、有多少；不写库
  inspectCircleImport: (file: File, passphrase: string) => {
    const form = new FormData()
    form.set('file', file)
    form.set('passphrase', passphrase)
    return request('POST', '/circles/import/inspect', { body: form, schema: CircleImportPreview })
  },
  importCircle: (
    file: File,
    passphrase: string,
    options: { name?: string; intoPersonalCircle?: boolean } = {},
  ) => {
    const form = new FormData()
    form.set('file', file)
    form.set('passphrase', passphrase)
    if (options.name?.trim()) form.set('name', options.name.trim())
    if (options.intoPersonalCircle) form.set('intoPersonalCircle', 'true')
    return request('POST', '/circles/import', { body: form, schema: CircleImportResult })
  },
  lorePlan: (circleId: string, body: LoreImportPlanRequest) =>
    request('POST', `/circles/${circleId}/lore-import/plan`, { body, schema: LoreImportPlan }),
  loreApply: (circleId: string, body: LoreImportApplyRequest) =>
    request('POST', `/circles/${circleId}/lore-import/apply`, { body, schema: LoreImportResult }),

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

  modelRegistry: () => request('GET', '/settings/models', { schema: ModelRegistryView }),
  createModelProvider: (body: UpsertModelProvider) =>
    request('POST', '/settings/models/providers', { body, schema: ModelProviderView }),
  updateModelProvider: (providerId: string, body: UpsertModelProvider) =>
    request('PUT', `/settings/models/providers/${providerId}`, { body, schema: ModelProviderView }),
  deleteModelProvider: (providerId: string) =>
    request('DELETE', `/settings/models/providers/${providerId}`),
  testModelProfile: (profileId: string) =>
    request('POST', `/settings/models/profiles/${profileId}/test`, {
      schema: ModelProfileTestResult,
    }),

  saveExtractionBinding: (body: UpdateExtractionBinding) =>
    request('PUT', '/settings/models/bindings/extraction', {
      body,
      schema: ExtractionBindingView,
    }),
  testExtractionBinding: () =>
    request('POST', '/settings/models/bindings/extraction/test', { schema: ModelChainTestResult }),

  saveDreamBinding: (body: UpdateDreamBinding) =>
    request('PUT', '/settings/models/bindings/dream', { body, schema: DreamBindingView }),
  testDreamBinding: () =>
    request('POST', '/settings/models/bindings/dream/test', { schema: ModelChainTestResult }),

  savePrivacyBinding: (body: UpdatePrivacyBinding) =>
    request('PUT', '/settings/models/bindings/privacy', { body, schema: PrivacyBindingView }),
  testPrivacyBinding: () =>
    request('POST', '/settings/models/bindings/privacy/test', { schema: ModelChainTestResult }),

  circlePrivacy: (circleId: string) =>
    request('GET', `/circles/${circleId}/privacy`, { schema: CirclePrivacySettings }),
  saveCirclePrivacy: (circleId: string, body: UpdateCirclePrivacySettings) =>
    request('PUT', `/circles/${circleId}/privacy`, { body, schema: CirclePrivacySettings }),
  rescanCirclePrivacy: (circleId: string) =>
    request('POST', `/circles/${circleId}/privacy/rescan`, {
      schema: z.object({ queued: z.boolean(), updated: z.number().int().optional() }),
    }),

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
