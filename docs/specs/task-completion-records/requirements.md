# 任务完成交付记录需求

## 功能概述
任务完成后，系统应留下便于回看与 review 的交付说明和真实证据。完成说明与验收证据是两类信息：说明不能替代内核验证，也不代表人工 review 已通过。

## 需求列表
- **FR-1**：正常 `task.close` 必须接收非空 `summary`（完成结论）、`changes`（主要改动）、`limitations`（遗留限制；没有遗留时明确写“无”）。保留 `resolvedBy`、`contextNote` 原有语义。
- **FR-2**：门禁及证据全部通过后，系统 SHALL 将任务成功收口和一条不可变交付记录一起持久化到 SQLite。记录需关联执行人、时间、代码指纹、所核验的验收 run（命令、退出码、HEAD、指纹、runId、日志哈希）以及 Task-Id 归属提交。门禁失败时 SHALL NOT 写入成功记录。
- **FR-3**：任务打回后再次完成 SHALL 追加记录并保留历次记录。历史已完成但此前没有交付说明的任务应显示“未记录”，不得伪造内容。Owner force-close 应保留人工原因、标明强制完成且不伪造验收证据。
- **FR-4**：CLI `task show`、`task.close` 返回、控制台任务详情和 Markdown 导出须可查看交付说明及历史证据。浏览器输出必须转义用户输入。
- **FR-5**：CLI/MCP 指引应要求提交交付说明；系统不得把门禁收口描述成人工 review 已通过。

## 验收标准
- AC-1：Given 正常 `task.close`，When 任一说明字段缺失、空白、类型错误或超过长度上限，Then 系统 SHALL 返回明确错误且不标记任务完成；三项均有效时 SHALL 保存并返回同一说明。
- AC-2：Given Agent 仅在文字中声称“测试通过”，When 数据库没有本任务、当前指纹对应的真实验收证据，Then 系统 SHALL 拒绝收口；成功记录 SHALL 快照当前收口实际核验的证据。
- AC-3：Given 任务被打回后重新完成，When 第二次收口成功，Then 系统 SHALL 保留第一条并追加第二条有序记录；旧数据库迁移 SHALL 可重复运行且保留原任务。
- AC-4：Given 存在完成记录，When 从 CLI、控制台或导出查看，Then 每条说明、历史、证据与归属提交 SHALL 可核对，动态 HTML 文本 SHALL 已转义；强制完成 SHALL 与验收通过明确区分。
- AC-5：Given 功能变更完成，When 执行冻结验收，Then `npm test`、`npm run build`、`npm run packcheck` SHALL 全部退出码为 0。

## 非功能需求
- NFR-1：新增数据采用向后兼容、幂等的 SQLite schema 迁移。
- NFR-2：成功任务状态与交付记录必须原子提交，不得使用 best-effort 写入。
- NFR-3：不新增外部依赖、不覆盖已有未提交改动、不自动发布或更新全局安装。
- NFR-4：字段须为字符串并限长：summary 4000、changes 16000、limitations 8000 字符。

## 依赖关系
FR-2 依赖既有 `task.close` 证据与 Task-Id 提交核验；FR-3 依赖历史追加和 Owner force-close 事件；FR-4 复用统一 SQLite 读取，避免 CLI、控制台、导出各自拼装不同事实。`resolvedBy` 和 `contextNote` 继续与交付说明分开。

## 约束与历史经验
UI 必须从 SQLite 权威数据读取，避免本地缓存遗漏新记录。外部或历史文本校验时先验证类型再执行长度与字符串操作。best-effort 通知写入模式不适用于任务完成记录与 done 状态的原子保存。所有改动限制在 T-001 scope 内；原验证门禁、审批权限与人工 review 流程不改变。
