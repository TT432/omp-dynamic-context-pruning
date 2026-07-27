# DCP 精简 + 锚点压缩 规格

## 目标

将 dcp 插件精简为只提供压缩能力：`add_anchor`（打锚点）+ `compress`（按锚点压缩）。
移除策略（dedup/purge-errors）、nudge、slash 命令、protected patterns/content、分层配置系统、
内容签名身份机制、文本引用锚点解析。

## 功能需求

### FR-1 add_anchor 工具

- 签名：`add_anchor({ anchor: string })`。
- 语义：该次工具调用本身成为对话中的具名锚点；身份 = tool_use id（provider 分配、全局唯一、持久化）。
- 校验（失败抛错，无副作用）：
  - 名字非空、不含空白、长度 ≤ 64；
  - `session_start` 为保留名，禁止占用；
  - 会话历史（branch）中已存在同名 add_anchor 调用 → 拒绝重复（排除自身 toolCallId）。
- 结果：确认文本，提示可在 compress 中作为 startAnchor/endAnchor 引用。

### FR-2 session_start 虚拟锚点

- 插件在每次 context 转换时，于**第一条用户消息**（role=user 且不含 tool_result 的消息，即原始提示词）
  之后注入标记消息 `[anchor: session_start]`。
- 保留：该锚点不被任何压缩消耗，始终可见、始终可作为 startAnchor 使用。
- 无用户消息时锚点不可用；以它为起点的压缩块视为不可解析（丢弃并记录）。

### FR-3 compress 工具

- 签名：`compress({ startAnchor, endAnchor, summary })`。
- 解析：在持久化 branch 消息上扫描锚点（add_anchor tool_use + session_start 虚拟锚点）。
- 区间语义（对 LLM 可见上下文而言）：
  - 起点为真实锚点：剥除起点 add_anchor 的 tool_use 块及其 tool_result 块（同消息其他内容保留，
    空消息整条删除）——**起点锚点被消耗**；整条删除 (startMsgIdx, endMsgIdx) 开区间内的消息。
  - 起点为 session_start：虚拟标记保留；整条删除 [firstUser+1, endMsgIdx) 内的消息。
  - **终点锚点保留**：endMsgIdx 消息及其 tool_result 不动。
  - 摘要作为合成 user 消息注入在终点锚点消息**之前**（占据被压缩区间的原位置），
    格式 `[Compressed {start} → {end}]\n{summary}`。
  - 本次 compress 调用本身（tool_use + tool_result，按 toolCallId）从未来上下文中剥除。
- 校验（失败抛错，状态不变）：
  - startAnchor/endAnchor 未找到 → 报错并列出可用锚点；
  - startAnchor == endAnchor，或起点位置 ≥ 终点位置 → 报错；
  - 空区间（开区间内无消息）→ 报错；
  - endAnchor 已是某活跃压缩块的终点 → 报错（应从该锚点链式继续）；
  - 与活跃块部分重叠 → 报错。
- 消耗/保留规则（lo = 真实起点 msgIndex 或 firstUser+1，hi = endMsgIdx）：
  - 链式（活跃块 B 的终点 == 新起点）：**保留** B——其摘要位于新起点消息之前，不在新
    区间内，摘要按序累加，形成有序记录；
  - 完全包含（B 终点 ∈ (lo, hi) 且 B 起点 ≥ lo）：B 被新块吸收（删除 B；模型应在新
    summary 中承接要点）；
  - B 起点 < lo 且 B 终点 ∈ (lo, hi)：部分重叠 → 拒绝。
- 后置条件：state.blocks 增加新块；被吸收块删除；dirty=true 并持久化。

### FR-4 context 钩子

- 每次 LLM 请求：克隆消息 → 应用全部活跃压缩块（剥除/删除/注入摘要）→ 注入 session_start 标记 → 返回。
- 块的锚点在当期消息中不可解析（fork/compaction 残余）→ 丢弃该块、置 dirty、记日志。
- 持久化会话永不修改（只改克隆副本）。

### FR-5 生命周期与持久化

- session_start / session_switch：绑定（id 变化则重置）+ 从 branch 最新 dcp-state custom entry 加载。
- session_before_switch / session_shutdown：dirty 时冲刷。
- session_compact（含 context 中检测到的 omp 压缩）：清空全部压缩块并持久化。
- 持久化格式 v2：`{ v:2, sessionId, nextBlockId, blocks:[{id,startName,startToolUseId,endName,endToolUseId,summary,compressCallId,createdAt}] }`。
  v1 条目直接忽略。

## 非功能需求

- NFR-1 存储不变量：session 历史字节不动，转换只作用于 LLM 请求副本。
- NFR-2 tool_use/tool_result 成对剥除，不留孤儿块；剥除后空消息整条删除。
- NFR-3 `tsc --noEmit` 通过；`bun smoke-test.ts` 全绿。
- NFR-4 无配置文件；调试开关只用环境变量 `DCP_DEBUG`。

## 不变量

- INV-1 任意两个存活压缩块的终点锚点位置不同（same-end 拒绝保证）。
- INV-2 存活块的终点锚点与摘要注入点不被其他存活块消耗（消耗/重叠规则保证）。
- INV-3 锚点名在会话内唯一（add_anchor 校验保证）；`session_start` 恒可用（有用户消息时）。
- INV-4 压缩失败（抛错）不改变 state.blocks。

## 删除清单

src/config.ts、src/commands.ts、src/token-utils.ts、src/protected-patterns.ts、
src/compress/、src/messages/、src/prompts/、src/state/（旧四件套）、dcp.schema.json。
保留：src/omp.d.ts、src/logger.ts。
