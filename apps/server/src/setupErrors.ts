// 初始化页接数据库时的错误。说明文字是给人看的：只写类别与下一步，不带驱动的说明与连接串

// 保存并接上失败：服务回到接入之前的状态，没有写 kioku.json
export class ActivationError extends Error {}

// 另一个请求正在接入或代建
export class SetupBusyError extends Error {
  constructor() {
    super('正在接入数据库，稍后刷新页面')
  }
}
