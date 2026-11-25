# 0002. 以自动短 ID、多切面变体与双链取代多级 URL 路径树

- 状态：已被 [0004](0004-flat-single-owner-v2.md) 部分取代（2026-11-24，保留 Base30 短 ID 与 `[[m-xxxxxx]]` 双链）
- 日期：2026-11-18

## 背景

从 Lore 继承的多级路径坐标（`<domain>://<位置>/<标识>`）在多端、多场景记忆体系下带来了四个结构性问题：
1. **单亲树无法表达多维交叉**：同时涉及「公司」「Windows」「家里网络」的记忆难以选择唯一父路径；
2. **身份地址与分类耦合**：修改归属或位置就必须 `move` 改变坐标，导致外部引用与内部关联断链，并迫使服务端维护复杂的 `claimUri` 过期释放与 409 占坑检测逻辑；
3. **跨环境规范打架**：Git 规范、终端环境等同一主题在不同机器与场域下的要求相反，拆成多条独立卡片后容易在启动加载或召回中互相污染；
4. **记忆物种割裂**：对话抽取的联系人事实（`fact`）与会话摘要（`episode`）没有坐标、不建向量索引，导致超过直连条数上限后的远期事实彻底遗忘。

## 决策

1. **废除多级 URL 路径树，采用自动短 ID + 标题寻址**：所有词条由服务端自动生成全实例全局唯一、不可变的无歧义 Base30 短 ID `m-<6位>`（`UNIQUE (short_id)`，含已软删除行；字符集 `23456789abcdefghjkmnpqrstvwxyz`，输入大小写不敏感、存储统一小写，碰撞重试），配合自然语言标题与非互斥主题标签 `topics` 进行组织与动态聚合浏览。彻底移除 `move`、`claimUri` 与占用冲突（跨圈迁移 `kioku_transfer` 与软删除恢复永不撞号；按圈导入成新圈遇到目标实例已存在的 `short_id` 时，由导入器静默分配新短 ID 并流式重写包内正文与双链中的 `[[旧ID]]`），保留 `legacy_uris` 表仅作旧数据迁入后的读取重定向兜底。
2. **统一词条物种与持久检索**：正式词条（`entry`）、联系人/群事实（`fact`）与会话摘要（`episode`，强制仅含单个无条件切片 `when = {}`）共用 `entries` 表与短 ID 体系；非机密且有效的 `entry` 与 `fact` 均建立 1024 维向量索引与全文索引，支持远期事实按作用域语义召回与弹窗新建提炼升级为 `entry`。
3. **引入「词条头 + 多切面变体（`entry_variants`）」**：普通记忆退化为单个无条件切片（`when = {}`）；跨环境同主题记忆可在同一词条下挂多个带 `when` 条件的切片（增删切片统一由 `kioku_update` 完成并保证词条至少保留 1 个切片，`kioku_delete` 只软删除整条词条）。`entry_variants` 通过 `(circle_id, entry_id) ON DELETE CASCADE` 与声明为 **`DEFERRABLE INITIALLY DEFERRED`** 的复合外键 `(circle_id, entry_id, sensitivity, kind) REFERENCES entries(circle_id, id, sensitivity, kind)` 在提交前强校验敏感级与物种一致性（避免 `ON UPDATE CASCADE` 在升降级敏感级时先于正文加解密触发本表 `CHECK`），并在本表保留 `CHECK` 约束死锁机密切片 `content IS NULL AND search_header = '' AND ciphertext IS NOT NULL AND wrapped_key IS NOT NULL`（非机密切片则强制 `content IS NOT NULL AND ciphertext IS NULL AND wrapped_key IS NULL`）；`fts` 基于同事务维护的本表 `search_header` 与 `content` 生成（严禁跨表引用）；机密级（`secret`）词条下所有切片正文统一信封加密（`aad` 绑定 `variant:<id>`）。
4. **支持 `[[m-xxxxxx]]` 双链图谱与 1 跳语境扩散**：边表 `entry_links` 以 `(source_variant_id, target_short_id)` 细化至切片粒度，写入时线性扫描正文中的双链标记重写出链（`secret` 词条与 `untrusted` 未确认来源不写明文出链；`secret` 降级或 `untrusted` 事实经 `confirm` 确认提升为 `owner` 时同步扫描补建出链；保留悬空目标边以支持跨圈与软删除恢复）；输出时仅为调用方当前可读的目标补全最新标题；召回对高分种子词条检查 1 跳双向可读邻居（正向仅从当前无互斥冲突的切片出发，反向按 `target_short_id` 跨圈反查并校验源切片无冲突），将与当前在场切面同频共振的邻居衰减并入候选（标记 `via: link`）。

## 后果

- 彻底消除命名负担、搬家断链与同实例导入冲突，同主题多环境规范可在一处集中维护与对比，机密明文死锁约束在拆表后依然在数据库层闭环。
- 读取、修改、加密与历史快照需围绕「词条头 + 变体切片列表」重构契约与 MCP 工具签名（如 `kioku_get`、`kioku_browse` 取代旧的 `kioku_list` 与 `kioku_move`）。
- 迁入工具需要将旧版 Kioku 与 Lore 的路径拆分为 `topics` 与 `legacy_uris` 映射。

## 可推翻条件

若全实例累计词条量级突破数千万级导致 6 位 Base30（$30^6 = 7.29 \times 10^8$）随机分配碰撞重试率显著上升，可将新生成短 ID 平滑扩展至 8 位并保持校验正则向下兼容旧 6 位 ID。
