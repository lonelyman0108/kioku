import type { ContentfulStatusCode } from 'hono/utils/http-status'

export class MemoryError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}
