import { z } from 'zod'

// 接口代际：记忆圈重构换了一代（2），接口与访问密钥都不兼容上一代。客户端读健康检查的这个字段判断能不能接，
// 旧服务端的健康检查没有这个字段，按 1 算
export const API_GENERATION = 2

export const HealthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
  api: z.number().int(),
})

export type HealthResponse = z.infer<typeof HealthResponse>
