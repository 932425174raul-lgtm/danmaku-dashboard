# 直播事件模型与SQLite结构

版本：`v1`

日期：2026-07-29

## 设计结论

本地资料库采用规范化事件表、会话摘要表、10秒统计桶和FTS5三元组全文索引。数据库只保存项目明确使用的字段，不保存B站原始JSON、WebSocket包、原始用户ID、匿名指纹、WBI材料或临时令牌。

弹幕正文属于产品需要保存的规范化字段。完整原始消息指B站返回的整段数组或JSON，两者不能混为一谈。

## 时间、标识与金额

### 时间

- 所有持久化时间使用UTC Unix毫秒整数。
- `received_at_ms`是本机接收并通过边界校验的时间，作为排序和统计的主时间。
- `sent_at_ms`来自平台字段，只在格式可信时保存，允许为空，不能用于数据库主排序。
- 同一毫秒内使用表内整数主键作为稳定次序。
- 界面展示时再转换为macOS本地时区。

### 会话标识

- `sessions.id`使用`INTEGER PRIMARY KEY AUTOINCREMENT`，避免历史删除后复用已经暴露给界面的会话标识。
- 子表使用`INTEGER PRIMARY KEY`，并通过`session_id`关联。
- IPC中的会话标识仍按整数处理，不向外暴露SQLite连接或行对象。

### 本地用户标识

应用首次运行生成32字节本机随机盐。原始平台用户ID只允许在协议适配器到事件规范化器之间短暂存在。

```text
local_user_key = 前16字节(
  HMAC-SHA-256(local_salt, bilibili:user: + normalized_source_user_id)
)
```

- 数据库使用16字节BLOB保存`local_user_key`。
- 平台提供匿名稳定标识时使用独立命名空间生成本地键。
- 没有任何稳定来源时保存`NULL`，不使用展示昵称假装成稳定用户。
- 活跃发言人数只统计非空本地用户标识。界面需要说明少量无法识别的匿名消息不会进入去重人数。
- 展示昵称可以随规范化事件保存，用于弹幕和活跃用户展示，但不能反推出生成本地键的输入。

### 平台事件去重键

平台消息标识存在时使用同一随机盐生成16字节`source_event_key`：

```text
source_event_key = 前16字节(
  HMAC-SHA-256(local_salt, event_type + : + source_event_id)
)
```

每种事件表建立`session_id + source_event_key`部分唯一索引。没有平台消息标识时保存`NULL`，不承诺严格去重。状态机通过禁止重叠连接减少重复。

### 金额

- 所有金额使用`milli_cny`整数，`1000`表示人民币1元。
- 醒目留言金额按平台人民币价格转换。
- 礼物只有在协议字段可以可靠换算时才保存单位金额和总金额，否则金额字段为`NULL`。
- 聚合金额只累加已知金额，另存未知金额的礼物数量。
- 不使用浮点数，不保存无法解释的原始金瓜子或银瓜子字段。

## 内部事件

所有事件进入写入队列前必须成为以下判别联合之一。字段长度在规范化边界限制，数据库不接受额外属性。

### 弹幕事件

```ts
type DanmakuEvent = {
  type: 'danmaku'
  sessionId: number
  sourceEventKey: Uint8Array | null
  receivedAtMs: number
  sentAtMs: number | null
  localUserKey: Uint8Array | null
  displayName: string
  text: string
  medalName: string | null
  medalLevel: number | null
}
```

限制：

- 展示昵称最多128个Unicode字符。
- 弹幕正文最多2000个Unicode字符。
- 粉丝牌名称最多64个Unicode字符。
- 文本执行Unicode合法性与控制字符清理，不改写用户可见语义。

### 礼物事件

```ts
type GiftEvent = {
  type: 'gift'
  sessionId: number
  sourceEventKey: Uint8Array | null
  receivedAtMs: number
  sentAtMs: number | null
  localUserKey: Uint8Array | null
  displayName: string
  giftName: string
  quantity: number
  unitValueMilliCny: number | null
  totalValueMilliCny: number | null
}
```

`quantity`是当前规范化事件新增的礼物数量，不保存组合礼物累计值。礼物数指标按`quantity`求和，不按WebSocket包数量计数。

### 醒目留言事件

```ts
type SuperChatEvent = {
  type: 'super_chat'
  sessionId: number
  sourceEventKey: Uint8Array | null
  receivedAtMs: number
  sentAtMs: number | null
  localUserKey: Uint8Array | null
  displayName: string
  text: string
  valueMilliCny: number
  expiresAtMs: number | null
}
```

醒目留言只按首次出现计数。后续更新或删除命令不属于第一版采集范围；如果平台重复发送同一消息，由`source_event_key`消除重复。

### 热度采样

```ts
type PopularitySample = {
  type: 'popularity'
  sessionId: number
  receivedAtMs: number
  value: number
}
```

每个有效心跳回复产生一个采样。热度是B站提供的相对指标，不称为真实在线人数。

### 会话转换

会话转换来自项目状态机，不直接复制B站命令：

```ts
type SessionTransition = {
  sessionId: number
  atMs: number
  fromState: string
  toState: string
  reason: string
  errorCategory: string | null
}
```

`LIVE`和`PREPARING`先经过适配器和状态机，再成为开播或下播转换。连接状态也通过同一表保存。

## SQLite表

以下DDL是实现契约。迁移脚本可以补充数据库支持的严格模式，但不能改变字段语义。

### 迁移记录

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
);
```

### 采集会话

```sql
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  input_room_id TEXT,
  room_title TEXT NOT NULL,
  anchor_display_name TEXT,
  adapter_version TEXT NOT NULL,
  event_schema_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'interrupted')),
  end_reason TEXT CHECK (
    end_reason IS NULL OR end_reason IN (
      'user_stop',
      'live_ended',
      'app_quit',
      'process_interrupted'
    )
  ),
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  last_checkpoint_at_ms INTEGER NOT NULL,
  interruption_detected_at_ms INTEGER,
  deleted_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (
    (status = 'active' AND ended_at_ms IS NULL AND end_reason IS NULL)
    OR
    (status <> 'active' AND ended_at_ms IS NOT NULL AND end_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX one_active_session
ON sessions(status)
WHERE status = 'active' AND deleted_at_ms IS NULL;

CREATE INDEX sessions_history
ON sessions(deleted_at_ms, started_at_ms DESC, id DESC);
```

`room_id`使用十进制文本，避免把上游标识绑定到JavaScript安全整数范围。数据库不保存主播原始用户ID。

### 会话摘要

```sql
CREATE TABLE session_metrics (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  danmaku_count INTEGER NOT NULL DEFAULT 0,
  active_user_count INTEGER NOT NULL DEFAULT 0,
  gift_count INTEGER NOT NULL DEFAULT 0,
  gift_event_count INTEGER NOT NULL DEFAULT 0,
  gift_known_value_milli_cny INTEGER NOT NULL DEFAULT 0,
  gift_unknown_value_count INTEGER NOT NULL DEFAULT 0,
  super_chat_count INTEGER NOT NULL DEFAULT 0,
  super_chat_value_milli_cny INTEGER NOT NULL DEFAULT 0,
  last_popularity INTEGER,
  peak_popularity INTEGER,
  gap_count INTEGER NOT NULL DEFAULT 0,
  gap_duration_ms INTEGER NOT NULL DEFAULT 0,
  first_danmaku_event_id INTEGER,
  last_danmaku_event_id INTEGER,
  last_message_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  CHECK (
    (first_danmaku_event_id IS NULL AND last_danmaku_event_id IS NULL)
    OR
    (
      first_danmaku_event_id IS NOT NULL
      AND last_danmaku_event_id >= first_danmaku_event_id
    )
  )
);
```

摘要是加速查询的投影，不是事实来源。迁移或诊断工具必须能够从事件表和缺口表重建它。

### 会话转换

```sql
CREATE TABLE session_transitions (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at_ms INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  error_category TEXT
);

CREATE INDEX session_transitions_timeline
ON session_transitions(session_id, at_ms, id);
```

`error_category`只能取项目内部脱敏枚举，不保存HTTP正文、WSS地址或异常对象序列化结果。

### 数据缺口

```sql
CREATE TABLE data_gaps (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  first_reason TEXT NOT NULL,
  last_reason TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  recovered INTEGER NOT NULL DEFAULT 0 CHECK (recovered IN (0, 1)),
  CHECK (ended_at_ms IS NULL OR ended_at_ms >= started_at_ms)
);

CREATE UNIQUE INDEX one_open_gap_per_session
ON data_gaps(session_id)
WHERE ended_at_ms IS NULL;

CREATE INDEX data_gaps_timeline
ON data_gaps(session_id, started_at_ms, id);
```

### 弹幕

```sql
CREATE TABLE danmaku_events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_event_key BLOB,
  received_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  local_user_key BLOB,
  display_name TEXT NOT NULL,
  text TEXT NOT NULL,
  medal_name TEXT,
  medal_level INTEGER,
  CHECK (length(source_event_key) = 16 OR source_event_key IS NULL),
  CHECK (length(local_user_key) = 16 OR local_user_key IS NULL)
);

CREATE UNIQUE INDEX danmaku_dedup
ON danmaku_events(session_id, source_event_key)
WHERE source_event_key IS NOT NULL;

CREATE INDEX danmaku_timeline
ON danmaku_events(session_id, received_at_ms, id);

CREATE INDEX danmaku_by_user
ON danmaku_events(session_id, local_user_key, received_at_ms, id)
WHERE local_user_key IS NOT NULL;
```

### 礼物

```sql
CREATE TABLE gift_events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_event_key BLOB,
  received_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  local_user_key BLOB,
  display_name TEXT NOT NULL,
  gift_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_value_milli_cny INTEGER,
  total_value_milli_cny INTEGER,
  CHECK (length(source_event_key) = 16 OR source_event_key IS NULL),
  CHECK (length(local_user_key) = 16 OR local_user_key IS NULL),
  CHECK (unit_value_milli_cny IS NULL OR unit_value_milli_cny >= 0),
  CHECK (total_value_milli_cny IS NULL OR total_value_milli_cny >= 0)
);

CREATE UNIQUE INDEX gift_dedup
ON gift_events(session_id, source_event_key)
WHERE source_event_key IS NOT NULL;

CREATE INDEX gift_timeline
ON gift_events(session_id, received_at_ms, id);
```

### 醒目留言

```sql
CREATE TABLE super_chat_events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_event_key BLOB,
  received_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  local_user_key BLOB,
  display_name TEXT NOT NULL,
  text TEXT NOT NULL,
  value_milli_cny INTEGER NOT NULL CHECK (value_milli_cny >= 0),
  expires_at_ms INTEGER,
  CHECK (length(source_event_key) = 16 OR source_event_key IS NULL),
  CHECK (length(local_user_key) = 16 OR local_user_key IS NULL)
);

CREATE UNIQUE INDEX super_chat_dedup
ON super_chat_events(session_id, source_event_key)
WHERE source_event_key IS NOT NULL;

CREATE INDEX super_chat_timeline
ON super_chat_events(session_id, received_at_ms, id);
```

### 热度采样

```sql
CREATE TABLE popularity_samples (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  received_at_ms INTEGER NOT NULL,
  value INTEGER NOT NULL CHECK (value >= 0)
);

CREATE INDEX popularity_timeline
ON popularity_samples(session_id, received_at_ms, id);
```

### 10秒统计桶

```sql
CREATE TABLE metric_buckets (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  bucket_start_ms INTEGER NOT NULL,
  bucket_seconds INTEGER NOT NULL DEFAULT 10 CHECK (bucket_seconds = 10),
  danmaku_count INTEGER NOT NULL DEFAULT 0,
  gift_count INTEGER NOT NULL DEFAULT 0,
  gift_known_value_milli_cny INTEGER NOT NULL DEFAULT 0,
  super_chat_count INTEGER NOT NULL DEFAULT 0,
  super_chat_value_milli_cny INTEGER NOT NULL DEFAULT 0,
  popularity_last INTEGER,
  popularity_peak INTEGER,
  PRIMARY KEY (session_id, bucket_start_ms)
);
```

最近30分钟固定读取最多180个桶。断线区间通过`data_gaps`覆盖显示，不能把缺失桶解释为零事件。

### 会话用户投影

```sql
CREATE TABLE session_users (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  local_user_key BLOB NOT NULL,
  last_display_name TEXT NOT NULL,
  danmaku_count INTEGER NOT NULL DEFAULT 0,
  first_danmaku_at_ms INTEGER NOT NULL,
  last_danmaku_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, local_user_key),
  CHECK (length(local_user_key) = 16)
);

CREATE INDEX session_users_active_rank
ON session_users(session_id, danmaku_count DESC, last_danmaku_at_ms DESC);
```

`session_users`只统计发过普通弹幕且具有本地用户标识的用户。它为活跃人数和活跃用户排行提供读取模型。

### 高频词投影

```sql
CREATE TABLE session_keywords (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  estimated_count INTEGER NOT NULL CHECK (estimated_count > 0),
  error_upper_bound INTEGER NOT NULL DEFAULT 0
    CHECK (error_upper_bound >= 0 AND error_upper_bound < estimated_count),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, term)
) WITHOUT ROWID;

CREATE INDEX session_keywords_rank
ON session_keywords(session_id, estimated_count DESC, term);
```

高频词采用固定容量Space-Saving候选集：

- 使用`Intl.Segmenter('zh-CN', { granularity: 'word' })`分词。
- 只接收`isWordLike`、去除首尾空白后长度为2至16个Unicode字符的词。
- 数字、项目内置停用词和同一弹幕内重复词被丢弃。
- 每条弹幕最多贡献6个词。
- 每个活动会话只保留128个候选词，每秒最多把一次候选快照写入`session_keywords`。
- `estimated_count`是Space-Saving估算值，真实次数范围为`estimated_count - error_upper_bound`至`estimated_count`。
- 高频词只用于看板和历史摘要，不作为计费、审计或精确统计依据。

内存候选集、数据库投影和renderer都保持固定上限。会话异常中断后可直接使用最近一次持久化快照；如需重建，按接收顺序流式扫描弹幕，不一次加载整场文本。

## 弹幕全文搜索

第一版要求打包的SQLite支持FTS5与`trigram`分词器，以支持中文子串搜索。使用外部内容表，避免在应用层维护另一套正文：

```sql
CREATE VIRTUAL TABLE danmaku_fts USING fts5(
  session_id UNINDEXED,
  text,
  display_name,
  content = 'danmaku_events',
  content_rowid = 'id',
  tokenize = 'trigram'
);
```

通过`AFTER INSERT`、`AFTER DELETE`和必要的`AFTER UPDATE`触发器同步索引。迁移完成后执行一次`rebuild`并校验行数。

搜索规则：

- 必须指定一个会话，第一版不做跨会话全文搜索。
- 搜索范围为弹幕正文和展示昵称。
- 去除首尾空白后长度为1至2个Unicode字符时，reader worker使用参数化`instr`查询和会话时间线索引回退。
- 长度为3至200个Unicode字符时使用FTS5三元组索引。
- FTS查询先用`MATERIALIZED`子查询取得匹配`rowid`，再关联事实表排序，避免查询计划按整场时间线逐行探测FTS。
- FTS子查询使用当前会话的`first_danmaku_event_id`和`last_danmaku_event_id`限制`rowid`范围。第一版只有一个活动会话，因此同一会话的弹幕事实ID必须连续递增。
- 用户输入按纯文本短语转义，不允许成为FTS操作符或SQL片段。
- 结果按`received_at_ms DESC, id DESC`返回。
- 每页100条，使用最后一条的时间和ID进行键集分页，不使用大偏移量`OFFSET`。
- 空查询直接返回普通时间线，不调用FTS。

## 批量写入与事务

### 单写入者

- 主进程监管的writer worker拥有唯一写连接。
- WebSocket回调只负责把已经规范化的事件放入有界内存队列，不执行SQL。
- 读取由主进程监管的reader worker使用独立只读连接，WAL模式下不阻塞写入者。

### 批次

- 达到500个事件或距离上次刷新100毫秒时提交一个批次，以先到者为准。
- 一个事务同时写入事实事件、`session_users`、`session_metrics`和当前`metric_buckets`增量。
- `source_event_key`唯一冲突按重复事件处理，不增加任何摘要或统计。
- 每批事务成功后才向聚合与界面发布已经持久化的高水位。
- 事件队列最多保留20000条或5秒积压，以先达到的限制为准。

### 存储故障

数据库忙、磁盘写入失败或队列达到上限时：

1. 停止读取新的WebSocket业务消息并关闭连接。
2. 保留有界队列中的规范化事件。
3. 状态机进入`recovering`，打开原因是`storage`的数据缺口。
4. 每5秒执行一次最小写入探测。
5. 探测成功后先刷新积压批次，再重新连接直播间。

不能为了保持界面看似在线而继续接收却丢弃事件。磁盘空间不足等持久故障由界面明确提示，用户仍可结束会话。

## 数据库配置

每个连接必须启用：

```sql
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

写连接使用：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA auto_vacuum = INCREMENTAL;
```

- 新数据库在创建业务表前设置`auto_vacuum`。
- 活动采集期间定期执行被动WAL检查点。
- 会话结束或应用空闲时按文件大小阈值执行截断检查点。
- 不在WebSocket接收路径执行`VACUUM`、全文索引重建或大型删除。

## 数据库迁移

- 迁移文件按不可变整数版本排序，并记录名称与SHA-256校验值。
- 已应用迁移的内容和校验值不能修改。
- 启动时先比较应用支持版本和数据库版本。
- 升级前使用SQLite在线备份API创建一致性备份，保留最近两份迁移前备份。
- 每个迁移在事务中执行；失败后回滚并进入只读恢复界面，不启动采集。
- 应用版本低于数据库版本时拒绝写入，允许显示兼容性错误，不能尝试降级迁移。
- 迁移后执行外键检查、快速完整性检查、FTS行数校验和必要的投影重建。
- `PRAGMA user_version`与`schema_migrations`最高版本必须一致。

## 整场删除

删除只允许针对已经结束的历史会话。为避免100万条事件的一次大事务阻塞活动采集，使用可恢复的两阶段删除：

1. 小事务写入`sessions.deleted_at_ms`，历史查询立即隐藏该会话。
2. 后台清理器按每批最多5000行删除FTS内容和各子表数据，每批之间让出写连接。
3. 子表清空后删除`sessions`父行。
4. 应用崩溃后根据`deleted_at_ms`继续未完成清理。
5. 空闲时执行FTS优化和增量真空，回收空间。

删除开始后不能撤销。用户正在查看的会话被删除时，界面返回历史列表。逻辑删除完成代表产品层已经删除，物理文件空间回收可能稍后完成；第一版不承诺取证级安全擦除。

## 查询契约

### 历史列表

- 只读取`deleted_at_ms IS NULL`的终态会话。
- 关联`session_metrics`返回房间、开始与结束时间、终态、弹幕数、礼物和醒目留言金额、峰值热度及缺口摘要。
- 按`started_at_ms DESC, id DESC`键集分页，每页50场。

### 会话详情

- 首屏只读取会话快照、摘要、缺口和最近100条弹幕。
- 弹幕继续加载使用`received_at_ms, id`键集分页，每页100条。
- 礼物和醒目留言分别分页，不把三种事件做成昂贵的跨表联合时间线。
- 活跃用户直接读取`session_users`前20名。
- 高频词直接读取`session_keywords`前30项。

### 实时看板

- 当前总量、人数和峰值读取内存聚合快照。
- 最近30分钟趋势读取最多180个10秒桶，并叠加尚未刷新的当前桶。
- 界面只接收投影结果，不接收SQL行和数据库路径。

## 100万条约束与验收

使用脱敏合成数据建立单场100万条弹幕、礼物与热度混合样本，至少验证：

- 数据库文件和WAL不会无限增长。
- 持续写入期间接收队列没有超过有界限制。
- 历史首屏查询冷启动不超过500毫秒，热查询不超过200毫秒。
- 普通弹幕下一页热查询不超过200毫秒。
- 会话内中文关键词搜索前100条热查询不超过500毫秒，冷查询不超过1500毫秒。
- 活跃用户、高频词和会话摘要热查询不超过200毫秒。
- 删除请求在500毫秒内完成逻辑删除，后台物理清理可中断并恢复。
- 删除完成后业务表、FTS索引和投影都不再返回该会话。
- 从事实表重建`session_metrics`后结果与增量聚合一致。

生成器、测量命令、实测结果和12小时发布门槛见[高吞吐与实时聚合规格](./throughput-and-realtime-aggregation.md)。
