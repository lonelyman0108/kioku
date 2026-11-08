<script setup lang="ts">
import {
  CREDENTIAL_CAPABILITIES,
  LAYERS,
  SENSITIVITIES,
  sensitivityAllowed,
  type CredentialCapability,
  type KeyScopes,
  type Layer,
  type Sensitivity,
} from '@kioku/contracts'
import { computed, useId } from 'vue'

import {
  ADMIN_SCOPE_LABEL,
  credentialCapabilityLabels,
  layerLabels,
  sensitivityLabels,
} from '../labels'
import Hint from './Hint.vue'
import {
  CUSTOM_PRESET,
  CUSTOM_PRESET_HELP,
  allowedCredentialCapability,
  issuedCredentialCapability,
  keyPresets,
  matchPreset,
  presetScopes,
} from './keyPresets'
import NoteLine from './strata/NoteLine.vue'
import SegmentedChoice from './SegmentedChoice.vue'
import AccessLegend from './strata/AccessLegend.vue'
import ScopeTags from './strata/ScopeTags.vue'
import StrataCore from './strata/StrataCore.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import {
  ACCESS_BAR_PERCENT,
  accessCellText,
  accessFill,
  accessKind,
  accessKindLabels,
  accessKindShortLabels,
  isConversationLayer,
  issuedScopeRows,
  orderRows,
  paintAccess,
  presentKinds,
  sensitivityHints,
  type AccessKind,
  type AccessRow,
  type PaintRect,
} from './strata/strata'

// 签发访问密钥时编辑签发范围：上面四张模板卡片，下面一张权限表直接勾选。
// 改了任何一格或任何一个控件，就按 matchPreset 重新对：和某个模板完全一样时选中它，否则选中自定义。
// 格子的判断只用 issuedScopeRows 与 accessKind，和岩芯、权限范围是同一套
const scopes = defineModel<KeyScopes>('scopes', { required: true })
const preset = defineModel<string>('preset', { required: true })
const props = defineProps<{ isSpaceOwner: boolean }>()
const uid = useId()

const cards = computed(() => [
  ...keyPresets.map((p) => ({
    id: p.id,
    label: p.label,
    help: p.help,
    scopes: presetScopes(p, props.isSpaceOwner),
  })),
  { id: CUSTOM_PRESET, label: '自定义', help: CUSTOM_PRESET_HELP, scopes: scopes.value },
])

function update(patch: Partial<KeyScopes>) {
  const next = { ...scopes.value, ...patch }
  scopes.value = next
  preset.value = matchPreset(next, props.isSpaceOwner)
}

// 选模板：换成模板（按签发人收紧之后）的权限；选自定义只换卡片，权限照旧，接着在表格里改
function pick(id: string) {
  preset.value = id
  const found = keyPresets.find((p) => p.id === id)
  if (found) scopes.value = presetScopes(found, props.isSpaceOwner)
}

// 归属按 LAYERS 的顺序存，先后不影响比较（sameScopes 不看顺序）
function toggle(field: 'readLayers' | 'writeLayers', layer: Layer, on: boolean) {
  const list = scopes.value[field]
  update({ [field]: LAYERS.filter((l) => (l === layer ? on : list.includes(l))) })
}
const checkedOf = (event: Event) => (event.target as HTMLInputElement).checked

const accessRows = computed(() => orderRows(issuedScopeRows(scopes.value)))
// 边界线画在最高敏感级那一列的右侧
const edge = computed(() => SENSITIVITIES.indexOf(scopes.value.maxSensitivity))

// 每一格的种类、能不能有这一级（本人不设公开）、画法与说明，跟着签发范围一次算好，模板只读结果
interface EditorCell {
  sensitivity: Sensitivity
  kind: AccessKind
  allowed: boolean
  title: string
  paint: PaintRect[]
}
const FULL = { x: 0, y: 0, width: '100%', height: '100%' }
const rows = computed(() =>
  accessRows.value.map((row: AccessRow) => ({
    layer: row.layer,
    cells: SENSITIVITIES.map((sensitivity): EditorCell => {
      const cell = row.cells.find((c) => c.sensitivity === sensitivity)
      const kind: AccessKind = cell ? accessKind(row.layer, cell) : 'none'
      const allowed = sensitivityAllowed(row.layer, sensitivity)
      return {
        sensitivity,
        kind,
        allowed,
        title: accessCellText(row.layer, sensitivity, kind),
        paint:
          allowed && kind !== 'none'
            ? paintAccess(row.layer, sensitivity, kind, FULL, ACCESS_BAR_PERCENT, 'lg')
            : [],
      }
    }),
  })),
)
const legendKinds = computed(() => presentKinds(accessRows.value))

// 机密级与跨人格写入只给空间所有者，编辑者签不出来，选项禁用
const maxItems = computed(() =>
  SENSITIVITIES.map((s) => ({
    value: s,
    label: sensitivityLabels[s],
    disabled: s === 'secret' && !props.isSpaceOwner,
  })),
)

// 凭据能力只有空间所有者能选取用与管理；别的成员只有不可用可选
const credentialItems = computed(() =>
  CREDENTIAL_CAPABILITIES.map((c) => ({
    value: c,
    label: credentialCapabilityLabels[c],
    disabled: allowedCredentialCapability(c, props.isSpaceOwner) !== c,
  })),
)
const credentialHelp: Record<CredentialCapability, string> = {
  none: '不能列出与取用凭据',
  use: '列出凭据并取值',
  manage: '另可新建、修改、删除凭据',
}
// 按签发范围实际能用到的凭据能力，和所选的不同时提示
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
          <StrataCore :scopes="card.scopes" :width="28" :height="44" aria-hidden="true" />
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
          权限<Hint>
            按归属与敏感级换算的签发范围，不是实际权限：人格、应用与会话上下文另有规则，签发后在权限范围里查看。机密仅可按坐标读取；联系人与会话的写入指对话抽取。粗线右侧超出最高敏感级。
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
      <p v-if="!isSpaceOwner" class="field-note block-note">仅空间所有者可签发机密级</p>
      <div class="mx-scroll">
        <table class="mx">
          <thead>
            <tr>
              <th scope="col" class="col-layer">归属</th>
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
            <tr
              v-for="row in rows"
              :key="row.layer"
              :class="{ 'conv-end': row.layer === 'subject' }"
            >
              <th scope="row" class="col-layer">
                <span class="lname">
                  <StrataSwatch :layer="row.layer" plain decorative :width="14" :height="10" />
                  <span>{{ layerLabels[row.layer] }}</span>
                  <span v-if="isConversationLayer(row.layer)" class="from-conv">来自对话</span>
                </span>
              </th>
              <td class="col-rw">
                <input
                  type="checkbox"
                  :aria-label="`读 ${layerLabels[row.layer]}`"
                  :checked="scopes.readLayers.includes(row.layer)"
                  @change="toggle('readLayers', row.layer, checkedOf($event))"
                />
              </td>
              <td class="col-rw">
                <input
                  type="checkbox"
                  :aria-label="`写 ${layerLabels[row.layer]}`"
                  :checked="scopes.writeLayers.includes(row.layer)"
                  @change="toggle('writeLayers', row.layer, checkedOf($event))"
                />
              </td>
              <td
                v-for="(cell, i) in row.cells"
                :key="cell.sensitivity"
                class="c"
                :class="[cell.kind, { edge: i === edge, na: !cell.allowed }]"
                :style="{ '--c': accessFill(row.layer) }"
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

    <div class="field-row">
      <span class="row-label">凭据能力</span>
      <SegmentedChoice
        :model-value="scopes.credentials"
        :items="credentialItems"
        label="凭据能力"
        @update:model-value="(v) => update({ credentials: v })"
      />
      <span class="row-help">
        <template v-if="!isSpaceOwner">仅空间所有者的应用可以取用或管理凭据。</template>
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
        :disabled="!isSpaceOwner"
        :aria-label="ADMIN_SCOPE_LABEL"
        @update:model-value="(v: boolean) => update({ admin: v })"
      />
      <span class="row-help">
        可写入任意人格与应用的记忆<template v-if="!isSpaceOwner">；仅空间所有者可开启</template>
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

/* 权限表：窄屏时横向滚动，归属那一列固定在左边 */
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
/* 文字压在色带上：标签自己铺一块底色，把纹理挖掉 */
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
