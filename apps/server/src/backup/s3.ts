import { AwsClient } from 'aws4fetch'

// 兼容S3的对象存储的最小客户端：放、取、删一个对象，列出一个前缀下的对象。用路径式的地址
// （<接口>/<存储桶>/<对象名>），MinIO、Cloudflare、Backblaze 等的对象存储都支持；签名（SigV4）交给 aws4fetch
export interface S3Location {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export interface S3Object {
  key: string
  bytes: number
  at: string
}

// 存储返回的错误或连不上：原因可以直接给管理员看（不含密钥）
export class S3Error extends Error {}

// 一般请求的时限；上传、下载整份备份的时限长一些
const TIMEOUT_MS = 30_000
const TRANSFER_TIMEOUT_MS = 10 * 60_000

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}
const unescapeXml = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]!)
const tag = (xml: string, name: string) =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]

// 存储的错误响应是 XML：<Error><Code>…</Code><Message>…</Message></Error>
async function describe(res: Response): Promise<string> {
  const body = await res.text().catch(() => '')
  const code = tag(body, 'Code')
  const message = tag(body, 'Message')
  const detail = [code, message && unescapeXml(message)].filter(Boolean).join('：')
  return `存储返回 ${res.status}${detail ? `（${detail}）` : ''}`
}

export function s3Client(location: S3Location) {
  // aws4fetch 自己会对 5xx 与 429 重试，次数调小，存储不可用时不要等太久
  const aws = new AwsClient({
    accessKeyId: location.accessKeyId,
    secretAccessKey: location.secretAccessKey,
    region: location.region,
    service: 's3',
    retries: 2,
  })
  const base = `${location.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(location.bucket)}`
  const urlOf = (key: string) => `${base}/${key.split('/').map(encodeURIComponent).join('/')}`

  async function request(
    method: string,
    url: string,
    options: { body?: Uint8Array; timeoutMs?: number } = {},
  ): Promise<Response> {
    let res: Response
    try {
      res = await aws.fetch(url, {
        method,
        ...(options.body ? { body: options.body } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      })
    } catch (err) {
      const cause = (err as { cause?: { message?: string } }).cause?.message
      throw new S3Error(`连不上存储：${cause ?? (err as Error).message}`)
    }
    if (!res.ok) throw new S3Error(await describe(res))
    return res
  }

  return {
    async put(key: string, body: Uint8Array): Promise<void> {
      await request('PUT', urlOf(key), { body, timeoutMs: TRANSFER_TIMEOUT_MS })
    },

    async get(key: string): Promise<Buffer> {
      const res = await request('GET', urlOf(key), { timeoutMs: TRANSFER_TIMEOUT_MS })
      return Buffer.from(await res.arrayBuffer())
    },

    async delete(key: string): Promise<void> {
      await request('DELETE', urlOf(key))
    },

    // 列出前缀下的全部对象（按页取完）
    async list(prefix: string): Promise<S3Object[]> {
      const objects: S3Object[] = []
      let token: string | undefined
      do {
        const url = new URL(base)
        url.searchParams.set('list-type', '2')
        url.searchParams.set('prefix', prefix)
        if (token) url.searchParams.set('continuation-token', token)
        const xml = await (await request('GET', url.toString())).text()
        for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = tag(entry!, 'Key')
          if (key === undefined) continue
          objects.push({
            key: unescapeXml(key),
            bytes: Number(tag(entry!, 'Size') ?? 0),
            at: tag(entry!, 'LastModified') ?? '',
          })
        }
        const next = tag(xml, 'NextContinuationToken')
        token = tag(xml, 'IsTruncated') === 'true' && next ? unescapeXml(next) : undefined
      } while (token)
      return objects
    },
  }
}

export type S3Client = ReturnType<typeof s3Client>
