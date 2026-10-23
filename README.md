# EasyPush

把手机摄像头、照片、视频，以及电脑浏览器的屏幕画面，投到同一局域网内的电脑大屏。

EasyPush 是一个 Electron 接收端：桌面应用负责配对、审批、解码与展示；手机端是零安装网页；同时内置标准 DLNA MediaRenderer，支持第三方 App 把媒体推送到本机。

> **能力边界**：手机浏览器的安全模型不允许网页抓取"整个手机屏幕"。EasyPush 提供的是**摄像头直播、相册/文件推送、桌面浏览器屏幕共享、DLNA 媒体推送**，不宣称手机整屏镜像。

## 能力矩阵

| 发送端 | 能力 | 通道 | 前置条件 |
| --- | --- | --- | --- |
| iPhone / Android 浏览器 | 摄像头直播（含麦克风） | WebRTC P2P | HTTPS + 手机信任本地 CA |
| iPhone / Android 浏览器 | 照片、视频、音频推送 | HTTP 上传 | 与电脑同一局域网 |
| Windows / macOS 浏览器 | 标签页/窗口/屏幕共享 | WebRTC P2P | HTTPS + 信任本地 CA；桌面浏览器 |
| 支持 DLNA 的 App | 图片、音视频推送 | DLNA/UPnP | 同一子网，允许 UDP 1900 |
| EasyPush 桌面端 | 接收、审批、播放、音量、历史 | — | Windows 10/11 x64 |

不支持：手机整屏镜像、跨公网投屏、云端中继、手机端遥控桌面鼠标。

## 快速开始

1. 安装 `release/EasyPush-1.0.0-x64.exe`（发布附件，或按下文自行构建；当前构建未做代码签名，Windows SmartScreen 可能提示）。
2. 启动 EasyPush，允许 Windows 防火墙的**专用网络**访问；也可以在设置中点击"安装防火墙规则"。
3. 手机连接与电脑相同的 Wi-Fi，扫描桌面二维码，或手动打开桌面显示的地址。
4. 输入桌面上的 6 位配对码，电脑弹出审批卡片后选择"允许并记住"。
5. 在手机网页中拍照/上传，或从支持 DLNA 的 App 推送到 "EasyPush" 渲染器。

摄像头与桌面屏幕共享需要 HTTPS。首次使用时，在手机浏览器打开桌面提供的 `http://<局域网IP>:7333/ca.crt` 下载本地 CA，并按系统要求安装并信任；随后使用二维码中的 HTTPS 地址。详见 [运维手册](docs/operations.md#3-证书与手机信任)。

## 开发与验证

要求：Node.js 24、npm 10+、Windows 10/11。依赖版本锁定在 `package-lock.json`。

```bash
npm ci
npm run typecheck   # 主进程、渲染器、移动网页、测试代码
npm run lint        # oxlint
npm run test        # Vitest：75 个单元/集成测试
npm run test:e2e    # 构建后运行 17 个 Playwright Electron E2E
npm run test:all    # 全量门禁
npm run verify:package  # 对 release/win-unpacked 做启动、HTTPS 配对与上传解码冒烟
```

`test:e2e` 会先执行 `npm run build`。E2E 使用独立的临时 `userData`，不会污染本机配置；摄像头用 Chromium 假设备，屏幕共享用真实 `getDisplayMedia`（Chromium 自动选择整个屏幕）。

## 构建安装包

```bash
npm run dist       # NSIS 安装包 -> release/EasyPush-1.0.0-x64.exe
npm run dist:dir   # 免安装目录 -> release/win-unpacked/
```

图标由 `scripts/make-icons.mjs` 确定性生成，`prebuild` 会自动执行；仓库不提交生成产物。

## 安全摘要

- 配对必须经过电脑端人工审批（除非显式开启"自动批准"，该开关同时会跳过直播审批）。
- 会话 Cookie 为 30 天、`HttpOnly`、`SameSite=Strict`、HTTPS 下 `Secure`；令牌使用服务端密钥做 HMAC-SHA256 签名。
- 桌面页与已上传媒体仅限回环地址访问；局域网只能访问手机网页、配对与上传 API。
- 严格校验 `Host`、`Origin`、`Sec-Fetch-Site`；网页启用 CSP、`X-Frame-Options: DENY`、COOP 与 Permissions-Policy。
- HTTPS 使用本机生成的 CA（RSA-2048/SHA-256）签发 365 天叶证书，TLS 最低 1.2；CA 私钥在 Electron `safeStorage` 可用时加密落盘，不可用时回退为明文 base64（见已知限制）。
- 上传默认上限 2 GB，单设备 5 分钟 30 次；配对码按 IP 与全局双重限速；日志对令牌、Cookie、凭据做键名脱敏。

完整威胁模型与残余风险见 [安全设计](docs/security.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [产品规格](docs/product-spec.md) | 目标、场景、功能需求、验收标准 |
| [架构设计](docs/architecture.md) | 进程/模块、数据流、状态机、存储 |
| [协议规范](docs/protocols.md) | HTTP、WebSocket、WebRTC、DLNA/UPnP |
| [安全设计](docs/security.md) | 威胁模型、控制措施、残余风险 |
| [设计系统](docs/design-system.md) | 视觉语言、令牌、组件、响应式与无障碍 |
| [验证规范](docs/verification.md) | 测试金字塔、门禁、手工矩阵、证据模板 |
| [运维手册](docs/operations.md) | 安装、证书、网络、日志、故障排查 |
| [架构决策记录](docs/adr.md) | 关键取舍与后果 |
| [工程规范](docs/engineering-standards.md) | 编码、测试、安全评审、发布标准 |

## 已知限制

- 手机浏览器无法整屏镜像；这是浏览器安全边界，不是实现缺陷。
- HEIC/HEIF 可上传，但 Electron 内置 Chromium 通常无法解码；请转为 JPEG。MKV/AVI 等容器能否播放取决于内部编码。
- DLNA 播放能力受发送端与编码格式限制；Electron 不支持的编码会显示播放错误。
- 自签 CA 需要逐台设备手动信任；部分 App 不信任用户安装的 CA。
- `safeStorage` 不可用时，CA 私钥以明文 base64 保存；此时应依赖 Windows 账户权限与 BitLocker。
- 为兼容局域网 IP 变化，HTTPS 响应使用 `Strict-Transport-Security: max-age=0`，不提供 HSTS 强制。
- 无公网中继、无 STUN/TURN：必须同一局域网，且 AP 需允许客户端互访与组播。
- 同一时刻只允许一个直播会话；新的直播可选择接管。
- 本仓库只提供 Windows x64 打包配置；安装包未签名。

## 许可

MIT © 2026 yxpil
