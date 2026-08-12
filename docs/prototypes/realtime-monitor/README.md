# 实时监控界面原型

这是一次性界面验证，不是正式Electron渲染进程代码。

打开：

```bash
open 'file:///Users/songjinzhao/Desktop/workspace/%E5%BC%B9%E5%B9%95%E7%9C%8B%E6%9D%BF/docs/prototypes/realtime-monitor/index.html?variant=A&state=collecting'
```

方案：

- `?variant=A`：左右并列，左侧实时弹幕，右侧实时看板。
- `?variant=B`：弹幕舞台，弹幕作为主要工作区。
- `?variant=C`：信号时间轴，趋势和会话摘要优先。

场景：

- `state=collecting`
- `state=waiting`
- `state=recovering`
- `state=risk`
- `state=idle`

其他参数：

- `view=live|history`
- `pane=feed|dashboard`，用于窄窗口实时页。
- `historyPane=list|detail`，用于窄窗口历史页。

页面底部的原型控制条或键盘左右方向键可以切换方案。正式实现采用方案A，吸收方案B的弹幕可读性和方案C的数据缺口标记。
