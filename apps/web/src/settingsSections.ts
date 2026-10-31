// 设置页的小节：地址里记的 key 和子导航上的名字。实例设置和空间设置各一份，顺序就是子导航的顺序

export interface SettingsSection {
  key: string
  label: string
}

export const INSTANCE_SECTIONS = [
  { key: 'embedding', label: '嵌入模型' },
  { key: 'extraction', label: '抽取模型' },
  { key: 'master-key', label: '主密钥' },
  { key: 'backup', label: '备份' },
  { key: 'import', label: '导入空间' },
  { key: 'retention', label: '保留期' },
  { key: 'recall', label: '召回记录' },
] as const satisfies readonly SettingsSection[]

export const SPACE_SECTIONS = [
  { key: 'layers', label: 'domain 默认层' },
  { key: 'budget', label: '抽取预算' },
  { key: 'dream', label: 'Dream 与私人内容' },
  { key: 'export', label: '导出空间' },
  { key: 'lore', label: '从 Lore 导入' },
] as const satisfies readonly SettingsSection[]

export type InstanceSectionKey = (typeof INSTANCE_SECTIONS)[number]['key']
export type SpaceSectionKey = (typeof SPACE_SECTIONS)[number]['key']

// 当前看哪一节：地址里写的不存在（链接过期、手写）时看第一节
export const currentSection = (sections: readonly SettingsSection[], value: unknown): string =>
  sections.find((section) => section.key === value)?.key ?? sections[0]!.key

// 子导航的链接带的参数：第一节是默认的，不写进地址
export const sectionQuery = (
  sections: readonly SettingsSection[],
  key: string,
): { section?: string } => (key === sections[0]!.key ? {} : { section: key })

// 从别的页面链到某一节
export const instanceSettingsRoute = (section: InstanceSectionKey) => ({
  name: 'settings',
  query: { section },
})
export const spaceSettingsRoute = (spaceId: string, section: SpaceSectionKey) => ({
  name: 'space-settings',
  params: { spaceId },
  query: { section },
})
