<div align="center">

# ⚡ 秒提单 MiaoTiDan

### Taobao / Tmall 定时自动提交订单 Chrome 扩展

**Timed Auto-Submit Chrome Extension for Taobao / Tmall Order Pages**

[![Chrome Extension](https://img.shields.io/badge/Platform-Chrome%20Extension-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Version](https://img.shields.io/badge/Version-3.2.0-blue)](./manifest.json)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![JavaScript](https://img.shields.io/badge/JavaScript-Vanilla-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)

[功能特性](#-功能特性--features) •
[快速开始](#-快速开始--quick-start) •
[使用指南](#-使用指南--usage-guide) •
[抢购模式](#-抢购模式--flash-sale-mode) •
[技术架构](#-技术架构--architecture) •
[常见问题](#-常见问题--faq)

---

**秒提单** 是一款 Chrome 浏览器扩展，可在淘宝/天猫订单确认页面实现**毫秒级精准定时自动点击提交按钮**，适用于限时抢购、定时开售等场景。

*MiaoTiDan is a Chrome extension that enables **millisecond-precision timed auto-click** on the submit button of Taobao/Tmall order confirmation pages — ideal for flash sales and timed product drops.*

</div>

---

## 📑 目录 / Table of Contents

- [功能特性 / Features](#-功能特性--features)
- [快速开始 / Quick Start](#-快速开始--quick-start)
- [使用指南 / Usage Guide](#-使用指南--usage-guide)
- [抢购模式 / Flash Sale Mode](#-抢购模式--flash-sale-mode)
- [技术架构 / Architecture](#-技术架构--architecture)
- [项目结构 / Project Structure](#-项目结构--project-structure)
- [常见问题 / FAQ](#-常见问题--faq)
- [免责声明 / Disclaimer](#-免责声明--disclaimer)
- [贡献指南 / Contributing](#-贡献指南--contributing)

---

## ✨ 功能特性 / Features

| 功能 | Feature | 描述 / Description |
|:---:|:---:|:---|
| 🎯 | **可视化选择器** / Visual Selector | 在页面上直接点击选取提交按钮，自动生成 CSS 选择器 <br> *Click on the page to pick the submit button; CSS selector is auto-generated* |
| ⏱️ | **毫秒级定时** / Millisecond Timing | 支持精确到毫秒的本地时间设定，三阶段递进式定时策略 <br> *Set trigger time down to the millisecond with a 3-phase progressive timing strategy* |
| 🔥 | **抢购模式** / Flash Sale Mode | 针对定时开售场景的专用策略：校准 RTT → 切换支付方式 → 监听按钮解锁 → 极速提交 <br> *Dedicated strategy for timed sales: calibrate RTT → toggle payment → watch for button unlock → instant submit* |
| 💳 | **支付方式切换** / Payment Toggle | 自动切换支付宝复选框以触发页面局部刷新，解锁提交按钮 <br> *Auto-toggle Alipay checkbox to trigger partial page refresh and unlock the submit button* |
| 🔓 | **强制解锁按钮** / Force Enable | 移除提交按钮的 `disabled` 属性和灰显样式 <br> *Strip `disabled` attribute and grayed-out styles from the submit button* |
| 👀 | **DOM 状态监听** / DOM Watcher | MutationObserver 实时监控按钮状态变化，状态一变立即点击 <br> *MutationObserver watches for button state changes and clicks immediately upon unlock* |
| 🧪 | **测试点击** / Test Click | 一键模拟点击验证选择器是否正确 <br> *One-click simulated click to verify selector accuracy* |
| ⏳ | **实时倒计时** / Live Countdown | 可视化倒计时面板，精确显示剩余时/分/秒/毫秒 <br> *Visual countdown panel showing remaining hours, minutes, seconds, and milliseconds* |
| 💾 | **自动保存** / Auto Persistence | 任务配置自动保存至 `chrome.storage.local`，刷新不丢失 <br> *Task config auto-saved to `chrome.storage.local`; survives page refreshes* |

---

## 🚀 快速开始 / Quick Start

### 环境要求 / Prerequisites

- **Google Chrome** 88+ (支持 Manifest V3 / *Manifest V3 support required*)
- 操作系统不限 / *Any OS (Windows, macOS, Linux)*

### 安装步骤 / Installation

```
1. 下载或克隆本仓库 / Clone or download this repository
   git clone https://github.com/your-username/taobao-auto-submit-extension.git

2. 打开 Chrome 浏览器，地址栏输入 / Open Chrome and navigate to:
   chrome://extensions/

3. 开启右上角「开发者模式」/ Enable "Developer mode" (top-right toggle)

4. 点击「加载已解压的扩展程序」/ Click "Load unpacked"

5. 选择本项目文件夹 / Select this project folder
```

> **💡 提示 / Tip:** 安装完成后，建议将扩展固定到工具栏以便快速访问。
> *After installation, pin the extension to the toolbar for quick access.*

---

## 📖 使用指南 / Usage Guide

### 基本模式 / Basic Mode

适用于提交按钮始终可点击的普通场景。
*For normal scenarios where the submit button is always clickable.*

```
步骤 1 ─ 打开淘宝/天猫订单确认页面
Step 1 ─ Open the Taobao/Tmall order confirmation page

步骤 2 ─ 点击浏览器工具栏中的「秒提单」图标，打开弹出面板
Step 2 ─ Click the MiaoTiDan icon in the toolbar to open the popup

步骤 3 ─ 点击 🎯「选择按钮」，然后在页面上点击提交订单按钮
Step 3 ─ Click 🎯 "选择按钮", then click the submit button on the page

步骤 4 ─ 设置 ⏱️「提交时间」（精确到毫秒）
Step 4 ─ Set ⏱️ trigger time (down to millisecond precision)

步骤 5 ─ 点击 🚀「启动定时」
Step 5 ─ Click 🚀 "启动定时" to arm the task

步骤 6 ─ 保持页面打开，等待自动执行
Step 6 ─ Keep the page open and wait for auto-execution
```

> **⚠️ 注意 / Important:**
> - 任务启动后请勿关闭或刷新订单页面 / *Do not close or refresh the order page after arming.*
> - 可随时点击 ⛔「取消任务」中止 / *Click ⛔ "取消任务" to abort at any time.*

### 定时策略 / Timing Strategy

扩展采用 **三阶段递进式定时** 以确保毫秒级精度：

*The extension uses a **3-phase progressive timing** approach for millisecond accuracy:*

| 阶段 / Phase | 触发条件 / Trigger | 机制 / Mechanism |
|:---:|:---|:---|
| **Phase 1** | T−2s 之前 / Before T−2s | `setTimeout` 粗粒度等待 / *Coarse wait* |
| **Phase 2** | T−2s → T−100ms | `setInterval(1ms)` 中粒度轮询 / *Medium-grain polling* |
| **Phase 3** | T−100ms → T | `requestAnimationFrame` 逐帧检测 / *Frame-by-frame detection* |

---

## 🔥 抢购模式 / Flash Sale Mode

专为定时开售场景设计——到点前提交按钮处于禁用状态，需要主动触发页面刷新才能解锁。

*Designed for timed sales where the submit button is disabled until the sale starts — requires an active page refresh trigger to unlock.*

### 启用方法 / How to Enable

1. 在弹出面板中勾选 **「启用抢购模式」**  
   *Check **"启用抢购模式"** in the popup panel*

2. 点击 💳 **「选择支付复选框」**，在页面上选取支付宝的复选框元素  
   *Click 💳 **"选择支付复选框"** and pick the Alipay checkbox element on the page*

3. 根据需要开启/关闭以下选项：  
   *Toggle the following options as needed:*

| 选项 / Option | 默认 / Default | 说明 / Description |
|:---|:---:|:---|
| 切换支付方式刷新 | ✅ 开启 | 到点时取消勾选 → 重新勾选支付宝，触发局部刷新 <br> *Uncheck → recheck Alipay at trigger time to force a partial refresh* |
| 强制解锁按钮 | ✅ 开启 | 移除 `disabled` 属性和灰显样式 <br> *Remove `disabled` attr and grayed-out styles* |
| 按钮状态监听 | ✅ 开启 | MutationObserver 监听按钮变化，一旦解锁立即点击 <br> *MutationObserver watches button; clicks immediately upon unlock* |

### 抢购策略流程 / Flash Sale Strategy Flow

```
T−3s    ┌─────────────────────────────────────┐
        │ Click ① ② 校准切换 (Calibration)     │
        │ → 测量 RTT，计算 oneWay ≈ RTT/2      │
        └──────────────┬──────────────────────┘
                       │
T−oneWay+10ms          ▼
        ┌─────────────────────────────────────┐
        │ Click ③ 取消勾选支付宝 (Uncheck)      │
        └──────────────┬──────────────────────┘
                       │
T (目标时间)            ▼
        ┌─────────────────────────────────────┐
        │ Click ④ 重新勾选支付宝 (Recheck)      │
        │ → 触发页面局部刷新                     │
        └──────────────┬──────────────────────┘
                       │
        ┌──────────────▼──────────────────────┐
        │ 三重检测 (Triple Detection)            │
        │  • MutationObserver 监听 DOM 变化     │
        │  • PerformanceObserver 监听网络响应    │
        │  • 定时轮询 (Polling)                  │
        │ → 一旦按钮可点击，立即 doSubmitClick   │
        └──────────────┬──────────────────────┘
                       │
T+RTT+200ms            ▼
        ┌─────────────────────────────────────┐
        │ Click ⑤ 安全兜底 (Safety Net)         │
        └─────────────────────────────────────┘
```

---

## 🏗️ 技术架构 / Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Chrome Extension (MV3)                │
├─────────────┬───────────────────────┬───────────────────┤
│  Popup UI   │   Background (SW)     │  Content Script   │
│  popup.html │   (service worker)    │  content.js       │
│  popup.js   │                       │                   │
│  popup.css  │   chrome.storage ◄────┤  Timing Engine    │
│             │   chrome.scripting    │  Flash Sale Logic  │
│  Flatpickr  │   chrome.tabs        │  Element Picker    │
│  (vendor/)  │                       │  Synthetic Events  │
└─────────────┴───────────────────────┴───────────────────┘
        ▲               ▲                      ▲
        │               │                      │
        └───── chrome.runtime.sendMessage ─────┘
              chrome.storage.onChanged
```

### 核心技术 / Key Technologies

| 技术 / Technology | 用途 / Purpose |
|:---|:---|
| **Manifest V3** | Chrome 扩展框架 / *Chrome extension framework* |
| **chrome.storage.local** | 任务持久化存储 / *Task persistence* |
| **chrome.scripting** | 动态注入内容脚本 / *Dynamic content script injection* |
| **MutationObserver** | DOM 变化检测 / *DOM change detection* |
| **PerformanceObserver** | 网络请求监测 / *Network request monitoring* |
| **requestAnimationFrame** | 高精度定时 / *High-precision timing* |
| **Flatpickr** | 日期时间选择器 / *Date & time picker UI* |

---

## 📁 项目结构 / Project Structure

```
taobao-auto-submit-extension/
├── manifest.json           # 扩展配置 / Extension manifest (MV3)
├── content.js              # 内容脚本：定时引擎 + 抢购策略 + 元素选择器
│                           # Content script: timing engine + flash sale + picker
├── popup.html              # 弹出面板 HTML / Popup panel HTML
├── popup.js                # 弹出面板逻辑 / Popup logic & messaging
├── popup.css               # 弹出面板样式 / Popup styles
├── vendor/
│   ├── flatpickr.min.js    # Flatpickr 日期选择器 / Date picker library
│   ├── flatpickr.min.css   # Flatpickr 基础样式 / Base styles
│   ├── flatpickr-dark.css  # Flatpickr 暗色主题 / Dark theme
│   └── flatpickr-zh.js     # Flatpickr 中文本地化 / Chinese locale
├── TECHNICAL_NOTES.md      # 技术设计文档 / Technical design document
└── README.md               # 本文件 / This file
```

---

## ❓ 常见问题 / FAQ

<details>
<summary><b>Q: 选择器捕获后页面刷新了，还能用吗？</b> / <i>Will the saved selector still work after a page refresh?</i></summary>

**A:** 可以。选择器保存在 `chrome.storage.local` 中，页面刷新后自动恢复。但如果淘宝更新了页面 DOM 结构，可能需要重新选择。

*Yes. The selector is persisted in `chrome.storage.local` and auto-restores after refresh. However, if Taobao updates the DOM structure, you may need to re-pick.*
</details>

<details>
<summary><b>Q: 为什么点击没有生效？</b> / <i>Why didn't the click work?</i></summary>

**A:** 常见原因：
1. 选择器已失效（页面 DOM 变化）→ 重新选择按钮
2. 页面未完全加载 → 等待加载完成后再启动
3. 淘宝反自动化检测 → 尝试启用抢购模式的「强制解锁按钮」

*Common causes:*
1. *Stale selector (DOM changed) → Re-pick the button*
2. *Page not fully loaded → Wait for full load before arming*
3. *Anti-automation detection → Try enabling "Force Enable" in Flash Sale mode*
</details>

<details>
<summary><b>Q: 支持手机淘宝吗？</b> / <i>Does it work on Taobao mobile app?</i></summary>

**A:** 不支持。本扩展仅适用于桌面版 Chrome 浏览器访问的淘宝/天猫网页版。

*No. This extension only works with the desktop Chrome browser on the web version of Taobao/Tmall.*
</details>

<details>
<summary><b>Q: 可以同时对多个页面设置定时吗？</b> / <i>Can I set timers on multiple pages simultaneously?</i></summary>

**A:** 当前版本使用单一全局任务。同时只能有一个活跃的定时任务。

*The current version uses a single global task. Only one active timed task at a time.*
</details>

<details>
<summary><b>Q: 时间精度怎么样？</b> / <i>How accurate is the timing?</i></summary>

**A:** 通过三阶段递进式定时策略，实际触发误差通常在 **±5ms** 以内（取决于系统负载和浏览器调度）。

*With the 3-phase progressive timing strategy, actual trigger deviation is typically within **±5ms** (depending on system load and browser scheduling).*
</details>

---

## ⚠️ 免责声明 / Disclaimer

> **中文：** 本扩展仅供学习和技术研究使用。使用本工具进行的任何操作均由用户自行承担责任。请遵守淘宝/天猫平台的用户协议和相关法律法规。开发者不对因使用本工具而导致的任何账号风险、经济损失或法律问题承担责任。
>
> **English:** This extension is provided for educational and technical research purposes only. Users assume full responsibility for any actions performed using this tool. Please comply with Taobao/Tmall platform user agreements and applicable laws and regulations. The developer assumes no liability for any account risks, financial losses, or legal issues resulting from the use of this tool.

---

## 🤝 贡献指南 / Contributing

欢迎提交 Issue 和 Pull Request！

*Issues and Pull Requests are welcome!*

1. **Fork** 本仓库 / *Fork this repository*
2. 创建功能分支 / *Create a feature branch:* `git checkout -b feature/awesome-feature`
3. 提交更改 / *Commit changes:* `git commit -m 'Add awesome feature'`
4. 推送分支 / *Push to branch:* `git push origin feature/awesome-feature`
5. 提交 PR / *Open a Pull Request*

### 开发建议 / Development Tips

- 本项目为纯 Vanilla JS，无需构建工具 / *Pure Vanilla JS — no build tools required*
- 修改 `content.js` 后需在 `chrome://extensions/` 刷新扩展 / *After editing `content.js`, reload the extension at `chrome://extensions/`*
- 修改 `popup.*` 文件后关闭再重新打开弹出面板即可 / *After editing `popup.*`, close and reopen the popup*

---

## 📜 更新日志 / Changelog

### v3.2.0
- 新增抢购模式（Flash Sale Mode），支持校准 RTT 双击策略
- 新增支付方式切换自动刷新
- 新增 MutationObserver + PerformanceObserver 三重检测
- 新增强制解锁按钮功能

### v3.0.0
- 升级至 Manifest V3 架构
- 全新 UI 设计，暗色主题
- 新增 Flatpickr 日期时间选择器
- 新增毫秒微调输入
- 新增实时倒计时面板

---

<div align="center">

**如果觉得有用，请给个 ⭐ Star！**

**If you find this useful, please give it a ⭐ Star!**

Made with ❤️ for the Taobao shopping community

</div>
