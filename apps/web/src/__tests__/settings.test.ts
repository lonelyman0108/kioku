import { describe, expect, it } from 'vitest'

import accountDataSettings from '../components/AccountDataSettings.vue?raw'
import backgroundTasksIndicator from '../components/BackgroundTasksIndicator.vue?raw'
import dataTransferPanel from '../components/DataTransferPanel.vue?raw'
import issueKeyModal from '../components/IssueKeyModal.vue?raw'
import keysSettings from '../components/KeysSettings.vue?raw'
import modelSettings from '../components/ModelSettings.vue?raw'
import organizeIndexRail from '../components/OrganizeIndexRail.vue?raw'
import consoleLayout from '../layouts/ConsoleLayout.vue?raw'
import credentialsPage from '../pages/CredentialsPage.vue?raw'
import settingsPage from '../pages/SettingsPage.vue?raw'

function extractTagBlock(source: string, marker: string, closingTag: string): string {
  const start = source.indexOf(marker)
  expect(start, `未找到 ${marker}`).toBeGreaterThan(-1)
  const end = source.indexOf(closingTag, start)
  expect(end, `未找到 ${closingTag}`).toBeGreaterThan(start)
  return source.slice(start, end + closingTag.length)
}

describe('设置页六子视图架构、安全交互与外壳收口', () => {
  it('SettingsPage 具备三组六项左目录轨、极简版本号底栏、窄屏横滑切换条与未保存守卫', () => {
    expect(settingsPage).toContain('grid-template-columns: 216px minmax(0, 1fr)')
    expect(settingsPage).toContain('终端与密钥')
    expect(settingsPage).toContain('嵌入与索引')
    expect(settingsPage).toContain('对话与整理')
    expect(settingsPage).toContain('定时计划')
    expect(settingsPage).toContain('账号与登录设备')
    expect(settingsPage).toContain('备份与迁移')
    expect(settingsPage).toContain('rail-foot-min')
    expect(settingsPage).toContain('settings-mobile-nav')
    expect(settingsPage).toContain('useUnsavedChangesGuard')
    expect(settingsPage).toContain('resolveSettingsSection')
  })

  it('KeysSettings 与 460px 编辑抽屉满足双栏纸墨布局、多维筛选与安全红线', () => {
    expect(keysSettings).toContain('read-layout has-rail')
    expect(keysSettings).toContain('key-filter-bar')
    expect(keysSettings).toContain('pruneStaleKeyFilter')
    expect(keysSettings).toContain('清空筛选')
    expect(keysSettings).toContain('v-if="revokedKeys.length"')
    expect(keysSettings).toContain('.key-ledger-main {\n    flex: none;\n    width: 100%;')
    // 轮换先经过 ConsequenceModal 二次确认，再展示不可误关的一次性明文弹窗
    expect(keysSettings).toContain('confirmRotate')
    expect(keysSettings).toContain('确认轮换')
    const rotatedModal = extractTagBlock(
      keysSettings,
      ':open="rotatedSecret !== null"',
      '</UModal>',
    )
    expect(rotatedModal).toContain(':dismissible="false"')
    expect(rotatedModal).toContain(':close="false"')

    // 460px 右滑抽屉、仅保留一行凭据匹配统计与链接、签发后锁定一次性明文弹窗
    expect(issueKeyModal).toContain('<USlideover')
    expect(issueKeyModal).toContain('max-w-[460px]')
    expect(issueKeyModal).toContain('countMatchingCredentials')
    expect(issueKeyModal).toContain('credentialsQuery.isError.value')
    expect(issueKeyModal).toContain('前往凭据')
    const issuedModal = extractTagBlock(issueKeyModal, ':open="issued !== null"', '</UModal>')
    expect(issuedModal).toContain(':dismissible="false"')
    expect(issuedModal).toContain(':close="false"')
  })

  it('ModelSettings 拆为嵌入、对话与定时三视图，采用 880px 纯纸面、吸底 SaveBar 与清理旧测试状态', () => {
    expect(modelSettings).toContain('--canvas-max: 880px')
    expect(modelSettings).toContain('嵌入与索引')
    expect(modelSettings).toContain('对话与整理')
    expect(modelSettings).toContain('定时计划')
    expect(modelSettings).toContain('清除密钥')
    expect(modelSettings).toContain('summary-block')
    expect(modelSettings).toContain('<SaveBar')
    expect(modelSettings).toContain('formatHoursHuman')
    expect(modelSettings).toContain('formatNextRunHint')
    expect(modelSettings).toContain('api.runDream')
    expect(modelSettings).toContain('delete testResults.embedding')
    expect(modelSettings).toContain('delete testResults.chat_llm')
  })

  it('账号与登录设备与备份与迁移拆分独立，且满足安全确认、ARIA 语义与无套娃纸墨样式', () => {
    expect(accountDataSettings).not.toContain('DataTransferPanel')
    expect(accountDataSettings).toContain('username-static')
    expect(accountDataSettings).toContain('下线其他设备')
    expect(accountDataSettings).toContain('r.reason.status === 404')
    expect(accountDataSettings).toContain('<ConsequenceModal')
    expect(accountDataSettings).toContain('useLogout')

    expect(dataTransferPanel).not.toContain('transfer-box')
    expect(dataTransferPanel).toContain('备份与迁移')
    expect(dataTransferPanel).toContain('role="radiogroup"')
    expect(dataTransferPanel).toContain('role="radio"')
    expect(dataTransferPanel).toContain(':aria-checked="exportMode === card.value"')
    expect(dataTransferPanel).toContain('exportPassphraseIssue')
    expect(dataTransferPanel).toContain('api.previewImport')
    expect(dataTransferPanel).toContain('api.applyImport')
  })

  it('全局外壳与跳转入口对齐：移动端账号入口、搜索占位提示、凭据新建查询参数与子页直达链接', () => {
    expect(consoleLayout).toContain('placeholder="搜索记忆、凭据或跳转页面"')
    expect(consoleLayout).toContain("settingsRoute('account')")
    const accountEntries = consoleLayout.match(/账号与数据/g) ?? []
    expect(accountEntries.length).toBeGreaterThanOrEqual(2)

    expect(credentialsPage).toContain('route.query.new')
    expect(credentialsPage).toContain("newFlag !== '1'")
    expect(backgroundTasksIndicator).toContain("settingsRoute('embed')")
    expect(organizeIndexRail).toContain("settingsRoute('schedule')")
  })
})
