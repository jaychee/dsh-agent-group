# dsh-agent-squad

给 DeepSeek Harness 加一个**按角色分工、显式启用（opt-in）的本地多智能体小队**：Lead 负责组织与分配，brain 负责业务方案与业务验收，architect 负责技术规格与技术验收，worker 负责实现与自测；返工复用同一个队友会话，而不是每次新建对话。

**默认不启用**：普通会话就是普通会话，看不到任何 squad 工具或章程。只有用户明确说"用小队实现 / 用智能体小队"时，Lead 才调用 `squad_enable` 进入小队；**仅提到队友名字（codex/gpt/zcode/qoder）不算启用**。插件重载后若会话失去 Lead 身份，再次 `squad_enable` 即可恢复。

```text
用户 ──▶ Lead (DSH 当前会话)
             ├─ codex  [brain]      业务方案 / 验收标准 / 业务验收
             ├─ gpt    [architect]  技术规格 / 技术验收 / 必要时接手实现
             ├─ zcode  [worker]     后端开发 / 后端自测
             └─ qoder  [worker]     前端产品开发 / 前端自测
```

插件本身很薄：它挂在 DSH 0.2.x 内置的标准 **subagent 运行时**（`ctx.subagents`：`startActivation`/`sendMessage`/`listDescendants`/`rootOf`）上，补上 DSH 缺的几件事：

1. **命名 + 角色**：四个固定 teammate（codex / gpt / zcode / qoder），角色决定系统提示里的职责章程与可见工具；
2. **共享记忆**：每个任务一个 `.agent-squad/<task>/` 目录，TASK / PLAN / SPEC / TECH-REVIEW / REVIEW / REPORT / JOURNAL 承载任务、业务方案、技术规格、技术验收、业务验收、交付证据与历史，所有成员读写同一份；
3. **会话复用**：队友是 Lead 的持久、可续跑子会话；重复 `squad_dispatch` 同一个队友 = 往同一会话追加消息，返工天然复用上一轮上下文。

## 角色

| 角色 | 谁 | 职责 | 工具 |
| --- | --- | --- | --- |
| `lead` | 当前 DSH 会话（启用后） | 拆解流程、审核并批准业务方案、决定派单顺序、汇总交付；不写业务代码 | `squad_enable` / `squad_start` / `squad_dispatch` / `squad_approve_plan` / `squad_extend` / `squad_status` / `squad_wait` / `squad_finish` |
| `brain` | codex | 业务方案（PLAN.md）与业务验收（REVIEW.md）；可澄清方案，改业务行为必须先请用户决策 | `squad_report` |
| `architect` | gpt（本地固定模型 `openai/gpt-6.2-sol`） | 技术规格（SPEC.md）与技术验收（TECH-REVIEW.md）；worker 不可用或技术返工到限时接手实现，但不能自签自己改动的技术验收 | `squad_report` |
| `worker` | zcode / qoder | zcode 后端实现自测；qoder **主责前端产品开发与自测，兼做后端代码开发** | `squad_report` |

任何角色（含 brain、architect 与 Lead）都可以通过设置里的 **worker 能力开关**以 worker 身份并行实现代码：`agents[].worker`（brain 默认关、architect/worker 默认开）与顶层 `leaderWorker`（Lead 默认关）。开启后该角色可接 implement/rework 派单；实现过代码的角色不能签署自己实现的技术验收。

角色章程可以在插件配置里整段替换（`brainCharter` / `architectCharter` / `workerCharter`），单个 agent 也可以用 `charter` 覆盖。默认章程为中文；Lead 策略额外要求**面向用户始终使用用户的语言**，章程语言不影响回复语言。

### brain 章程（要点）

- 把业务目标写成可执行业务方案，存入 PLAN.md：对外行为、用户可见结果、边界场景与编号验收标准（AC）。
- 涉及对外接口时逐项写明接口契约与错误行为；没有接口变更时明确写“无接口变更”，并列出须保留的对外行为。
- 列出边界输入与精确期望值；每条 AC 必须给出可直接执行的验收命令、执行目录、退出码与通过条件。
- 在“假设与待确认”中显式列出假设及影响；未确定且影响交付的事项标为待确认，不能让架构师或 worker 猜测。禁止使用“适当”“合理”“类似”“等等”“参考现有实现”替代具体规格。
- 你可以澄清方案；但要改变原有业务功能、对外结果或验收标准，必须先请用户决策，不得擅自变更。
- 写完后自检“一个没有上下文的架构师能否只靠 PLAN 拍板技术设计”，把结论写入 PLAN.md；不能时补全方案，或列入“假设与待确认”并标明阻塞项，不得宣称方案可执行。
- 业务验收轮以 PLAN-APPROVED.md 为唯一权威业务规格，逐条核对 AC 并在 REVIEW.md 写明 AC 编号、验证命令、退出码、关键输出与结论；亲自运行或检查，不接受没有证据的声明。技术结论对照 SPEC.md 与 TECH-REVIEW.md，不替技术验收背书。
- 当架构师接手实现时，由你对照 SPEC.md 亲自运行验证测试并代签技术验收：在 TECH-REVIEW.md 记录命令、退出码、关键输出与编号缺陷，最后一行同样是「VERDICT: APPROVED」或「VERDICT: CHANGES_REQUESTED」；之后再按业务方案单独签署业务验收，两份验收独立记录。

### architect 章程（要点）

- 设计轮（spec）读取已批准的业务方案 PLAN-APPROVED.md；对缺失的技术设计拍板，对已有设计审核、补充。
- 把技术规格写入 SPEC.md，至少覆盖适用的：代码结构、文件与模块职责、数据库表与迁移、领域模型及其依赖、对外接口与错误行为、各模块实现、可执行验证用例；对不适用的部分逐项明确说明“不适用”。
- 技术实现可以调整，但不能擅改业务行为；若必须改业务预期，暂停受影响工作并在报告中交 Lead 转用户决策。
- 规格有问题时按 worker 的上报修订并发布新版本（更新 SPEC.md，版本号以派单为准）；单纯澄清规格不扣返工额度，也不重置已用额度。
- 技术验收轮（tech-review）以当前 SPEC.md 为唯一权威技术规格：做代码审查、亲自运行验证测试，在 TECH-REVIEW.md 逐条记录需求/AC 编号、命令、退出码、关键输出与可执行的编号缺陷清单。
- 接手实现时按 worker 章程执行并自测，但你不能签署自己改动的技术验收：插件会拒绝对你派 tech-review；交由 brain（codex）对照 SPEC.md 独立代签技术验收。

### worker 章程（要点）

- 动手前先读 TASK.md、PLAN-APPROVED.md（业务方案）与 SPEC.md（技术规格）。PLAN-APPROVED.md 是业务方案与业务验收的唯一权威规格；SPEC.md 是技术实现、返工与技术验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。
- 只做规格定义的最小改动；不得引入规格未定义的接口、文件或依赖，不重新设计、不改名、不扩大范围。
- 规格缺失、矛盾或明显错误时立即停止实现，报 "blocked"，引用 PLAN-APPROVED.md/SPEC.md 的具体章节与编号，并列出缺失项或冲突原文；需要归档而文件缺失时明确引用文件名；豁免任务引用 TASK.md 章节或 Lead 派单条目。规格有问题上报 Lead 转 gpt 修订发布，不自行偏离或改用 PLAN.md。
- 按 SPEC.md 指定的测试名、输入与期望输出写或更新测试，并亲自运行每条 AC 的验收命令；豁免任务按 TASK.md 与 Lead 本轮派单执行。
- 在 REPORT.md 逐条 AC 给证据：AC 编号、改动文件路径、测试名、实际命令、退出码、关键输出与结论；失败或未执行必须如实标注，不得只写“测试通过”。
- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md/SPEC.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/TECH-REVIEW.md/REVIEW.md 按对应规格逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。

## 使用

对任意会话说"**用智能体小队把这个需求做掉：……**"。Lead 会先 `squad_enable`，然后按固定流程推进（**先审方案再实现**，完整流程为默认）：

1. `squad_start` 建任务与共享记忆（可选 `flow="simple"` 走简化流程，适合非代码任务）；**默认同时创建 worktree + 新分支，并把会话切过去**；
2. `squad_dispatch(codex, phase="design")` → brain 写业务方案 `PLAN.md`；
3. **Lead 审核 `PLAN.md`**：假装自己是没有上下文的架构师，无法只靠 PLAN 拍板技术设计的点一律按 D1 起连续编号，写明章节、缺失或矛盾、最小补全要求，再派回 brain。有问题就把编号缺陷派回 brain（`phase="design"` 返工）；设计预算默认 4 次，未扩展时第 5 次暂停——先向用户说明阻塞点并等待决策，用户同意后用 `squad_extend(kind="design", rounds=3, reason="用户批准的追加理由", confirmed=true)` 追加轮次再派。方案合格后调用 **`squad_approve_plan`** 批准（归档 `PLAN-APPROVED.md`）；
4. `squad_dispatch(gpt, phase="spec")` → architect 发布技术规格 `SPEC.md`（可多轮修订，不占返工额度）；**规格交付后即可派工，不需要 Lead 再审批**；
5. `squad_dispatch(zcode 或 qoder, phase="implement")` → worker 按 PLAN-APPROVED.md + SPEC.md 在 worktree 里实现并自测，写 `REPORT.md`，逐条 AC 给证据；
6. `squad_dispatch(gpt, phase="tech-review")` → 技术验收，写 `TECH-REVIEW.md`（`VERDICT: APPROVED|CHANGES_REQUESTED`）；
7. 技术验收不通过 → 把编号缺陷派回对应 worker（`phase="rework"`，技术返工预算 3 轮，前后端共享；未扩展时第 4 轮暂停——先向用户说明阻塞点并等待决策，用户同意后用 `squad_extend(kind="tech", rounds=3, reason="用户批准的追加理由", confirmed=true)` 追加轮次再派；
8. 技术验收通过 → `squad_dispatch(codex, phase="review")` → 业务验收，写 `REVIEW.md`；
9. 业务验收不通过 → `phase="rework"`（业务返工预算 3 轮，与技术额度独立；**业务返工改了代码后必须重新通过技术验收**）；未扩展时第 4 轮暂停——先向用户说明阻塞点并等待决策，用户同意后用 `squad_extend(kind="business", rounds=3, reason="用户批准的追加理由", confirmed=true)` 追加轮次再派；
10. 两份验收都 `approved` 且仍然新鲜 → `squad_finish`：逐仓提交 worktree 改动、切回主仓库源目录、给出每仓分支与合并命令。

> 三种批准相互独立：`squad_approve_plan`（Lead）批准的是**业务方案**，`TECH-REVIEW.md` 的 `VERDICT: APPROVED`（技术验收）与 `REVIEW.md` 的 `VERDICT: APPROVED`（业务验收）各自独立签署；任何一个不能替代另一个。**两份验收必须对应同一版候选代码、业务方案与技术规格**：任一变化（代码轮次 codeEpoch、规格版本 specVersion 变动）使旧结论失效，不能用旧批准收尾。

### 接手实现与代签

- 对应 worker 不可用时，Lead 可以直接派 gpt 接手实现（`phase="implement"/"rework"`）；
- 三轮技术返工仍未通过时，Lead 先向用户说明阻塞点并等待决策；用户同意继续后直接派 gpt 接手，**不需要再次确认选人**；
- gpt 接手写代码后可以自测，但**不能签署自己改动的技术验收**（插件会拒绝）：tech-review 改派 codex 对照 SPEC.md 独立代签技术验收，业务验收仍由 codex 按业务方案单独签署，两份验收独立记录。

### 架构师容错（failover，额度耗尽自动交接）

gpt（架构师）因**额度耗尽**等原因不可用时，插件把 gpt **挂起**并把架构师职责（SPEC.md 技术规格、TECH-REVIEW.md 技术验收）交给 **codex（brain）代行**，完成剩下的任务；gpt 挂起直到恢复：

- **自动触发**：① 对 gpt 的派单失败且错误匹配额度特征（额度/余额/欠费/限流/quota/insufficient/balance/exceeded/429/rate limit）→ 自动挂起，报错附交接指引；② gpt 以 `squad_report` 上报 `blocked` 且摘要匹配额度特征 → 自动挂起。
- **手动触发/恢复**（Lead 工具 `squad_failover`）：挂起 `squad_failover({ agent: "gpt", reason: "原因" })`；用户确认额度恢复后 `squad_failover({ agent: "gpt", recover: true })` 交还职责。
- **挂起期间**：对 gpt 的任何派单被拒绝（提示改派 codex）；`spec` 阶段放行 codex（代行架构师，派单提示注明"代行架构师职责"）；`tech-review` 本就允许 codex。非额度类派单错误**不会**触发挂起。
- **持久化**：挂起状态存 `~/.dsh/agent-squad/failover.json`，插件重载/DSH 重启后仍生效，直到显式恢复；`squad_status` 显示"挂起：gpt（自 …；自动/手动；原因 …）"。
- 代行期间 codex 产出的 SPEC.md 与 TECH-REVIEW.md 是正式记录；验收新鲜度规则不变（代行产生的技术验收同样绑定 codeEpoch/specVersion）。

### 并行开发（默认运行方式，两层并行）

- **任何角色都可当 worker**：设置页每个成员有 worker 能力开关（`agents[].worker`），另有顶层 `leaderWorker` 开关——brain（codex）、architect（gpt）与 Lead 开启后都能作为 Worker 参与并行实现（实现者不参与自签验收）。
- **worker 内部并行（默认）**：ZCode CLI 自带 subagent 体系（Task/Agent 工具），Qoder CLI 亦有 subagent（默认启用的实验设置）与 Workflow parallel/pipeline 编排；ACP/CLI 通道均不过滤工具、权限自动放行。worker 章程与 implement/rework 派单提示内置"并行默认"引导：交办包含多个独立文件/模块时，worker 默认用自己的子代理同时开发；不独立的部分串行完成；边界不变（只改规格内文件、逐条 AC 留证、汇总写 REPORT.md）。
- **小队级并行（默认）**：external 执行者的 `implement`/`rework` 派单**默认后台派发**（`delivery: 'parent'`）——工具调用立即返回、结果完成时以后台消息送达 Lead，因此 Lead **默认可以连续并发派多个 worker**（如 zcode 后端 + qoder 前端同时跑）。需要在本回合同步拿到结果时传 `background: false` 恢复阻塞式；`design/spec/review/tech-review` 始终同步（需读取交付物）；local/team 执行者本就不阻塞。
- `squad_status` 显示"后台执行器运行中：N 个"；`squad_finish` 会等所有后台执行器结束。同一队友运行中的重复派单仍受 R07 守卫限制。

### 不阻塞主会话（所有 external 阶段默认后台）

所有 external 派单——包括 codex 的 `design`/`review`、gpt 的 `spec`/`tech-review`、worker 的 `implement`/`rework`——**默认后台派发**（`delivery: 'parent'`）：工具调用立即返回，Lead 结束本回合，用户可继续操作；结果完成时以后台消息送达，下一次工具调用会把待记账结果落盘（design → `PLAN-R<n>.md`；spec → `SPEC-V<n>.md`；review/tech-review → verdict + `REVIEW-R<n>.md`）。验收绑定（codeEpoch/specVersion）在派单时即记录，保证"验收对应哪版代码"不错位。

- 后台任务在跑时，`squad_approve_plan` / `squad_deliver` / `squad_finish` 会拒绝并提示"后台任务仍在运行：…"，`squad_status` 进度里显示"后台运行中：…"；
- 需要在本回合同步拿结果（脚本化、必须立刻读交付物）时传 `background: false` 恢复阻塞式；
- local/team 执行者本就不阻塞；
- **可用性探测**是唯一仍同步的步骤（约一次短往返）：成功后按 `probeTtlMs`（默认 10 分钟）在 profile 级 `probe-cache.json` 缓存，跨任务复用；`probe: true` 强制重探，`probe: false` 跳过，`workerProbe: false` 全局关闭；`squad_failover(recover)` 会清掉该成员的缓存；
- `squad_wait` 按设计会阻塞（最长 10 分钟），非必要不要用。

### 进度同步与分层展示

- **自动同步**：派单、方案批准、开启并行、交付、收尾以及收到队友 `squad_report` 时，插件自动把最新进度写入共享记忆的 `PROGRESS.md`（任务总览 → 分阶段进度 → 队员进度 → 并行特性，含门禁/验收状态、各队员最近一轮与运行状态）。
- **分层视图**：`squad_status` 顶部直接输出同一份分层进度，之后才是门禁/预算/成员/文件/派单明细。
- **汇报口径**：`squad_report` 转发给 Lead 的消息附带一行"进度同步：…"（阶段与特性合并进度）；Lead 章程要求在阶段完成、关键报告、交付与收尾时按分层进度向用户简报。

### 阶段化并行（强制工作流）

拆分任务时的固定顺序（插件门禁强制，不是建议）：

1. **基础层串行**：通用/底层功能排在前面，**一次只派一个 worker 串行开发**（不要同时派多个）；
2. **基础层交付**：完成技术+业务验收后，`squad_deliver({ summary })` 把任务 worktree 分支**合并到 Base 分支**（"当前项目所在分支"，源仓库必须切在 Base 上）；合并冲突会报错且不标记完成；
3. **开启并行**：只有基础层交付后，`squad_parallel_start({ features: [{ name, focus? }] })` 才允许执行——基于 **Base 分支 HEAD** 为每个业务特性创建独立 worktree 与分支 `squad-<task>-<feature>`（记录基线提交）；
4. **并行开发**：`squad_dispatch({ …, feature: "<name>" })` 把特性派给不同 worker（默认后台并行，多个特性同时跑）；基础层交付后**不带 feature 的 implement/rework 会被拒绝**；
5. **特性交付**：每个特性完成后 `squad_deliver({ feature: "<name>" })` 直接合入 Base；未全部合并前 `squad_finish` 会拒绝收尾；
6. **最终验收**：全部特性合并后，技术/业务验收在 **Base 分支（源仓库）** 上重新执行（对合并后的代码新鲜），再 `squad_finish` 收尾（Base 已交付路径不再重复合并）。

多仓任务暂不支持特性 worktree（`squad_parallel_start` 会拒绝）；`squad_status` 显示并行阶段、Base 交付与各特性合并状态。

### worker 可用性门禁（额度耗尽自动替代）

每次 `implement`/`rework` 派单前，插件先对目标 worker 做一轮**轻量可用性探测**（同一任务同一 worker 探测成功即缓存；`probe: true` 强制重探、`probe: false` 跳过；`config.workerProbe: false` 全局关闭）。若探测返回**额度类错误**（limit/quota/429/余额/欠费/限流…）：

- 立即把该 worker 记为不可用（`failover.json`，跨重载持久），并在派单反馈里明示：`[可用性门禁] zcode 不可用（可用性探测失败：HTTP 429 …）→ 已上报，并自动改由 qoder 执行本轮任务。`；
- **自动改派**另一个可用 worker 执行本轮（优先 worker 角色；架构师不参与 worker 替代，其容错走架构师交接）；STATE 的派单记录带 `substitutedFrom` / `substitutionReason`，JOURNAL 留痕；
- 此后对该 worker 的派单也会被自动绕开；`squad_status` 显示"挂起：zcode（…自动…）→ 派单将自动改由其他 worker 执行"；
- 用户确认额度恢复后 `squad_failover({ agent: "zcode", recover: true })` 解除；
- 非额度类探测异常只提示（`[可用性门禁] … 探测异常（非额度类）…继续按计划派发`），不改变执行者；
- 没有可用替代者时派单被拒绝并说明原因（不会静默失败）。

### 预算与上限

- **设计预算（默认 4 次）**：初始设计 + 最多 3 轮返工；未扩展时第 5 次暂停。
- **技术返工预算（默认 3 轮）**：技术验收不通过的返工；**前后端 worker 共享**，不因换人、修订规格而重置。未扩展时第 4 轮暂停。
- **业务返工预算（默认 3 轮）**：业务验收不通过的返工；与技术额度独立计数。未扩展时第 4 轮暂停。业务返工改动代码后必须重新通过技术验收，再重新业务验收。
- **到上限是暂停，不是硬拒绝**：先向用户说明阻塞点及已完成部分并**等待决策**；仅用户明确同意后调用 `squad_extend`（如 `squad_extend(kind="design", rounds=3, reason="用户批准的追加理由", confirmed=true)`）追加轮次再派单。每次扩展都要重新取得用户同意（每次都传 `confirmed=true`），可重复扩展、无插件硬上限，但不得预先充值，也**不自动续跑**；用户拒绝或未回复时保持暂停。
- **默认值只在插件常量里**：各类上限存 STATE（`designLimit` / `techReworkLimit` / `businessReworkLimit` / `reworkLimit`），由 `squad_extend` 提高。
- **简化/兼容流程**（`flow="simple"` 或未配置 architect 的任务、旧任务）沿用旧门禁：Lead 批准 PLAN + brain 单一 REVIEW 验收，返工预算用 `kind="implement"` 扩展。

## Worktree 分支开发（默认开启）

改项目代码时，`squad_start` 由插件通过 Git 创建 worktree；省略 `repos` 时默认使用当前仓库：

- 在源仓库的 `.agents/worktrees/` 下创建 checkout；
- 新分支名 `squad-<taskId>`，基线默认 `HEAD`；
- 把**当前会话**切到该目录，之后 spawn 的队友继承这个工作目录；
- 已有队友在派单时也会被显式切到该目录；
- 源 checkout 的未提交改动**不会**复制过去（worktree 从 `HEAD` 检出）。

双验收 approved 后调用 `squad_finish`：默认自动 `git add -A && git commit`，打印 diff stat / 分支 / 合并命令，并把会话切回源目录。合并由你决定（`git merge --no-ff squad-<taskId>`），插件不自动合并。

一个任务跨多个独立 Git 仓库时，传入非空 `repos: string[]`，首项是主仓库。例如在 `/projects` 调用：

```json
{
  "goal": "同步修改前后端接口",
  "acceptance": "两个仓库的验证命令均通过",
  "repos": ["./frontend", "/projects/backend"]
}
```

所有相对路径均基于调用前的 cwd，支持含空格路径、仓库子目录与符号链接入口；不展开 `~`。路径规范化后按 Git common-dir 去重，同仓的 linked checkout 也会判为重复。两个仓库的基线各自解析 `worktreeFrom`，不要求 SHA 相同。

```text
/projects/frontend/.agents/worktrees/squad-<taskId>/  # taskRoot，所有执行器的 cwd
├── 1-frontend/                                    # frontend 的 worktree
│   └── .agent-squad/current.json                  # 指向 taskRoot 中的共享记忆
├── 2-backend/                                     # backend 的 worktree
│   └── .agent-squad/current.json
└── .agent-squad/
    ├── current.json
    └── <taskId>/                                  # TASK/JOURNAL/STATE 与方案、规格、验收、报告
```

每个 worktree 的分支均为 `squad-<taskId>`；子目录名由输入序号与小写仓库名组成，非 ASCII 字母数字连续段替换为 `-`，去掉首尾 `-`，空名用 `repo`。STATE 按顺序记录 `{repo, path, branch, baseCommit}`。主仓库源目录和调用源目录也保存 current 指针，其他源仓库不写入。单仓仍以 worktree 为 cwd，记忆放在 worktree 内；多仓的 local、external、team 执行器统一以 taskRoot 为 cwd，qoder 无需 `--add-dir` 即可访问全部子目录。

- **显式 repos 严格模式**：拒绝空列表、不存在、非 Git、bare、重复仓库，以及目标路径或分支冲突；不退回原地开发。显式单仓校验后沿用原单仓创建逻辑。多仓先完成全部预检，再创建；创建、初始化或发布指针失败时恢复源端文件原字节并回滚本次拥有的 worktree/分支，清理失败标为 fatal 并报告详情。
- **省略 repos 兼容模式**：保持当前仓库默认行为，已在 linked checkout 时复用；非 fatal 创建失败仍退回原地开发并说明原因，旧 STATE 仍可读取。单仓 cwd 切换失败保留已有 Git 产物，恢复源目录也失败时停止。
- **多仓收尾**：每仓先查 status，默认只给脏仓 add/commit；干净仓为 `no-change`，关闭自动提交时为 `skipped`。每仓获取短 SHA 和 diff stat，返回文本与 FINAL 给出可复制的 quoted 查看／合并命令。任一仓失败仍处理下一仓，最后尝试切回主仓库源目录，持久化 commits/FINAL 后抛聚合错误；失败时不写完成字段，已成功提交不撤销。修复原因后可重试，已干净仓变为 `no-change`。

在包含本插件的工作区根目录执行以下两条验证命令；普通测试使用临时 CLI stub，实机命令要求已安装并登录 `qoderclicn`，也可用 `ASQ_QODER_COMMAND` 指定可执行文件绝对路径：

```sh
node --test dsh-agent-squad/test/settings.test.js
ASQ_LIVE_QODER=1 node --test --test-name-pattern='^T09 ' dsh-agent-squad/test/settings.test.js
```

测试保持十八个顶层用例（T01–T18；T11 完整流程与双验收，T12 架构师容错交接，T13 后台并行派发，T14 角色 worker 能力与 leaderWorker，T15 worker 可用性门禁与自动替代，T16 阶段化并行与 Base 分支合并，T17 分层进度与自动同步，T18 外部阶段非阻塞与延迟记账）；实机模式由 qoder 一次派单修改两个临时仓库，各新增一次提交，并输出 `AC7 task=... cwd=... repo=... commit=... repo=... commit=...`。普通单测不能代替该证据。

## B 模式：外部 provider（一次性）

`agents[].provider` 非空且不是 `spawn`/`fork` 时，`squad_dispatch` 不再走 Team 队友，而是直接调用宿主 `ctx.subagents.startActivation({ provider, delivery: 'caller' })`：

- Lead 的调用阻塞到外部 agent 返回，结果直接回到 Lead；外部 agent 不进入 Team roster，也不能 `squad_report`、不能续跑；
- 每次派发前生成 `BRIEF.md`（≤30 行），外部 agent 只读共享文件，返工必须重发 BRIEF + 编号缺陷；实现、返工与验收指向 PLAN-APPROVED.md / SPEC.md，并要求 AC 映射；
- 外部 agent 的 cwd 为任务工作区：单仓是 worktree，多仓是包含所有 worktree 的 taskRoot；共享记忆位于该 cwd 下的 `.agent-squad/`（沙箱可写）；
- 已适配 Codex：`provider: codex`，需先安装 `@deepseek-ai/dsh-subagent-codex`（bundle）；
- ZCode 需要 `@deepseek-ai/dsh-subagent-acp`（不是 bundle，要单独插入 provider 行）；本 pilot 用直连 ACP 桥测量；
- **内置 `qoder-cli` 外部 provider**：插件自带适配器，封装已安装的 `qoderclicn`（npm 全局，由宿主 PATH 找到且需已完成登录；可用 `qoderCommand` 指定可执行文件绝对路径）。**headless 审批**：`-p` 一次性运行没有 TTY 应答 CLI 自己的审批提问，未预先放行的动作会被自动拒绝（典型报错 `Error: Allow reading /opt/homebrew/bin/mvn?`、`Allow Bash to run: mvn -v?`）。适配器因此默认追加 `--add-dir`（`/opt/homebrew`、`/usr/local`、`JAVA_HOME`、`/Library/Java/JavaVirtualMachines`、`~/.m2`、`~/.gradle`、`~/.npm`、`~/.pnpm-store`，仅添加实际存在的目录）与 `--allowed-tools`（`Bash(mvn:*)`、`Bash(./mvnw:*)`、`Bash(gradle:*)`、`Bash(./gradlew:*)`、`Bash(java:*)`、`Bash(javac:*)`、`Bash(node:*)`、`Bash(npm:*)`、`Bash(pnpm:*)`、`Bash(npx:*)`、`Bash(git:*)`、`Bash(ls/cat/head/tail:*)`），让构建与测试在无交互环境下可跑；`qoderAddDirs` / `qoderAllowedTools` 可整表覆盖，`qoderPermissionMode` 也可设为 `bypass_permissions` 完全跳过审批（风险自担）。插件不附带二进制本体。每次执行 `qoderclicn -p <prompt> -w <cwd> --permission-mode <mode>`（`qoderModel` 非空时追加 `-m <model>`），stdout 作为一次性结果返回；非 0 退出码按 error 返回 diagnostic，`dispose` 以 SIGTERM（1 秒后升级 SIGKILL）终止子进程。权限模式默认 `accept_edits`（`qoderPermissionMode` 可改写），`qoderModel` 默认空（不传 `-m`）。外部执行**一次性、不可续跑**，也不能 `squad_report`：每轮派单都会重发完整任务与共享文件路径，返工同样重发。

### B pilot 实测（2026-11-09）

任务 `t-mw8yaewy-ifwc`（罗马数字工具 + 8 测试，worktree 分支 `squad-t-mw8yaewy-ifwc`）：

| 轮次 | 执行者 | 结果 | token |
| --- | --- | --- | --- |
| design | Codex（provider） | PLAN.md | 未能从 provider 取到（临时线程不写 session 日志） |
| implement | Codex（provider） | 8/8 测试 | 同上 |
| review | Codex（provider） | APPROVED | 同 prompt 直连 `codex exec` 复测：**20,880** |
| ZCode 对照 | ACP 桥直连 | 独立评审 approved | **1,121,088**（fresh input 17,304 / cached 1,097,792 / output 5,992） |

结论：ZCode 单轮约是 Codex 的 **50 倍**（缓存读占大头），不适合常规 B 流程；Codex 单轮约 2 万 token，可接受。

## 混合模型：Lead DeepSeek + gpt/zcode/qoder 本地固定模型（可续跑）

`agents[].model` 写成 `provider/model`（如 `zai-coding-cn/glm-5.3`、`openai/gpt-6.2-sol`）时，该 agent 走**本地固定模型子代理**：

- `ctx.subagents.startActivation({ provider: 'spawn', childId, request: { agentOptions: { provider, model } }, delivery: 'parent' })`；
- 子代理是可持续跑的本地 child，返工用 `ctx.subagents.sendMessage(childId)` 续跑同一会话；
- 角色章程通过 childId → 配置映射挂到子会话上；
- Lead 仍用 DeepSeek；codex 走外部一次性（B 模式），gpt 默认 `openai/gpt-6.2-sol`。

前提：`llm-pi-ai` 的路由要注册成功。手工声明的 provider **必须写 `api`**（如 `openai-completions`），否则 pi-ai 会跳过整条路由。

### 实测（2026-11-09）

任务 `t-mw92ogf1-tu0h`（hello 工具 + 5 测试，worktree 分支 `squad-t-mw92ogf1-tu0h`）：

| 轮次 | 模型 | totalTokens | fresh input | output | cache read |
| --- | --- | --- | --- | --- | --- |
| implement | glm-5.3 | 18,949 | 241 | 148 | 18,560 |
| rework（同一 child id） | glm-5.3 | 20,105 | 257 | 136 | 19,712 |
| Codex review（对照，一次性） | codex | 20,880 | — | — | — |
| ZCode review（对照，一次性） | zcode cli | 1,121,088 | 17,304 | 5,992 | 1,097,792 |

返工续跑只增加约 **1.1k tokens**（上下文命中缓存），这就是“同会话返工”的价值。

### 完整三角色流水线（2026-11-09）

任务 `t-mw92ujrc-quea`（semver 比较工具，8 测试，分支 `squad-t-mw92ujrc-quea`）：

| 阶段 | 执行者 | 模式 | totalTokens |
| --- | --- | --- | --- |
| design | codex | 外部一次性 | 不可观测（直连代理 ~20,880） |
| implement | glm-5.3 | 本地子代理 | **28,763**（fresh 1,271 / output 228 / cache 27,264） |
| review | codex | 外部一次性 | 不可观测（直连代理 ~20,880） |
| rework | — | 未触发（一次通过） | — |

整条流水线约 **7 万 tokens**（Codex 按直连代理估算）；同样三轮若走 ZCode，仅单轮就 112 万。

### 验收不通过 → 返工 → 复审（2026-11-09）

任务 `t-mw93iitb-r9zt`（range 工具），人为注入“缺终点”缺陷：

| 步骤 | 结果 |
| --- | --- |
| round-1 codex review | `VERDICT: CHANGES_REQUESTED`（3 测试失败），归档 `REVIEW-R1.md` |
| `squad_finish` | 正确拒绝：lastVerdict ≠ APPROVED |
| 返工 zcode | 同一 child `a4b54075-…`，补 `result.push(end)`，7/7 通过 |
| round-2 codex review | `VERDICT: APPROVED`，归档 `REVIEW-R2.md` |
| `squad_finish` | 通过并提交 |

token：GLM implement 26,295 / rework 26,459（cache 主导）；Codex 设计 + 两轮验收约 3×20k；整轮闭环约 **11.5 万**。同样 5 次调用若走 ZCode 约 560 万。

> 门禁规则：`TECH-REVIEW.md` 与 `REVIEW.md` 最后一行必须是 `VERDICT: APPROVED|CHANGES_REQUESTED`；每轮自动归档为 `TECH-REVIEW-R<round>.md` / `REVIEW-R<round>.md`；`squad_finish` 只认最后一条 VERDICT，且验收绑定必须仍然新鲜（codeEpoch/specVersion 未变）。

> 注意：`dsh-tool-subagent` 的 `list_subagent_models` 仍受 `subagent-model-selection` 会话策略限制；本插件直接调 subagent 服务，绕过的是工具层的策略门。若要让 GUI/工具一致，在 `subagent-model-selection-settings` 的 `allowedModels` 里加上 `zai-coding-cn/glm-5.3` 与 `openai/gpt-6.2-sol`。

## 设置页（Web GUI）

插件的 Client 半（`client.js`）在设置里注册一个 **Agent Squad** 页面（`settings.section`，id `agent-squad`）：顶部执行流程 SVG、四张成员卡片与 worktree 目录区块。配置存放在 **profile 级** JSON 文件：

```text
~/.dsh/agent-squad/settings.json     # $DSH_HOME 可覆盖
{ "version": 2, "revision": 3,
  "agents": [
    { "id": "codex", "displayName": "codex", "role": "brain",
      "executor": "external", "model": "codex", "description": "…" },
    { "id": "gpt", "displayName": "gpt", "role": "architect",
      "executor": "local", "model": "openai/gpt-6.2-sol", "description": "…" },
    { "id": "zcode", "displayName": "zcode", "role": "worker",
      "executor": "local", "model": "zai-coding-cn/glm-5.3", "description": "…" },
    { "id": "qoder", "displayName": "qoder", "role": "worker",
      "executor": "team", "model": "", "description": "…" } ],
  "worktree": { "directory": ".agents/worktrees" } }
```

- **字段**：四个成员固定 id（codex/gpt/zcode/qoder，只读），可编辑 `displayName/role/executor/model/reasoning/worker/description`，以及顶层 `leaderWorker`（Lead 的 worker 能力）；worktree 只有 `directory`（仓库相对路径，拒绝绝对路径与 `..`）。`reasoning`（思考强度，''/low/high/xhigh/max）仅对固定模型执行者生效（local，或 `provider/model` 形式的外部一次性），派发时作为 `reasoningEffort` 传给子代理；纯外部 provider（codex-cli 等）不显示该控件。
- **role 三态**：`brain`（业务设计与验收）| `architect`（系统架构师）| `worker`（实现与自测）。
- **executor 三态**：`external`（外部 provider，一次性派发）、`local`（`provider/model` 固定模型本地子代理，可续跑）、`team`（进程内队友，可续跑）。校验：名称唯一、至少一个 brain、local 模型必须在模型目录内、external provider 必须已注册。
- **迁移**：v1（三成员）文件读取时自动插入 gpt 架构师行并升为 v2，用户既有编辑与 revision 全部保留。
- **读写**：页面经 Host 的 loopback 同源 HTTP（`GET/PUT /agent-squad/settings`、`GET /agent-squad/models`）读写；非 loopback socket、非本地 Host（如 `127.attacker.example`）或跨源/异协议 Origin 一律 403。保存走 revision 乐观锁：并发写第二笔返回 **409 REVISION_CONFLICT** 并附服务器当前 settings；页面显示冲突横幅并保留草稿，点"改用服务器版本"经确认才替换。恢复出厂默认只写入草稿，保存才落盘。未保存的草稿在切换设置页后保留（工厂级会话），保存期间编辑冻结，无字段错误的服务器故障（IO/模型目录 503）显示整体错误提示。
- **生效时机**：`squad_start`/`squad_dispatch` 每次都重读设置，保存立即影响下一次派单；运行中的 child 不追溯（local 改绑模型须等其空闲）。
- **持久化**：原子写（同目录临时文件 + rename）；损坏文件先备份 `settings.json.corrupt-<ts>`，备份成功才恢复默认（出厂默认 = 有效 bundle seed），备份失败返回 IO 错误并保留原文件。首次从 bundle 配置 seed，已有合法文件不会被 bundle 覆盖。
- worktree 由插件自建：单仓位于 `<repo>/<directory>/squad-<taskId>`；多仓以首仓的该路径为 taskRoot，每仓创建一个子 worktree，`squad_finish` 逐仓处理。directory 始终相对主仓库；多仓的 memoryDir 也必须位于 taskRoot 内。

### 验证步骤

1. 隔离 profile 安装本插件，打开设置 → Agent Squad：页面出现，四张卡片 id 只读，SVG 标签随草稿变化，中英切换正常。
2. `GET /agent-squad/models`（或在页面下拉）确认 groups 同时含 `deepseek-account` 与 `zai-coding-cn`（gpt 需要 `openai` 组）。
3. 修改名称并保存，重开页面核对 `settings.json`（revision +1）。
4. 提交重复名称：字段级错误出现且文件不变（服务端二次校验）。
5. 两个页面同 revision 依次保存：第二笔收到 409，磁盘只含第一笔结果。
6. 非本机请求（如局域网 IP）访问任一路由：403。

## 配置

```yaml
- id: agent-squad
  name: 'dsh-agent-squad'
  config:
    memoryDir: .agent-squad
    worktreeDir: .agents/worktrees # 首次 seed 的 worktree 目录（此后以设置文件为准）
    worktreeFrom: HEAD             # 从哪个本地提交/分支拉出
    worktreeAutoCommit: true       # squad_finish 时逐仓自动提交脏 worktree
    qoderCommand: qoderclicn       # qoder-cli provider 调用的可执行文件（默认 PATH 上的 qoderclicn，可填绝对路径）
    qoderPermissionMode: accept_edits  # 传给 --permission-mode 的权限模式（默认 accept_edits）
    qoderModel: ''                 # qoder-cli 模型；默认空 = 不传 -m
    agents:                        # 仅作首次 seed；已有合法 settings.json 不会被覆盖
      - name: codex
        role: brain
        provider: codex      # 外部 provider（一次性）
      - name: gpt
        role: architect      # 系统架构师
        provider: ''
        model: openai/gpt-6.2-sol    # 本地固定模型（可续跑）
      - name: zcode
        role: worker
        provider: ''
        model: zai-coding-cn/glm-5.3   # provider/model → 本地固定模型（可续跑）
      - name: qoder
        role: worker
        provider: ''         # 空 = team 队友（可续跑）
```

- `role`：`brain` | `architect` | `worker`（可编辑字段保存在设置文件；bundle 只作 seed 与 charter/context 补充）。
- **小队是显式启用（opt-in）**：普通会话不进入 Squad。启用状态在内存里按会话保存；插件重载后用 `squad_enable` 恢复，不影响任务数据。
- **worktree 始终启用**（无开关）：省略 repos 时保留单仓复用与失败降级行为；显式 repos 严格校验，多仓始终创建独立子 worktree，即使入口是 linked checkout 也不复用。路径与回滚规则见上方“Worktree 分支开发”。
- **运行中不重派**：目标（本地子代理或 team 队友）处于 running/provisioning 时拒绝再次派单或切换执行方式，避免同时保留两个活动执行者；空闲时同绑定续跑、改绑定（模型/执行方式）则下一次新建。
- **验收门禁快照**：任务建立时把"是否需要 brain 验收"、"是否需要 Lead 批准 PLAN"（`planRequired`）与"是否启用完整流程"（`flow` + `specRequired`）写入 STATE；此后修改角色不能绕过该任务的门禁，也不能给简化任务追加新门禁。
- `worktreeAutoCommit`：默认 `true`；设为 `false` 则 `squad_finish` 只收尾、不提交，改动留在 worktree 里。
- `provider`：DSH subagent provider 名。留空时 `fork → fork`、`fresh → spawn`（进程内 DeepSeek 智能体）。装了 `@deepseek-ai/dsh-subagent-acp` 之类的 provider 后，可把各队友分别指到真实的本地 CLI：

```yaml
      - name: zcode
        role: worker
        provider: zcode-bm
        context: fresh
```

> 真实 CLI 的 provider 大多需要单独安装并注册（例如 ACP 桥），插件只负责按名字选择 provider，不内置任何厂商二进制。唯一例外是内置的 **qoder-cli 适配器**：适配器本身随插件提供，但 `qoderclicn` 可执行文件仍须自行安装并登录。要启用 qoder 外部执行，在设置页把 qoder 的 `executor` 设为 `external`、`model` 选 `qoder-cli` 并保存（已有合法 settings.json 不会因 bundle 更新被覆盖，升级后须手动改一次并保存）。

## 共享记忆布局

```text
<workspace>/.agent-squad/
├── current.json              # 当前任务指针
└── t-<id>/
    ├── TASK.md               # 目标 / 验收标准 / 约束 / 成员（Lead 写）
    ├── BRIEF.md              # 每次派单重写的一次性简报（外部 agent 必读）
    ├── PLAN.md               # 业务方案草稿 + 编号验收标准（brain 写）
    ├── PLAN-R<n>.md          # 第 n 次设计的方案归档（n 随扩展增长）
    ├── PLAN-APPROVED.md      # 业务方案与业务验收的唯一权威规格（squad_approve_plan 写）
    ├── SPEC.md               # 技术规格（architect 写；当前版本）
    ├── SPEC-V<n>.md          # 第 n 版技术规格归档（external 同步归档）
    ├── TECH-REVIEW.md        # 技术验收结论 + 证据（architect 写；gpt 实现代签时由 brain 写）
    ├── TECH-REVIEW-R<round>.md  # 每轮技术验收归档
    ├── REVIEW.md             # 业务验收结论 + 证据（brain 写）
    ├── REVIEW-R<round>.md    # 每轮业务验收归档
    ├── REPORT.md             # 逐条 AC 的文件 / 测试 / 命令 / 退出码 / 输出 / 结论
    ├── JOURNAL.md            # 追加式流水（所有人写）
    ├── STATE.json            # phase / round / flow / specRequired / plan 门禁 / codeEpoch / specVersion / implementers / 双验收绑定 / 各类预算 / dispatch 记录
    └── FINAL.md              # 收尾摘要（squad_finish 写）
```

### PLAN / SPEC 归档与门禁

- **external 执行者**：每次成功的 design/spec 派单在返回前同步读取 `PLAN.md`/`SPEC.md` 并归档为 `PLAN-R<n>.md` / `SPEC-V<n>.md`；归档失败会显式报错（说明已派单）、计数不增加、不自动重派。
- **local / team 执行者**：design 派单投递成功即计数写 STATE，不逐轮归档；仅在 `squad_approve_plan` 批准时把当前 PLAN.md 补归档为当前轮次 `PLAN-R<n>.md`（已存在的历史归档不改写）。spec 派单投递成功即 `specVersion+1` 并置 `specPublished=true`。
- **设计预算**：默认初始设计 + 3 轮返工 = 4 次成功 design 派单；未扩展时第 5 次暂停（用户决策门禁，见上），上限存 STATE 的 `designLimit`。PLAN 已批准后 design 一律拒绝（扩展不解除批准门禁）。
- **实现门禁**：`planRequired`（任务建立时按参与者是否含 brain 快照，之后改角色不生效）且未批准时，implement/rework/spec 在写 BRIEF/STATE/调用执行器之前即被拒绝，错误信息指向 `squad_approve_plan`；无 brain 任务豁免。完整流程（`specRequired`）下，技术规格未发布（`specPublished=false`）时拒绝 implement/rework；规格发布后即可派工，不需要 Lead 再审批。旧 STATE 无这些字段时按验收门禁快照回退（gate 显式 false 才豁免），不按当前 roster 放宽。
- **验收新鲜度**：每次 tech-review/review 派单把 `codeEpoch`（实现/返工轮次计数）与 `specVersion` 绑定进 STATE；此后任何实现、返工或规格修订都会让旧结论失效。业务验收前技术验收必须新鲜且 APPROVED；`squad_finish` 同样只认新鲜的 APPROVED。业务返工改动代码后必须重新通过技术验收。

每次派单的消息只带任务号、阶段、轮次、目录和本轮任务，不复制历史对话；队友先读文件再动手。这样跨 agent 的“共享记忆”是可审计的文件，而不是互相复制的 transcript。

## 会话复用（token 关键）

- 队友第一次派单时通过 `subagents.startActivation({provider:'spawn', childId, name})` 创建为命名可续跑子代理，之后 `squad_dispatch` 走 `subagents.sendMessage`：消息进入同一个子会话，冷启动时按需 resume。
- `squad_dispatch` 返回 `mode=spawned|resumed` 和 `session_id`，可以直接核对返工是否落在同一会话。
- 同一个姓名在 Team 内永久唯一，所以不要为返工新建 agent——再派一次即可。

## 工具

| 工具 | 调用者 | 作用 |
| --- | --- | --- |
| `squad_enable` | 任意会话根（未启用时） | 显式启用小队：仅当用户明确要求"用小队"时调用；仅提到队友名字不算启用。启用后本会话成为 Squad Lead |
| `squad_start` | Lead | 可选 `repos: string[]`（默认当前仓库，首项为主仓）与 `flow: "full"\|"simple"`（默认 full；无 architect 参与者自动降级为简化规则并警告）；建 worktree 集合、写 TASK/JOURNAL/STATE 和门禁快照，最后发布 current |
| `squad_dispatch` | Lead | 首次创建 / 之后续跑指定队友，推进 phase（design/spec/implement/tech-review/review/rework）与 round；design 受设计预算与已批准限制，spec 限 architect，implement/rework 受 PLAN 批准与规格交付门禁且 external 执行者默认后台派发（background: false 恢复阻塞），tech-review 禁止自签，review（完整流程）要求技术验收新鲜通过；到预算上限时暂停并提示先问用户 |
| `squad_approve_plan` | Lead（仅 Lead 可见） | 审核通过 PLAN.md：补归档当前轮次 `PLAN-R<n>.md`，写 `PLAN-APPROVED.md` 与 `planApproved`/`planApprovedAt`；缺 PLAN、已收尾或已批准时拒绝 |
| `squad_extend` | Lead（仅 Lead 可见） | 用户决策门禁：仅当对应预算（完整流程 `kind` = design/tech/business；简化/兼容 `kind` = design/implement）已到上限且用户明确同意后调用（`confirmed=true` 必填，`rounds` 正整数默认 3，`reason` 必填），提高该类上限并追加一条扩展记录；未到上限、未确认或非 Lead 一律拒绝；可重复扩展，不自动续跑 |
| `squad_status` | Lead | 任务、阶段/轮次、流程（flow/specPublished/specVersion/codeEpoch/implementers）、双验收绑定与结论、全部仓库/worktree/分支/基线、PLAN 门禁、各类预算与最近 6 条扩展记录、成员状态、记忆文件、最近派单 |
| `squad_wait` | Lead | 有界阻塞等待团队变化（通常不需要，报告会唤醒 Lead） |
| `squad_finish` | Lead | 校验无队友运行 + 验收 approved（完整流程需技术+业务双验收且新鲜），逐仓提交并记录结果，切回主仓库源目录，写 FINAL.md 与每仓合并命令；多仓失败可重试 |
| `squad_parallel_start` | Lead（仅 Lead 可见） | 基础层交付后开启并行阶段：基于 Base 为每个特性创建独立 worktree/分支，供按 feature 并行派单 |
| `squad_deliver` | Lead（仅 Lead 可见） | 交付并合并：基础层（通过验收后把 squad 分支合入 Base）或单个特性（`feature`，合入 Base）；源仓库须切在 Base，冲突报错不标记完成 |
| `squad_failover` | Lead（仅 Lead 可见） | 架构师容错：额度耗尽时挂起架构师（自动触发或手动 `reason`），职责由 brain 代行；`recover: true` 在用户确认恢复后解除挂起；挂起状态持久化于 failover.json |
| `squad_report` | brain / architect / worker | 把结果、阻塞或验收结论发回 Lead 并写 JOURNAL；架构师上报额度耗尽的 blocked 会触发自动挂起 |

## 安装 / 卸载

```sh
# 安装（在 DSH 会话里）
plugin_manager install_bundle  <本目录绝对路径>

# 卸载
plugin_manager remove_bundle   dsh-agent-squad
```

DSH 0.2.x 已把 Agent Teams 并入标准 subagent 运行时，本插件的 patch 不再挂载已移除的 `@deepseek-ai/dsh-experimental-agent-team`；改为挂载 `@deepseek-ai/dsh-subagent-codex` 提供 codex 外部执行者。

### zcode-bm：BigModel ACP 桥（随 bundle 挂载）

本 bundle 的 patch 同时挂载 `@deepseek-ai/dsh-subagent-acp`（provider 名 `zcode-bm`），通过本地 `zcode-acp-server` 桥以 ACP/stdio 驱动 ZCode CLI（BigModel 个人编码套餐，GLM-5.3），并注册 `subagent_zcode_bm` 工具行与 collab 技能约定对齐。把 zcode 的 executor 设为 `external`、model 选 `zcode-bm` 即走此通道；该包须作为 profile 直接依赖安装（`link:` bundle 的自身依赖不会进 profile 的 node_modules）：

```sh
cd ~/.dsh/profiles/<profile> && pnpm add @deepseek-ai/dsh-subagent-acp@<运行时版本>
```

桥的命令行与 env（`ZCODE_BIN`/`ZCODE_PROVIDER`/`ZCODE_MODEL`）在 `cordis.patch.yml` 的 `subagent-acp-zcode-bm` 行内配置。

## 升级与重载

本插件挂载的 Team 运行时与工具都归属于插件上下文。修改 `index.js` 后，用插件管理器禁用再启用 `agent-squad` 即可干净重载（工具全局注册、按 `when` 对 agent 可见；章程分区由插件上下文持有并随重载销毁）。重载会清空"已启用小队"的会话集合：正在带任务的会话需要再调一次 `squad_enable` 恢复 Lead 身份（任务数据不受影响）。内置的 qoder-cli provider 也随插件上下文注册/注销：重载后它出现在 `GET /agent-squad/models` 的 `externalProviders`（id `qoder-cli`）。实机验证：在设置页把 qoder 的 `executor` 设为 `external`、`model` 选 `qoder-cli` 并保存（前提是宿主 PATH 上已安装并登录 `qoderclicn`），随后给 qoder 派一个小任务，确认派单结果带 `provider=qoder-cli` 且产物落盘。如果旧版本曾在会话里留下作用域注册，升级后需要重启一次 DSH 清除。从三成员旧版本升级时，settings.json 读取时自动迁移为 v2（插入 gpt 行），既有编辑保留。

## 验证记录（2026-11-09，端到端）

用一个真实小任务（word-count CLI + 22 个测试）跑完整闭环，全部由小队完成：

| 阶段 | 执行者 | 结果 |
| --- | --- | --- |
| 设计 | codex（brain） | `PLAN.md` 283 行：接口契约、D1–D19 决策表、22 个测试、AC1–AC7 可执行命令 |
| 实现 | zcode（worker） | 仅新增 `.squad-verify/` 两个文件；`node --test` → **22 pass / 0 fail** |
| 验收 | codex（brain，续跑同一会话） | `REVIEW.md` 187 行，AC1–AC7 逐条 PASS，裁定 2 处 PLAN 算术错误并修订，**approved** |

- **会话复用证据**：codex 设计时 `session=23ed8a18-…`，验收时同一 `session=23ed8a18-…`（`mode=resumed`）。
- **返工路径**：本轮一次通过未触发 rework；rework 与 review 走同一条 `sendMessage` 分支（同一会话续跑）。
- **共享记忆**：`.agent-squad/t-mw8pxuue-o8my/{TASK,PLAN,REVIEW,REPORT,JOURNAL}.md`，跨 agent 传递方案/证据/结论。
- 验证产物 `.squad-verify/` 是一次性夹具，可随时 `rm -rf .squad-verify` 删除，不属于插件。

### worktree 验证（2026-11-09）

- `squad_start` 自动创建分支 `squad-t-mw8u3ayq-mvut` 与 checkout `.agents/worktrees/…`，并把会话目录切过去；
- zcode 在该 worktree 内完成改动（报告附 `pwd` 证据），源 checkout 没有该文件、状态与基线一致；
- `squad_finish` 自动提交 `e648ac3`、打印 `1 file changed` 与合并命令、把会话切回源目录；
- 验证后已删除测试 worktree 与分支，源仓库只保留原有未提交改动。

## 已知边界

- **一个会话 = 一个 Team**。队名永久唯一，所以同一会话里换一个完全无关的新任务时，各队友仍是原会话；新任务请开新会话，或接受上下文延续。
- **小队按会话显式启用**：启用集合在内存里，插件重载/重启后需要重新 `squad_enable`；普通会话永远看不到 squad 工具。
- **worktree 只从本地提交检出**：源 checkout 的未提交改动不会带过去；子模块、依赖安装、LFS 内容也不由插件处理。
- **不自动合并**：`squad_finish` 只提交分支并给出合并命令，合不合、何时合由你决定。
- **worktree 生命周期**：收尾成功或失败后，各仓 checkout 与分支均保留；逐仓用 `git -C <repo> worktree remove <path>` + `git -C <repo> branch -D <branch>` 清理。多仓创建事务失败才自动回滚本次产物；失败详情会报告，源文件与已有分支不删除。
- 所有成员共享同一个任务工作区；多仓工作区包含多个子 worktree，不提供按成员隔离，写冲突靠 Lead 划分文件范围 + 双验收兜底。
- 只支持单任务串行推进（`current.json` 只有一个指针）；并行任务需要多开会话。
- 队友必须主动 `squad_report`；若模型漏报，用 `squad_status` 查看文件与状态，必要时 `squad_wait`。
