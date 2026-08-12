# 抖音公开直播间实时事件可行性验证

验证日期：2026-07-31至2026-08-01

## 结论

技术上可行，匿名网页在线消息链路已经本机实测通过，但当前证据仍不足以直接接入正式采集器。

匿名请求已经能够从一个正在直播的公开页面取得`web_rid`并解析出长`room_id`，没有读取账号Cookie。2026-08-01使用全新临时浏览器上下文完成30秒在线PoC：WSS保持连接，69个入站帧全部解码，66帧要求ACK；网页实际发出66个ACK和3个应用层心跳，没有未知出站帧。匿名业务消息实测包含评论、点赞、进场、关注和房间统计。

这次PoC复用了抖音网页自身当前下发的动态连接参数与签名，没有独立实现或保存签名算法。礼物、下播、断线后的游标与补发行为仍未实测。正式主进程采集器必须等人工签名向量、完整畸形包测试和独立连接闭环通过后再接入会话、SQLite或界面。

抖音官方开放能力不能替代任意公开直播间采集。官方路径面向直播玩法和互动工具，需要创建应用、申请互动数据能力、由主播挂载玩法并启动数据推送任务。[直播间评论互动能力](https://developer.open-douyin.com/docs/resource/zh-CN/interaction/jierushuoming/hudongshuju/pinglunshuju)、[抖音云接入指南](https://developer.open-douyin.com/docs/resource/zh-CN/interaction/develop/douyincloud/guide)

## 证据等级

### 本机匿名实测

- 公开直播首页可以在无账号Cookie请求下返回当前直播入口。
- 公开直播间页面可以在无账号Cookie请求下返回服务端渲染状态。
- 页面状态中包含公开`web_rid`对应的长`room_id`和直播状态。本轮验证只保留字段存在性和流程结果，没有把房间号、主播资料、页面正文或响应原文写入仓库。
- 全新临时浏览器上下文没有读取用户浏览器资料或账号Cookie，能够建立`/webcast/im/push/v2/`连接并持续30秒不关闭。
- 69个入站二进制帧全部按`PushFrame`、gzip和`Response`链路解码成功。其中66帧要求ACK；同一连接发出66个`payloadType=ack`帧和3个`payloadType=hb`帧。
- 收到`WebcastChatMessage`、`WebcastLikeMessage`、`WebcastMemberMessage`、`WebcastSocialMessage`、`WebcastRoomStatsMessage`和`WebcastRoomUserSeqMessage`。PoC只输出方法计数，没有读取或保存消息正文、昵称、用户ID和房间标识。
- 当前帧把`gzip`声明放在`PushFrame.headersList`的`compress_type`头中，而不是旧实现常见的`payloadEncoding`字段。业务帧还带有超过JavaScript安全整数范围的`uint64`字段，读取器必须按字节跳过不使用的ID，不能转成`number`。

### 官方文档确认

- 官方直播玩法可以接收评论、点赞、礼物和粉丝团等互动数据，但要先申请相应能力并启动数据推送任务。[直播间评论互动能力](https://developer.open-douyin.com/docs/resource/zh-CN/interaction/jierushuoming/hudongshuju/pinglunshuju)、[直播间礼物互动能力](https://developer.open-douyin.com/m/docs/resource/zh-CN/interaction/jierushuoming/hudongshuju/liwushuju)
- 抖音云方案从玩法运行上下文取得应用、直播间和主播信息，再由开发者后端启动推送；它服务于被主播挂载的玩法，不是匿名查询任意公开房间的接口。[抖音云接入指南](https://developer.open-douyin.com/docs/resource/zh-CN/interaction/develop/douyincloud/guide)
- 直播互动工具使用直播数据时，官方要求后端部署在抖音云，体现这条开放能力的合规边界。[直播互动工具接入抖音云指南](https://developer.open-douyin.com/docs/resource/zh-CN/live-interactive-tools/development/douyin-cloud/live-interaction-guide-dycloud)

### 开源源码交叉核对

以下内容来自网页私有协议的开源逆向实现，不是抖音承诺稳定的公开协议。

- `jwwsjlm/douyinLive`在2026-07-26仍有更新。它先根据`room_id`与匿名`user_unique_id`生成签名，请求`/webcast/im/fetch/`取得动态游标、内部扩展和推送地址，再构造WSS URL。[签名与初始状态源码](https://github.com/jwwsjlm/douyinLive/blob/597969eb66fb923573f9d679c866b4a62a40ad3e/websocket_connection.go#L91-L255)
- 同一实现把WSS外层解析为`PushFrame`，载荷解析为`Response`；gzip载荷先受限解压，`NeedAck`为真时回传带`log_id`和`internal_ext`的ACK。[解码与ACK源码](https://github.com/jwwsjlm/douyinLive/blob/597969eb66fb923573f9d679c866b4a62a40ad3e/message_decode.go#L37-L120)、[心跳与ACK源码](https://github.com/jwwsjlm/douyinLive/blob/597969eb66fb923573f9d679c866b4a62a40ad3e/heartbeat.go#L11-L178)
- 该实现使用应用层`PushFrame`心跳，默认下限10秒，读取超时70秒，并把控制消息`action=3`解释为下播。[连接常量](https://github.com/jwwsjlm/douyinLive/blob/597969eb66fb923573f9d679c866b4a62a40ad3e/constants.go#L8-L31)
- `skmcj/dycast`在2026-04-12仍有更新，也采用动态签名、Protobuf、gzip、`PushFrame`与`Response`，并列出评论、点赞、进场、关注、房间统计和控制消息。它明确标注礼物消息需要登录Cookie，因此匿名第一版不能把礼物当作稳定能力。[实现说明](https://github.com/skmcj/dycast/blob/dc3ab9ad4633b21ec255942e5262bba78750a1c3/README.md#L20-L70)

## 两条接入路线

| 路线 | 适用范围 | 当前判断 |
| --- | --- | --- |
| 抖音开放平台直播玩法 | 主播主动挂载的玩法或互动工具 | 官方支持，需应用、能力申请、主播运行上下文和推送任务，不满足任意公开直播间 |
| 抖音网页直播私有协议 | 用户输入任意公开`web_rid`或直播链接 | 房间发现已匿名实测；WSS链路有近期源码交叉核对，但仍需本机在线PoC |

当前产品应继续选择网页协议，并把它隔离为可替换、可版本化的`douyin-web-v1`适配器。官方路线只保留为未来独立产品方向，第一版不同时接入。现阶段仓库只加入纯解码边界和脱敏在线探针，没有接入正式采集流程。

## 暂定连接流程

```text
web_rid或公开直播链接
  ↓
匿名请求直播间页面
  ↓
解析长room_id、匿名user_unique_id与直播状态
  ↓
生成当前网页签名并请求IM初始状态
  ↓
取得cursor、internal_ext与动态push_server
  ↓
建立带signature的WSS连接
  ↓
解析PushFrame
  ↓
按需gzip解压Response
  ↓
NeedAck时回传ACK，按服务端节奏发送心跳
  ↓
校验并转换为项目内部事件
```

页面内在线PoC已经验证从页面到消息方法计数的链路；其中动态签名仍由当前网页生成，尚未形成可审计的独立签名实现。动态签名和Protobuf字段都可能随网页发布变化。

## 事件可用性

| 事件 | 官方玩法 | 网页匿名当前证据 | 第一版处理 |
| --- | --- | --- | --- |
| 普通评论 | 支持，但限挂载玩法 | 匿名在线PoC已收到 | 候选第一版事件，仍需固定消息体样本 |
| 点赞 | 支持，但限挂载玩法 | 匿名在线PoC已收到 | 候选第一版聚合事件，仍需验证字段语义 |
| 进场 | 官方资料不作为本轮目标 | 匿名在线PoC已收到且频率高 | 默认不持久化，避免高频低价值数据 |
| 关注 | 官方玩法可配置相关互动 | 匿名在线PoC已收到 | 第一版暂不持久化 |
| 礼物 | 支持，但限挂载玩法 | 一个实现明确要求登录Cookie | 匿名第一版不能承诺，缺失显示为不可用 |
| 房间统计 | 玩法上下文可取得部分房间信息 | 匿名在线PoC已收到两类统计消息，具体字段未解析 | 必须逐字段验证，不能与B站热度共用文案 |
| 下播 | 可由玩法生命周期判断 | 源码通过控制消息与页面状态识别 | 在线PoC必须验证 |

## 安全与隐私边界

- 不读取、导入或提示用户提供抖音账号Cookie。
- 不绕过验证码、设备校验、账号限制或平台访问控制。
- 页面响应、Protobuf原包、签名、`ttwid`、`msToken`、`user_unique_id`、`room_id`和主播资料不能进入日志、数据库、IPC、固定样本或Git。
- 用户去重只能在主进程边界把平台用户标识转换为现有本地HMAC标识，随后立即丢弃原值。
- 在线PoC只输出阶段、状态码、消息类型计数、压缩类型、心跳和ACK计数、关闭码与耗时。
- Protobuf解压必须设置输入帧、输出体积、消息数量和递归层级上限；异常单元不能原样写日志。

## 进入编码前的门槛

1. 已通过：使用公开直播间完成匿名WSS连接，并收到`PushFrame`和多类业务消息。
2. 已通过页面链路验证：30秒内发送3个心跳和66个ACK，连接未关闭。独立主进程实现仍需复测相同节奏。
3. 部分通过：评论、点赞和房间统计消息类型已收到；礼物与下播没有匿名证据，不能承诺。
4. 部分通过：人工构造的`PushFrame`、gzip、`Response`、ACK标志、大`uint64`和脱敏摘要测试已经固定；签名向量和业务消息体样本尚未建立。
5. 部分通过：Protobuf解码已经放入独立`douyin-web-v1`边界并只输出脱敏错误码；页面解析、签名和正式平台适配器尚未实现。

## 可重复验证

在线探针会自行选择一个当前公开直播间，在临时浏览器上下文中运行，不接受或输出房间号、Cookie和原始消息：

```bash
npx playwright install chromium-headless-shell
DOUYIN_PROBE_DURATION_MS=30000 npm run probe:douyin
```

成功门槛是至少建立一条WSS连接、解码一帧、收到一类业务消息，并分别识别至少一个ACK与心跳出站帧。固定样本单元测试由`npm run test:unit`执行。

## 遗留风险

- 网页协议没有公开稳定性承诺，动态签名和Protobuf结构都可能失效。
- 当前网页签名已被在线WSS接受，但独立签名实现尚未验证；匿名消息集合也可能因地区、房间或风控不同而变化。
- 礼物数据与登录态存在明显关联，和原B站版本的事件范围不能直接等同。
- 第三方实现可能包含从网页脚本逆向得到的代码。正式项目不能直接复制来源、授权或可维护性不清晰的大段签名脚本，应先确定可审计的最小实现与许可证义务。
