<script setup lang="ts">
import { PLAINTEXT_KIND_NAMES } from '@kioku/contracts'
import { computed, toRef, useId } from 'vue'

import {
  usePlaintextSave,
  type PlaintextSaveRequest,
  type PlaintextSaveResult,
} from '../composables/usePlaintextSave'
import { plaintextChoiceLabels } from '../labels'
import { previewValue } from '../plaintext'
import { linesText } from '../plaintextSave'
import ConvertDestinationPicker from './ConvertDestinationPicker.vue'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'

// 保存记忆之前逐处处理新增的疑似明文，状态和规则在 usePlaintextSave。
// 没有表单：单选在表单里时回车会隐式提交，没选完就保存了。只有点按钮才继续
const props = defineProps<{ spaceId: string; owner: boolean }>()
const request = defineModel<PlaintextSaveRequest | null>('request', { required: true })
const emit = defineEmits<{ proceed: [result: PlaintextSaveResult] }>()

const save = usePlaintextSave(toRef(props, 'spaceId'), request, toRef(props, 'owner'), (result) => {
  request.value = null
  emit('proceed', result)
})
const { rows, matching, matchFailure, unavailableConnections, busy, failure, problem, ready } = save

function close() {
  if (!busy.value) request.value = null
}

const group = useId()
// 写成一整句：模板里中文换行会多出空格
const INTRO =
  '保存前逐处选择：转存为凭据，正文中的值换成占位符，历史中不留明文；不是凭据，照常保存。'
const anyConvertible = computed(() => rows.value.some((row) => !save.convertBlocker(row)))
</script>

<template>
  <UModal
    :open="request !== null"
    title="正文疑似包含明文凭据"
    :dismissible="!busy"
    :close="!busy"
    :ui="{ content: 'sm:max-w-2xl' }"
    @update:open="(v) => !v && close()"
  >
    <template #body>
      <div v-if="request" class="gate">
        <p>{{ INTRO }}</p>
        <NoteLine v-if="request.rejected" tone="warning" flush>
          服务端检出新增的疑似明文，未保存
        </NoteLine>
        <p v-if="matching" class="text-muted">正在查找同值的凭据……</p>
        <NoteLine v-else-if="matchFailure" tone="warning" flush>
          {{ matchFailure }}
          <template #detail>仍可新建托管凭据。</template>
        </NoteLine>
        <p v-else-if="unavailableConnections && anyConvertible" class="text-muted">
          {{ unavailableConnections }} 个密码库连接不可用，未比对<Hint>
            连接恢复后重新保存可再次查找。
          </Hint>
        </p>

        <ul class="spots">
          <li v-for="(row, i) in rows" :key="i" class="spot">
            <p class="spot-head">
              <span>{{ linesText(row.spot.lines) }}</span>
              <span>{{ PLAINTEXT_KIND_NAMES[row.spot.kind] }}</span>
              <code v-if="row.spot.value" class="spot-preview">{{
                previewValue(row.spot.value)
              }}</code>
            </p>
            <div class="spot-choices" role="radiogroup" :aria-label="linesText(row.spot.lines)">
              <label
                class="spot-choice"
                :class="{ 'is-disabled': !!save.convertBlocker(row) }"
                :title="save.convertBlocker(row) ?? undefined"
              >
                <input
                  type="radio"
                  :name="`${group}-${i}`"
                  :checked="row.choice === 'convert'"
                  :disabled="!!save.convertBlocker(row) || busy"
                  @change="row.choice = 'convert'"
                />
                {{ plaintextChoiceLabels.convert }}
              </label>
              <label class="spot-choice">
                <input
                  type="radio"
                  :name="`${group}-${i}`"
                  :checked="row.choice === 'ignore'"
                  :disabled="busy"
                  @change="row.choice = 'ignore'"
                />
                {{ plaintextChoiceLabels.ignore }}
              </label>
              <span v-if="save.convertBlocker(row)" class="text-muted">
                不可转存<Hint>{{ save.convertBlocker(row) }}</Hint>
              </span>
            </div>
            <div v-if="row.choice === 'convert' && !save.convertBlocker(row)" class="spot-body">
              <ConvertDestinationPicker
                v-model="row.destination"
                :destinations="save.destinationsOf(row).destinations"
                :unmapped="save.destinationsOf(row).unmapped"
              >
                <template #vault="{ destination }">
                  <UFormField
                    v-if="destination.kind === 'vault'"
                    label="凭据标识"
                    help="名称取条目名称，字段对应按条目的字段"
                  >
                    <UInput
                      v-model="save.vaultIdentifiers[save.itemKey(destination)]"
                      class="w-full font-mono"
                      autocomplete="off"
                      :disabled="save.createdVault.value.has(save.itemKey(destination))"
                    />
                  </UFormField>
                </template>
                <template #hosted>
                  <div class="hosted-fields">
                    <UFormField label="凭据标识">
                      <UInput
                        v-model="row.hosted.identifier"
                        class="w-full font-mono"
                        autocomplete="off"
                        :disabled="row.created"
                      />
                    </UFormField>
                    <UFormField label="名称">
                      <UInput
                        v-model="row.hosted.name"
                        class="w-full"
                        autocomplete="off"
                        :disabled="row.created"
                      />
                    </UFormField>
                    <UFormField label="字段名">
                      <UInput
                        v-model="row.hosted.field"
                        class="w-full font-mono"
                        autocomplete="off"
                        :disabled="row.created"
                      />
                    </UFormField>
                  </div>
                </template>
              </ConvertDestinationPicker>
              <p class="spot-effect">
                将换成 <code>{{ save.placeholderFor(row) }}</code>
              </p>
            </div>
          </li>
        </ul>

        <NoteLine v-if="failure" tone="error" flush>
          {{ failure }}
          <template #detail>已新建的凭据保留，再次保存不会重复新建。</template>
        </NoteLine>
      </div>
    </template>
    <template #footer>
      <div class="gate-footer">
        <span class="gate-problem">{{ matching ? '' : problem }}</span>
        <UButton color="neutral" variant="ghost" :disabled="busy" @click="close">取消</UButton>
        <UTooltip
          v-if="owner"
          text="正文原样保存，明文写入历史，这条记忆进待处理"
          :content="{ side: 'top' }"
        >
          <UButton color="neutral" variant="outline" :disabled="busy" @click="save.saveAnyway">
            照样保存
          </UButton>
        </UTooltip>
        <UButton :loading="busy" :disabled="!ready" @click="save.proceed">保存</UButton>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.gate {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 14px;
}
.spots {
  border-top: 1px solid var(--ui-border);
}
.spot {
  padding: 10px 0;
  border-bottom: 1px solid var(--ui-border);
}
.spot-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 12px;
  font-weight: 500;
}
.spot-preview {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 400;
}
.spot-choices {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 16px;
  margin-top: 6px;
}
.spot-choice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.spot-choice input {
  accent-color: var(--ui-text-highlighted);
}
.spot-choice.is-disabled {
  color: var(--ui-text-dimmed);
  cursor: default;
}
.spot-body {
  margin: 8px 0 0 22px;
}
.spot-effect {
  margin-top: 6px;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.spot-effect code {
  color: var(--ui-text);
}
.hosted-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.gate-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  width: 100%;
}
.gate-problem {
  flex: 1 1 12em;
  font-size: 14px;
  color: var(--ui-text-muted);
}
@media (max-width: 640px) {
  .hosted-fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
