<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  SPACE_EXPORT_MAX_BYTES,
  type SpaceImportPreview,
  type SpaceImportResult,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { formatBytes } from '../backup'
import { ME_KEY } from '../composables/useSession'
import { formatTime } from '../time'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import SettingsBlock from './strata/SettingsBlock.vue'

const toast = useToast()
const router = useRouter()
const queryClient = useQueryClient()

// 和实例设置的主密钥卡片同一份数据：没配主密钥时先提醒，含 secret 或托管凭据的文件导入不了
const masterKey = useQuery({ queryKey: ['settings', 'master-key'], queryFn: api.masterKeyStatus })

const file = ref<File | null>(null)
const passphrase = ref('')
const name = ref('')
const busy = ref(false)
// 检查或导入失败的原因（口令不对、文件被改过、没配主密钥等）留在卡片上，改了再试
const error = ref<string | null>(null)
// 检查过的文件：是谁导出的、有多少。换了文件或口令就要重新检查，导入之前先让人看清哪些会归自己
const preview = ref<SpaceImportPreview | null>(null)
watch([file, passphrase], () => {
  preview.value = null
  error.value = null
})

const tooLarge = computed(() => (file.value ? file.value.size > SPACE_EXPORT_MAX_BYTES : false))
const ready = computed(
  () => Boolean(file.value) && !tooLarge.value && Boolean(passphrase.value) && !busy.value,
)
// 文件里写的导出人：是文件自带的，谁都能填，界面上不当成核实过的事实
const exporter = computed(() => preview.value?.exporter.displayName || '（未填写）')

async function inspect() {
  if (!ready.value || !file.value) return
  busy.value = true
  error.value = null
  try {
    preview.value = await api.inspectSpaceImport(file.value, passphrase.value)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '检查失败'
  } finally {
    busy.value = false
  }
}

async function importSpace() {
  if (!ready.value || !file.value || !preview.value) return
  busy.value = true
  error.value = null
  let result: SpaceImportResult
  try {
    result = await api.importSpace(file.value, passphrase.value, name.value)
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
    title: `已导入「${result.name}」`,
    description: `共导入 ${c.memories} 条记忆。导出人的个人画像层 ${c.ownerMemories} 条、私人层 ${c.privateMemories} 条记忆与 ${c.credentials} 条凭据归当前账号所有。请为应用重新签发 Key；向量在后台重新生成。`,
    color: 'success',
  })
  // 新空间要先出现在自己的空间列表里，跳过去才不会被当成不是成员
  await queryClient.invalidateQueries({ queryKey: ME_KEY }).catch(() => {})
  busy.value = false
  await router.push({ name: 'overview', params: { spaceId: result.spaceId } })
}
</script>

<template>
  <SettingsBlock title="导入空间">
    <template #note>
      将空间导出文件导入为新空间。仅导入本人导出、或导出人同意移交的文件。
      <Hint>
        <p>
          当前账号成为新空间的所有者。导出人的个人画像层、私人层记忆与凭据导入后归当前账号所有，个人画像层将进入当前账号
          Agent 的启动加载，被客户端当作指令读取。
        </p>
        <p class="mt-1">
          机密记忆与托管的凭据值使用当前实例的主密钥重新加密。Key
          不在文件中，导入后需为应用重新签发。
        </p>
      </Hint>
    </template>
    <NoteLine v-if="masterKey.data.value && !masterKey.data.value.configured" tone="warning">
      当前实例未配置主密钥：文件包含机密记忆或托管的凭据时无法导入。请先配置 KIOKU_MASTER_KEY。
    </NoteLine>
    <form class="space-y-4" @submit.prevent="preview ? importSpace() : inspect()">
      <UFormField
        label="导出文件"
        :help="`不超过 ${formatBytes(SPACE_EXPORT_MAX_BYTES)}`"
        :error="tooLarge ? `文件超出 ${formatBytes(SPACE_EXPORT_MAX_BYTES)} 上限` : undefined"
      >
        <!-- 不预览文件内容：导出文件是加密的，预览要给它建 blob: 地址当图片加载，会被内容安全策略拦下 -->
        <UFileUpload
          v-model="file"
          label="选择或拖入导出文件"
          description=".kioku-space"
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
              文件记录的来源空间为「{{ preview.spaceName }}」，导出时间
              {{ formatTime(preview.exportedAt) }}。共
              {{ preview.counts.memories }} 条记忆（其中机密 {{ preview.counts.secrets }} 条）、{{
                preview.counts.personas
              }}
              个人格、{{ preview.counts.apps }} 个应用、{{ preview.counts.subjects }} 个联系人。
            </p>
            <p>
              导入后，导出人的个人画像层 {{ preview.counts.ownerMemories }} 条、私人层
              {{ preview.counts.privateMemories }} 条记忆，{{ preview.counts.credentials }} 条凭据与
              {{ preview.counts.providers }} 个凭据源，以及标记为导出人本人的
              {{ preview.counts.linkedSubjects }} 个联系人均归当前账号所有；个人画像层将进入当前账号
              Agent 的启动加载。仅导入本人导出、或导出人同意移交的文件。
            </p>
            <p v-if="!preview.exporter.dreamPrivate">
              导出人已关闭「允许 Dream
              整理个人画像层与私人层」：新空间中同样保持关闭，这两层不发送给抽取模型。如需整理，请在新空间的空间设置中开启。
            </p>
          </div>
        </div>
        <UFormField label="新空间名称" :help="`留空时使用导出时的空间名称「${preview.spaceName}」`">
          <UInput
            v-model="name"
            class="w-full"
            maxlength="64"
            :placeholder="preview.spaceName"
            :disabled="busy"
          />
        </UFormField>
      </template>
      <NoteLine v-if="error" tone="error">{{ error }}</NoteLine>
      <UButton
        v-if="!preview"
        type="submit"
        color="primary"
        variant="outline"
        :loading="busy"
        :disabled="!ready"
      >
        检查文件
      </UButton>
      <UButton v-else type="submit" :loading="busy" :disabled="!ready">确认导入</UButton>
    </form>
  </SettingsBlock>
</template>
