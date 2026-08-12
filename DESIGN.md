---
name: 弹幕看板
description: 以原创棱镜折射为视觉线索的本地直播观察工具
colors:
  canvas: "#0a090c"
  panel: "#111014"
  panel-raised: "#17151a"
  surface: "#1d1a20"
  line: "#2a272e"
  line-strong: "#45404a"
  text: "#f1eee8"
  text-muted: "#aba59d"
  text-faint: "#88817a"
  action: "#eeeae3"
  danger: "#e56b61"
  warning: "#d8b25c"
  spectrum-red: "#e85955"
  spectrum-orange: "#ef8b45"
  spectrum-yellow: "#e9cf63"
  spectrum-green: "#79b875"
  spectrum-blue: "#63a9ce"
  spectrum-violet: "#9a7bc7"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, HarmonyOS Sans SC, MiSans, Microsoft YaHei, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.6
  data:
    fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  small: "4px"
  medium: "8px"
spacing:
  compact: "8px"
  standard: "16px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.small}"
    height: "44px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.small}"
    height: "44px"
---

# Design System: 弹幕看板

## Overview

**Creative North Star:「折射中的现场」**

界面像一张克制的黑胶唱片内页：大面积哑光近黑、温暖的灰白文字、细线排版，以及一束从信息中穿过的光谱。棱镜和光谱只出现在品牌标记、空状态和趋势数据等有明确意义的位置，不能成为随处发光的装饰。

整体采用产品UI的Operate模式。数据、状态和标准控件优先，艺术感来自构图、留白和几何关系，而不是陌生交互。

**Key Characteristics:**

- 平面、低饱和、无网格背景。
- 大区域靠明度和留白分层，边线保持细而克制。
- 光谱优先作为连续整体使用；实时看板允许把同一束光按固定顺序分配给相邻指标，不能随机散落或改变顺序。
- 时间与数字可使用等宽字体，标题、控件和正文使用中文系统无衬线字体。

## Colors

中性色承担绝大多数界面面积，光谱颜色服务折射图形、趋势数据和看板类别辨识。

### Primary

- **温灰白行动色**：用于主要按钮、重点数字和键盘焦点附近的高对比反馈。

### Secondary

- **完整折射光谱**：红、橙、黄、绿、蓝、紫必须以连续次序出现。单独状态色不得假借光谱含义。

### Neutral

- **唱片黑**：页面背景。
- **石墨层**：工作区、输入框和浮层。
- **暖灰文字**：主文字、说明文字和弱化信息按三级明度区分。

### Named Rules

**The One Spectrum Rule.** 光谱每个视区只允许形成一个主要视觉运动。统计矩阵必须按红、橙、黄、绿、蓝、紫的阅读顺序分配弱底色与数字颜色，不能使用独立彩色描边，也不能把颜色随机分配给无关组件。

## Typography

**Body Font:** macOS中文系统无衬线字体栈。

**Label/Mono Font:** SFMono与Menlo，只用于时间、计数和机器可读编号。

**Character:** 中文界面平静、清楚，靠字号和留白建立层级。英文不再承担科技气氛。

### Hierarchy

- **Title**：页面和区域标题，字重650，禁止伪斜体与负字距。
- **Body**：弹幕、说明与操作文案，最长说明控制在约70个字符宽度。
- **Label**：栏目标签使用中文小字号，不使用全大写英文眉题。
- **Data**：时间和数值使用等宽数字并右对齐。

## Layout

宽窗口继续使用左侧弹幕、右侧看板的双栏结构，左侧保留更大阅读面积。顶栏、导航和采集控制形成连续的水平编辑版面。右侧指标从独立卡片改为共享分隔线的统计矩阵，趋势和排行按内容自然分区。

760px以下保留弹幕与看板页签，520px以下统计改为单列。字号使用固定阶梯，响应式变化只调整结构和间距。

## Elevation & Depth

默认界面保持平面，不使用霓虹外发光或玻璃模糊。层级通过近黑明度变化、细分隔线和留白表达。只有删除确认浮层使用向下偏移的柔和阴影。

**The Flat Sleeve Rule.** 静止界面像印刷唱片内页，阴影只在真正离开页面平面的浮层上出现。

## Shapes

控件使用4px小圆角，大区域不做漂浮圆角卡片。原创棱镜图形使用锐角三角形、单线入射光和连续平行光谱，装饰线不得压住文字。

## Components

### Buttons

- **Shape:** 小圆角矩形。
- **Primary:** 暖灰白底配唱片黑文字；hover只改变明度并轻微位移。
- **Secondary:** 透明或石墨底，依靠文字和细边线表达。
- **Focus:** 2px清晰轮廓，不只依赖颜色变化。

### Inputs / Fields

- **Style:** 哑光石墨背景、细边线、小圆角。
- **Focus:** 边线变亮，不使用光晕。
- **Error / Disabled:** 错误同时使用文字与边线，禁用保持足够对比度。

### Navigation

导航保持标准标签结构。当前页面使用一条细光谱作为底线，hover只提升文字明度。

### Prism Signature

小尺寸用于品牌标记，大尺寸用于实时弹幕空状态。它不承载按钮行为，也不与文字重叠。实时趋势通过同序光谱柱状延续这一签名。

### Dashboard Spectrum

- 六项统计按红、橙、黄、绿、蓝、紫顺序排列，使用弱底色、短横线和数字颜色共同区分。
- 30分钟趋势从左到右按时间分成六个连续色段，缺口仍使用红色虚线和文字图例。
- 高频词使用暖色，活跃用户使用冷色；栏目标题、左右位置与文字标签继续提供非颜色提示。
- 光谱颜色不能覆盖说明文字，正文和辅助文字继续使用暖灰分级。

## Do's and Don'ts

### Do:

- **Do**把光谱作为一束连续、可追踪的视觉线索。
- **Do**用暖灰白与石墨色维持长时间观看舒适度。
- **Do**保留标准按钮、输入框、页签、列表和对话框行为。

### Don't:

- **Don't**使用网格背景、荧光绿描边、HUD标签或无意义等宽英文。
- **Don't**复刻任何具体专辑封面的构图、文字、标志或比例。
- **Don't**把每块数据包进独立的发光圆角卡片。
- **Don't**让装饰图形与中文标题、说明或弹幕正文重叠。
