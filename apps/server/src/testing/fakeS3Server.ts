import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

// 测试用的对象存储（兼容S3的接口），跑在本机的随机端口上：路径式地址，支持放、取、删对象与按前缀分页列出。
// 只核对请求带了 SigV4 签名和这把访问密钥，不验签名本身（签名对不对，在本机连真实的对象存储走查时核对）
export interface FakeS3Server {
  endpoint: string
  // 存着的对象：键是「存储桶/对象名」
  objects: Map<string, { body: Buffer; at: string }>
  requests: { method: string; path: string }[]
  // 之后这种方法的请求（不给就是全部）返回这个状态码；undefined 恢复正常
  fail(status: number | undefined, method?: string): void
  // 列出时每页最多几个
  pageSize: number
  close(): Promise<void>
}

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const errorXml = (code: string, message: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`

export async function startFakeS3Server(accessKeyId: string): Promise<FakeS3Server> {
  const objects: FakeS3Server['objects'] = new Map()
  const requests: FakeS3Server['requests'] = []
  const failures = new Map<string, number>()
  const state = { pageSize: 1000 }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const method = req.method ?? 'GET'
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      requests.push({ method, path: url.pathname })
      const reply = (status: number, body = '', type = 'application/xml') =>
        res.writeHead(status, { 'content-type': type }).end(body)
      const failure = failures.get(method) ?? failures.get('*')
      if (failure) return reply(failure, errorXml('AccessDenied', '故意出错'))
      const auth = req.headers.authorization ?? ''
      if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${accessKeyId}/`)) {
        return reply(403, errorXml('InvalidAccessKeyId', '访问密钥不对'))
      }
      const [bucket, ...rest] = url.pathname.slice(1).split('/').map(decodeURIComponent)
      const key = rest.join('/')
      const id = `${bucket}/${key}`
      if (!key && method === 'GET') {
        const prefix = url.searchParams.get('prefix') ?? ''
        const start = Number(url.searchParams.get('continuation-token') ?? 0)
        const matching = [...objects.keys()]
          .filter((k) => k.startsWith(`${bucket}/${prefix}`))
          .sort()
        const page = matching.slice(start, start + state.pageSize)
        const truncated = start + state.pageSize < matching.length
        const contents = page
          .map((k) => {
            const object = objects.get(k)!
            return `<Contents><Key>${escapeXml(k.slice(bucket!.length + 1))}</Key><LastModified>${object.at}</LastModified><Size>${object.body.length}</Size></Contents>`
          })
          .join('')
        return reply(
          200,
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>${contents}${truncated ? `<NextContinuationToken>${start + state.pageSize}</NextContinuationToken>` : ''}</ListBucketResult>`,
        )
      }
      if (method === 'PUT') {
        objects.set(id, { body: Buffer.concat(chunks), at: new Date().toISOString() })
        return reply(200)
      }
      if (method === 'GET') {
        const object = objects.get(id)
        if (!object) return reply(404, errorXml('NoSuchKey', '没有这个对象'))
        return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(object.body)
      }
      if (method === 'DELETE') {
        objects.delete(id)
        return reply(204)
      }
      reply(405, errorXml('MethodNotAllowed', method))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    fail: (status, method = '*') =>
      status === undefined ? failures.delete(method) : failures.set(method, status),
    get pageSize() {
      return state.pageSize
    },
    set pageSize(n: number) {
      state.pageSize = n
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
