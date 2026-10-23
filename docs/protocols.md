# EasyPush 协议规范

| 项目 | 内容 |
| --- | --- |
| 协议版本 | 1 |
| 日期 | 2026-10-23 |
| 传输 | HTTP/1.1、HTTPS（TLS ≥1.2）、WebSocket、WebRTC、SSDP/SOAP/GENA |
| 端口 | HTTP 7333、HTTPS 7443（可配置，冲突时顺延）、SSDP 1900/UDP |
| 相关文档 | [架构设计](architecture.md) · [安全设计](security.md) |

本文描述**发送端与接收端之间的线上契约**。协议版本通过 `/api/health` 与 WS `hello.protocolVersion` 暴露；不兼容变更必须递增版本并提供迁移说明。所有 JSON 均为 UTF-8，时间戳为毫秒。

## 1. 通用规则

- 监听地址为 `0.0.0.0`；手机应使用桌面展示的局域网地址，不要使用 `127.0.0.1`。
- HTTP 与 HTTPS 同时提供同一套页面/API；摄像头与屏幕共享要求安全上下文（HTTPS 或 localhost）。
- 所有请求必须带可接受的 `Host`：`localhost`、回环、RFC1918 地址、本机主机名（含 `.local`，支持 IDNA）。否则 `421 Misdirected Request`。
- 所有响应带：`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、`Cross-Origin-Opener-Policy: same-origin`、`Permissions-Policy`（默认全部拒绝）。HTTPS 额外带 `Strict-Transport-Security: max-age=0`，用于避免 IP 变化后被 HSTS 锁死。
- 修改状态的 API 校验 `Sec-Fetch-Site`（`cross-site` 直接 403）与 `Origin`（存在时必须与 `Host` 一致）；无 `Origin` 的非浏览器客户端可通过，但仍需会话。
- 会话 Cookie `ep_session`：`Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`，HTTPS 下加 `Secure`。
- 错误统一为：

```json
{ "error": { "code": "machine-code", "message": "面向用户的中文说明" } }
```

## 2. HTTP 端点

### 2.1 路由总表

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET/HEAD | `/`、`/setup`、`/index.html` | 无 | 手机/桌面发送端页面 |
| GET | `/assets/*`、`/manifest.webmanifest`、`/icon-*.png`、`/favicon.svg` | 无 | 前端静态资源 |
| GET | `/ca.crt`、`/EasyPush-CA.crt` | 无 | 下载本地 CA（`application/x-x509-ca-cert`） |
| GET | `/api/health` | 无 | 发现与健康检查 |
| GET | `/api/me` | 会话 | 当前设备、接收端摘要、上传上限 |
| POST | `/api/pair/ticket` | ticket | 扫码配对 |
| POST | `/api/pair/code` | 6 位码 | 手动配对 |
| GET | `/api/pair/status?id=` | 请求 ID + 同 IP | 轮询审批结果 |
| POST | `/api/pair/resume` | 设备凭据 | Cookie 丢失后恢复会话 |
| POST | `/api/pair/signout` | 会话 | 撤销当前设备 |
| POST | `/api/upload` | 会话 | 流式上传媒体（≤2 GB） |
| POST | `/api/cast/url` | 会话 | 推送 http/https 媒体直链 |
| GET/HEAD | `/media/:id` | 回环来源 | 已上传媒体，支持 Range |
| GET/HEAD | `/desktop/*` | 回环来源 | Electron 桌面界面 |
| GET/HEAD | `/dlna/description.xml`、`/dlna/scpd/*` | 私网/回环 | DLNA 设备描述与 SCPD |
| POST | `/dlna/control/:service` | 私网/回环 | SOAP 控制 |
| SUBSCRIBE/UNSUBSCRIBE | `/dlna/event/:service` | 私网/回环 | GENA 订阅 |
| WS | `/ws` | 会话 + 同源 | 直播信令 |

静态页面回退到 `index.html`；`/desktop` 不启用回退。路径解码后做前缀校验，阻止 `..` 穿越。API 响应 `Cache-Control: no-store`；带哈希的构建资源可长期缓存。

### 2.2 健康检查

```http
GET /api/health
```

```json
{
  "ok": true,
  "name": "EasyPush",
  "version": "1.0.0",
  "protocolVersion": 1,
  "deviceName": "STUDY-PC",
  "secure": true,
  "allowLive": true,
  "allowDlna": true,
  "uptimeSec": 42,
  "httpPort": 7333,
  "httpsPort": 7443
}
```

不返回设备列表、令牌、文件或设置细节。`secure` 表示本次连接是否 TLS。

### 2.3 配对

#### 扫码（ticket）

```http
POST /api/pair/ticket
Content-Type: application/json

{ "ticket": "<二维码中的 ticket>", "deviceName": "iPhone", "clientId": "可选，稳定设备ID" }
```

- ticket 120s 有效，成功使用后立即轮换；旧 ticket 失效。
- 返回 `202` + `{status:"pending", requestId}` 表示等待桌面审批。
- 开启自动批准时返回 `200` + `{status:"approved", device, deviceSecret}`，并设置 Cookie。
- ticket 无效 `401 invalid-ticket`；同一 IP 每分钟超过 12 次 `429 rate-limited`。

#### 手动配对码

```http
POST /api/pair/code
Content-Type: application/json

{ "code": "123456", "deviceName": "Android 设备", "clientId": "可选" }
```

- 6 位数字，5 分钟轮换；非数字字符会被剔除后比较。
- 错误码 `401 invalid-code`，文案不泄露正确值。
- 限速：单 IP 5 分钟 6 次错误；全局 10 分钟 30 次；命中后 `429`。
- `deviceName` 清除控制字符、压缩空白、截断 40 字符；空值按 UA 推断。

#### 审批轮询

```http
GET /api/pair/status?id=<requestId>
```

```json
{ "status": "approved", "expiresAt": 1760000060000, "device": { "...": "..." }, "deviceSecret": "一次性凭据" }
```

- `status` 为 `pending | approved | denied | expired`。
- 只允许发起请求的 IP 查询；不匹配按 `expired` 处理，避免探测。
- 批准响应同时刷新 Cookie；`deviceSecret` **只返回一次**，用于之后恢复会话。
- 请求 60s 未处理即过期。

#### 恢复与退出

```http
POST /api/pair/resume
{ "clientId": "<deviceId>", "deviceSecret": "<remember secret>" }
```

校验 HMAC 后签发新 Cookie；单 IP 5 分钟 12 次。`POST /api/pair/signout` 立即从设备表删除当前设备并清除 Cookie，已建立 WS 会被结束。

#### 令牌格式

```
v1.<deviceId>.<expMs>.<nonce>.<base64url(HMAC-SHA256(serverSecret, "v1.<deviceId>.<expMs>.<nonce>"))>
```

有效期 30 天。服务端只保存设备凭据的 HMAC，不保存明文 secret。令牌不绑定 IP，但绑定设备记录；设备被移除或禁用后立即失效。

### 2.4 当前设备

```http
GET /api/me
Cookie: ep_session=...
```

```json
{
  "device": { "id": "...", "name": "iPhone", "platform": "ios", "ip": "192.168.1.23", "remembered": true },
  "receiver": { "name": "STUDY-PC", "version": "1.0.0", "secure": true, "allowLive": true },
  "limits": { "maxUploadBytes": 2147483648 }
}
```

`401 unauthorized` 表示无 Cookie、签名无效、过期或设备已移除。

### 2.5 上传

```http
POST /api/upload
Cookie: ep_session=...
Content-Type: image/png
X-File-Name: photo.png
X-EasyPush-Append: 1        # 可选，追加到当前队列
Content-Length: 123456
<binary>
```

- 类型需为 `image/*`、`audio/*`、`video/*`、HLS MIME；否则 `415 unsupported-media`。
- 上限 2 GB；声明值或实际流超过都返回 `413 too-large`；空文件 `400 empty-upload`。
- 流式写入 `uploads/<id>.<ext>.part`，成功后原子 rename；失败删除临时文件。
- 单设备 5 分钟 30 次，超限 `429`。
- `201` 响应：

```json
{
  "item": { "id": "...", "kind": "image", "name": "photo.png", "mime": "image/png", "size": 123456, "url": "http://127.0.0.1:7333/media/...", "source": "upload" },
  "queued": false,
  "queueLength": 1,
  "appended": false
}
```

`queued: true` 表示当前正在直播，媒体已排队；直播结束后不自动抢占，需在桌面播放。

### 2.6 推送媒体直链

```http
POST /api/cast/url
{ "url": "https://example.com/clip.mp4", "title": "可选标题" }
```

只接受 `http:`/`https:` 且长度 ≤2048；服务端不代理、不下载，桌面渲染器直接访问该地址。直播中调用会加入待播队列；没有活动直播时立即切到媒体舞台。响应结构同上。

### 2.7 媒体与桌面页面

- `GET /media/:id`：仅回环来源；ID 为 8–64 位 `[A-Za-z0-9_-]`；支持单段 `Range`，返回 `206`/`416`；`Cache-Control: private, max-age=600`。
- `GET /desktop/*`：仅回环来源；HTML 使用桌面 CSP，`Cache-Control: no-store`。
- 网页 HTML 的 CSP 允许 `camera=(self)`、`microphone=(self)`、`display-capture=(self)`；桌面页 CSP 禁止摄像头/麦克风，仅允许 `fullscreen=(self)`。

## 3. WebSocket 信令

### 3.1 建立连接

```
GET /ws HTTP/1.1
Upgrade: websocket
Cookie: ep_session=...
Origin: https://192.168.1.10:7443
```

- 必须通过 Host、Origin（存在时同源）和会话校验；否则升级阶段返回 `421/403/401`。
- 单帧上限 512 KiB，关闭压缩；每设备每 10 秒最多 180 条消息。
- 服务端每 30 秒 ping；未回 pong 的连接被终止。客户端每 20 秒发送应用层 `ping`。
- 同一设备重连会替换旧连接；被替换方收到关闭原因 `replaced`。

### 3.2 消息

客户端 → 服务端：

| 类型 | 负载 | 说明 |
| --- | --- | --- |
| `intent` | `{media:"screen"\|"camera", audio:boolean}` | 申请直播，进入审批或接管 |
| `offer` | `{sdp:{type:"offer",sdp}, media, audio}` | SDP ≤200,000 字符 |
| `ice` | `{candidate:{candidate,sdpMid,sdpMLineIndex,usernameFragment}\|null}` | 候选 ≤4096 字符；offer 前最多缓冲 64 个 |
| `resume` | `{sessionId}` | 断线重连恢复 |
| `end` | `{reason?}` | 主动结束，reason ≤200 |
| `ping` | `{t:number}` | 应用层心跳 |

服务端 → 客户端：

| 类型 | 负载 | 说明 |
| --- | --- | --- |
| `hello` | `{protocolVersion,receiverName,deviceName,sessionId,state,secure}` | 连接建立即发送；`sessionId` 用于重连 |
| `state` | `{state,sessionId?,reason?}` | 状态迁移 |
| `ready` | `{sessionId}` | 审批通过，可以发 offer |
| `answer` | `{sdp:{type:"answer",sdp}}` | 桌面应答 |
| `ice` | `{candidate}` | 桌面候选，可能为 `null` 表示结束 |
| `stats` | `{stats}` | 每秒采样，向手机最多每 1.8 秒推送一次 |
| `notice` | `{message}` | 桌面静音等提示 |
| `error` | `{code,message}` | 业务错误 |
| `pong` | `{t}` | 心跳响应 |
| `ended` | `{reason}` | 会话结束 |

`stats` 字段：`at,width,height,fps,bitrateKbps,rttMs,jitterMs,packetsLost,bytesReceived,framesDecoded,codec,audioCodec,jitterBufferMs`。

### 3.3 直播时序

```
客户端                         服务端                         桌面
  │── intent ─────────────────► │                            │
  │◄─ state awaiting-approval ──│── 审批卡片 ───────────────►│
  │                             │◄─ approve ─────────────────│
  │◄─ state awaiting-offer ─────│                            │
  │◄─ ready ────────────────────│── live:prepare ───────────►│
  │── offer ───────────────────►│── live:offer ─────────────►│
  │                             │◄─ answer ──────────────────│
  │◄─ answer ───────────────────│                            │
  │── ice ⇄ ────────────────────│── ice ⇄ ───────────────────│
  │◄─ state live ───────────────│◄─ live（首帧）─────────────│
  │── end / 关闭 ──────────────►│── live:stop ──────────────►│
  │◄─ ended ────────────────────│                            │
```

- 审批 60s 超时、offer 25s 超时、连接 25s 超时；控制连接断开给 8s 恢复窗口。
- 新设备请求时状态为 `awaiting-takeover`；批准先结束旧会话再复用舞台。
- 同一设备新 `intent` 直接替换当前会话，不重复审批。
- 关闭直播功能后，`intent` 返回 `error.live-disabled`；已有待审批时拒绝设置变更。

### 3.4 错误码

| code | 场景 |
| --- | --- |
| `rate-limited` | WS 消息或配对/上传过频 |
| `invalid-json` / `invalid-message` | 无法解析或字段不合法 |
| `unauthorized` | 会话失效 |
| `live-disabled` | 接收端关闭直播 |
| `busy` | 已有待审批请求 |
| `rejected` | 桌面拒绝或审批超时 |
| `no-session` | 会话不存在/已结束 |
| `protocol` | 当前状态不允许该消息 |

## 4. WebRTC 约束

| 项目 | 摄像头 | 屏幕共享 |
| --- | --- | --- |
| 发起方 | 手机/桌面浏览器 | 桌面浏览器 |
| 角色 | offerer | answerer（Electron） |
| 分辨率 | 1280×720 ideal，30fps max | 1920×1080 ideal，30fps max |
| 音频 | 可选麦克风（EC/NS/AGC） | 可选标签页/系统音频 |
| 最大码率 | 4 Mbps | 8 Mbps |
| 降级偏好 | `balanced` | `maintain-resolution` |
| ICE | `iceServers: []`，仅 host candidate | 同左 |

- 摄像头获取失败时依次降级：完整约束 → 仅 `facingMode` → 提示用户检查权限。
- 屏幕共享首选带音频；音频不被支持时降级为 `audio:false`。
- 前后摄像头切换使用 `replaceTrack`，不重建 PeerConnection。
- 不收集 STUN/TURN，不在 SDP 之外建立通道；跨子网/AP 隔离环境无法连接属于部署限制。
- 手机停止原生共享或任一 track 结束时，发送 `end`；桌面收到渲染器 `ended` 也结束会话。

## 5. DLNA / UPnP

### 5.1 发现（SSDP）

- 监听 UDP 1900，加入 `239.255.255.250`，在多张私有网卡上发送 alive/byebye。
- `CACHE-CONTROL: max-age=1800`；alive 每 900 秒；启动与停止时立即通告。
- 响应 `M-SEARCH` 的 ST：

```
upnp:rootdevice
uuid:<uuid>
urn:schemas-upnp-org:device:MediaRenderer:1
urn:schemas-upnp-org:service:AVTransport:1
urn:schemas-upnp-org:service:RenderingControl:1
urn:schemas-upnp-org:service:ConnectionManager:1
```

- `LOCATION: http://<primary-ip>:<http-port>/dlna/description.xml`；UUID 由实例 ID 稳定派生（version-5 风格），重装/换数据目录会变化。
- 仅处理私网/回环来源的 M-SEARCH；SSDP 报文不做鉴权。

### 5.2 设备描述与 SCPD

| 资源 | 路径 |
| --- | --- |
| 设备描述 | `/dlna/description.xml` |
| AVTransport SCPD | `/dlna/scpd/AVTransport.xml` |
| RenderingControl SCPD | `/dlna/scpd/RenderingControl.xml` |
| ConnectionManager SCPD | `/dlna/scpd/ConnectionManager.xml` |
| AVTransport 控制 | `/dlna/control/AVTransport` |
| AVTransport 事件 | `/dlna/event/AVTransport` |
| RenderingControl 控制/事件 | `/dlna/control/RenderingControl`、`/dlna/event/RenderingControl` |
| ConnectionManager 控制/事件 | `/dlna/control/ConnectionManager`、`/dlna/event/ConnectionManager` |

描述声明 `MediaRenderer:1`、`DMR-1.50`、制造商/型号/UDN；控制/事件 URL 均以 `/dlna/` 为前缀。所有 `/dlna/*` 请求只接受回环或 RFC1918 来源，否则 403；SOAP 单请求上限 128 KiB；单 IP 每分钟 1200 次控制请求。

### 5.3 SOAP 控制

请求需 `Content-Type: text/xml; charset="utf-8"`，`SOAPACTION: "<serviceType>#<Action>"`；动作必须与头一致，否则 `402 Invalid Args`。

支持的动作：

| 服务 | 动作 |
| --- | --- |
| AVTransport | `SetAVTransportURI`、`GetMediaInfo`、`GetTransportInfo`、`GetPositionInfo`、`GetDeviceCapabilities`、`GetTransportSettings`、`GetCurrentTransportActions`、`Play`、`Pause`、`Stop`、`Seek`、`Next`、`Previous` |
| RenderingControl | `GetVolume`、`SetVolume`、`GetMute`、`SetMute`、`ListPresets`、`SelectPreset` |
| ConnectionManager | `GetProtocolInfo`、`GetCurrentConnectionIDs`、`GetCurrentConnectionInfo`、`PrepareForConnection`、`ConnectionComplete` |

- 只支持 `InstanceID=0`，其他返回 `718 Invalid InstanceID`。
- `SetAVTransportURI` 接受 http/https；空 URI 会停止当前 DLNA 媒体；非法 URI 返回 `716 Resource not found`。
- 无媒体时 `Play` 返回 `701 Transition not available`；未知动作 `401 Invalid Action`。
- `SetNextAVTransportURI` 明确返回 `701`（未实现队列）。
- 直播进行中设置 URI 返回 `701`（互斥）。
- `GetProtocolInfo` 公布的 sink 列表见 `src/main/dlna/upnp.ts`，仅代表容器协商，实际解码能力仍受 Chromium 限制。

### 5.4 GENA 事件

```http
SUBSCRIBE /dlna/event/AVTransport HTTP/1.1
CALLBACK: <http://192.168.1.30:49152/notify>
NT: upnp:event
TIMEOUT: Second-1800
```

响应：

```http
HTTP/1.1 200 OK
SID: uuid:...
TIMEOUT: Second-1800
```

- `TIMEOUT` 被钳制在 120–3600 秒；续订必须携带相同 `SID` 且服务一致，否则 `412`。
- `CALLBACK` 必须是 http URL，且主机名等于订阅者远端 IP；端口 1900 禁止。回调不匹配返回 `403`。
- 订阅成功后立即发送 `SEQ: 0` 的初始 `NOTIFY`，后续变化在 1 秒内推送。
- AVTransport 使用 `LastChange` 内嵌 `TransportState`、`CurrentTransportActions`、URI、时长、轨道数等；RenderingControl 使用 `LastChange` 内嵌 `Volume`、`Mute`。命名空间分别为 `urn:schemas-upnp-org:metadata-1-0/AVT/` 与 `.../RCS/`。
- 退订：`UNSUBSCRIBE` + `SID`，成功 200，未知 SID `412`。
- 通知失败会累计，连续 2 次失败后移除订阅；不重试阻塞主流程。

### 5.5 DLNA 故障码

| 码 | 含义 |
| --- | --- |
| `401` | Invalid Action |
| `402` | Invalid Args |
| `501` | Action Failed |
| `701` | Transition not available |
| `716` | Resource not found |
| `718` | Invalid InstanceID |

## 6. 超时与限额

| 项目 | 值 |
| --- | --- |
| ticket / 配对码 / 配对请求 | 120s / 300s / 60s |
| 会话 | 30 天 |
| 直播审批 / offer / 连接超时 | 60s / 25s / 25s |
| 断线宽限 | 8s |
| HTTP headers / keep-alive | 30s / 65s；请求体无总超时（支持大文件） |
| WS 心跳 / 消息限速 | 30s / 180 条每 10s |
| 上传 | 2 GB；30 次每 5 分钟 |
| DLNA 订阅 | 120–3600s；1200 次控制每分钟 |
| 历史 / 设备 / 日志 | 200 / 500 / 14 天 |

## 7. 兼容性说明

- 浏览器需支持 WebSocket、WebRTC、`getUserMedia`、`getDisplayMedia`（桌面屏幕共享）。
- iOS Safari 16+、Android Chrome 120+ 为设计基线；真机矩阵见 [验证规范](verification.md#5-真机矩阵)。
- DLNA 按 UPnP AV 1.0 / DLNA DMR 1.50 的常用子集实现，不承诺通过全部 DLNA 认证用例。
- 协议版本 1 不提供向后兼容的旧消息别名；不认识的客户端消息返回 `invalid-message`。
