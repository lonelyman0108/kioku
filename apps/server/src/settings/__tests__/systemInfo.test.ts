import { describe, expect, it } from 'vitest'

import { detectContainer, diagnosticsText } from '../systemInfo'

describe('诊断信息', () => {
  it('分组与说法和页面一样，不含库名、主机与主密钥标识', () => {
    const text = diagnosticsText({
      build: { version: '0.1.0', commit: 'a'.repeat(40), builtAt: '2026-11-12T00:00:00.000Z' },
      runtime: {
        node: 'v22.0.0',
        platform: 'linux',
        arch: 'arm64',
        osRelease: '6.1.0',
        container: 'unknown',
        startedAt: '2026-11-12T00:00:00.000Z',
        uptimeSeconds: 90,
      },
      database: {
        version: '17.2',
        pgvector: '0.8.0',
        zhparser: null,
        migration: '0006_device_grants',
        name: 'hidden_db_name',
        host: 'db.internal.example.com:5432',
      },
      config: {
        masterKey: { configured: true, id: '0123456789abcdef', rotating: true },
        cookieSecure: false,
        trustedProxies: 1,
        webUi: 'served',
        jobs: true,
        embedding: false,
        extraction: true,
      },
      updates: {
        enabled: false,
        applicable: true,
        checking: false,
        checkedAt: null,
        attemptedAt: null,
        failed: false,
        latest: null,
        available: null,
      },
    })
    for (const line of [
      '[构建]',
      '版本：0.1.0',
      '[运行环境]',
      '系统：linux 6.1.0（arm64）',
      '容器：无法判断',
      '已运行：1 分钟',
      'zhparser：未安装',
      '主密钥：已配置，轮换中',
      'Cookie：允许 HTTP',
      '受信代理：1',
      '管理界面：已托管',
    ]) {
      expect(text).toContain(line)
    }
    for (const hidden of ['hidden_db_name', 'db.internal.example.com', '0123456789abcdef']) {
      expect(text).not.toContain(hidden)
    }
  })
})

describe('在不在容器里', () => {
  const probe = (files: Record<string, string>, env: Record<string, string> = {}) => ({
    exists: (path: string) => path in files,
    read: (path: string) => files[path] ?? null,
    env,
    platform: 'linux',
  })
  const overlayRoot =
    '1234 1200 0:52 / / rw,relatime master:1 - overlay overlay rw,lowerdir=/x\n1235 1234 0:53 / /proc rw - proc proc rw'
  const ext4Root = '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw'

  it('留下的标记文件、Kubernetes 的环境变量、旧版 cgroup 的路径、overlay 的根目录都算在容器里', () => {
    expect(detectContainer(probe({ '/.dockerenv': '' }))).toBe('yes')
    expect(detectContainer(probe({ '/run/.containerenv': '' }))).toBe('yes')
    expect(detectContainer(probe({}, { KUBERNETES_SERVICE_HOST: '10.0.0.1' }))).toBe('yes')
    expect(detectContainer(probe({ '/proc/1/cgroup': '12:pids:/docker/abc' }))).toBe('yes')
    expect(
      detectContainer(probe({ '/proc/1/cgroup': '0::/', '/proc/self/mountinfo': overlayRoot })),
    ).toBe('yes')
  })

  it('1 号进程是 systemd 或 init 时是宿主机；统一层级的 cgroup 下别的都看不出时说判断不了', () => {
    const host = {
      '/proc/1/cgroup': '0::/init.scope',
      '/proc/self/mountinfo': ext4Root,
      '/proc/1/sched': 'systemd (1, #threads: 1)\n----',
    }
    expect(detectContainer(probe(host))).toBe('no')
    expect(
      detectContainer(
        probe({
          '/proc/1/cgroup': '0::/',
          '/proc/self/mountinfo': ext4Root,
          '/proc/1/sched': 'node (1, #threads: 11)',
        }),
      ),
    ).toBe('unknown')
    expect(detectContainer({ ...probe({}), platform: 'darwin' })).toBe('no')
  })
})
