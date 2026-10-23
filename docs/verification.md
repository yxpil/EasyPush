# EasyPush 验证规范

| 项目 | 内容 |
| --- | --- |
| 版本 | 1.0.0 |
| 日期 | 2026-10-23 |
| 适用范围 | 源码、自动化测试、Windows 安装包、手工真机签收 |
| 门禁实现 | `package.json` scripts、`playwright.config.ts`、`scripts/verify-package.mjs`、`.github/workflows/` |

## 1. 验证原则

1. **只报告实际执行过的结果**。构建成功不等于应用可启动；启动成功不等于协议可用；单元测试通过不等于能在真机解码。
2. **测试必须能失败**。每条安全用例都应能在移除对应控制后变红；只断言"返回 200"的用例不视为覆盖。
3. **优先穿过真实边界**：真实 HTTP/HTTPS 端口、真实 WebSocket、真实 WebRTC、真实 Electron 进程、真实文件落盘。只有纯函数与时间/网络不可控处才使用替身。
4. **隔离**：E2E 使用临时 `userData`/数据目录与独立端口，不读写用户真实配置；结束后删除临时目录。
5. **可复现**：依赖锁定；测试不依赖公网；不使用动态下载的媒体；时间相关用例使用可控时钟或宽裕断言。
6. **诚实记录缺口**：未在真机、干净虚机、真实 DLNA 设备上执行的项，必须保持"未验证"，不得用自动化结果替代。

## 2. 测试金字塔

| 层级 | 位置 | 数量 | 运行环境 | 关注点 |
| --- | --- | --- | --- | --- |
| 单元 | `tests/unit/` | 52 | Vitest / Node | 配置归一化、地址与 Host 判定、MIME/文件名、协议消息解析、限速器、UPnP XML/DIDL |
| 集成 | `tests/integration/` | 23 | Vitest / Node + 临时目录 | 证书生成与续期、配对/令牌/限速、媒体与展示状态机、存储持久化 |
| 端到端 | `tests/e2e/` | 17 | Playwright + Electron | 真实配对、上传解码、WebRTC 摄像头/屏幕、会话与传输安全、DLNA 发现/控制/事件 |
| 打包冒烟 | `scripts/verify-package.mjs` | 3 个断言组 | 已构建的 `release/win-unpacked/EasyPush.exe` | 安装包应用可启动、HTTPS 配对、上传后桌面解码 |

合计：**75 个 Vitest 用例（10 个文件）+ 17 个 Playwright 用例（3 个 spec）**。

### 2.1 分层职责

- **单元**不启动应用、不监听端口；每个用例在毫秒级完成。
- **集成**启动服务对象但不起 Electron 窗口，验证跨模块状态与磁盘副作用；每个用例独立临时目录。
- **E2E** 启动真实 Electron 主进程，用 Playwright 同时驱动桌面窗口与手机浏览器上下文；网络请求走真实端口。
- **打包冒烟**针对 `win-unpacked`，验证 asar/资源/路径/生产构建差异，而不是源码运行。

### 2.2 E2E 环境事实

- 摄像头使用 Chromium 假设备（`--use-fake-device-for-media-stream`），验证信令、协商、轨道接收与解码链路，不验证真实镜头画质/对焦。
- 屏幕共享使用真实 `getDisplayMedia`，由 Chromium 自动选择整个屏幕；验证轨道与桌面解码，不覆盖用户手动选窗口的交互。
- 每个 Electron 进程只能可靠创建一路假摄像头，cast 用例串行执行（`test.describe.configure({ mode: 'serial' })`）。
- E2E 不使用公网；WebRTC 仅 host candidate，符合产品"无 STUN/TURN"的约束。
- 渲染进程的 `visibilityState` 在自动化环境中不可靠，涉及媒体播放的断言以元素状态与解码结果为准，不依赖页面可见性事件。

## 3. 门禁

### 3.1 本地/PR 门禁

```bash
npm ci
npm run typecheck   # 主进程、渲染器、手机网页、测试代码四套 tsconfig
npm run lint        # oxlint src web tests，要求 0 warning / 0 error
npm run test        # Vitest 75 用例
npm run test:e2e    # 先 build，再跑 17 个 Playwright 用例
```

合并前必须全部通过。`test:all` 串联以上四步（不含打包）。

### 3.2 发布门禁

| 门禁 | 命令/动作 | 通过标准 |
| --- | --- | --- |
| 类型 | `npm run typecheck` | 4 个项目全部 0 error |
| 静态检查 | `npm run lint` | 0 warning / 0 error |
| 单元/集成 | `npm run test` | 75/75，无 skip |
| 端到端 | `npm run test:e2e` | 17/17，无 skip，无重试后通过 |
| 构建 | `npm run build` | 主进程/桌面/手机三份产物齐全 |
| 打包 | `npm run dist` | 生成 `release/EasyPush-1.0.0-x64.exe` 与 blockmap |
| 打包冒烟 | `npm run verify:package` | 三条 PASS，进程正常退出 |
| 安装/卸载 | 干净 Windows 虚机手工 | 安装、启动、卸载、残留检查通过 |
| 真机矩阵 | §5 | 必测项全部通过，证据归档 |
| 安全评审 | `docs/security.md` §8 清单 | 无未处置的高风险项 |

任一门禁失败即停止发布。禁止通过 `--no-verify`、跳过测试、放宽断言或删除失败用例来"修复"门禁。

### 3.3 失败处理

- 首次失败必须保留日志与截图（Playwright 已配置 trace/screenshot 策略），定位是产品缺陷、测试缺陷还是环境问题。
- 只有证明为环境问题才允许重跑；重跑通过需在证据中注明首次失败原因。
- 偶发失败超过两次的用例必须标记并修复根因，不得长期依赖 `retries`。
- 任何安全用例被删除或降级，必须在 PR 说明中给出替代覆盖。

## 4. 覆盖矩阵

| 需求 | 自动化证据 | 手工证据 |
| --- | --- | --- |
| FR-01 连接入口 | `cast.spec.ts` 读取二维码/配对码与地址；`security.spec.ts` 校验 HTTPS 与证书 | 真实手机扫码、IP 变化后 30 秒刷新 |
| FR-02 配对 | `cast.spec.ts` 审批配对、错误配对码；`security.spec.ts` 限速；`pairing.test.ts` 7 用例 | 多设备并发配对、拒绝后重试、禁用设备 |
| FR-03 会话与设备 | `security.spec.ts` `HttpOnly`/审批前无 Cookie；`pairing.test.ts` 令牌过期/恢复/撤销 | 30 天真实过期、退出登录、移除设备 |
| FR-04 媒体上传与播放 | `cast.spec.ts` 上传并在舞台解码；`security.spec.ts` 类型/空文件/大小/鉴权；`presentation.test.ts`；`media.test.ts` | 2 GB 文件、HEIC/HEVC 失败提示、清空上传 |
| FR-05 摄像头直播 | `cast.spec.ts` 假摄像头 + 真实 WebRTC；`protocol.test.ts`；`pairing.test.ts` 审批超时 | iPhone/Android 前后摄切换、麦克风、弱网、断线恢复 |
| FR-06 屏幕共享 | `cast.spec.ts` 真实 `getDisplayMedia`，桌面解码且状态为 `screen` | Chrome/Edge 窗口/标签页/整屏、停止共享、标签页音频 |
| FR-07 DLNA | `dlna.spec.ts` 5 用例（发现、GENA、真实图片推送与状态、错误码、退订）；`upnp.test.ts` 14 用例 | 真实电视/音箱、第三方 App、长时间事件订阅 |
| FR-08 接收界面 | E2E 覆盖空闲、直播、媒体、审批覆盖层；`design-system.md` §10 自检 | 键盘全流程、屏幕阅读器、110% 缩放 |
| FR-09 设置 | `config.test.ts` 默认值与归一化；设置持久化由 `storage.test.ts` 覆盖 | 端口冲突顺延、开机启动、托盘、防火墙规则 UAC |
| FR-10 历史与日志 | `storage.test.ts` 持久化；`config.test.ts` 日志级别 | 14 天轮转、脱敏抽查、诊断复制 |

覆盖矩阵描述的是**测试意图**，不保证每个子条件都有独立用例；缺口在 §9 明示。

## 5. 真机矩阵

以下项目必须在发布签收时于真实环境执行，并把日期、操作者、设备型号、系统版本、结果与证据路径填入 §8 模板。当前状态均为**未执行**。

### 5.1 安装与系统

| ID | 环境 | 步骤 | 期望 | 状态 |
| --- | --- | --- | --- | --- |
| M-01 | 干净 Windows 11 x64 虚机 | 运行安装包，默认路径安装，启动 | 安装无报错；首次启动显示连接卡片；防火墙提示为专用网络 | 未执行 |
| M-02 | 同上 | 卸载应用，检查数据目录 | 程序移除；用户数据默认保留（`deleteAppDataOnUninstall: false`）；可手动清理 | 未执行 |
| M-03 | Windows 11 + 已装旧版 | 覆盖安装 1.0.0 | 设置、历史、证书保留；单实例锁生效 | 未执行 |
| M-04 | 端口 7333/7443 被占用 | 启动应用 | 自动向后顺延（最多 9 个端口），界面地址与实际监听一致 | 未执行 |
| M-05 | 开启"关闭到托盘" | 关闭窗口、托盘恢复、托盘退出 | 进程保留；恢复窗口正常；退出后端口释放 | 未执行 |
| M-06 | 开启"开机启动" | 注销并重新登录 | 以 `--hidden` 启动到托盘，不弹主窗口 | 未执行 |
| M-07 | 安装防火墙规则 | 点击设置中的按钮并同意 UAC | 生成 `EasyPush_TCP`（双端口）与 `EasyPush_UDP`（1900）入站允许规则 | 未执行 |
| M-08 | 双网卡/虚拟网卡 | 启动并切换网络 | 默认地址合理；IP 变化后二维码/地址 30 秒内更新；HTTPS 叶证书重签 | 未执行 |

### 5.2 手机浏览器

| ID | 设备/系统 | 步骤 | 期望 | 状态 |
| --- | --- | --- | --- | --- |
| M-10 | iPhone，iOS 16+，Safari | 扫码 HTTP → 配对 → 上传照片/视频 | 配对审批正常；上传后桌面播放；HEIC 失败有明确提示 | 未执行 |
| M-11 | 同上 | 安装并信任 CA → 打开 HTTPS 二维码 → 摄像头直播（含麦克风） | 证书无警告；摄像头/麦克风授权；720p 可用；前后摄切换不断流；桌面可静音/停止 | 未执行 |
| M-12 | Android，Chrome 120+ | HTTP 与 HTTPS 分别走配对、上传、摄像头 | 流程与 iOS 一致；HTTP 下摄像头入口明确禁用并引导 | 未执行 |
| M-13 | 手机与电脑不同 AP/开启客户端隔离 | 扫码连接 | 给出可理解的连接失败提示；不误报成功 | 未执行 |
| M-14 | 弱网（限速 2 Mbps、丢包 3%） | 摄像头直播 10 分钟 | 自动降帧/降码率；8 秒断线宽限内可恢复；无崩溃 | 未执行 |
| M-15 | 直播 2 小时 | 持续摄像头直播 | 无内存持续增长；桌面不休眠；历史记录时长/码率合理 | 未执行 |

### 5.3 桌面浏览器与 DLNA

| ID | 环境 | 步骤 | 期望 | 状态 |
| --- | --- | --- | --- | --- |
| M-20 | Windows Chrome/Edge | 手机网页"共享屏幕"→ 选择标签页/窗口/整屏 | 桌面审批后显示；1080p 可用；浏览器原生"停止共享"会结束会话 | 未执行 |
| M-21 | macOS Chrome（仅发送端） | 同一流程 | 页面可加载；屏幕共享入口仅在支持 `getDisplayMedia` 时显示 | 未执行 |
| M-22 | 真实 DLNA 电视/音箱 | SSDP 发现、推送图片、视频、音频 | 设备出现在列表；推送后桌面播放；传输状态正确；停止后回到空闲 | 未执行 |
| M-23 | 第三方 DLNA App | 连续推送 10 个媒体、Seek、Next/Previous | 状态与事件同步；异常编码显示可读错误 | 未执行 |
| M-24 | DLNA + 直播并发 | 直播中发起 DLNA 推送 | 返回忙碌错误，不打断直播 | 未执行 |

### 5.4 安全与恢复

| ID | 场景 | 期望 | 状态 |
| --- | --- | --- | --- |
| M-30 | 错误配对码 6 次（同 IP） | 进入限速；文案不泄露正确码 | 未执行 |
| M-31 | 另一台设备伪造 Host/Origin | 421/403；不建立会话 | 未执行 |
| M-32 | 非回环地址访问 `/desktop` 与 `/media/*` | 403 | 未执行 |
| M-33 | 强制结束主进程后重启 | 单实例恢复；临时上传/会话状态一致；无残留坏锁 | 未执行 |
| M-34 | 渲染进程崩溃 | 自动重载界面；直播状态被正确上报结束；无幽灵会话 | 未执行 |
| M-35 | 拔网线/切换 Wi-Fi | 地址刷新；进行中的上传/直播按预期失败并提示 | 未执行 |

签收规则：M-01、M-10、M-11、M-12、M-20、M-22、M-30、M-32 为**必测**；任一失败则不得发布。

## 6. 手工安全与隐私检查

自动化已覆盖协议层控制，但以下项目必须人工确认：

1. **网络抓包**：手机上传/直播期间在电脑端抓包，确认无公网目的地址、无遥测请求；WebRTC 仅局域网 host candidate。
2. **日志抽查**：触发配对、上传、直播、错误后检索日志，确认 `token/secret/cookie/authorization/ticket/credential/password` 值被脱敏，媒体内容不入日志。
3. **证书检查**：查看叶证书 SAN、有效期（365 天）、TLS 最低版本；确认私钥文件权限；确认 CA 私钥在 `safeStorage` 可用时为加密存储。若 `safeStorage` 不可用，当前实现回退为**明文 base64**，必须在发布说明中标注。
4. **浏览器头**：用开发者工具确认 CSP、`X-Frame-Options: DENY`、COOP、Permissions-Policy、`Cache-Control: no-store`（页面）与 HSTS `max-age=0`。
5. **上传边界**：真实 2 GB 文件、0 字节文件、伪造扩展名、路径穿越文件名；确认拒绝行为与错误码。
6. **DLNA 边界**：非私网来源、回调地址与订阅者 IP 不一致、端口 1900、超大 SOAP、非法 UUID；确认拒绝且不崩溃。
7. **卸载残留**：确认用户数据目录与证书未被静默删除；告知用户清理路径。

## 7. 打包产物验证

### 7.1 已执行（2026-10-23）

| 项目 | 结果 |
| --- | --- |
| 构建环境 | Windows 10.0.26300 x64，Node 24.18.0，npm 10+ |
| 安装包 | `release/EasyPush-1.0.0-x64.exe`，115,597,198 字节 |
| SHA-256 | `1e17c3a314a0047ceb4934d971e25162a58f28e9273b84d58683de29582a7fd5` |
| 免安装目录 | `release/win-unpacked/EasyPush.exe`，249,797,632 字节 |
| 打包冒烟 | `PASS packaged startup: v1.0.0, http:7333, https:7443`；`PASS packaged pairing over HTTPS`；`PASS packaged upload decode on desktop stage`；`PACKAGE VERIFY OK` |
| 代码签名 | 未签名；Windows SmartScreen 可能提示 |

打包冒烟以 `--user-data-dir=<临时目录>` 启动生产构建，断言版本、HTTPS、6 位配对码、数据目录确实随参数隔离；随后在忽略证书错误的浏览器上下文中完成真实 HTTPS 配对，上传 PNG 并等待桌面 `<img>` 解码（`naturalWidth > 0`）。它不验证安装器本身。

### 7.2 未执行

- 安装包在干净 Windows 虚机的安装/卸载（M-01、M-02）。
- 安装包签名与 SmartScreen 信誉。
- 自动更新（产品未提供）。

## 8. 证据模板

每次发布复制以下模板到发布记录（不提交生成物到仓库）：

```text
发布版本：
提交 / 标签：
构建时间：
构建机（OS / Node / npm）：
安装包路径与 SHA-256：

自动门禁：
  typecheck:   PASS / FAIL  （4 个项目）
  lint:        PASS / FAIL  （warning / error 数）
  vitest:      __/75
  e2e:         __/17
  build:       PASS / FAIL
  package:     PASS / FAIL  （命令与三条断言）
  smoke:       PASS / FAIL  （verify-package.mjs 输出）

真机矩阵：
  M-01 __   M-10 __   M-11 __   M-12 __   M-20 __   M-22 __
  M-30 __   M-32 __   （必测）
  其余项：通过 __ / 失败 __ / 未执行 __
  证据路径（截图、抓包、日志摘要）：

缺陷与例外：
  已知问题：
  发布说明中必须披露的限制：

签署：姓名 / 日期
```

证据要求：截图包含设备型号与时间；抓包提供目的地址列表；日志提供脱敏后的片段；失败项必须附复现步骤。证据存放在受控的发布记录中，不写入本仓库。

## 9. 已知未验证项

以下项目在 1.0.0 自动化门禁中**没有**被验证，发布说明不得声称已通过：

1. 物理 iPhone/Android 上的摄像头画质、对焦、麦克风回声与前后摄切换。
2. iOS Safari 对本地 CA 的信任流程差异（尤其非 MDM 设备）与证书警告后的行为。
3. 真实 DLNA 电视/音箱的兼容性、事件订阅稳定性与编码支持范围。
4. Windows 干净虚机的安装/卸载、UAC 防火墙规则、SmartScreen 与代码签名。
5. 长时间（≥2 小时）直播与上传的内存/句柄稳定性；无 soak test。
6. 多设备并发（>5 台）与恶意流量下的拒绝服务韧性；未做压力测试。
7. macOS/Linux 运行与打包（代码尽量跨平台，但只发布 Windows x64）。
8. 屏幕阅读器（VoiceOver/TalkBack/NVDA）逐流程实测；桌面弹窗无焦点陷阱。
9. CI 实际执行：`.github/workflows/` 提供配置，但本次结果来自本地 Windows 主机，未观察到 CI 运行记录。
10. 外部安全审计与渗透测试；`docs/security.md` 的控制项来自代码评审与自动化测试。

## 10. 回归选择与维护

- 改动配对/令牌/限速：必跑 `pairing.test.ts`、`security.spec.ts`，并人工检查 §5.4。
- 改动 HTTP 路由/头/静态服务：必跑 `security.spec.ts` 全部；检查 CSP 与回环隔离。
- 改动 WebRTC/直播状态机：必跑 `cast.spec.ts` 摄像头与屏幕用例、`protocol.test.ts`；真机至少抽查一台手机。
- 改动 DLNA：必跑 `dlna.spec.ts` 与 `upnp.test.ts`；至少一台真实设备抽测。
- 改动媒体/上传：必跑 `media.test.ts`、`presentation.test.ts`、`storage.test.ts` 与上传 E2E；抽查 2 GB 边界。
- 改动 UI：按 `design-system.md` §10 检查断点、键盘、reduced motion；E2E 至少覆盖审批与舞台。
- 依赖升级：全量 `test:all` + 打包冒烟；Electron/Chromium 升级必须重跑摄像头与屏幕共享用例。

测试数量变化时同步更新 README、`product-spec.md` 与本文；数字以实际运行输出为准。
