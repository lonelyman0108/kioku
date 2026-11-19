const pending = new Set<Promise<unknown>>()

// 登记异步召回日志写入，供测试清库前等待落盘完成
export function trackRecallWrite(promise: Promise<unknown>): void {
  pending.add(promise)
  void promise.finally(() => {
    pending.delete(promise)
  })
}

export async function settleRecallEvents(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending])
  }
}
