# 高吞吐与实时聚合原型

这是一次性逻辑原型，不是生产代码。

它验证的问题是：单写SQLite worker、500条或100毫秒批次、固定容量实时投影和节流后的renderer载荷，能否在主进程持续接收事件时保持队列和内存有界，并满足每秒200条、单场100万条和12小时运行的验收设计。

原型使用Node内置实验性SQLite驱动，只验证数据结构、事务策略、worker隔离和性能数量级。正式实现仍需使用最终Electron版本和最终SQLite驱动重复同一套基准。

## 一条命令运行

快速检查：

```bash
node --disable-warning=ExperimentalWarning docs/prototypes/throughput/benchmark.mjs --profile smoke
```

100万条容量验证：

```bash
node --disable-warning=ExperimentalWarning docs/prototypes/throughput/benchmark.mjs --profile million
```

持续200条/秒，默认10分钟：

```bash
node --disable-warning=ExperimentalWarning docs/prototypes/throughput/benchmark.mjs --profile sustained
```

12小时运行：

```bash
node --disable-warning=ExperimentalWarning docs/prototypes/throughput/benchmark.mjs --profile soak
```

`soak`默认每秒20条，每15分钟加入1分钟的每秒200条负载。可使用`--duration-seconds`和`--rate`缩短本地试跑。数据库默认建在系统临时目录并在结束后删除；加`--keep-db`可保留明确打印出的临时数据库。

## 输出

终端会持续显示当前事件数、队列深度、写入速度和内存。结束时输出JSON摘要，包含：

- 事实表、FTS和投影计数校验。
- 批次提交延迟与总吞吐。
- 主线程事件循环延迟和最大接收队列。
- SQLite、WAL和检查点后的文件大小。
- 最近500条、180个趋势桶、200条待推送上限和IPC载荷大小。
- 新连接查询和热查询耗时。
- 持续运行时的内存变化斜率。

真正的冷启动查询需要在重启macOS后运行正式应用，原型中的`freshConnectionMs`只代表新SQLite连接，不能冒充操作系统冷缓存。

