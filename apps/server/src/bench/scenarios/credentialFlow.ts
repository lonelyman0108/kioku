import type { BenchScenarioInput } from '@kioku/contracts'

import { runUri, SECRET_WRITE } from './shared'

const IDENTIFIER = 'bench-${run}'
const LOGIN = runUri('login')

// 凭据流程：只有 secret 级的 Key 能通过 Key 管理凭据。只断言报错与否和元数据，不断言值：
// 进程内不解密，命令行取值是一次真实调用
export const credentialFlow: BenchScenarioInput = {
  id: 'credential-flow',
  title: '凭据流程',
  description: '新建托管的凭据、列出、取用、在记忆里引用，被引用时不能删，去掉引用之后修改并删除。',
  steps: [
    {
      kind: 'tool',
      label: '新建',
      tool: 'kioku_credential_save',
      arguments: {
        identifier: IDENTIFIER,
        name: '测试台的凭据',
        description: '测试台的凭据流程写下的，值不是真的',
        values: { password: 'bench-not-a-real-value' },
      },
      requires: SECRET_WRITE,
      expect: { error: false, contains: ['已新建凭据', '字段 password', '版本 1'] },
      capture: { version: '版本 ' },
    },
    {
      kind: 'tool',
      label: '列出',
      tool: 'kioku_credential',
      requires: SECRET_WRITE,
      expect: { error: false, contains: [IDENTIFIER] },
    },
    {
      kind: 'tool',
      label: '取用',
      tool: 'kioku_credential',
      arguments: { identifier: IDENTIFIER, field: 'password' },
      requires: SECRET_WRITE,
      expect: { error: false, contains: [IDENTIFIER, '来源：Kioku 托管'] },
    },
    {
      kind: 'tool',
      label: '在记忆里引用',
      tool: 'kioku_create',
      arguments: {
        uri: LOGIN,
        content: `测试台的登录说明，密码 {{cred:${IDENTIFIER}#password}}。`,
        layer: 'private',
        priority: 2,
      },
      requires: SECRET_WRITE,
      expect: { error: false },
    },
    {
      kind: 'tool',
      label: '读记忆时列出引用的凭据',
      tool: 'kioku_get',
      arguments: { uri: LOGIN },
      requires: SECRET_WRITE,
      expect: { error: false, contains: ['正文里引用的凭据', IDENTIFIER] },
    },
    {
      kind: 'tool',
      label: '被引用时不能删',
      tool: 'kioku_credential_delete',
      arguments: { identifier: IDENTIFIER },
      requires: SECRET_WRITE,
      expect: { error: true, contains: ['引用'] },
    },
    {
      kind: 'tool',
      label: '删掉引用它的记忆',
      tool: 'kioku_delete',
      arguments: { uri: LOGIN },
      requires: SECRET_WRITE,
      expect: { error: false },
    },
    {
      kind: 'tool',
      label: '修改说明',
      tool: 'kioku_credential_save',
      arguments: {
        identifier: IDENTIFIER,
        description: '测试台改过的说明',
        expected_version: '${version}',
      },
      requires: SECRET_WRITE,
      expect: { error: false, contains: ['已修改凭据', '版本 2'] },
      capture: { version: '版本 ' },
    },
    {
      kind: 'tool',
      label: '删除',
      tool: 'kioku_credential_delete',
      arguments: { identifier: IDENTIFIER, expected_version: '${version}' },
      requires: SECRET_WRITE,
      expect: { error: false },
    },
    {
      kind: 'tool',
      label: '删掉之后取不到',
      tool: 'kioku_credential',
      arguments: { identifier: IDENTIFIER },
      requires: SECRET_WRITE,
      expect: { error: true, contains: ['不存在'] },
    },
  ],
}
