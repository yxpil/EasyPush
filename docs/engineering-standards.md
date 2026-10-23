# EasyPush 工程规范

| 项目 | 内容 |
| --- | --- |
| 版本 | 1.0.0 |
| 日期 | 2026-10-23 |
| 适用对象 | 所有修改 `src/`、`web/`、`tests/`、`scripts/`、构建配置与文档的贡献者 |
| 强制程度 | 除标注"建议"外均为合并/发布门槛 |

## 1. 基本原则

1. **可验证优先于可扩展**：先写能证明行为的测试，再抽象；不为假设中的未来需求增加层级或配置。
2. **安全边界显式**：每个来自网络的输入都视为不可信；每个高风险动作都有审批或明确的风险开关。
3. **最小依赖**：运行时依赖越少越好；不引入需要公网、账号或后台上传数据的库。
4. **诚实交付**：未执行的测试、未验证的平台、未签名的产物必须如实标注，不用"应该可以"替代证据。
5. **单实例、单用户、单屏**是当前产品的明确约束；违反该假设的设计需要先写 ADR。

## 2. 技术栈与版本

| 层 | 技术 | 版本约束 |
| --- | --- | --- |
| 运行时 | Node.js | 24.x（开发/构建）；Electron 45 内置 Node 供主进程使用 |
| 语言 | TypeScript | 5.9.x，`strict` |
| 桌面 UI | React 19 + Vite 8 | 版本锁定 |
| 手机网页 | 原生 DOM + TypeScript + Vite 8 | 不引入 React/Vue |
| 测试 | Vitest 5、Playwright 1.64 | 版本锁定 |
| 静态检查 | oxlint | 0 warning / 0 error |
| 打包 | electron-builder 26（Windows NSIS x64） | 版本锁定 |
| 运行时依赖 | `ws`、`qrcode`、`node-forge`、`fast-xml-parser`、`hls.js` | 全部锁定精确版本 |

依赖使用精确版本（无 `^`/`~`），由 `package-lock.json` 锁定。新增运行时依赖必须说明：为什么标准库/现有依赖不能满足、许可证、维护状态、体积与安全影响。

## 3. 目录与分层

```
src/main/          Electron 主进程（唯一拥有 Node/系统权限的层）
  core/            配置、存储、证书、日志、网络、AppCore
  net/             HTTP/HTTPS、WebSocket、路由与安全头
  services/        配对、直播、媒体库、展示状态机
  dlna/            SSDP、描述、SCPD、SOAP、GENA
src/preload/       受控 IPC 桥（contextBridge）
src/renderer/      桌面 React 界面（无 Node 权限）
src/shared/        纯类型、协议解析、无副作用工具（三端共享）
web/               手机网页（原生 TS，无 Electron 依赖）
tests/unit|integration|e2e
scripts/           构建辅助、图标生成、打包冒烟
docs/              产品、架构、协议、安全、设计、验证、运维、ADR、本规范
```

分层规则：

- `shared` 不得导入 `main`、`renderer`、`web` 或 Node 内置模块（保持纯函数/类型）。
- `renderer` 与 `web` 不得导入 `main`；所有能力经 HTTP/WS 或 preload IPC。
- `main` 不得导入 `renderer`/`web` 源码，只通过静态目录提供构建产物。
- 业务规则放在 `services`/`core`，路由层只做参数提取、鉴权与响应映射。
- 跨层共享的错误码、超时、上限值放 `shared` 或 `core/config.ts`，禁止魔法数字散落。

## 4. TypeScript 规则

- 开启 `strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`、`noFallthroughCasesInSwitch`、`useUnknownInCatchVariables`；不得通过 `// @ts-ignore`、`as any` 绕过。
- 外部输入（JSON、HTTP 头、查询参数、SOAP）先收窄为 `unknown`，逐字段校验后再使用；禁止直接断言为业务类型。
- `catch` 变量为 `unknown`，必须显式收窄；不得假设 `Error`。
- 非空断言 `!` 仅用于已由同一作用域证明的不变量，并在评审中说明；优先重构控制流。
- 导出类型优先 `interface`；联合类型用于状态与消息；避免枚举（用字面量联合，便于序列化）。
- 函数参数超过 3 个或含多个布尔开关时改用对象参数；布尔参数命名必须能读懂（如 `remember`，而非 `flag`）。
- 不在模块顶层执行 I/O 或读取环境；副作用集中在 `bootstrap`/`start`。
- 异步函数必须 `await` 或显式 `void`（fire-and-forget 需有错误处理与生命周期考量）。
- 文件命名：模块用 kebab-case 或既有单词（`mediaLibrary.ts`、`rateLimiter.ts`）；React 组件 PascalCase（`ApprovalOverlay.tsx`）；测试与被测文件同名。

四套 typecheck（主进程、渲染器、手机网页、测试）必须全部通过。新增目录时同步更新对应 `tsconfig` 的 `include`，不得把测试文件混入生产配置。

## 5. 代码风格

- 2 空格缩进；单引号；语句结尾分号；多行结构保留尾逗号。
- 行宽不强制，但避免超过约 120 字符；长表达式提取为有名字的变量。
- 导入顺序：Node 内置 → 第三方 → 本地（`../shared` → 同层）；类型导入使用 `import type`。
- 命名：类型 `PascalCase`，变量/函数 `camelCase`，常量 `UPPER_SNAKE_CASE`，事件名 `domain.action`（如 `live.auto_approved`）。
- 注释只解释**为什么**（隐藏约束、浏览器怪癖、安全权衡），不复述代码；不保留被注释掉的代码。
- 用户可见文案用简体中文，服务端错误同时返回稳定 `code` 与可读 `message`；代码/日志用英文。
- 不使用 `console.log` 作为生产日志；统一走 `Logger`（开发模式由 `consoleLogs` 输出）。
- 时间单位写入变量名（`expiresAt`、`imageSlideMs`）；时间戳统一毫秒。

## 6. 安全编码规则

1. **先鉴权后读 body**：需要会话的路由在读取请求体、写文件之前完成令牌校验；上传同时校验 `Content-Type` 与设备限速。
2. **Host/Origin/Sec-Fetch-Site**：所有浏览器可达路由经过统一校验；新增路由不得绕开 `applySecurityHeaders` 与 Host 允许列表。
3. **路径**：任何来自请求的路径片段都必须 `resolve` 后校验位于根目录内；文件名使用生成的 ID，不使用用户文件名落盘。
4. **回环隔离**：`/desktop` 与 `/media` 保持仅回环；新增管理类页面默认回环，除非有 ADR 说明。
5. **上传**：流式写盘、边写边计数、超过上限立即销毁流并删除部分文件；限制并发与速率；拒绝空文件；MIME 与扩展名双重归一化。
6. **令牌**：使用服务端密钥 HMAC-SHA256；比较使用恒定时间函数；令牌不写日志、不回显到页面 URL（ticket 除外，且一次性）。
7. **随机数**：安全场景使用 `crypto.randomBytes`/`randomUUID`，禁止 `Math.random`。
8. **XML/SOAP**：解析器禁用外部实体；限制 body 大小；对 DIDL/URI 做长度与协议校验。
9. **DLNA**：控制端点仅私网/回环；SUBSCRIBE 回调地址必须与来源 IP 一致；禁止端口 1900；限制订阅数与超时。
10. **CSP/头**：页面响应设置 CSP、`X-Frame-Options: DENY`、COOP、`Permissions-Policy`、`nosniff`；不得为方便调试放宽生产策略。
11. **Electron**：保持 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；preload 只暴露白名单方法；IPC 校验发送者窗口与 URL；禁止 `shell.openExternal` 打开未校验 URL。
12. **日志**：按键名脱敏；不记录媒体内容、完整令牌、Cookie、私钥；诊断包不做"方便排查"的例外。

安全相关改动必须同时在 `tests/e2e/security.spec.ts` 或对应集成测试中增加**能失败的**用例，并更新 [安全设计](security.md) 的威胁/控制表。

## 7. 错误处理与状态

- 可预期失败使用类型化错误（如 `UploadError`、`PresentationError`），路由层映射为稳定 HTTP 状态与 `{ error: { code, message } }`。
- 不把内部异常文本直接返回给客户端（可能包含路径、密钥线索）；记录日志后返回通用文案。
- 仅有明确理由的 best-effort 操作可以吞掉异常（如通知、运行态文件、日志清理），必须保持静默且不改变主流程。
- 状态机转换必须集中定义与测试；禁止在路由/UI 中零散修改状态。
- 定时器必须 `.unref()`（除非需要保持进程存活）并在关闭时清理；事件监听器在会话结束时移除。
- 队列必须有上限；新的异步任务要考虑关闭中的应用（`closed` 标志）。
- 关停顺序：停止接收新请求 → 结束直播/媒体 → 停止 DLNA → 关闭 HTTP/HTTPS → flush 状态与日志 → 删除运行态文件。

## 8. 日志与可观测性

- 事件名采用 `domain.action`，如 `pair.ticket_invalid`、`media.uploaded`、`certs.generate_leaf`。
- 字段使用稳定英文键；包含必要上下文（设备 ID、字节数、错误类型），不包含敏感值。
- 级别：`error` 仅用于需要人工关注的失败；可恢复的客户端错误用 `warn`/`info`；高频路径避免 `debug` 泛滥。
- 用户可见状态（Toast、审批、错误）必须与日志事件对应，便于按时间排查。
- 诊断信息只包含版本、环境、快照、设备摘要与最近日志；新增字段前评估隐私影响。

## 9. 测试规范

### 9.1 编写要求

- 测试名描述**行为与条件**（"rejects a wrong pairing code without creating a device"），不描述实现。
- 单元测试纯函数优先；集成测试使用临时目录与真实对象；E2E 走真实端口/进程。
- 不访问公网；不使用 `sleep` 等待异步结果，使用 `waitFor`/轮询条件/事件；时间敏感逻辑注入时钟。
- 每个测试独立准备与清理；E2E 使用隔离 `userData`，结束后删除。
- 断言关键副作用（文件、状态、头、Cookie 属性），不只断言状态码。
- 安全用例必须能在移除控制后失败；禁止把"返回 403"写成无来源构造的孤立测试。
- 组件/页面测试覆盖空、加载、错误、禁用态；媒体测试等待实际解码（如 `naturalWidth > 0`、`readyState`），不依赖 `visibilityState`。
- 资源互斥（摄像头、端口、单实例）时串行执行，并在注释中说明原因。

### 9.2 数量与门禁

- 当前基线：75 个 Vitest + 17 个 Playwright；新增功能必须附带测试，修 bug 优先补回归用例。
- 数量变化时同步 README、`product-spec.md`、`verification.md`；不得为凑数添加无断言测试。
- 合并前运行 `npm run test:all`；发布前追加打包冒烟与人工矩阵。
- 失败不得用重试掩盖；`forbidOnly` 在 CI 开启，禁止提交 `.only`。

### 9.3 测试替身

- 允许：假摄像头、固定时钟、临时目录、内存日志。
- 不允许：用 mock HTTP 替代安全头/路由测试、mock WebRTC 数据通道替代端到端协商、mock 文件系统替代落盘边界（除非故障注入）。
- 外部 DLNA 设备无法自动化，必须列入真机矩阵，不得用单元测试宣称兼容。

## 10. 前端与交互规范

- 视觉遵循 [设计系统](design-system.md)：只使用登记的色彩/圆角/断点；新增令牌先改文档。
- 所有图标按钮有 `aria-label`；表单有可见标签；对话框有 `role="dialog"`、`aria-modal` 与标题关联。
- 键盘：主流程可完成；`Escape` 关闭最上层；焦点可见；新增弹窗应实现焦点陷阱或在文档中登记缺口。
- 状态齐全：空、加载、错误、禁用；长文本与 320px 宽度不溢出；触控目标不小于 36px。
- 不使用外部字体、CDN、远程图片；所有资源随包分发。
- 动画仅用于反馈与层级切换，支持 `prefers-reduced-motion`；不用动画延迟关键信息。
- 桌面与手机共享语义而非组件；改动共享状态字段时同时检查两端渲染与 E2E。
- 不在渲染进程直接使用 Node API；所有系统能力经 preload 白名单。

## 11. 依赖与供应链

- 依赖精确锁定；升级需单独 PR，附 `npm run test:all` 与打包冒烟结果。
- Electron/Chromium 升级属于高风险变更：必须重跑摄像头、屏幕共享、DLNA、TLS 与打包冒烟，并人工抽查一台手机。
- 新增依赖检查：许可证（MIT/Apache-2.0 等）、最近维护、已知漏洞、安装脚本、是否发起网络请求。
- 禁止引入遥测、自动更新 SDK 或需要云端 key 的库。
- 构建镜像/代理配置属于环境，不写入仓库；CI 使用默认源，必要时由组织配置。
- 不在仓库提交 `node_modules/`、`dist/`、`release/`、生成的图标、日志、测试产物或任何密钥/证书。

## 12. Git 与评审

- 主分支保持可发布；每个 PR 聚焦单一目的，避免混合重构与功能。
- 提交信息说明"为什么"与影响范围；不提交调试代码、临时文件、个人路径。
- PR 描述必须包含：变更摘要、风险点、验证命令与结果、截图/证据（UI 变更）、未覆盖项。
- 评审至少检查：安全边界、错误路径、关停清理、类型收窄、测试是否能失败、文档是否同步。
- 涉及审批、证书、回环、DLNA 暴露、限速的改动需要第二名评审者（或维护者明确签署）。
- 不强制要求 `--no-verify`；本地钩子失败应修复根因。禁止绕过签名/钩子。

## 13. 构建与发布

### 13.1 构建

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run test:e2e       # 含 build
npm run dist           # NSIS：release/EasyPush-1.0.0-x64.exe
npm run dist:dir       # 免安装目录
node scripts/verify-package.mjs
```

- `build` 生成 `dist/main`、`dist/renderer`、`dist/web`；`dist` 为构建产物，可安全删除。`npm run clean` 只清理 `dist/`，不会删除已构建的 `release/`，避免误删已签收的安装包。
- 图标由 `scripts/make-icons.mjs` 确定性生成，`prebuild` 自动执行；生成物不提交。
- 打包为 asar；`assets/icon.png` 作为 extraResource 供运行时托盘/通知使用。
- 安装包未签名；发布时必须提供 SHA-256，并在说明中标注 SmartScreen 风险。

### 13.2 发布门槛

- 全部门禁（见 [验证规范](verification.md#3-门禁)）通过；保留原始输出与时间。
- 版本号、README、`product-spec.md`、测试数量、截图与证书说明保持一致。
- 计算并记录安装包 SHA-256；打包冒烟在**生产构建**上通过。
- 人工矩阵中的必测项完成；未完成项在发布说明中明确"未验证"。
- 安全相关文档更新；已知缺口（焦点陷阱、明文私钥回退、无签名、无 DoS 防护）如实披露。
- 发布后不修改同一版本产物；修复必须升版本重新构建。

## 14. 文档规范

- 文档使用简体中文、Markdown；开头包含版本/日期/状态表。
- 每个规范必须可执行：给出命令、阈值、验收标准，而不是原则口号。
- 链接使用相对路径；标题锚点被引用时不得随意重命名（当前外部引用：`verification.md#5-真机矩阵`、`operations.md#3-证书与手机信任`、`adr.md#adr-004自建本地-ca-而非公网证书`、`adr.md#adr-014自动批准跳过直播审批`）。
- 修改行为时同步更新：README 能力矩阵、产品规格验收、协议细节、安全控制、验证覆盖、运维步骤。
- 数字必须来自实际运行（测试数、包大小、哈希、耗时）；不确定时写"未验证"。
- 不提交带个人隐私的日志、截图、IP、设备名或抓包；示例使用 `192.168.1.10` 等占位值。
- 新增文档需在 README 文档表中登记。

## 15. 完成定义（Definition of Done）

一个变更只有同时满足以下条件才算完成：

- [ ] 行为符合产品规格，边界条件有明确处理。
- [ ] TypeScript 四套 typecheck、oxlint、Vitest、E2E 全部通过。
- [ ] 新增/修改逻辑有能失败的测试；安全变更覆盖对应攻击面。
- [ ] 无新增未处理的高风险安全项；日志无敏感信息。
- [ ] UI 变更在桌面与手机断点检查，键盘可用，空/错/加载态齐全。
- [ ] 关停、异常、超时路径有清理，无泄漏定时器/监听器/临时文件。
- [ ] 文档、ADR、验证矩阵与测试数量同步。
- [ ] 打包冒烟通过（涉及主进程/构建/依赖时）。
- [ ] 未验证项已记录，而不是用推断代替。

## 16. 例外流程

任何违反本规范的临时做法必须：

1. 在 PR 中说明原因、影响范围与失效条件；
2. 写入 ADR 或在 `verification.md` 的已知缺口登记；
3. 设定移除条件（版本/日期/触发事件）；
4. 不涉及绕过鉴权、关闭安全头、删除安全测试等不可接受的例外。

不可接受的例外：关闭 Host/Origin 校验、允许局域网访问 `/desktop` 或 `/media`、记录明文令牌、跳过审批且未标注风险、使用 `--no-verify` 合并、删除失败测试而不修复。
