# dsh-agent-squad

给 DeepSeek Harness 加一个**按角色分工的本地多智能体小队**：Lead 负责组织与分配，brain 负责方案与验收，worker 负责实现与测试；返工复用同一个队友会话，而不是每次新建对话。

```text
用户 ──▶ Lead (DSH 当前会话)
            ├─ codex  [brain]   方案 / 验收标准 / 最终验收
            ├─ zcode  [worker]  实现 / 测试
            └─ qoder  [worker]  并行或前端实现
```

插件本身很薄：它挂在 DSH 内置的实验性 **Agent Teams** 运行时（`ctx.agentTeams`）上，补上 DSH 缺的三件事：

1. **命名 + 角色**：三个固定 teammate（codex / zcode / qoder），角色决定系统提示里的职责章程与可见工具；
2. **共享记忆**：每个任务一个 `.agent-squad/<task>/` 目录，TASK / PLAN / REVIEW / REPORT / JOURNAL 五份文件，所有成员读写同一份；
3. **会话复用**：队友是 Lead 的持久、可续跑子会话；重复 `squad_dispatch` 同一个队友 = 往同一会话追加消息，返工天然复用上一轮上下文。

## 角色

| 角色 | 谁 | 职责 | 工具 |
| --- | --- | --- | --- |
| `lead` | 当前 DSH 会话 | 拆解流程、审核并批准 PLAN、决定下一个执行者、汇总交付；不写业务代码 | `squad_start` / `squad_dispatch` / `squad_approve_plan` / `squad_status` / `squad_wait` / `squad_finish` |
| `brain` | codex | 出方案、实现计划、编号化验收标准；最终逐条验收，只有它能给 approved | `squad_report` |
| `worker` | zcode / qoder | 按 PLAN 实现、写测试、跑验收命令、记录证据；返工按编号缺陷修复 | `squad_report` |

角色章程可以在插件配置里整段替换（`brainCharter` / `workerCharter`），单个 agent 也可以用 `charter` 覆盖。默认章程为中文；Lead 策略额外要求**面向用户始终使用用户的语言**，章程语言不影响回复语言。

### 预算与上限

- **方案预算**：brain 的计划正文默认 ≤ 80 行，测试数 ≤ `max(6, 验收条数×2)`，除非任务确实更复杂并在 PLAN.md 说明理由。
- **设计返工上限**：Lead 先审方案再实现——初始设计 + 最多 **3 轮设计返工**（合计 4 次 `phase="design"` 派单），**第 5 次被 `squad_dispatch` 直接拒绝**；与实现返工预算相互独立、分别计数。
- **实现返工上限**：同一任务最多 **3 轮返工**；**第 4 次** `phase="rework"` 会被 `squad_dispatch` 直接拒绝，Lead 必须停下来向用户报告。
- **预算常量都在插件常量里**，可按需调整（`MAX_DESIGN_REWORK_ROUNDS` / `MAX_REWORK_ROUNDS`）。

## 使用

安装后直接对 Lead 说：

> 用智能体小队把这个需求做掉：……

Lead 的固定流程（**先审方案再实现**）：

1. `squad_start` 建任务与共享记忆；**默认同时创建 worktree + 新分支，并把会话切过去**；
2. `squad_dispatch(codex, phase=design)` → brain 写 `PLAN.md` 与验收标准；
3. **Lead 审核 `PLAN.md`**：有问题就把编号缺陷派回 brain（`phase="design"` 返工，最多 3 轮）；方案合格后调用 **`squad_approve_plan`** 批准（归档 `PLAN-APPROVED.md`）。有 brain 参与的任务，批准前 `implement`/`rework` 派单会被拒绝；无 brain 任务豁免；
4. `squad_dispatch(zcode, phase=implement)` → worker 在 worktree 里实现并写 `REPORT.md`；
5. `squad_dispatch(codex, phase=review)` → brain 对照 PLAN 逐条验收；
6. 不通过 → `squad_dispatch(zcode, phase=rework)`：**同一会话**继续，只补缺陷；
7. brain `approved` 后调用 `squad_finish`：提交 worktree 改动、切回源目录、给出分支与合并命令。

> 两种批准相互独立：`squad_approve_plan`（Lead）批准的是**方案**，`REVIEW.md` 的 `VERDICT: APPROVED`（brain）批准的是**实现**；前者不能替代后者，收尾仍只认 brain 验收。

## Worktree 分支开发（默认开启）

改项目代码时，`squad_start` 会调用 DSH 的 worktree 运行时：

- 在源仓库的 `.agents/worktrees/` 下创建 checkout（该池自带 `.gitignore`，不污染 git）；
- 新分支名 `squad-<taskId>`，基线默认 `HEAD`；
- 把**当前会话**切到该目录，之后 spawn 的队友继承这个工作目录；
- 已有队友在派单时也会被显式切到该目录；
- 源 checkout 的未提交改动**不会**复制过去（worktree 从 `HEAD` 检出）。

`brain approved` 后调用 `squad_finish`：默认自动 `git add -A && git commit`，打印 diff stat / 分支 / 合并命令，并把会话切回源目录。合并由你决定（`git merge --no-ff squad-<taskId>`），插件不自动合并。

## B 模式：外部 provider（一次性）

`agents[].provider` 非空且不是 `spawn`/`fork` 时，`squad_dispatch` 不再走 Team 队友，而是直接调用宿主 `ctx.subagents.startActivation({ provider, delivery: 'caller' })`：

- Lead 的调用阻塞到外部 agent 返回，结果直接回到 Lead；外部 agent 不进入 Team roster，也不能 `squad_report`、不能续跑；
- 每次派发前生成 `BRIEF.md`（≤30 行），外部 agent 只读共享文件，返工必须重发 BRIEF + 编号缺陷；
- 外部 agent 的 cwd 是 worktree，因此本任务的共享记忆放在 **worktree 内** 的 `.agent-squad/`（沙箱可写）；
- 已适配 Codex：`provider: codex`，需先安装 `@deepseek-ai/dsh-subagent-codex`（bundle）；
- ZCode 需要 `@deepseek-ai/dsh-subagent-acp`（不是 bundle，要单独插入 provider 行）；本 pilot 用直连 ACP 桥测量。

### B pilot 实测（2026-11-09）

任务 `t-mw8yaewy-ifwc`（罗马数字工具 + 8 测试，worktree 分支 `squad-t-mw8yaewy-ifwc`）：

| 轮次 | 执行者 | 结果 | token |
| --- | --- | --- | --- |
| design | Codex（provider） | PLAN.md | 未能从 provider 取到（临时线程不写 session 日志） |
| implement | Codex（provider） | 8/8 测试 | 同上 |
| review | Codex（provider） | APPROVED | 同 prompt 直连 `codex exec` 复测：**20,880** |
| ZCode 对照 | ACP 桥直连 | 独立评审 approved | **1,121,088**（fresh input 17,304 / cached 1,097,792 / output 5,992） |

结论：ZCode 单轮约是 Codex 的 **50 倍**（缓存读占大头），不适合常规 B 流程；Codex 单轮约 2 万 token，可接受。

## 混合模型：Lead DeepSeek + worker GLM（可续跑）

`agents[].model` 写成 `provider/model`（如 `zai-coding-cn/glm-5.3`）时，该 agent 走**本地固定模型子代理**：

- `ctx.subagents.startActivation({ provider: 'spawn', childId, request: { agentOptions: { provider, model } }, delivery: 'parent' })`；
- 子代理是可持续跑的本地 child，返工用 `ctx.subagents.sendMessage(childId)` 续跑同一会话；
- 角色章程通过 childId → 配置映射挂到子会话上；
- Lead 仍用 DeepSeek；codex 仍走外部一次性（A 模式）。

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

> 门禁规则：`REVIEW.md` 最后一行必须是 `VERDICT: APPROVED|CHANGES_REQUESTED`；每轮自动归档为 `REVIEW-R<round>.md`；`squad_finish` 只认最后一条 VERDICT。

> 注意：`dsh-tool-subagent` 的 `list_subagent_models` 仍受 `subagent-model-selection` 会话策略限制；本插件直接调 subagent 服务，绕过的是工具层的策略门。若要让 GUI/工具一致，在 `subagent-model-selection-settings` 的 `allowedModels` 里加上 `zai-coding-cn/glm-5.3`。

## 设置页（Web GUI）

插件的 Client 半（`client.js`）在设置里注册一个 **Agent Squad** 页面（`settings.section`，id `agent-squad`）：顶部执行流程 SVG、三张成员卡片与 worktree 目录区块。配置存放在 **profile 级** JSON 文件：

```text
~/.dsh/agent-squad/settings.json     # $DSH_HOME 可覆盖
{ "version": 1, "revision": 3,
  "agents": [
    { "id": "codex", "displayName": "codex", "role": "brain",
      "executor": "external", "model": "codex", "description": "…" },
    { "id": "zcode", "displayName": "zcode", "role": "worker",
      "executor": "local", "model": "zai-coding-cn/glm-5.3", "description": "…" },
    { "id": "qoder", "displayName": "qoder", "role": "worker",
      "executor": "team", "model": "", "description": "…" } ],
  "worktree": { "directory": ".agents/worktrees" } }
```

- **字段**：三个成员固定 id（codex/zcode/qoder，只读），可编辑 `displayName/role/executor/model/description`；worktree 只有 `directory`（仓库相对路径，拒绝绝对路径与 `..`）。
- **executor 三态**：`external`（外部 provider，一次性派发）、`local`（`provider/model` 固定模型本地子代理，可续跑）、`team`（进程内队友，可续跑）。校验：名称唯一、至少一个 brain、local 模型必须在模型目录内、external provider 必须已注册。
- **读写**：页面经 Host 的 loopback 同源 HTTP（`GET/PUT /agent-squad/settings`、`GET /agent-squad/models`）读写；非 loopback socket、非本地 Host（如 `127.attacker.example`）或跨源/异协议 Origin 一律 403。保存走 revision 乐观锁：并发写第二笔返回 **409 REVISION_CONFLICT** 并附服务器当前 settings；页面显示冲突横幅并保留草稿，点"改用服务器版本"经确认才替换。恢复出厂默认只写入草稿，保存才落盘。未保存的草稿在切换设置页后保留（工厂级会话），保存期间编辑冻结，无字段错误的服务器故障（IO/模型目录 503）显示整体错误提示。
- **生效时机**：`squad_start`/`squad_dispatch` 每次都重读设置，保存立即影响下一次派单；运行中的 child 不追溯（local 改绑模型须等其空闲）。
- **持久化**：原子写（同目录临时文件 + rename）；损坏文件先备份 `settings.json.corrupt-<ts>`，备份成功才恢复默认（出厂默认 = 有效 bundle seed），备份失败返回 IO 错误并保留原文件。首次从 bundle 配置 seed，已有合法文件不会被 bundle 覆盖。
- worktree 由插件自建：`git worktree add -b squad-<taskId> <repo>/<directory>/squad-<taskId> <base>`，`squad_finish` 行为不变。

### 验证步骤

1. 隔离 profile 安装本插件，打开设置 → Agent Squad：页面出现，三张卡片 id 只读，SVG 标签随草稿变化，中英切换正常。
2. `GET /agent-squad/models`（或在页面下拉）确认 groups 同时含 `deepseek-account` 与 `zai-coding-cn`。
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
    worktreeAutoCommit: true       # squad_finish 时自动提交 worktree 改动
    agents:                        # 仅作首次 seed；已有合法 settings.json 不会被覆盖
      - name: codex
        role: brain
        provider: codex      # 外部 provider（一次性）
      - name: zcode
        role: worker
        provider: ''
        model: zai-coding-cn/glm-5.3   # provider/model → 本地固定模型（可续跑）
      - name: qoder
        role: worker
        provider: ''         # 空 = team 队友（可续跑）
```

- `role`：`brain` | `worker`（可编辑字段保存在设置文件；bundle 只作 seed 与 charter/context 补充）。
- **worktree 始终启用**（无开关）：每次 `squad_start` 以 Git 元数据（git-dir/git-common-dir）判断，已在 linked worktree 内则复用当前 checkout，否则在 `<仓库>/<设置目录>/squad-<任务号>` 创建新分支；非 Git 仓库或普通创建失败才退回原地开发并在结果中说明。目录切换失败会显式恢复源目录，恢复失败则 start 直接停止。
- **运行中不重派**：目标（本地子代理或 team 队友）处于 running/provisioning 时拒绝再次派单或切换执行方式，避免同时保留两个活动执行者；空闲时同绑定续跑、改绑定（模型/执行方式）则下一次新建。
- **验收门禁快照**：任务建立时把"是否需要 brain 验收"与"是否需要 Lead 批准 PLAN"（`planRequired`）写入 STATE；此后修改角色不能绕过该任务的 REVIEW 要求或 PLAN 批准门禁。
- `worktreeAutoCommit`：默认 `true`；设为 `false` 则 `squad_finish` 只收尾、不提交，改动留在 worktree 里。
- `provider`：DSH subagent provider 名。留空时 `fork → fork`、`fresh → spawn`（进程内 DeepSeek 智能体）。装了 `@deepseek-ai/dsh-subagent-acp` 之类的 provider 后，可把 codex / zcode / qoder 分别指到真实的本地 CLI：

```yaml
      - name: zcode
        role: worker
        provider: zcode-bm
        context: fresh
```

> 真实 CLI 的 provider 需要单独安装并注册（例如 ACP 桥），插件只负责按名字选择 provider，不内置任何厂商二进制。

## 共享记忆布局

```text
<workspace>/.agent-squad/
├── current.json              # 当前任务指针
└── t-<id>/
    ├── TASK.md               # 目标 / 验收标准 / 约束 / 成员（Lead 写）
    ├── BRIEF.md              # 每次派单重写的一次性简报（外部 agent 必读）
    ├── PLAN.md               # 方案 + 编号验收标准（brain 写）
    ├── PLAN-R<n>.md          # 第 n 次设计的方案归档（1–4）
    ├── PLAN-APPROVED.md      # Lead 批准时的方案定稿归档（squad_approve_plan 写）
    ├── REVIEW.md             # 逐条验收结论 + 证据（brain 写）
    ├── REVIEW-R<round>.md    # 每轮验收归档
    ├── REPORT.md             # 改动 / 命令 / 测试证据（worker 写）
    ├── JOURNAL.md            # 追加式流水（所有人写）
    ├── STATE.json            # phase / round / planRequired / planRounds / planApproved / dispatch 记录
    └── FINAL.md              # 收尾摘要（squad_finish 写）
```

### PLAN 归档与门禁

- **external 执行者**：每次成功的 design 派单在返回前同步读取 `PLAN.md` 并归档为 `PLAN-R<n>.md`（n = 派单前 planRounds + 1）；归档失败会显式报错（说明已派单）、planRounds 不增加、不自动重派。
- **local / team 执行者**：design 派单投递成功即计数写 STATE，不逐轮归档；仅在 `squad_approve_plan` 批准时把当前 PLAN.md 补归档为当前轮次 `PLAN-R<n>.md`（已存在的历史归档不改写）。
- **设计预算**：初始设计 + 3 轮返工 = 4 次成功 design 派单；第 5 次拒绝。PLAN 已批准后 design 一律拒绝。
- **实现门禁**：`planRequired`（任务建立时按参与者是否含 brain 快照，之后改角色不生效）且未批准时，implement/rework 在写 BRIEF/STATE/调用执行器之前即被拒绝，错误信息指向 `squad_approve_plan`；无 brain 任务豁免。旧 STATE 无这些字段时按验收门禁快照回退（gate 显式 false 才豁免），不按当前 roster 放宽。

每次派单的消息只带任务号、阶段、轮次、目录和本轮任务，不复制历史对话；队友先读文件再动手。这样跨 agent 的“共享记忆”是可审计的文件，而不是互相复制的 transcript。

## 会话复用（token 关键）

- 队友第一次派单时由 `ctx.agentTeams.spawnTeammate` 创建，之后 `squad_dispatch` 走 `sendMessage`：消息进入同一个子会话，冷启动时按需 resume。
- `squad_dispatch` 返回 `mode=spawned|resumed` 和 `session_id`，可以直接核对返工是否落在同一会话。
- 同一个姓名在 Team 内永久唯一，所以不要为返工新建 agent——再派一次即可。

## 工具

| 工具 | 调用者 | 作用 |
| --- | --- | --- |
| `squad_start` | Lead | 建任务、写 TASK.md/JOURNAL.md、快照 plan 门禁（planRequired/planRounds/planApproved）、设为 current |
| `squad_dispatch` | Lead | 首次创建 / 之后续跑指定队友，推进 phase 与 round；design 受 4 次预算与已批准限制，implement/rework 受 PLAN 批准门禁 |
| `squad_approve_plan` | Lead（仅 Lead 可见） | 审核通过 PLAN.md：补归档当前轮次 `PLAN-R<n>.md`，写 `PLAN-APPROVED.md` 与 `planApproved`/`planApprovedAt`；缺 PLAN、已收尾或已批准时拒绝 |
| `squad_status` | Lead | 任务、阶段、轮次、PLAN 门禁（planRequired / planRounds/4 / planApproved / planApprovedAt）、成员状态、记忆文件、最近派单 |
| `squad_wait` | Lead | 有界阻塞等待团队变化（通常不需要，报告会唤醒 Lead） |
| `squad_finish` | Lead | 校验无队友运行 + brain approved，提交 worktree，切回源目录，写 FINAL.md |
| `squad_report` | brain / worker | 把结果、阻塞或验收结论发回 Lead 并写 JOURNAL |

## 安装 / 卸载

```sh
# 安装（在 DSH 会话里）
plugin_manager install_bundle  <本目录绝对路径>

# 卸载
plugin_manager remove_bundle   dsh-agent-squad
```

本插件的 patch 会顺带挂载 `@deepseek-ai/dsh-experimental-agent-team`（DSH 自带包）。如果之后又启用了官方 `dsh-experimental-agent-team-profile`，两者会重复注册同一个服务，二选一保留。

## 升级与重载

本插件挂载的 Team 运行时与工具都归属于插件上下文。修改 `index.js` 后，用插件管理器禁用再启用 `agent-squad` 即可干净重载（工具全局注册、按 `when` 对 agent 可见；章程分区由插件上下文持有并随重载销毁）。如果旧版本曾在会话里留下作用域注册，升级后需要重启一次 DSH 清除。

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

- **一个会话 = 一个 Team**。队名永久唯一，所以同一会话里换一个完全无关的新任务时，codex/zcode/qoder 仍是原会话；新任务请开新会话，或接受上下文延续。
- **worktree 只从本地提交检出**：源 checkout 的未提交改动不会带过去；子模块、依赖安装、LFS 内容也不由插件处理。
- **不自动合并**：`squad_finish` 只提交分支并给出合并命令，合不合、何时合由你决定。
- **worktree 生命周期**：收尾后 checkout 与分支保留；删除用 `git worktree remove <path>` + `git branch -D <branch>`，插件不自动清理。
- 不提供 worktree/沙箱隔离：所有成员共享同一工作目录，写冲突靠 Lead 划分文件范围 + brain 验收兜底。
- 只支持单任务串行推进（`current.json` 只有一个指针）；并行任务需要多开会话。
- 队友必须主动 `squad_report`；若模型漏报，用 `squad_status` 查看文件与状态，必要时 `squad_wait`。
