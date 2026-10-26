// 构建时没有注入版本号就用 dev，避免在运行时读 package.json
export const VERSION = process.env.KIOKU_VERSION ?? 'dev'
