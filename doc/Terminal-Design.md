# Session Terminal 设计

状态：第一版已实现，跨平台实机验证持续补充。更新：2026-09-10。

实现调整：按最新要求取消 systemd/cgroup v2 的部署前提，使用跨平台 PTY 加仅负责清理的 guardian。它不持有 PTY master、不转发终端 I/O、不支持恢复；API 仍直接 spawn 和管理 PTY。Linux 已验证普通 shell/后台任务的手动关闭及 API SIGKILL 清理；macOS/Windows 尚未实机验证。完全脱离原进程树/会话的 daemon 清理仍有边界，见第 5 节。

本文定义 Web 内嵌远端终端的产品行为、进程生命周期、接口和部署方式。代码路径以当前 AgentWaypoint 仓库为准。

## 1. 核心决定

- 浏览器使用 xterm.js，API 使用 node-pty 启动服务器上的真实交互式 shell，以 WebSocket 传输输入、输出和尺寸变化。不通过 SSH。
- 每个 PTY 必须绑定一个已有 Session，一个 Session 可以有多个 PTY。Project 提供归属和工作目录上下文，不直接持有终端。
- PTY 是 API 生命周期内的临时资源：API 直接 spawn、在内存中管理，不建立 Terminal 数据库表，不使用独立 Terminal Host，不跨 API 重启恢复。
- API 存活期间，隐藏面板、切换 Session、浏览器关闭和网络断开都不立即关闭 PTY。连续 12 小时没有有效客户端连接的 PTY，由 API 每小时检查并自动关闭；有连接但没有键盘输入不触发回收。用户仍可点击 tab 的 `×` 主动关闭，shell 自行退出也正常结束。
- API 正常退出或 crash 后，自动清理其 PTY。不能仅以 API 的 JavaScript 退出回调作为保障；独立的轻量 guardian 通过 IPC 断开检测实际 API 进程死亡，调用平台清理路径，具体要求见第 5 节。
- 不包装 tmux。用户可以在终端里自行运行 tmux，也可以运行 vim、top、开发服务器、构建和其他普通命令。
- 支持 HTTP + `ws://` 和 HTTPS + `wss://`。默认同源访问，无需先配置 SSL 证书或 Origin 白名单。

这里的“远端”是相对浏览器而言：第一版 PTY 运行在 API 所在机器，不是浏览器机器，也不自动转发到其他 Runner 主机。

## 2. 技术选型与职责

| 部件 | 选择 | 职责 |
| --- | --- | --- |
| 浏览器终端 | `@xterm/xterm`、`@xterm/addon-fit` | 终端显示、键盘/粘贴/IME 输入、尺寸计算 |
| 远端 PTY | `node-pty` | 创建真实伪终端，启动 shell，读写、resize、接收退出事件 |
| WebSocket 服务端 | `ws` | 在 API HTTP server 上处理指定 Upgrade 路径、心跳和连接 |
| Web 入口代理 | Next.js custom Node server + `http-proxy-middleware` | 在现有 Web 端口接收并转发终端 Upgrade |
| 内存中的终端画面 | `@xterm/headless`、`@xterm/addon-serialize` | 为断线重连和页面刷新提供有界终端状态快照 |
| 崩溃清理 | Node guardian + 平台进程清理 | API 消失时清理登记的终端进程，不保存或恢复终端；不要求 systemd/cgroup |

xterm.js 是终端模拟器，不是 shell；真正执行命令的是 node-pty 启动的服务端进程。xterm 官方也介绍了 headless 配合 serialize 维护服务端终端状态的用途。相关包应锁定互相兼容的版本；serialize 的状态覆盖范围需要验收，不能假设能恢复任意应用的所有内部状态。[xterm.js 项目说明](https://github.com/xtermjs/xterm.js)、[serialize addon](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize)

node-pty 启动的进程拥有其宿主用户的权限，并且有原生编译依赖。第一版使用 Node 22.15+（仍限定 22.x），适配 Linux、macOS 和 Windows 的 embedded Runner 部署；它不提供新的权限隔离层。Linux 安装需可用的 C/C++ 编译工具和 Python，Windows 使用 ConPTY。[node-pty 项目说明](https://github.com/microsoft/node-pty)

`ws` 以 `noServer` 模式挂接 Nest/Fastify 底层 HTTP server，只负责终端路径。鉴权通过后才调用 `handleUpgrade`，不另开 WebSocket 端口，不同时引入第二套 WebSocket adapter。[ws 官方用例](https://github.com/websockets/ws)

## 3. Session / Project 交互

### 3.1 归属与初始目录

创建前通过现有数据库确认 `Session → Project → ownerUserId`，随后创建内存资源。浏览器只提供 Session ID、初始尺寸和可选显示名称，不能直接指定其他用户的 Project、任意 PID 或清理目标。

初始目录按以下顺序解析：

1. 使用 Session 创建时保存的 `meta.runtime.cwd`，尊重 Session 的目录快照/覆盖。
2. 仅当旧 Session 缺少该目录信息时，回退到 `Project.repoPath`。
3. 路径不存在、不可访问或两者都缺失，返回明确错误，不悄悄切换到 API 启动目录或用户 home。

终端只需要解析目录，不应依赖 AI 模型配置校验成功。现有 `readSessionRuntimeForExecution` 同时校验后端模型等字段，不宜直接作为终端创建的前置条件。

API 从部署用户的 shell 配置选择可执行 shell，Linux 默认回退到 `/bin/bash`，以对应 shell 支持的交互模式启动。不能给所有 shell 机械传入同一组启动参数。保留正常 PATH、locale 和用户命令行环境，设置 `TERM=xterm-256color`；内部 Web→API 凭据不注入 PTY 环境。shell 和参数以独立 argv 传入，不用字符串拼接 `sh -c` 创建终端。

PTY 中的 `cd` 只改变该 shell 的目录，不回写 Session 或 Project。API 的 `initialCwd` 不冒充实时 cwd。Session 修改配置、Project 改名或改变默认目录，不迁移已经运行的 PTY。

### 3.2 与 AI 会话的关系

- 终端不创建 AI turn，不占用聊天的“正在运行”状态，不自动继承 AI 的命令审批/只读模式。
- Agent 和用户终端可以同时访问同一个工作目录；不自动加文件锁，也不承诺两者的并发编辑无冲突。
- 终端输出不自动写入聊天历史、消息数据库或 Agent 上下文。
- Session fork 创建新的 Session 归属，但不复制 PTY、进程、终端输出或 shell 状态。现有 Session fork 也不代表创建隔离的文件系统工作区。
- 不使用 AI 后端的 `backendThreadId` 标识终端。
- 第一版 `RUNNER_MODE=http` 返回终端能力不可用及原因，避免在 API 主机打开与远端 Runner 同路径但不同内容的目录。后续若支持远端 Runner，必须单独定义该执行节点的生命周期协议。

### 3.3 删除规则

删除 Session/Project 时，如果存在 `starting`、`running` 或 `closing` 的终端，返回 `409 TERMINALS_ACTIVE`，列出需要关闭的终端，界面提示先点击对应 tab 的 `×`。不因为删除会话而隐式杀掉正在工作的终端；原有 active turn 删除限制继续适用。

终端创建、Session 删除和 Project 删除共享按 Project 划分的生命周期锁：在锁内检查归属、删除条件和内存状态，防止“刚检查没有终端，另一个请求就创建了 PTY”的竞态。不能只加前端提示，也不在数据库事务内等待进程退出。

已退出终端不阻止删除；删除成功后丢弃其内存快照和索引。终端不提供跨 Session 移动功能。

## 4. 界面与状态交互

顶部工具栏增加 `Terminal` 开关。没有选中 Session 时禁用并显示原因。打开后，底部出现属于当前 Session 的面板，顶部包含 tab、`+` 和收起按钮；tab 内的 `×` 是终止终端，面板的收起按钮只是隐藏。

| 用户操作 / 事件 | 界面行为 | 服务端行为 |
| --- | --- | --- |
| 显式打开面板，当前 Session 无运行中 PTY | 创建并选中新 tab | 原子执行 ensure，最多创建一个 |
| 显式打开面板，已有运行中 PTY | 优先显示上次选中的运行中 tab，否则最早创建的运行中 tab | 复用，不创建 |
| 点击 `+` | 增加并选中新 tab | 为当前 Session 新建 PTY |
| 切换 terminal tab | 显示选中终端 | 其他 PTY 继续运行 |
| 收起 Terminal 面板 | 隐藏面板 | PTY 继续运行 |
| 面板展开时切换 Session/Project | 切换到新 Session 的终端列表；有则复用，无则 ensure | 原 Session 的 PTY 继续运行 |
| 面板收起时切换 Session/Project | 不打开面板 | 不创建，也不关闭 PTY |
| 点击 tab 的 `×` | 显示 closing，完成后移除 tab | 关闭该终端并确认清理完成 |
| 关闭最后一个 tab | 收起整个 Terminal 面板，顶部开关恢复关闭状态 | 不立即自动补建；下次显式打开才新建 |
| shell 执行 `exit` 或正常结束 | 保留“已退出”tab 和退出码，可查看最后画面 | 清理进程，保留有界内存快照 |
| 页面刷新、关闭、断网或退出登录 | 重连/重新登录后重新查询列表 | 不立即关闭；最后一个连接断开后开始无人连接计时 |
| 连续 12 小时无人连接，小时巡检命中 | 下次查询显示“无人连接超时，已自动关闭”的已退出 tab | 关闭 PTY 及其受管子树，不自动补建 |
| API crash / 重启 | 提示“服务已重启，原终端已结束”，清空旧实例 tab | 清理旧 PTY，新 API 列表为空 |

`ensure` 只由上述明确的打开/切换动作触发，不能由“列表变空”的通用 React effect 触发。shell 自行退出、无人连接超时、关闭最后一个 tab、API 重启，都不能引发自动重建循环。API 重启或超时关闭后，用户通过 `+` 或重新显式打开面板创建新终端，不把新 shell 冒充旧会话恢复。

上表中的“继续运行/不关闭”均指不因界面操作立即关闭，仍受连续 12 小时无人连接规则约束。关闭或隐藏后，如果前端释放了最后一个终端订阅，就会开始计时；保留有效连接的后台页面仍算已连接，不按页面可见性或最后输入时间判断。面板不显示固定的回收规则说明行。

终端正文显式使用无衬线等宽字体栈（Consolas、SF Mono、Menlo、Monaco、DejaVu Sans Mono、Noto Sans Mono），不用 xterm 默认的 Courier 字体；保留等宽以保证命令输出和 TUI 对齐。工具栏沿用应用的无衬线字体。终端不提供网络设置按钮或设置弹窗，Origin 仅属于部署配置。

正常连接且可输入时不显示 Connected 状态行，也不显示右上角目录路径，不为这两项保留空白区域。仍保留连接异常、退出等必要提示和只读连接的接管输入操作；shell 自身输出的提示符和路径不作改写。

桌面端保留底部面板：默认高 320px，最小 160px，最大为窗口高度的 70%。拖拽分隔条使用 pointer capture，支持键盘调整并提供可访问名称。

移动端与侧边栏共用 `max-width: 860px` 断点，改为页面内全屏覆盖，不调用浏览器 Fullscreen API、不同时展示聊天区。隐藏高度拖动条，顶部提供返回、tabs 和新建按钮，触摸目标至少 44px。返回只收起面板、释放浏览器连接，不立即结束 PTY；再次打开复用原终端。关闭最后一个 tab 后自动回到聊天。覆盖期间背景界面设为 inert，返回后恢复。

全屏尺寸跟随 `visualViewport` 的 height/width 与 offsetTop/offsetLeft，并监听 resize/scroll，处理软键盘弹出、浏览器视口平移和横竖屏切换；不支持该 API 时回退窗口尺寸。面板包含 safe-area padding，已有 ResizeObserver 负责将内容区尺寸传给 PTY。移动端尺寸变化不会覆盖桌面保存的面板高度，也不会重新创建 PTY。布局按 CSS 视口宽度决定：大于 860px 时恢复桌面面板。

使用 ResizeObserver 配合 fit addon；只有可见、非零尺寸的活动终端可以提交 resize，拖拽时合并连续更新。面板隐藏时不能把 PTY resize 到 `0×0`。终端输出直接写入 xterm，不逐字符进入 React state。[xterm addon 使用方式](https://xtermjs.org/docs/guides/using-addons/)

浏览器可以按用户保存面板高度、展开偏好，按用户和 Session 保存活动 terminal ID。它们都是偏好，不是事实来源；读取后必须与 API 实例和终端列表核对。后台 tab 不需要一直保留 xterm DOM 或网络连接。

## 5. API 生命周期与崩溃清理

### 5.1 不需要 Terminal Host

API 内的 `TerminalService` 拥有 node-pty 对象、进程引用、订阅和缓冲区。没有独立的终端服务、恢复协议、PTY 元数据数据库或 tmux session。

API 在正常退出时先停止小时巡检并禁止创建/attach，通知连接关闭，终止各终端并等待清理，然后释放服务资源。现有 `main.ts` 的 SIGTERM/SIGINT → `app.close()` 路径应接入这一顺序，并设置有限的退出期限。

但 `SIGKILL`、进程级 OOM 或原生崩溃可能完全不执行 JS 回调。PTY master 文件描述符关闭和 shell 收到挂断，不等于所有后台进程都已消失；普通 process-group kill 也不能完整覆盖另建 session 的进程。Linux 的 parent-death signal 同样不能自动覆盖全部后代进程。[Node 子进程与信号说明](https://nodejs.org/download/release/v22.20.0/docs/api/child_process.html)、[Linux PR_SET_PDEATHSIG](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html)

### 5.2 跨平台清理 guardian

API 第一次创建终端时 fork 一个独立进程组中的 guardian，通过专用 IPC 通道与实际 API 进程保持连接。API 正常关闭时显式通知；API crash 或 SIGKILL 时 IPC EOF 自动触发清理，不依赖仍然存活的 pnpm/watch 包装进程。该进程只保存临时 PID/进程身份和关闭请求，全部终端清理后退出。

创建流程为：API 向 guardian 预登记随机 terminal ID/token → node-pty 启动 gate → gate 通过私有 Unix socket（Windows 为 named pipe）登记 PID → guardian 确认 → gate 才启动用户 shell。未确认或连接失败时 gate 超时退出，不运行用户启动脚本。Unix 使用 `process.execve` 保持已登记 PID，Windows 保留 gate 作为 ConPTY 内 shell 的父进程。[Node process.execve](https://nodejs.org/api/process.html#processexecvefile-args-env)

| 平台 | 第一版清理路径 | 验证状态 |
| --- | --- | --- |
| Linux，含 cgroup v1/v2 | `ps` 进程树/会话发现，加 `/proc` 启动时间防 PID 复用，TERM 后 KILL | 已验证普通 shell、后台任务、API SIGKILL |
| macOS | `ps` 进程树/会话发现与 Unix 信号 | 已提供分支，待实机验证 |
| Windows | ConPTY gate 进程树，PowerShell 启动时间校验，`taskkill.exe /PID … /T /F` | 已提供分支，待实机验证 |

没有 systemd、没有 cgroup v2 或未以系统服务启动，都不会因此禁用 Terminal。仅平台不支持、Runner 不在本机、Node 版本不足或原生模块/进程工具实际不可用时返回具体错误。

### 5.3 关闭和 crash 的准确语义

点击 `×` 时先标记 closing、停止接受输入，旧 ticket 不能再 attach；调用 guardian 清理目标进程，Unix 下先唤醒停止的作业并发送 TERM，再在短暂宽限期后发送 KILL。清理失败保留 closing 供重试，不能只删除内存对象。第一版 DELETE 等待关闭成功后返回 204，不使用异步 202 协议。

shell 自然退出同样清理已跟踪的残余子树，随后保留 exited tab。API 正常退出或 crash 时，guardian 清理所有登记终端，包括没有浏览器连接的终端；创建中尚未被允许启动 shell 的 gate 因握手失败退出。

这里“自动关闭”指不依赖浏览器、管理员点击或 API 重启来触发清理，并在可调度的正常内核状态下于限定宽限期后强制终止；不承诺对不可中断的内核 I/O 或主机故障实现瞬时死亡。

清理边界必须区分 PTY 与完全脱离它的 daemon：第一版能清理 PTY 根进程、其会话内的任务以及已经跟踪到的子进程；进程发现不是操作系统的原子子树容器。快速 double-fork/setsid 后、尚未被采样就完全脱离的服务（包括某些 tmux server 启动方式）可能存活，不能宣称跨平台保证追踪了任意后代。

用户仍可以正常输入 tmux；不包装它，也不执行全局 `tmux kill-server`。既有外部 tmux server/系统服务不属于本应用。若后续需要所有脱离后代也严格随 API 消失，应为各平台增加操作系统级容器适配（例如 Linux cgroup、Windows Job Object），而不是将某一平台机制作为所有部署的前提。

这一清理边界不是针对恶意命令的沙箱。用户通过系统服务管理器、容器管理器或足够权限显式将任务移出管理范围，属于外部服务，不承诺追杀。否则“允许任意主机命令”和“绝对控制所有外部任务”无法同时成立。

### 5.4 对当前启动方式的影响

现有 CLI 仍管理 API/Web，无需安装或配置额外服务。guardian 由 API 按需启动，只监听它与 API 的专用通道；不同 API 实例使用不同 socket/token/PID 集合，不能按用户名或宽泛路径清理进程。

launcher 的 Web 启动入口已经改为 custom Node server，使用原有 Web 端口转发终端 Upgrade。API 的 SIGTERM/SIGINT 关闭路径先关闭 gateway 和终端，再关闭数据库。现有 Bash 运维脚本本身的 Windows 兼容范围没有在本功能中整体重写；终端模块的 Windows 分支不代表所有运维脚本已经原生 Windows 化。

### 5.5 连续 12 小时无人连接自动关闭

这是基于客户端连接的回收规则，不是“12 小时没有输入”或“12 小时没有输出”。API 内的 TerminalService 使用一个每小时触发的巡检任务扫描全部 Session 的运行中 PTY；不需要 cron、独立调度进程、每个 PTY 一个定时器或数据库记录。第一版固定超时为 12 小时、巡检间隔为 1 小时，不增加设置项。

有效连接指已完成身份验证和 attach、绑定到该 PTY，且未断开或被心跳机制判定失效的连接。writer 和只读观看连接都计数；仅查询终端列表、申请 ticket、尚未完成 attach 的 WebSocket、Agent 正在工作或 tmux 自身的客户端都不计数。

每个 PTY 在内存维护有效订阅集合，以及 `unattachedSince` 和对应的单调时钟起点：

- PTY 成功进入 running 时，如果还没有连接，从该时刻开始计时，覆盖创建后从未 attach 的情况；starting 的失败/卡住仍由创建握手超时处理。
- 任意一个有效 attach 成功，立即清空无人连接计时。之后最后一个有效连接从 1 变为 0 时，重新开始完整的 12 小时计时；之前的断线时长不累加。
- 多连接场景下，只断开其中一个不开始计时。重复 close/error 回调必须幂等，不能反复刷新同一次断线的起点。
- 心跳超时、注销、权限撤销和 Origin 策略导致的断开，按有效连接移除处理。异常断网的起点是服务端确认失联的时间，而非无法准确获知的物理断网时间。
- PTY 持续输出、后台任务持续运行或没有键盘输入，均不改变计时。无人连接的长时间构建/训练任务也会被关闭，界面必须明确提示。

每小时扫描时，对候选项检查 `state === 'running'`、有效连接数为 0、无人连接时长 `>= 12 小时`。时长使用可注入的单调时钟计算，UTC 时间仅用于界面展示，避免系统时间校准导致误关闭或不必要地延长保留。

标记 closing 前，在与 attach/手动关闭共用的终端生命周期临界区内重新检查上述条件，并原子完成状态转换，再异步执行关闭。若重连先成功，则跳过本次回收；若关闭先进入 closing，则拒绝后来的 attach，不允许“检查时无人、执行关闭时已经有人”的竞态。申请 ticket 本身不阻止回收。

巡检复用第 5.3 节的 guardian 关闭路径，不只删除内存对象或断开 WebSocket。成功后保留有界的 exited 元数据/最后画面，记录 `closeReason: 'unattached_timeout'`，供下次查询显示原因；点击该已退出 tab 的 `×` 可移除记录。不会为自动关闭的终端自动 spawn 替代进程。

同一 API 只运行一个巡检任务，各轮不重叠；单个终端关闭失败不能阻止其他候选项处理，也不能误标记为已退出。关闭操作复用幂等 promise，并沿用失败诊断/重试规则。API 退出时取消后续巡检，由统一关闭流程接管正在进行的清理。

按小时巡检意味着：在正常调度条件下，实际发起关闭时间为连续无人连接满 12～13 小时，另加短暂的进程清理宽限期；不是精确在第 12 小时执行。事件循环阻塞或主机暂停可能使检查更晚，恢复后下一轮重新读取时钟和连接状态，不把停顿前的候选快照直接用于关闭。

## 6. 临时状态与数据管理

不增加 Prisma 模型，不增加 Terminal 数据库迁移，不向 Session.meta 写入活动 terminal ID。数据库仍只用于已有的登录身份、Project、Session 和目录配置。

API 内存结构示意：

```ts
type TerminalState = 'starting' | 'running' | 'closing' | 'exited' | 'failed';

type TerminalMetadata = {
  id: string;
  apiInstanceId: string;
  sessionId: string;
  projectId: string;
  ownerUserId: string;
  title: string;
  initialCwd: string;
  shell: string;
  state: TerminalState;
  cols: number;
  rows: number;
  createdAt: string;
  connectedClientCount: number;
  unattachedSince: string | null; // running 且无人连接时的 UTC 起点，仅用于展示
  exitedAt?: string;
  exitCode?: number;
  closeReason?: 'user' | 'process_exit' | 'unattached_timeout' | 'api_shutdown';
};

// 实际 TerminalInstance 另含 PTY handle、guardian 登记引用、
// headless 画面、有界输出队列、订阅者、writer lease、关闭 promise，
// 以及用于无人连接时长比较的 unattachedSinceMonoMs（有连接时为 null）。
// connectedClientCount 从有效订阅集合派生，不另建易失配的计数来源。
const terminals = new Map<string, TerminalInstance>();
const terminalIdsBySession = new Map<string, Set<string>>();
```

`apiInstanceId` 每次 API 启动随机生成。terminal ID 也是不可预测的新 ID，不用 PID 作为公开标识。列表、创建和 attach 响应包含实例 ID，客户端检测变化后作废旧缓存、旧序列号和待发输入。

存储边界：

| 数据 | 位置 | 生命周期 |
| --- | --- | --- |
| PTY handle、终端归属/状态、最近画面、控制权、连接计数与无人连接计时 | API 内存 | 至终端清理或 API 退出；exited 画面可保留到关闭 tab |
| Attach ticket、创建幂等结果 | API 内存 | 短有效期，且不跨 API 实例 |
| 面板高度、上次选中的 tab | 浏览器偏好 | 可保留，但必须重新核对 API 状态 |
| Origin 策略、允许来源、公开访问 Origin | 部署 `config.json` / 环境变量 | 持久化配置，与 PTY 无关 |
| Session、Project、身份 | 现有数据库 | 沿用现有规则 |

运行中 PTY 仅按第 5.5 节的连续无人连接时长自动回收，不按输入/输出活跃程度回收。可设置每 Session/每用户/全局创建上限和缓冲预算；达到上限只拒绝新建，不因此关闭已有 PTY。退出 tab 的快照也计入内存预算，必要时丢弃旧的 scrollback 并显示提示，不能让临时资源无限积累。

单 API 实例是第一版前提；不使用 Redis 或跨进程注册表。多 API worker/负载均衡不能直接启用这一内存模型，否则请求可能找不到所属 PTY。

## 7. HTTP 与 WebSocket 协议

以下为拟新增的核心 API，不是现有接口。现有 Web channel 的聊天请求路径不变，终端不走 AI turn 调度，也不自动开放给 bot channel。

### 7.1 控制接口

| 方法与路径 | 含义 |
| --- | --- |
| `GET /api/terminals/capabilities` | 返回 enabled、不可用原因、apiInstanceId、尺寸/数量等限制 |
| `GET /api/sessions/:sessionId/terminals` | 返回当前 API 实例内该 Session 的终端列表 |
| `POST /api/sessions/:sessionId/terminals/ensure` | 原子复用一个 starting/running PTY；没有则创建 |
| `POST /api/sessions/:sessionId/terminals` | `+`：明确新建一个 PTY |
| `PATCH /api/terminals/:terminalId` | 修改显示名称，不改变归属、进程或目录 |
| `POST /api/terminals/:terminalId/attach` | 签发短期一次性 attach ticket |
| `DELETE /api/terminals/:terminalId` | `×`：启动并等待/查询同一个关闭流程 |
| `GET /api/terminals/socket`，HTTP Upgrade | 一个连接绑定一个 PTY，承载实时 I/O |

ensure 在 Project 生命周期锁内优先复用客户端偏好的、确属当前 Session 的活动 ID，否则选择最早创建的活动终端。并发 ensure 必须共享 starting 结果。明确新建带 `requestId`，在同一用户/Session/API 实例内短期去重，防止 React StrictMode、双击和网络重试重复 spawn；不会把两个不同 requestId 的 `+` 合并。

第一版 DELETE 等待关闭流程完成后返回 `204`；进行中可通过列表/事件观察 closing。重复 DELETE 复用已有关闭 promise；已不存在的资源返回 404，客户端重新查询并将“确已不存在”视为关闭完成。无权限资源不泄露进程或目录信息。

创建失败返回 cwd 不可用、shell 不可执行、进程管理不可用或资源限制等具体错误。清理失败不能返回假成功，应保留 closing/诊断状态供重试，并交由 guardian 处理最终 API 退出场景。

### 7.2 连接与鉴权

所有控制请求复用现有登录身份并验证 Project owner。WebSocket 不直接复用只适用于 HTTP context 的 AuthGuard，而是复用其底层身份解析和归属检查逻辑。

一次 attach 流程：

1. 已登录页面通过 JSON POST 获取 ticket；API 检查 Origin、身份和终端归属。
2. ticket 在 API 内存保存，绑定当前登录会话、userId、terminalId、apiInstanceId、浏览器 Origin，有效期建议 30 秒，只能消费一次。
3. 浏览器对同源 `/api/terminals/socket` 发起 Upgrade；Web 入口构造可信的来源上下文，API 校验入口可信性、cookie 和 Origin。
4. Upgrade 后 5 秒内第一条消息必须是 `{type: 'attach', ticket}`。原子消费成功前不发送终端内容，也不接受输入。
5. 服务端发送 ready、快照和后续输出；失败关闭连接。ticket 不放 URL、日志或 localStorage。

断线需要重新获取 ticket，不重复使用旧 ticket。注销、账号停用、权限失效和登录会话撤销应关闭相关连接、撤销票据，但不立即关闭 PTY；如果最后一个有效连接被移除，则开始无人连接计时。已有连接定期重新验证登录有效性，例如每 30 秒，并在本进程处理注销时立即撤销。

对 exited tab 的 attach 只允许读取保留的快照和退出信息，不授予 writer lease，不重新 spawn。closing 状态拒绝新 attach，已有连接只接收关闭进度。

命令输入不加白名单、不逐条审批。仍保留身份和来源检查：允许已授权用户执行任意命令，不等于允许其他网页借用登录 cookie 操作终端。HTTP 不提供链路加密；部署可用已有可信网络边界，产品不强制 HTTPS。

### 7.3 消息、控制权与重连

协议使用有版本的 tagged JSON 消息；单连接单终端避免初版复用协议的复杂度。至少定义：

- 客户端：`attach`、`input`、`inputBinary`、`resize`、`ack`、`takeControl`。
- 服务端：`ready`、`snapshot`、`output`、`resized`、`controlChanged`、`exit`、`closing`、`error`、`resyncRequired`。

文本输入保持原样写入 PTY，不按行解释。支持 xterm 的二进制输入事件，例如用 base64 传输再还原字节，不能将所有鼠标协议数据都按普通 UTF-8 文本改写。限制单帧尺寸、粘贴分块和合法 rows/cols，禁用不必要的 WebSocket 压缩。

同一个 PTY 可以有多个观看连接，但同一时间只有一个 writer lease。第一个连接默认取得控制权，其他连接只读并显示“接管输入”按钮；接管后通知原控制端变为只读。只有 writer 能发送输入、终端响应和 resize，避免两个屏幕尺寸相互覆盖。断线释放控制权但不立即杀 PTY；无人连接回收依据所有有效订阅，而不是是否存在 writer。

输出和 resize 共享服务端有序序列，标识由 `apiInstanceId + terminalId + seq` 构成。输入不做自动重放：网络断开时尚未确认是否写入的命令，不能在重连后再次执行。连接不可用时禁用输入并提示，不缓存一整段命令等待恢复。

每个 PTY 保留有界 headless 终端状态与增量输出队列。重连时在序号 S 的状态上生成快照，快照包含当时尺寸；客户端 reset 后恢复，再按序应用 S 之后的输出/resize。必须等待 headless 的异步 write 完成、正确处理快照期间新到的数据；若增量溢出，则重新生成快照。

不能把任意截断的原始字节缓冲直接重放给一个全新 xterm，并宣称恢复了 vim/tmux 的完整显示。重放期间抑制客户端自动回复/用户输入，headless 解析产生的终端回复也不反向写入 shell；实时阶段只有 writer 回复终端查询，避免一次查询被多个模拟器重复响应。没有观看者时仍持续解析输出，但不保证无人连接时应用的终端查询一定得到即时答复。

近期 scrollback 有上限，旧内容可能淘汰；这不是命令日志持久化功能。前后端 xterm 版本必须匹配，并验收 alternate screen、光标模式、Unicode 和 resize 后的恢复效果。

### 7.4 背压与无客户端运行

无客户端且尚未回收时，API 仍读 PTY，并更新有界画面/缓冲，否则程序会因输出无人消费而阻塞；这些输出不重置 12 小时无人连接计时。慢连接设置独立发送高水位，超过预算后断开该连接并要求 resync，不让最慢的浏览器阻塞全部观看者或无限占用 API 内存。

客户端完成 xterm write 后才 ACK。服务端 headless 自身的处理队列同样需要高/低水位，必要时短暂 pause/resume PTY 读取；“一直运行”不等于无限缓冲或完全没有操作系统背压。[xterm flow control 指南](https://xtermjs.org/docs/guides/flowcontrol/)

建议每 25 秒执行 ping/pong 心跳；超时先清理连接和 lease，不立即终止 PTY，连接数归零时启动无人连接计时。重连采用有上限的指数退避；面板隐藏时可 detach，重新打开后走正常快照恢复流程；若原 PTY 已超时关闭，显示关闭原因并按显式打开规则创建新终端。

## 8. 同源入口与 HTTP 支持

浏览器始终使用当前页面的 host 和端口构造连接：HTTP 页面使用 `ws://`，HTTPS 页面使用 `wss://`。不把内部 `API_BASE_URL`、API 端口或 `0.0.0.0` 暴露为浏览器连接地址。HTTPS 页面不能回落到不加密的 ws。[WebSocket 构造方式](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket)

当前 `apps/web/src/app/api/[...path]/route.ts` 使用 fetch 代理 HTTP/SSE，不是 Upgrade 代理。实现时为 Web 增加 custom Node server：普通 HTTP 交给 Next request handler，仅精确匹配 `/api/terminals/socket` 的 Upgrade 转发到 API；其他 Upgrade 交给 Next 自身 handler，保留开发 HMR。

`http-proxy-middleware` 提供在 HTTP server 的 upgrade 事件中代理 WebSocket 的方式。不能只在 Next Route Handler 增加 GET 就认为已支持 WebSocket。[代理官方说明](https://github.com/chimurai/http-proxy-middleware)

同时修改 Web package scripts 和 `scripts/agent-waypoint.mjs`：当前 launcher 直接调用 `next start`，只改 package.json 不会生效。custom server 入口需自行构建/运行；Next 官方提示它与 standalone 输出不兼容，并会失去部分默认优化，需在后续打包方案中明确采用这一运行模式。[Next 15 custom server 文档](https://nextjs.org/docs/15/app/guides/custom-server)

如外部入口做 TLS 终止或 Host 重写，通过下节的公开 Origin 配置还原浏览器看到的来源，不无条件信任外部 `X-Forwarded-*`。Web 重启会中断连接，但 API 未退出时 PTY 继续运行。

## 9. Origin：存储、迁移与更新

这里的 Origin 是浏览器安全来源，例如 `http://host.example:3000`，与 Git remote 的 origin 无关。它包含 scheme、host、port，不包含路径；HTTP 页面的 WebSocket Origin 仍是 `http://...`，不是 `ws://...`。[WebSocket Origin 协议](https://www.rfc-editor.org/rfc/rfc6455.html)

### 9.1 默认策略与存储

新增以下部署配置键，延续当前 config 的字符串形式；以下只展示新增字段，不是完整 config 文件：

```json
{
  "TERMINAL_ORIGIN_POLICY": "same-origin",
  "TERMINAL_ALLOWED_ORIGINS": "",
  "PUBLIC_WEB_ORIGIN": ""
}
```

- `same-origin` 为默认：浏览器 Origin 必须等于可信 Web 入口对应的 Origin，无需提前列举每一个直接访问的域名/IP。
- `PUBLIC_WEB_ORIGIN` 非空时，作为该部署固定的公开 Origin，用于外部 TLS 终止或 Host 重写。为空时由 Web 入口实际连接协议和有效 Host 计算；不采用客户端随意提交的 forwarded header。
- `TERMINAL_ORIGIN_POLICY=allowlist` 时，仅接受 `TERMINAL_ALLOWED_ORIGINS` 的精确匹配项，不额外并入任意动态同源 Host。列表采用逗号分隔、trim、标准化和去重。
- allowlist 用于显式限制允许访问的公开入口，不意味着第一版支持任意跨站嵌入及跨站 cookie 登录。
- Origin 只接受规范化的 HTTP/HTTPS origin；拒绝 `*`、`null`、用户密码部分、非根路径、query 和 fragment。默认端口进行标准化，不把 localhost 和 127.0.0.1 当作同一个 host。
- `LISTEN_IP=0.0.0.0` 是绑定地址，不是允许来源。没有 Origin 的浏览器终端握手拒绝；非浏览器接入另行设计。

这些值存放在当前 `AGENTWAYPOINT_HOME/config.json`，允许启动环境变量覆盖，不存 Session/Project 或新的数据库表。same-origin 防御跨站页面借用凭据，但不是网络访问控制或完整的 DNS rebinding 防护；需要固定主机边界的部署使用固定公开 Origin/allowlist。

### 9.2 Web 到 API 的可信来源上下文

API 接收到的 Host 可能是内部地址，不能直接与浏览器公开 Origin 比较。Web 入口应为终端控制请求和 Upgrade 转发原始浏览器 Origin、计算出的外部请求 Origin，并附带内部入口认证。

第一版由 API 在隔离 home 的 `run/terminal-ingress.key` 创建权限为 0600 的随机入口凭据，供同部署的 Web 和 API 读取。Web 先删除/忽略外部请求携带的所有同名内部头，再注入自己的上下文和凭据；API 验证凭据后才信任这些头，终端路径不接受未经验证的直接绕过入口请求。凭据不下发浏览器、不记日志、不进入 PTY 环境；它是部署入口凭据，不是 PTY 状态，重启时保留以支持 Web/API 分别重启。

Origin 策略的权威判断位于 API，Web 负责提供可信的请求上下文；这样配置更新不要求 Web 与 API 同时热更新策略。API 根据最新 `PUBLIC_WEB_ORIGIN` 或该上下文计算 expected origin，同时对 ticket 中绑定的浏览器 Origin 做核对。

现有 fetch 代理只显式转发 cookie 等少量头，因此 HTTP 代理和 Upgrade 代理都要接入此机制。终端相关的修改请求还必须验证 Origin/要求 JSON；不能只保护 socket 而允许其他站点创建或删除 PTY。现有其他 API 的行为保持不变，不借此进行全站鉴权重构。

### 9.3 老配置迁移

缺少上述键的配置按默认 same-origin 读取，不要求用户先修改文件、重新登录或完成数据库 migration。已有同源页面访问地址可以继续使用。

不采用首次访问自动信任并写入 Origin 的机制，也不在观察到陌生 Origin 时自动扩大白名单。需要固定公开入口或 allowlist 时，由管理员明确配置；Host 重写/TLS 终止的部署在启用时检查并提示是否需要 `PUBLIC_WEB_ORIGIN`。

升级只添加可选配置读取和默认值，不强制重写整个 config、不替换 JWT/cookie 配置。回滚时老代码应继续忽略这些附加键，原有聊天 API 不依赖这些新字段。

### 9.4 更新与生效

不提供 Terminal network settings 界面，也不提供对应的 GET/PATCH 配置管理接口。管理员通过部署的 `config.json` 或启动环境变量配置 Origin，终端页面不读取或写入配置文件。

手动编辑文件时应保留其他字段、限制文件权限，并建议使用同目录临时文件加原子 rename，避免留下不完整 JSON。读取时验证完整的新策略（包括非空有效 allowlist）；管理员可以有意移除旧入口，不自动把旧入口加回来。

有效优先级为“真实启动环境覆盖 > 文件 > 默认”。当前 bootstrap 会将文件配置复制到 `process.env`，不能随后把这些复制值误认为不可变的环境覆盖：新热更新键应排除在该复制机制外，由专门配置 resolver 管理，并修正 launcher 对这些键的传递方式。

API 在终端请求和连接定期验证时重新读取文件，只有校验成功才替换旧策略，失败保留旧有效值；没有有效旧值时返回错误。真实环境变量覆盖文件配置，改变环境变量需重启部署；重启 API 会结束所有 PTY。

新策略生效后撤销未消费 ticket，后续请求立即使用新策略。已连接且来源不再允许的 socket 断开，但 PTY 不立即关闭；仍合法的连接不必断开。断开后无人连接的 PTY 按 12 小时规则计时。Origin 更新不触发 PTY 重新创建，也不写入终端状态数据库。

## 10. 仓库落点与实施顺序

第一版落点如下；进一步的平台强化与完整验收仍按上述边界推进：

| 位置 | 工作 |
| --- | --- |
| `apps/api/src/modules/terminals/`（新增） | TerminalService、控制接口、WS gateway、schema、内存索引、画面与进程管理接口、连接计时与每小时回收巡检 |
| `apps/api/src/main.ts`、`app.module.ts` | 注册模块、连接底层 Upgrade、统一关闭顺序 |
| `apps/api/src/modules/sessions/`、`modules/projects/` | 共享归属/目录解析与生命周期锁、删除时活动终端检查 |
| `apps/api/src/modules/auth/` | 复用身份校验、撤销订阅通知，不新增终端身份体系 |
| `apps/api/src/modules/terminals/terminal-network.ts`、`bootstrap/local-bootstrap.ts` | 部署 Origin 配置读取、兼容默认值和环境覆盖，不提供设置界面/API |
| `apps/web/src/app/page.tsx`、`globals.css` | 顶部开关、Session 选择联动、底部布局 |
| `apps/web/src/components/terminal/`（新增） | Panel、Tabs、xterm View、拖拽、连接和控制权状态 |
| `apps/web/server.*`（新增）、现有 API proxy | 同端口 Upgrade、可信入口上下文、保留 Next HMR |
| `scripts/agent-waypoint.mjs`、相关启动入口 | Web custom server，沿用已有启动参数与隔离 home |
| `apps/api/src/modules/terminals/runtime/`、`apps/api/scripts/copy-terminal-runtime.mjs` | 跨平台 guardian/gate、握手、失败退出与构建复制；不实现 Host |
| API/Web package.json、lockfile | 增加已选包并锁定兼容版本，验证 Node 22 原生构建 |

第一版已按以下四个部分实现；平台实机验证和更严格的脱离进程清理仍待补充：

1. **进程生命周期验证**：验证 guardian/gate 在当前平台对实际 API 进程 SIGKILL 的响应，分别补充 macOS/Windows 实机结果和脱离进程清理增强。
2. **内存服务和传输**：完成归属、cwd、ensure/创建/关闭、连接计时与小时巡检、同端口 WS、身份与 Origin 默认策略、启动脚本。
3. **界面和重连**：完成面板/tabs、Session 联动、尺寸、快照、背压、控制权和 API 实例变化提示。
4. **配置更新与回归**：完成部署 Origin 配置读取、旧配置兼容、删除竞态及全面测试，随后更新已实现架构/接口文档。

不在本次设计中加入终端审计数据库、命令审批系统、跨 API 恢复、远端多节点路由、终端到 Agent 的自动上下文同步或独立 Host。

## 11. 验收要求

### 生命周期与清理

- 无客户端连接、隐藏面板、刷新页面、切换 Session/Project、注销后，在无人连接回收阈值内，计时命令和后台任务仍运行，重新连接到同一个 PTY。
- 用可注入时钟和假定时器验证：未满 12 小时不关闭，达到 12 小时后首次小时巡检关闭，正常调度下的触发窗口为 12～13 小时；不让测试真实等待 12 小时。
- 始终有连接但没有输入，或只有只读连接时，不回收；持续有输出但无人连接时仍回收；创建后从未 attach 的 PTY 也回收。
- 两个连接只断开一个不开始计时；最后一个断开才开始；重连清零，再次全断开重新计满 12 小时；重复断开事件不推迟期限。
- 列表轮询、未消费 ticket、未认证/未完成 attach 的 socket 不续期；心跳判定失联、注销和 Origin 撤销正确减少有效连接数。
- 巡检与 attach/手动关闭并发时不误杀已重连终端、不重复关闭；系统墙钟前后调整不改变判定；一项关闭失败不阻塞其余候选项，API 退出取消巡检。
- 自动回收复用受管子树清理，保留 `unattached_timeout` 原因，不自动补建；用户下次显式打开时可新建，不能恢复已关闭的旧进程。
- 同 Session 并发 ensure 只创建一个；两个明确的新建请求各创建一个；Session 切换中晚到的响应不挂到错误面板。
- 点击 `×` 只关闭目标终端及其受管子树，不影响其他终端；关闭最后一个 tab 后自动收起面板、不自动补建，再次显式打开会新建终端。
- shell 自然退出不自动重启；已退出 tab 能查看最后画面并关闭。
- API 正常停止、实际 API PID 的 SIGKILL、原生异常退出/进程被系统终止，均在不重启 API 的条件下触发清理。
- crash 测试覆盖前台程序、普通后台程序、忽略 HUP 的程序，以及已跟踪的后代。对快速脱离的 daemon/tmux server 单独记录边界，不能把关闭 WebSocket 作为进程清理通过的依据。
- crash 恰逢 PTY 创建/关闭、多个 Session 都有终端、没有浏览器在线时也不泄漏；预先存在的外部 tmux server 和其他 home 的服务不被误杀。
- API 重启后实例 ID 改变、终端列表为空，浏览器不能向旧终端发送输入，也不自动重放未确认的命令。

### 使用体验与资源

- 验证 bash/zsh、Ctrl-C/Ctrl-D/Ctrl-Z、作业控制、vim/top、用户自行输入 tmux、中文/宽字符/IME、鼠标模式、多行粘贴和拖拽 resize。
- 在 alternate screen、resize 中断和高输出速率时刷新/断线重连，画面恢复有序；慢客户端不会导致 API 无限增大缓冲。
- 无观看者时持续输出仍有界；旧 scrollback 淘汰有提示；不因为收起面板而停止读取 PTY。
- 两个浏览器连接时控制权明确，非 writer 无法输入或覆盖尺寸。
- 手机尺寸下全屏覆盖、背景不可交互、返回后原 PTY 仍运行；横竖屏和软键盘视口变化不重建 PTY、不覆盖桌面高度偏好；恢复桌面尺寸后拖动条可用。
- Session/Project 删除与新建终端并发时，不产生无归属终端；达到资源上限只拒绝创建。

### 网络、配置和回归

- 无新增 Origin 配置的旧 config 可在 HTTP 同源地址使用；HTTPS 部署使用 wss，不要求另开 API/WS 公网端口。
- 验证合法/非法/缺失/null Origin、端口变化、Host 重写、伪造内部转发头、过期/重复 ticket、跨用户访问和注销撤销。
- Origin 文件重读后生效；不合法文件保留旧有效策略；环境覆盖优先；终端不写入部署配置、不提供网络设置界面或接口；移除来源只断连接不杀 PTY。
- `next dev` 的 HMR、生产 launcher、自定义端口、已有 HTTP/SSE 和聊天功能继续可用。
- 在 isolated home、非保留端口执行测试，不使用真实 `~/.agentwaypoint`，不使用 4242/3443；进程清理测试只针对本轮创建的隔离实例。

实现时按 [AGENTS.md](../AGENTS.md) 执行 API/Web typecheck、package tests 和 API E2E，并补充专门的 PTY/guardian 集成测试。现有 API E2E 可以验证接口规则，但不能替代真实 Linux crash 清理和浏览器终端行为测试。

当前 Linux 环境已通过 API 100 项测试、Web 11 项单元测试、生产模式 4 项浏览器测试（含 2 项移动端模拟），以及 API/Web 类型检查和构建；开发模式此前通过 2 项桌面浏览器测试。真实 PTY 测试覆盖手动关闭和 API SIGKILL 后 shell/普通后台任务的退出；浏览器额外验证注销立即撤销连接但保留 PTY、非法 Origin 拒绝及开发模式 HMR。这不代表上述所有验收场景或 macOS/Windows、iOS/Android 实机验证已经完成。

浏览器端到端测试：安装 Chromium 后运行 `AW_TERMINAL_TEST_NEXT_DIR=.next-terminal-test corepack pnpm test:terminal:browser`，使用独立构建目录，避免覆盖正在运行实例的 `.next`。测试自动创建临时 SQLite/home 和随机 TCP 端口，用 mock AI runner 配合真实 PTY，验证 HTTP 输入、恢复、面板尺寸、多 tab、关闭最后一个 tab 后收起与重新打开、无衬线字体、无网络设置和回收提示行；不访问真实服务。

移动端用 Chromium 的手机视口与触摸模拟检查全屏布局、横竖屏切换、返回保留 PTY、tabs，以及返回桌面布局。软键盘通过模拟 VisualViewport resize/scroll 验证尺寸和 PTY 行数更新；这不等价于真实 iOS/Android 软键盘、中文输入法和系统剪贴板验收，仍需实机补充。

设置 `AW_TERMINAL_TEST_WEB_DEV=1` 后直接运行 `corepack pnpm exec playwright test`，额外检查开发模式 HMR 与终端 Upgrade 共存。第一版通过 Next 的公开 `httpServer` 选项将其自动注册的 Upgrade handler 放在单独的未监听事件目标上，再显式分流，避免 Next 提前关闭 `/api/terminals/socket`。
