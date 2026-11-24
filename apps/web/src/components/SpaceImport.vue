<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  CIRCLE_EXPORT_MAX_BYTES,
  type CircleImportPreview,
  type CircleImportResult,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { formatBytes } from '../backup'
import { useCircleLimit } from '../composables/useCreateSpace'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { circleKindLabels } from '../labels'
import { isCircleQuery, refreshCircles } from '../spaces'
import { formatTime } from '../time'
import Hint from './Hint.vue'
import ModalOrBare from './strata/ModalOrBare.vue'
import NoteLine from './strata/NoteLine.vue'

// 导入记忆圈：记忆圈 › 导入与导出里用弹窗入口，外壳的弹窗里（bare）直接放表单。
// busy 报给弹窗：检查、导入期间不让关。导入成功后自己刷新、跳到目标记忆圈，再报 imported
const props = withDefaults(defineProps<{ bare?: boolean }>(), { bare: false })
const emit = defineEmits<{ imported: [] }>()
const busy = defineModel<boolean>('busy', { default: false })
const modalOpen = ref(false)

const toast = useToast()
const router = useRouter()
const queryClient = useQueryClient()
const { me } = useSession()
// 导入共享圈才占名额；检查文件和个人圈合并导入不受共享圈上限限制
const { blocked } = useCircleLimit()

// 和实例设置的主密钥卡片同一份数据：没配主密钥时先提醒，含 secret 或托管凭据的文件导入不了。
// 这个接口只给实例管理员，别的账号不问，导入时由服务端说明
const masterKey = useQuery({
  queryKey: ['settings', 'master-key'],
  queryFn: api.masterKeyStatus,
  enabled: computed(() => me.data.value?.isAdmin ?? false),
})

const file = ref<File | null>(null)
const passphrase = ref('')
const name = ref('')
// 检查或导入失败的原因（口令不对、文件被改过、没配主密钥等）留在卡片上，改了再试
const error = ref<string | null>(null)
// 检查过的文件：是谁导出的、个人圈还是共享圈、有多少内容
const preview = ref<CircleImportPreview | null>(null)
watch([file, passphrase], () => {
  preview.value = null
  error.value = null
})
watch(modalOpen, (opened) => {
  if (!opened) {
    passphrase.value = ''
    error.value = null
  }
})

const tooLarge = computed(() => (file.value ? file.value.size > CIRCLE_EXPORT_MAX_BYTES : false))
const canInspect = computed(
  () => Boolean(file.value) && !tooLarge.value && Boolean(passphrase.value) && !busy.value,
)
const importBlocked = computed(
  () => preview.value?.circleKind === 'shared' && Boolean(blocked.value),
)
const canImport = computed(() => canInspect.value && Boolean(preview.value) && !importBlocked.value)
// 文件里写的导出人：是文件自带的，谁都能填，界面上不当成核实过的事实
const exporter = computed(() => preview.value?.exporter.displayName || '（未填写）')

async function inspect() {
  if (!canInspect.value || !file.value) return
  busy.value = true
  error.value = null
  try {
    preview.value = await api.inspectCircleImport(file.value, passphrase.value)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '检查失败'
  } finally {
    busy.value = false
  }
}

async function importCircle() {
  if (!canImport.value || !file.value || !preview.value) return
  const currentPreview = preview.value
  busy.value = true
  error.value = null
  let result: CircleImportResult
  try {
    result = await api.importCircle(file.value, passphrase.value, {
      name: currentPreview.circleKind === 'shared' ? name.value : undefined,
      intoPersonalCircle: currentPreview.circleKind === 'personal',
    })
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '导入失败'
    busy.value = false
    return
  }
  // 导入已经成功：之后的刷新与跳转出了问题也不当成导入失败，免得再导入一份
  file.value = null
  passphrase.value = ''
  name.value = ''
  const c = result.counts
  toast.add({
    title:
      result.circleKind === 'personal'
        ? `已合并导入个人圈「${result.name}」`
        : `已导入独立圈「${result.name}」`,
    description: `共导入 ${c.entries} 条记忆（${c.variants} 个变体）、${c.credentials} 条凭据。请为客户端重新签发访问密钥；向量在后台重新生成。`,
    color: 'success',
  })
  // 新记忆圈要先出现在列表中，跳过去才不会被当成无权访问；目标记忆圈缓存（尤其是合并入个人圈）与名额一起刷新
  await refreshCircles(queryClient, result.circleId, { accounts: true }).catch(() => {})
  await queryClient.invalidateQueries({ predicate: isCircleQuery(result.circleId) }).catch(() => {})
  busy.value = false
  modalOpen.value = false
  emit('imported')
  await router.push({ name: 'overview', params: { circleId: result.circleId } })
}
</script>

<template>
  <ModalOrBare
    v-model:open="modalOpen"
    :bare="props.bare"
    title="导入记忆圈"
    entry-title="导入记忆圈文件（.kioku-circle）"
    entry-description="选择导出的记忆圈文件并在弹窗中核对内容；个人圈包合并入本人个人圈，独立圈包导入为新独立圈。"
    action-label="导入记忆圈"
    :icon="icons.importCircle"
    :busy="busy"
  >
    <template #note>
      从导出文件恢复或迁移记忆圈。仅导入本人导出、或导出人同意移交的文件。
      <Hint>
        <p>
          个人圈导出文件将合并进入当前账号的个人记忆圈；独立圈导出文件将新建为一个由当前账号所有的独立圈。其中高优先级记忆会按接入配置进入启动加载。
        </p>
        <p class="mt-1">
          机密记忆与托管的凭据值使用当前实例的主密钥重新加密。访问密钥不在文件中，导入后需为客户端重新签发。
        </p>
      </Hint>
    </template>
    <template #alerts>
      <NoteLine v-if="masterKey.data.value && !masterKey.data.value.configured" tone="warning">
        当前实例未配置主密钥：文件包含机密记忆或托管的凭据时无法导入。请先配置 KIOKU_MASTER_KEY。
      </NoteLine>
    </template>
    <form class="space-y-4" @submit.prevent="preview ? importCircle() : inspect()">
      <UFormField
        label="导出文件"
        :help="`不超过 ${formatBytes(CIRCLE_EXPORT_MAX_BYTES)}`"
        :error="tooLarge ? `文件超出 ${formatBytes(CIRCLE_EXPORT_MAX_BYTES)} 上限` : undefined"
      >
        <!-- 不预览文件内容：导出文件是加密的，预览要给它建 blob: 地址当图片加载，会被内容安全策略拦下 -->
        <UFileUpload
          v-model="file"
          label="选择或拖入导出文件"
          description=".kioku-circle"
          layout="list"
          :file-image="false"
          class="w-full"
          :disabled="busy"
        />
      </UFormField>
      <UFormField label="口令" help="导出时设置的口令">
        <UInput
          v-model="passphrase"
          type="password"
          autocomplete="off"
          class="w-full"
          :disabled="busy"
        />
      </UFormField>
      <template v-if="preview">
        <div>
          <NoteLine tone="warning">
            文件记录的导出人：「{{ exporter }}」（文件自带信息，无法核实）
          </NoteLine>
          <div class="space-y-1">
            <p>
              文件记录来源：{{ circleKindLabels[preview.circleKind] }}「{{
                preview.circleName
              }}」，导出时间 {{ formatTime(preview.exportedAt) }}。共
              {{ preview.counts.entries }} 条记忆（{{ preview.counts.variants }} 个变体、其中机密
              {{ preview.counts.secrets }} 条）、{{ preview.counts.personas }} 个人格、{{
                preview.counts.clients
              }}
              个客户端、{{ preview.counts.facetTerms }} 个条件项、{{ preview.counts.subjects }}
              个联系人。
            </p>
            <p v-if="preview.circleKind === 'personal'">
              此包为个人圈导出文件，确认后将合并导入当前账号的个人记忆圈，包含
              {{ preview.counts.credentials }} 条凭据与
              {{ preview.counts.vaultConnections }} 个密码库连接；冲突的短 ID 将自动重映射。
            </p>
            <p v-else>
              导入后，当前账号将成为新独立圈的所有者，并接收文件中的
              {{ preview.counts.credentials }} 条凭据与
              {{ preview.counts.vaultConnections }} 个密码库连接及关联本人联系人（{{
                preview.counts.linkedSubjects
              }}
              个）。仅导入本人导出、或导出人同意移交的文件。
            </p>
            <p v-if="!preview.exporter.dreamPrivate">
              导出人已关闭「允许整理本人记忆」：导入后同样保持关闭，相关隐私内容不发送给抽取模型。如需整理，可在记忆圈设置中开启。
            </p>
          </div>
        </div>
        <NoteLine v-if="importBlocked && blocked" tone="warning">
          {{ blocked }}，删除或转让一个独立圈后再导入独立圈。
        </NoteLine>
        <UFormField
          v-if="preview.circleKind === 'shared'"
          label="新独立圈名称"
          :help="`留空时使用导出时的名称「${preview.circleName}」`"
        >
          <UInput
            v-model="name"
            class="w-full"
            maxlength="64"
            :placeholder="preview.circleName"
            :disabled="busy"
          />
        </UFormField>
      </template>
      <NoteLine v-if="error" tone="error">{{ error }}</NoteLine>
      <div class="flex flex-wrap justify-end gap-2">
        <UButton
          v-if="!props.bare"
          color="neutral"
          variant="ghost"
          :disabled="busy"
          @click="modalOpen = false"
        >
          取消
        </UButton>
        <UButton
          v-if="!preview"
          type="submit"
          color="primary"
          variant="outline"
          :loading="busy"
          :disabled="!canInspect"
        >
          检查文件
        </UButton>
        <UButton v-else type="submit" :loading="busy" :disabled="!canImport">确认导入</UButton>
      </div>
    </form>
  </ModalOrBare>
</template>
