// 外面拿得到 resolve 的 Promise：测试里让回调停在某一步，或者等它走到某一步
export function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
