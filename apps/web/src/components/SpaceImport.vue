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
import { icons } from '../icons'
import { formatTime } from '../time'

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
const exporter = computed(() => preview.value?.exporter.displayName || '导出人')

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
    description: `「${result.exporter.displayName || '导出人'}」的画像层 ${c.ownerMemories} 条、私人层 ${c.privateMemories} 条记忆与 ${c.credentials} 条凭据已归你，共 ${c.memories} 条记忆。Key 没有带过来，给应用重新签发；向量在后台重新生成。`,
    color: 'success',
  })
  // 新空间要先出现在自己的空间列表里，跳过去才不会被当成不是成员
  await queryClient.invalidateQueries({ queryKey: ME_KEY }).catch(() => {})
  busy.value = false
  await router.push({ name: 'overview', params: { spaceId: result.spaceId } })
}
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="font-medium">导入空间</h2>
      <p class="mt-1 text-sm text-muted">
        把在空间设置里导出的文件导入成一个新空间，你是新空间的
        owner。导出人的画像层、私人层记忆与凭据导入后都归你，画像层会进你的 agent
        的启动上下文：只导入你自己导出的、或者导出人同意交给你的文件。secret
        记忆与托管的凭据值用这个实例的主密钥重新加密；Key 不在文件里，导入之后给应用重新签发。
      </p>
    </template>
    <UAlert
      v-if="masterKey.data.value && !masterKey.data.value.configured"
      color="warning"
      variant="subtle"
      class="mb-4"
      title="这个实例没有配置主密钥：文件里有 secret 记忆或托管的凭据时导入不了，先配好 KIOKU_MASTER_KEY 再导入"
    />
    <form class="space-y-4" @submit.prevent="preview ? importSpace() : inspect()">
      <UFormField
        label="导出文件"
        :help="`不超过 ${formatBytes(SPACE_EXPORT_MAX_BYTES)}`"
        :error="tooLarge ? `文件超过 ${formatBytes(SPACE_EXPORT_MAX_BYTES)} 的上限` : undefined"
      >
        <!-- 不预览文件内容：导出文件是加密的，预览要给它建 blob: 地址当图片加载，会被内容安全策略拦下 -->
        <UFileUpload
          v-model="file"
          label="选择或拖进导出文件"
          description=".kioku-space"
          layout="list"
          :file-image="false"
          class="w-full"
          :disabled="busy"
        />
      </UFormField>
      <UFormField label="口令" help="导出时设的口令">
        <UInput
          v-model="passphrase"
          type="password"
          autocomplete="off"
          class="w-full"
          :disabled="busy"
        />
      </UFormField>
      <template v-if="preview">
        <UAlert
          color="warning"
          variant="subtle"
          :title="`这个文件是「${exporter}」在 ${formatTime(preview.exportedAt)} 从空间「${preview.spaceName}」导出的`"
        >
          <template #description>
            <p>
              共 {{ preview.counts.memories }} 条记忆（其中 secret
              {{ preview.counts.secrets }} 条）、{{ preview.counts.personas }} 个人格、{{
                preview.counts.apps
              }}
              个应用、{{ preview.counts.subjects }} 个对象。
            </p>
            <p class="mt-1">
              导入后，「{{ exporter }}」的画像层 {{ preview.counts.ownerMemories }} 条、私人层
              {{ preview.counts.privateMemories }} 条记忆，{{ preview.counts.credentials }} 条凭据与
              {{ preview.counts.providers }} 个凭据源，以及标记成「{{ exporter }}」本人的
              {{ preview.counts.linkedSubjects }} 个对象都归你；画像层会进你的 agent
              的启动上下文。只导入你自己导出的、或者「{{ exporter }}」同意交给你的文件。
            </p>
          </template>
        </UAlert>
        <UFormField label="新空间的名字" :help="`留空时用导出时的空间名「${preview.spaceName}」`">
          <UInput
            v-model="name"
            class="w-full"
            maxlength="64"
            :placeholder="preview.spaceName"
            :disabled="busy"
          />
        </UFormField>
      </template>
      <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      <div class="flex justify-end">
        <UButton
          v-if="!preview"
          type="submit"
          :icon="icons.search"
          :loading="busy"
          :disabled="!ready"
        >
          检查文件
        </UButton>
        <UButton v-else type="submit" :icon="icons.importSpace" :loading="busy" :disabled="!ready">
          确认导入
        </UButton>
      </div>
    </form>
  </UCard>
</template>
