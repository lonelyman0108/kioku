import type { BackupSettingsView } from '@kioku/contracts'
import { computed, reactive, ref, watch, type Ref } from 'vue'

import { defaultHour } from '../backup'

const DEFAULT_REGION = 'us-east-1'
const DEFAULT_KEEP = 7

// 备份设置的表单。有没有改动只和填进表单的那一版比：设置隔一会儿就刷新，还可能被别的管理员改过，
// 和最新的比会把别人的改动算成自己的，保存时再写回去。
// 没有改动时跟上最新的设置；有改动时不动，等结果时的刷新不能冲掉正在填的内容
export function useBackupForm(view: Ref<BackupSettingsView | undefined>) {
  const hour = defaultHour()
  // 和保存的设置一一对应的字段。secretAccessKey 读不回来，不在里面，留空表示沿用已保存的
  const fieldsOf = (s: BackupSettingsView) => ({
    endpoint: s.endpoint ?? '',
    region: s.region ?? DEFAULT_REGION,
    bucket: s.bucket ?? '',
    prefix: s.prefix ?? '',
    accessKeyId: s.accessKeyId ?? '',
    hour: s.hour ?? hour,
    keep: s.keep ?? DEFAULT_KEEP,
  })
  type Fields = ReturnType<typeof fieldsOf>

  const form = reactive({
    endpoint: '',
    region: DEFAULT_REGION,
    bucket: '',
    prefix: '',
    accessKeyId: '',
    secretAccessKey: '',
    hour,
    keep: DEFAULT_KEEP,
  })
  // 表单是从哪一版填的；还没读到时为 null，这时不算有改动
  const baseline = ref<Fields | null>(null)
  const dirty = computed(() => {
    const base = baseline.value
    if (!base) return false
    const fields = Object.keys(base) as (keyof Fields)[]
    return form.secretAccessKey !== '' || fields.some((field) => form[field] !== base[field])
  })
  function fill(s: BackupSettingsView) {
    const fields = fieldsOf(s)
    Object.assign(form, fields)
    baseline.value = fields
  }
  // 改动撤销之后也跟上：有改动期间别的管理员可能保存过
  watch(
    [view, dirty],
    ([s, changed]) => {
      if (s && !changed) fill(s)
    },
    { immediate: true },
  )
  return { form, dirty, fill }
}
