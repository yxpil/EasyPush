# EasyPush 架构设计

| 项目 | 内容 |
| --- | --- |
| 版本 | 1.0.0 |
| 日期 | 2026-10-23 |
| 状态 | 与当前代码同步 |
| 相关文档 | [协议规范](protocols.md) · [安全设计](security.md) · [验证规范](verification.md) |

## 1. 架构目标

EasyPush 是一个**单机、局域网、无账号**的接收端。架构围绕四个约束设计：

1. **发送端零安装**：手机只加载浏览器页面，所有能力通过标准 Web 平台获取。
2. **数据不出局域网**：没有云端、没有 STUN/TURN、没有遥测；媒体与信令直连。
3. **接收端是唯一可信端**：配对、直播、接管必须由桌面用户确认；桌面页面与媒体文件仅限回环访问。
4. **可诊断、可恢复**：端口冲突自行顺延，网络变化自动换证书，渲染进程崩溃自动重载，状态落盘可追溯。

## 2. 进程与信任域

```
┌─────────────────────────────── Windows 主机 ───────────────────────────────┐
│                                                                            │
│  Electron 主进程 (Node.js)                                                 │
│  ├─ AppCore ── Store / CertManager / Logger                                │
│  ├─ HTTP :7333 + HTTPS :7443 ── 静态页、API、上传、媒体、DLNA 端点        │
│  ├─ WebSocket ── 配对设备的长连接与 WebRTC 信令                             │
│  ├─ LiveService / PresentationService / PairingService                    │
│  ├─ DLNA (SSDP UDP 1900 + SOAP + GENA)                                     │
│  └─ IPC ── 白名单通道，校验 sender 与 frame URL                            │
│         │                                                                  │
│         ├─ Preload (contextBridge) ── window.easypush                     │
│         │        │                                                         │
│         │        └─ Renderer (React, sandbox, 无 Node)                    │
│         │             ├─ 舞台 / 审批 / 设置 / 日志                         │
│         │             └─ WebRTC answerer + 媒体解码                         │
│         │                                                                  │
│         └─ 回环页面：http://127.0.0.1:<port>/desktop/                      │
│                                                                            │
│  局域网发送端                                                              │
│  ├─ 手机/桌面浏览器：GET /、POST /api/*、WS /ws、媒体上传                 │
│  └─ DLNA 控制器：SSDP、/dlna/*、SOAP、GENA                                 │
│                                                                            │
│  回环媒体：GET /media/:id（仅 127.0.0.1 / ::1）                           │
└────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 信任边界

| 边界 | 可信侧 | 不可信侧 | 主要控制 |
| --- | --- | --- | --- |
| 桌面 IPC | 主进程 | 渲染进程 | 通道白名单、sender/frame 校验、参数归一化 |
| 回环 HTTP | 本机 | 其他本机进程 | 仅回环绑定页面与媒体；API 仍需会话 |
| 局域网 HTTP/WS | 主进程 | 任意同网设备 | Host/Origin/Sec-Fetch-Site、配对、Cookie、限速 |
| DLNA | 主进程 | 任意私网 UPnP 控制器 | 私网源限制、SOAP 校验、回调地址绑定、限速 |
| 证书私钥 | 操作系统用户 | 同机其他用户/进程 | `safeStorage` 加密、目录 0700、日志脱敏 |

桌面渲染进程按 Electron 安全基线配置：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity` 默认开启、禁用 `webview`、拒绝新窗口、限制导航到 `/desktop`。

## 3. 模块地图

| 路径 | 职责 |
| --- | --- |
| `src/main/main.ts` | Electron 生命周期、单实例、窗口/托盘/通知、登录项、防火墙规则、IPC host |
| `src/main/core/appCore.ts` | 组合根：启动顺序、快照、服务编排、网络与证书刷新、设置变更 |
| `src/main/core/store.ts` | `state.json` 读写、迁移、原子落盘、设备/历史上限 |
| `src/main/core/certs.ts` | 本地 CA、叶证书、SAN 同步、密钥加密、指纹 |
| `src/main/core/lan.ts` | 网卡枚举、主网卡评分、地址列表、Host 允许列表、回环判断 |
| `src/main/core/logger.ts` | JSONL 日志、级别、保留期、键名脱敏 |
| `src/main/core/rateLimiter.ts` | 固定窗口限速（配对、上传、WS、DLNA） |
| `src/main/core/networkProfile.ts` | Windows 网络配置文件（专用/公用）探测 |
| `src/main/net/http.ts` | HTTP/HTTPS 服务、路由、安全头、Cookie、上传、Range、静态资源 |
| `src/main/net/ws.ts` | WebSocket 升级鉴权、心跳、消息限速、连接生命周期 |
| `src/main/services/pairing.ts` | ticket/配对码、审批请求、设备与会话、HMAC、二维码 |
| `src/main/services/live.ts` | 单直播会话状态机、审批、接管、ICE 中继、超时、历史 |
| `src/main/services/presentation.ts` | 媒体会话、队列、播放命令、直播互斥、音量持久化 |
| `src/main/services/mediaLibrary.ts` | 上传流式落盘、MIME/文件名归一化、本地/远程条目、清理 |
| `src/main/dlna/*` | SSDP、设备描述、SCPD、SOAP、GENA、事件聚合 |
| `src/main/ipc.ts` | IPC 通道注册、可信来源检查、参数类型与长度限制 |
| `src/preload/preload.ts` | `contextBridge` 暴露最小 API，订阅/退订事件 |
| `src/renderer/*` | 桌面 UI、WebRTC answerer、媒体元素、状态展示 |
| `web/*` | 手机/桌面浏览器发送端、无框架 TypeScript |
| `src/shared/*` | 类型、协议校验、格式化、MIME/设备名等纯函数 |

`src/shared` 不依赖 Electron 或 Node，主进程、渲染器和移动网页共用；任何跨端协议变更先改这里。

## 4. 启动与关闭顺序

### 4.1 启动

1. `app.requestSingleInstanceLock()`；失败立即退出，第二实例唤起已有窗口。
2. 创建数据目录，加载 `state.json`（损坏则重命名为 `.corrupt-<ts>` 并重建）。
3. 初始化日志、媒体库、证书；枚举私有 IPv4 网卡并选出主网卡。
4. 生成/加载 CA 与叶证书（SAN 包含所有私有 IPv4、主机名及 `.local`）。
5. 依次监听 HTTP 与 HTTPS，端口冲突时从首选值向后尝试最多 10 个端口。
6. 注册 WS 升级、DLNA 处理器；启动配对、直播、DLNA 服务。
7. 创建无边框窗口并加载 `http://127.0.0.1:<http>/desktop/`；托盘与登录项就绪。
8. 渲染器通过 `app:ready` 报到后，主进程才开始推送快照；之前的事件只更新内部状态。
9. 每 15 秒检查网卡/IP；变化时重签叶证书、热更新 HTTPS context、刷新地址与二维码，必要时重启 DLNA。
10. 启动时探测 Windows 网络配置文件；若为“公用网络”，快照带防火墙警告。

若 HTTP 启动失败，弹出错误框并退出；HTTPS 失败只降级为无 HTTPS，不影响 HTTP 上传与 DLNA。

### 4.2 关闭

`before-quit` 阻止默认退出，依次：通知渲染器 → 释放电源锁 → 停止直播/媒体 → 停止 DLNA → 关闭 WS → 停止配对 → 关闭 HTTP/HTTPS → 落盘 state/日志 → 删除 `runtime.json` → `app.exit(0)`。关闭窗口在“关闭到托盘”开启时仅隐藏，不触发退出。

## 5. 关键状态机

### 5.1 直播会话

```
idle
  └─ intent ─► awaiting-approval ──拒绝/超时──► rejected
                    │ 批准
                    ▼
               awaiting-offer ──25s 无 offer──► ended
                    │ offer
                    ▼
                connecting ──失败/超时──► ended
                    │ 首帧
                    ▼
                   live
                    │ WS 断开（8s 宽限）
                    ▼
               disconnected ──resume──► live
                    │ 宽限超时 / end / 静默停止
                    ▼
                   ended
```

- 其他设备发起时进入 `awaiting-takeover`；批准会结束当前会话并复用舞台。
- 同一设备再次发起视为重连替换，不再二次审批。
- `autoApprove` 开启时跳过审批，但接管仍需人工确认。
- 主进程所有定时器每秒 tick 一次；审批 60s、offer 25s、连接 25s、断线宽限 8s。

### 5.2 媒体会话

`idle → loading → playing ↔ paused → ended`，解码失败进入 `error`。服务端持有播放位置、时长、索引、音量与静音；渲染器只上报事实（`reportMediaState`），不直接决定业务状态。直播期间上传的内容进入待播队列，不抢占直播画面。

### 5.3 配对请求

`pending → approved | denied | expired`。请求 60s 有效；批准后生成 30 天会话令牌，并在“记住”时返回一次性设备凭据。状态轮询按请求 IP 绑定，换 IP 查不到。

## 6. 数据流

### 6.1 配对与上传

```
浏览器 ──POST /api/pair/code──► PairingService ──pending──► 桌面审批覆盖层
桌面 ──IPC approve/remember──► PairingService ──token──► Set-Cookie ep_session
浏览器 ──POST /api/upload (Cookie)──► 流式写 .part ──rename──► MediaLibrary
                                   └─► PresentationService ──IPC media:load──► 舞台
```

上传不经过 JSON 缓冲，直接消费请求流；中途超限、空文件或失败会删除临时文件与目标文件。媒体 URL 使用不可猜测 ID，且 `/media/*` 只接受回环来源。

### 6.2 WebRTC 直播

```
手机 offerer                        主进程                         桌面 answerer
WS intent ─────────────────────────► LiveService ──审批──►
WS ready ◄──────────────────────────┘
createOffer ──WS offer──────────────► 转发 ──IPC live:offer──► setRemoteDescription
WS ice ◄────────────────────────────► 转发（offer 前最多缓冲 64 个）
                                    ◄──IPC live:signal── createAnswer / ice
WS answer ◄─────────────────────────┘
WS stats ───────────────────────────► 节流后写入状态与历史
```

- 手机负责创建 offer，桌面负责 answer。
- `iceServers: []`，只依赖同子网 host candidate；无公网中继。
- 手机摄像头 720p/30、4 Mbps 上限；屏幕共享 1080p/30、8 Mbps 上限。
- 桌面媒体元素直接播放收到的 track；断线宽限内可用 `resume` 恢复会话。

### 6.3 DLNA

```
控制器 ──SSDP M-SEARCH──► DMR ──200 + LOCATION──► description.xml / SCPD
控制器 ──SUBSCRIBE event──► DMR ──初始 NOTIFY(LastChange)──► 回调地址（同源 IP）
控制器 ──SOAP SetAVTransportURI/Play──► PresentationService ──IPC──► 舞台
DMR ──≤1s GENA NOTIFY──► 控制器
```

DLNA 与直播互斥；推送 URI 前会校验 http/https 且不指向自身 1900 端口。控制端点只接受回环或私有 IPv4。

## 7. 持久化

| 路径（默认） | 内容 | 生命周期 |
| --- | --- | --- |
| `%APPDATA%\EasyPush\state.json` | 设置、实例 ID、服务端密钥、设备、历史 | 长期；原子写入 |
| `%APPDATA%\EasyPush\certs\` | CA/叶证书与加密私钥、SAN 元数据 | CA 10 年；叶 365 天，提前 30 天续 |
| `%APPDATA%\EasyPush\uploads\` | 上传媒体与 `.part` 临时文件 | 7 天；可手动清空 |
| `%APPDATA%\EasyPush\logs\` | 每日 JSONL | 14 天 |
| `%APPDATA%\EasyPush\runtime.json` | 端口、URL、PID、DLNA 位置 | 运行期诊断；退出删除 |

`state.json` 写入采用“临时文件 + rename”，120ms 去抖并串行化；解析失败保留原文件副本。设备上限 500，历史上限 200；未记住且 30 天未活跃的设备会被清理。

## 8. 并发与故障处理

| 场景 | 行为 |
| --- | --- |
| 端口被占用 | 最多尝试 10 个端口（含首选，向后顺延 9 个）；两个端口独立处理 |
| HTTPS 上下文失败 | 关闭 HTTPS，保留 HTTP；界面不展示安全链接 |
| 渲染进程崩溃/无响应 | 主进程标记渲染器离线，结束直播，800ms 后自动重载 |
| 修改端口/关闭直播 | 有活动会话或媒体时拒绝修改端口；关闭 `allowLive` 立即结束会话 |
| 网络切换/IP 变化 | 重签叶证书并热更新，不改变已安装 CA；主网卡变化时重启 DLNA 播报 |
| WS 重复连接 | 同一设备新连接关闭旧连接；同一连接被替换后旧 socket 收到 `replaced` |
| 上传中断 | 删除 `.part`，记录日志，不进入播放列表 |
| DLNA 端口 1900 被占用 | DLNA 状态置错并可在界面看到，其他功能继续 |
| 状态文件损坏 | 原文件改名保留，重建默认状态，继续启动 |

## 9. 资源与容量

| 资源 | 上限 |
| --- | --- |
| 单文件上传 | 2 GB，流式写盘，写入前检查可用空间 |
| WS 单帧 | 512 KiB；SDP 200,000 字符；ICE candidate 4,096 字符 |
| 直播会话 | 1 个活动 + 1 个待审批 |
| 上传频率 | 单设备 5 分钟 30 次 |
| 配对尝试 | 单 IP 5 分钟 6 次；全局 10 分钟 30 次 |
| DLNA SOAP | 128 KiB；单 IP 每分钟 1200 次 |
| 历史/设备 | 200 / 500 |
| 日志内存 | 500 条；界面读取最近 400 条 |

## 10. 明确的非目标

- 手机整屏镜像：浏览器不能捕获系统屏幕。
- 跨公网/跨 NAT：没有 STUN/TURN/中继。
- 账号、云同步、远程管理、遥测。
- 多接收端集群或负载均衡。
- 代码签名与自动更新（当前版本未实现，见 [ADR](adr.md)）。
