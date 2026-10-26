import { HealthResponse } from '@kioku/contracts'

// 管理界面与后端同源，路径直接以 /v1 开头
export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch('/v1/health')
  if (!res.ok) throw new Error(`health 请求失败：HTTP ${res.status}`)
  return HealthResponse.parse(await res.json())
}
