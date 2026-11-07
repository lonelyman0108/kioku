import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 用官方 bw 命令行核对测试实例里的数据。bw 只连 https，所以在测试实例前面起一个本地的 TLS 代理（自签证书，用 openssl 生成）。
// bw 的数据目录每次新建（BITWARDENCLI_APPDATA_DIR），环境变量只给它需要的几个，不继承 BW_SESSION 之类的：
// 本机已有的 bw 登录状态一概不碰

export function bwAvailable(): boolean {
  try {
    execFileSync('bw', ['--version'], { stdio: 'ignore' })
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface TlsProxy {
  url: string
  caFile: string
  close(): Promise<void>
}

// 把 https://127.0.0.1:<随机端口> 转发到 upstream（http）
export async function startTlsProxy(
  upstream: string,
  dir: string,
  featureStates?: Record<string, boolean>,
): Promise<TlsProxy> {
  const keyFile = join(dir, 'proxy.key')
  const caFile = join(dir, 'proxy.crt')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      caFile,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )
  const target = new URL(upstream)
  const server: Server = createServer(
    { key: readFileSync(keyFile), cert: readFileSync(caFile) },
    (req, res) => {
      const out = httpRequest(
        {
          host: target.hostname,
          port: target.port || 80,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: target.host },
        },
        (up) => {
          if (!featureStates || req.url?.split('?')[0] !== '/api/config') {
            res.writeHead(up.statusCode ?? 502, up.headers)
            up.pipe(res)
            return
          }
          // 服务端配置里加上功能开关，例如让 bw 写条目时生成条目密钥（Vaultwarden 不认这个开关）
          const chunks: Buffer[] = []
          up.on('data', (chunk: Buffer) => chunks.push(chunk))
          up.on('end', () => {
            const config = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              featureStates?: Record<string, unknown>
            }
            config.featureStates = { ...config.featureStates, ...featureStates }
            const body = JSON.stringify(config)
            res.writeHead(up.statusCode ?? 200, {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
            })
            res.end(body)
          })
        },
      )
      out.on('error', () => res.destroy())
      req.pipe(out)
    },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `https://127.0.0.1:${port}`,
    caFile,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

// 官方客户端的开关名。只给这一个：bw 把它转给 SDK 时另写一份 enableCipherKeyEncryption，再给别名会报重复字段
const CIPHER_KEY_FLAGS = { 'cipher-key-encryption': true }

export interface BwCli {
  run(args: string[], input?: string): Promise<string>
  // 登录并解锁，之后的命令都带这个会话
  login(email: string, password: string): Promise<void>
  close(): Promise<void>
}

// cipherKeys 为真时让 bw 以为服务端开着条目密钥：新写的条目带自己的密钥
export async function startBw(upstream: string, cipherKeys = false): Promise<BwCli> {
  const dir = mkdtempSync(join(tmpdir(), 'kioku-bw-'))
  const proxy = await startTlsProxy(upstream, dir, cipherKeys ? CIPHER_KEY_FLAGS : undefined)
  let session: string | null = null
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    BITWARDENCLI_APPDATA_DIR: join(dir, 'appdata'),
    NODE_EXTRA_CA_CERTS: proxy.caFile,
    BW_NOINTERACTION: 'true',
  }
  const run = (args: string[], input?: string) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        'bw',
        [...args, ...(session ? ['--session', session] : [])],
        { env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`bw ${args[0]} 失败：${stderr || stdout}`))
          else resolve(stdout)
        },
      )
      if (input !== undefined) child.stdin?.end(input)
      else child.stdin?.end()
    })
  await run(['config', 'server', proxy.url])
  return {
    run,
    async login(email, password) {
      session = null
      session = (await run(['login', email, password, '--raw'])).trim()
      await run(['sync'])
    },
    async close() {
      await run(['logout']).catch(() => {})
      await proxy.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
