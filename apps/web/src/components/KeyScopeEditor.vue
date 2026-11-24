<script setup lang="ts">
import {
  CREDENTIAL_CAPABILITIES,
  ENTRY_KINDS,
  FacetTermSlug,
  SENSITIVITIES,
  sensitivityAllowed,
  type CircleKind,
  type CredentialCapability,
  type EntryKind,
  type LensKeyScopes,
  type Sensitivity,
} from '@kioku/contracts'
import { computed, ref, useId } from 'vue'

import {
  ADMIN_SCOPE_LABEL,
  credentialCapabilityLabels,
  entryKindLabels,
  sensitivityLabels,
} from '../labels'
import Hint from './Hint.vue'
import SegmentedChoice from './SegmentedChoice.vue'
import {
  CUSTOM_PRESET,
  CUSTOM_PRESET_HELP,
  allowedCredentialCapability,
  issuedCredentialCapability,
  keyPresets,
  matchPreset,
  presetScopes,
} from './keyPresets'
import AccessLegend from './strata/AccessLegend.vue'
import NoteLine from './strata/NoteLine.vue'
import ScopeTags from './strata/ScopeTags.vue'
import StrataCore from './strata/StrataCore.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import {
  ACCESS_BAR_PERCENT,
  accessFill,
  accessKindLabels,
  accessKindShortLabels,
  isConversationKind,
  issuedBandRows,
  issuedScopeRows,
  kindAccessCellText,
  kindAccessKind,
  kindBandForCircle,
  orderKindRows,
  paintAccess,
  presentKinds,
  sensitivityHints,
  type AccessKind,
  type KindAccessRow,
  type PaintRect,
} from './strata/strata'

// 签发访问密钥时编辑签发范围：模板卡片 + 形态×敏感级矩阵 + 静态场域锁 + 凭据与管理权限
const scopes = defineModel<LensKeyScopes>('scopes', { required: true })
const preset = defineModel<string>('preset', { required: true })
const props = withDefaults(
  defineProps<{
    isCircleOwner: boolean
    circleKind?: CircleKind
    realmTerms?: readonly { slug: string; label: string }[]
  }>(),
  {
    circleKind: 'shared',
    realmTerms: () => [],
  },
)
const uid = useId()

const cards = computed(() => [
  ...keyPresets.map((p) => ({
    id: p.id,
    label: p.label,
    help: p.help,
    scopes: presetScopes(p, props.isCircleOwner),
  })),
  { id: CUSTOM_PRESET, label: '自定义', help: CUSTOM_PRESET_HELP, scopes: scopes.value },
])

function update(patch: Partial<LensKeyScopes>) {
  const next = { ...scopes.value, ...patch }
  scopes.value = next
  preset.value = matchPreset(next, props.isCircleOwner)
}

function pick(id: string) {
  preset.value = id
  const found = keyPresets.find((p) => p.id === id)
  if (found) scopes.value = presetScopes(found, props.isCircleOwner)
}

function toggle(field: 'readKinds' | 'writeKinds', kind: EntryKind, on: boolean) {
  const list = scopes.value[field]
  update({ [field]: ENTRY_KINDS.filter((k) => (k === kind ? on : list.includes(k))) })
}
const checkedOf = (event: Event) => (event.target as HTMLInputElement).checked

const accessRows = computed(() => orderKindRows(issuedScopeRows(scopes.value, props.circleKind)))
const bandRowsForEditor = computed(() =>
  accessRows.value.map((row) => ({
    band: kindBandForCircle(row.kind, { circleKind: props.circleKind, isPrimary: true }),
    cells: row.cells,
  })),
)
const edge = computed(() => SENSITIVITIES.indexOf(scopes.value.maxSensitivity))

interface EditorCell {
  sensitivity: Sensitivity
  kind: AccessKind
  allowed: boolean
  title: string
  paint: PaintRect[]
}
const FULL = { x: 0, y: 0, width: '100%', height: '100%' }
const rows = computed(() =>
  accessRows.value.map((row: KindAccessRow) => {
    const band = kindBandForCircle(row.kind, { circleKind: props.circleKind, isPrimary: true })
    const label = entryKindLabels[row.kind]
    return {
      kind: row.kind,
      band,
      label,
      cells: SENSITIVITIES.map((sensitivity): EditorCell => {
        const cell = row.cells.find((c) => c.sensitivity === sensitivity)
        const accessKindVal: AccessKind = cell ? kindAccessKind(row.kind, cell) : 'none'
        const allowed = sensitivityAllowed(props.circleKind, row.kind, sensitivity)
        return {
          sensitivity,
          kind: accessKindVal,
          allowed,
          title: kindAccessCellText(row.kind, props.circleKind, sensitivity, accessKindVal, label),
          paint:
            allowed && accessKindVal !== 'none'
              ? paintAccess(band, sensitivity, accessKindVal, FULL, ACCESS_BAR_PERCENT, 'lg')
              : [],
        }
      }),
    }
  }),
)
const legendKinds = computed(() => presentKinds(bandRowsForEditor.value))

// 机密级、凭据与词表人格管理权限仅记忆圈所有者可签发
const maxItems = computed(() =>
  SENSITIVITIES.map((s) => ({
    value: s,
    label: sensitivityLabels[s],
    disabled: s === 'secret' && !props.isCircleOwner,
  })),
)

// 静态场域白名单锁定（null 不限定，string[] 仅限所选场域）
const realmLocked = computed(() => scopes.value.allowedRealms !== null)
const realmChoices = computed(() => {
  const known = new Set(props.realmTerms.map((t) => t.slug))
  const extra = (scopes.value.allowedRealms ?? [])
    .filter((slug) => !known.has(slug))
    .map((slug) => ({ slug, label: slug }))
  return [...props.realmTerms, ...extra]
})
const customRealmInput = ref('')
const customRealmError = ref<string | null>(null)

function setRealmMode(restricted: boolean) {
  customRealmError.value = null
  if (!restricted) {
    update({ allowedRealms: null })
    return
  }
  update({ allowedRealms: scopes.value.allowedRealms ?? [] })
}

function toggleRealm(slug: string) {
  const current = scopes.value.allowedRealms ?? []
  const next = current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug]
  update({ allowedRealms: next })
}

function addCustomRealm() {
  const parsed = FacetTermSlug.safeParse(customRealmInput.value)
  if (!parsed.success) {
    customRealmError.value = parsed.error.issues[0]?.message ?? '场域标识格式有误'
    return
  }
  customRealmError.value = null
  const current = scopes.value.allowedRealms ?? []
  if (!current.includes(parsed.data)) {
    update({ allowedRealms: [...current, parsed.data] })
  }
  customRealmInput.value = ''
}

const credentialItems = computed(() =>
  CREDENTIAL_CAPABILITIES.map((c) => ({
    value: c,
    label: credentialCapabilityLabels[c],
    disabled: allowedCredentialCapability(c, props.isCircleOwner) !== c,
  })),
)
const credentialHelp: Record<CredentialCapability, string> = {
  none: '不能列出与取用凭据',
  use: '列出凭据并取值',
  manage: '另可新建、修改、删除凭据',
}
const credentialShortfall = computed(() => {
  const actual = issuedCredentialCapability(scopes.value)
  return actual === scopes.value.credentials ? null : actual
})
</script>

<template>
  <div class="scope-editor">
    <fieldset class="field">
      <legend class="field-label">
        模板<span class="field-note">改动下面任意一项会切到「自定义」</span>
      </legend>
      <div class="tpls">
        <label v-for="card in cards" :key="card.id" class="tpl" :class="{ on: preset === card.id }">
          <input
            type="radio"
            class="sr-only"
            :name="`${uid}-preset`"
            :value="card.id"
            :checked="preset === card.id"
            @change="pick(card.id)"
          />
          <StrataCore
            :rows="issuedBandRows(card.scopes, { primaryKind: circleKind })"
            :width="28"
            :height="44"
            aria-hidden="true"
          />
          <span class="tpl-text">
            <b>{{ card.label }}</b>
            <span class="tpl-help">{{ card.help }}</span>
          </span>
          <ScopeTags v-if="card.id !== CUSTOM_PRESET" class="tpl-tags" :scopes="card.scopes" />
        </label>
      </div>
    </fieldset>

    <div class="field">
      <div class="field-head">
        <span class="field-label">
          访问范围<Hint>
            按记忆形态与敏感级换算的签发上限，客户端与会话上下文另有收紧规则，签发后在访问范围里查看。机密仅可按短
            ID 读取且仅在主圈有效；联系人事实与会话摘要的写入指对话抽取。粗线右侧超出最高敏感级。
          </Hint>
        </span>
        <span class="max-label" aria-hidden="true">最高敏感级</span>
        <SegmentedChoice
          :model-value="scopes.maxSensitivity"
          :items="maxItems"
          label="最高敏感级"
          @update:model-value="(v) => update({ maxSensitivity: v })"
        />
      </div>
      <p v-if="!isCircleOwner" class="field-note block-note">仅记忆圈所有者可签发机密级</p>
      <div class="mx-scroll">
        <table class="mx">
          <thead>
            <tr>
              <th scope="col" class="col-layer">记忆形态</th>
              <th scope="col" class="col-rw">读</th>
              <th scope="col" class="col-rw">写</th>
              <th
                v-for="(s, i) in SENSITIVITIES"
                :key="s"
                scope="col"
                class="col-sens"
                :class="{ edge: i === edge }"
                :title="sensitivityHints[s]"
              >
                <span class="mx-key">
                  <StrataSwatch :sensitivity="s" :width="20" :height="12" decorative />
                  <span>{{ sensitivityLabels[s] }}</span>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.kind" :class="{ 'conv-end': row.kind === 'fact' }">
              <th scope="row" class="col-layer">
                <span class="lname">
                  <StrataSwatch :band="row.band" plain decorative :width="14" :height="10" />
                  <span>{{ row.label }}</span>
                  <span v-if="isConversationKind(row.kind)" class="from-conv">来自对话</span>
                </span>
              </th>
              <td class="col-rw">
                <input
                  type="checkbox"
                  :aria-label="`读 ${row.label}`"
                  :checked="scopes.readKinds.includes(row.kind)"
                  @change="toggle('readKinds', row.kind, checkedOf($event))"
                />
              </td>
              <td class="col-rw">
                <input
                  type="checkbox"
                  :aria-label="`写 ${row.label}`"
                  :checked="scopes.writeKinds.includes(row.kind)"
                  @change="toggle('writeKinds', row.kind, checkedOf($event))"
                />
              </td>
              <td
                v-for="(cell, i) in row.cells"
                :key="cell.sensitivity"
                class="c"
                :class="[cell.kind, { edge: i === edge, na: !cell.allowed }]"
                :style="{ '--c': accessFill(row.band) }"
                :title="cell.title"
              >
                <span v-if="!cell.allowed" class="c-na">不适用</span>
                <template v-else-if="cell.kind !== 'none'">
                  <svg width="100%" height="100%" aria-hidden="true">
                    <rect
                      v-for="(r, k) in cell.paint"
                      :key="k"
                      :x="r.x"
                      :y="r.y"
                      :width="r.width"
                      :height="r.height"
                      :opacity="r.opacity"
                      :style="{ fill: r.fill }"
                    />
                  </svg>
                  <span class="c-label" aria-hidden="true">{{
                    accessKindShortLabels[cell.kind]
                  }}</span>
                  <span class="sr-only">{{ accessKindLabels[cell.kind] }}</span>
                </template>
                <template v-else>
                  <span class="c-none" aria-hidden="true">{{ accessKindShortLabels.none }}</span>
                  <span class="sr-only">{{ accessKindLabels.none }}</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <AccessLegend class="mx-legend" :kinds="legendKinds" />
    </div>

    <div class="field">
      <div class="field-row">
        <span class="row-label">
          允许场域锁<Hint>
            安全硬边界：设为仅限指定场域后，机密记忆与凭据严格锁在所选场域内，绝不随客户端动态上报项目或提问唤醒别名放宽；选「仅限指定场域」且不勾任何项将阻止访问所有带场域限制的机密与凭据。
          </Hint>
        </span>
        <SegmentedChoice
          :model-value="realmLocked ? 'restricted' : 'open'"
          :items="[
            { value: 'open', label: '不限定场域' },
            { value: 'restricted', label: '仅限指定场域' },
          ]"
          label="允许场域锁"
          @update:model-value="(v) => setRealmMode(v === 'restricted')"
        />
      </div>
      <div v-if="realmLocked" class="realm-box">
        <div class="realm-list" role="group" aria-label="允许的场域">
          <label
            v-for="item in realmChoices"
            :key="item.slug"
            class="realm-chip"
            :class="{ on: (scopes.allowedRealms ?? []).includes(item.slug) }"
          >
            <input
              type="checkbox"
              class="sr-only"
              :checked="(scopes.allowedRealms ?? []).includes(item.slug)"
              @change="toggleRealm(item.slug)"
            />
            <span>{{ item.label }}</span>
            <code v-if="item.label !== item.slug">{{ item.slug }}</code>
          </label>
        </div>
        <div class="realm-custom">
          <UInput
            v-model="customRealmInput"
            size="xs"
            class="w-44 font-mono"
            placeholder="添加场域标识"
            aria-label="添加场域标识"
            @keydown.enter.prevent="addCustomRealm"
          />
          <UButton size="xs" color="neutral" variant="outline" @click="addCustomRealm"
            >添加</UButton
          >
          <span v-if="customRealmError" class="text-xs text-error">{{ customRealmError }}</span>
        </div>
        <NoteLine v-if="!scopes.allowedRealms?.length" tone="warning" flush class="mt-2">
          已启用场域锁但尚未选择任何场域：将阻止访问所有带场域限制的机密与凭据，请至少勾选一项或切回「不限定场域」。
        </NoteLine>
      </div>
    </div>

    <div class="field-row">
      <span class="row-label">凭据能力</span>
      <SegmentedChoice
        :model-value="scopes.credentials"
        :items="credentialItems"
        label="凭据能力"
        @update:model-value="(v) => update({ credentials: v })"
      />
      <span class="row-help">
        <template v-if="!isCircleOwner">仅记忆圈所有者的客户端可以取用或管理凭据。</template>
        <template v-else>{{ credentialHelp[scopes.credentials] }}</template>
      </span>
    </div>
    <NoteLine v-if="credentialShortfall" class="shortfall" tone="warning" flush>
      按当前签发范围，凭据能力实际为「{{ credentialCapabilityLabels[credentialShortfall] }}」
    </NoteLine>

    <div class="field-row">
      <span class="row-label">{{ ADMIN_SCOPE_LABEL }}</span>
      <USwitch
        :model-value="scopes.admin"
        :disabled="!isCircleOwner"
        :aria-label="ADMIN_SCOPE_LABEL"
        @update:model-value="(v: boolean) => update({ admin: v })"
      />
      <span class="row-help">
        可管理语境词典与独立人格设定<template v-if="!isCircleOwner"
          >；仅记忆圈所有者可开启</template
        >
      </span>
    </div>
  </div>
</template>

<style scoped>
.scope-editor {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.field {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.field-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  padding: 0;
  font-size: 14px;
  font-weight: 600;
}
.field-note {
  margin-left: 4px;
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-text-muted);
}
.block-note {
  display: block;
  margin: -2px 0 6px;
  text-align: right;
}
.field-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  margin-bottom: 6px;
}
.field-head .field-label {
  margin-bottom: 0;
}
.max-label {
  margin-left: auto;
  font-size: 12px;
  color: var(--ui-text-muted);
}

/* 模板卡片：四张一排，选中的反白 */
.tpls {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border: 1px solid var(--strata-rule);
}
.tpl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-content: start;
  gap: 6px 10px;
  padding: 10px 12px;
  border-right: 1px solid var(--ui-border);
  cursor: pointer;
}
.tpl:last-child {
  border-right: 0;
}
.tpl:hover:not(.on) {
  background: var(--ui-bg-muted);
}
.tpl:has(input:focus-visible) {
  position: relative;
  z-index: 1;
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: -2px;
}
.tpl.on {
  --strata-frame: var(--strata-selected-frame);
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.tpl-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tpl-text b {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}
.tpl-help {
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-muted);
}
.tpl.on .tpl-help {
  color: var(--strata-on-selected-muted);
}
.tpl-tags {
  grid-column: 1 / -1;
}
.tpl.on .tpl-tags :deep(li) {
  border-color: var(--strata-on-selected-muted);
  color: var(--strata-on-selected-muted);
}
.tpl.on .tpl-tags :deep(b) {
  color: var(--strata-on-selected);
}

/* 权限表：窄屏时横向滚动，物种那一列固定在左边 */
.mx-scroll {
  min-width: 0;
  padding-right: 1px;
  overflow-x: auto;
}
.mx {
  width: 100%;
  min-width: 600px;
  border-collapse: collapse;
}
.mx thead th {
  position: relative;
  height: 32px;
  padding: 0 8px 5px;
  border-bottom: 1px solid var(--strata-rule);
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-text-muted);
  text-align: left;
  vertical-align: bottom;
  white-space: nowrap;
}
.mx .col-layer {
  position: sticky;
  left: 0;
  z-index: 2;
  width: 1%;
  padding-left: 0;
  background: var(--ui-bg);
}
.mx .col-rw {
  width: 44px;
  text-align: center;
}
.mx .col-sens {
  width: 17%;
}
.mx-key {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.mx tbody th {
  padding: 0 12px 0 0;
  border-bottom: 1px solid var(--ui-border);
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
}
.lname {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.from-conv {
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-text-muted);
}
.mx td.col-rw {
  border-bottom: 1px solid var(--ui-border);
}
.mx td.col-rw input {
  width: 16px;
  height: 16px;
  margin: 0;
  vertical-align: middle;
  accent-color: var(--ui-text-highlighted);
  cursor: pointer;
}
.mx td.col-rw input:focus-visible {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: 2px;
}
.c {
  position: relative;
  height: 36px;
  padding: 0 8px;
  border: 1px solid var(--ui-border);
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
}
.c svg {
  position: absolute;
  inset: 0;
}
.c-label {
  position: relative;
  display: inline-block;
  margin-left: -3px;
  padding: 3px 5px;
  line-height: 1.2;
  color: var(--ui-text-highlighted);
  background: color-mix(in srgb, var(--c) var(--strata-tint), var(--ui-bg));
}
.c.read-write .c-label {
  background: var(--c);
  color: var(--strata-on-layer);
  font-weight: 500;
}
.c.explicit .c-label,
.c.explicit-write .c-label,
.c.explicit-extract .c-label {
  background: none;
  color: var(--strata-on-solid);
}
.c.extract .c-label,
.c.write .c-label {
  background: none;
}
.c-none,
.c-na {
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.c.edge::after,
.mx thead th.edge::after {
  content: '';
  position: absolute;
  top: -1px;
  bottom: -1px;
  right: -1px;
  z-index: 1;
  width: 2px;
  background: var(--strata-rule);
}
.mx .conv-end th,
.mx .conv-end td,
.mx .conv-end td.col-rw {
  border-bottom: 1px dashed var(--strata-rule);
}
.mx-legend {
  margin-top: 8px;
}

.field-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
}
.row-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  min-width: 7em;
  font-size: 14px;
  font-weight: 600;
}
.row-help {
  min-width: 0;
  font-size: 13px;
  color: var(--ui-text-muted);
}
.realm-box {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border-accented);
}
.realm-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.realm-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border: 1px solid var(--ui-border-accented);
  font-size: 13px;
  cursor: pointer;
}
.realm-chip.on {
  border-color: var(--strata-rule);
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.realm-chip code {
  font-family: var(--font-mono);
  font-size: 12px;
  opacity: 0.8;
}
.realm-custom {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}
.note-line.shortfall {
  margin-top: -8px;
}

@media (max-width: 760px) {
  .tpls {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .tpl:nth-child(2) {
    border-right: 0;
  }
  .tpl:nth-child(-n + 2) {
    border-bottom: 1px solid var(--ui-border);
  }
  .max-label {
    margin-left: 0;
  }
}
</style>
