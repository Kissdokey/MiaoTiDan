# 秒提单 MiaoTiDan — 技术文档 (v3.2)

---

## 一、Chrome 浏览器插件项目结构说明

### 1.1 Manifest V3 基础

Chrome 扩展的核心入口是 `manifest.json`，它声明了插件的元信息、权限和各类脚本。当前业界标准是 **Manifest V3**（V2 已被 Chrome 逐步弃用）。

```
项目目录
├── manifest.json          # 插件清单（入口配置文件）
├── popup.html             # 弹窗页面（点击插件图标弹出的 UI）
├── popup.css              # 弹窗样式（深色科技感主题）
├── popup.js               # 弹窗逻辑（运行在 popup 的独立上下文中）
├── content.js             # 内容脚本（注入到目标网页中运行，核心策略引擎）
├── vendor/                # 第三方库（本地打包，CSP 要求）
│   ├── flatpickr.min.js
│   ├── flatpickr.min.css
│   ├── flatpickr-dark.css
│   └── flatpickr-zh.js
├── TECHNICAL_NOTES.md     # 本文档
└── README.md
```

### 1.2 manifest.json 核心字段

| 字段 | 作用 | 本项目值 |
|------|------|----------|
| `manifest_version` | 清单版本 | `3`（必须） |
| `name` / `version` | 插件名称和版本号 | `秒提单 MiaoTiDan` / `3.2.0` |
| `permissions` | 请求的 Chrome API 权限 | `storage`, `activeTab`, `tabs`, `scripting` |
| `host_permissions` | 允许注入的目标站点 | `*://*.taobao.com/*`, `*://*.tmall.com/*` |
| `action.default_popup` | 点击图标弹出的 HTML 页面 | `popup.html` |
| `content_scripts` | 自动注入到匹配页面的脚本 | `content.js`，在 `document_idle` 时注入 |

### 1.3 三种运行上下文

Chrome 扩展代码运行在 **三个相互隔离的环境** 中，理解这一点是开发扩展的关键：

```
┌────────────────────────────────────────────────────┐
│                    Chrome 浏览器                     │
│                                                     │
│  ┌─────────────┐   chrome.runtime    ┌───────────┐ │
│  │  Popup 页面  │ ◄═══════════════► │  Content   │ │
│  │  popup.js    │   .sendMessage()   │  Script    │ │
│  │  (独立上下文) │   .onMessage       │ content.js │ │
│  └──────┬──────┘                    └─────┬─────┘ │
│         │                                  │       │
│         │ chrome.storage.local             │       │
│         └──────────┬───────────────────────┘       │
│                    ▼                                │
│           ┌──────────────┐                         │
│           │  Storage 存储  │                        │
│           │  (持久化共享)   │                        │
│           └──────────────┘                         │
└────────────────────────────────────────────────────┘
```

#### (1) Popup 上下文（popup.js）

- **触发方式**：用户点击工具栏上的插件图标时打开。
- **生命周期**：弹窗打开时创建，**关闭即销毁**（不持久）。
- **能力**：拥有完整的 `chrome.*` API 访问权。
- **限制**：用户点击网页其他地方时弹窗自动关闭，所有 JS 状态丢失。
- **应对策略**：关键数据（选择器、任务状态）必须写入 `chrome.storage.local`，而非内存变量。

#### (2) Content Script 上下文（content.js）

- **触发方式**：Chrome 根据 `manifest.json` 中的 `matches` 规则自动注入到匹配页面。
- **生命周期**：随页面存在。页面刷新后会重新注入，但旧的 JS 状态丢失。
- **能力**：可以操作页面 DOM、监听页面事件、执行 `document.querySelector()` 等。
- **限制**：不能直接调用大部分 `chrome.*` API（仅 `chrome.runtime`、`chrome.storage` 等少数可用）。
- **通信**：通过 `chrome.runtime.sendMessage` / `chrome.runtime.onMessage` 与 Popup 互发消息。

#### (3) Background / Service Worker（本项目未使用）

- Manifest V3 中称为 Service Worker，常驻后台，适合做定时提醒、网络拦截等。
- 本项目的定时任务直接在 Content Script 中用高精度轮询实现，因此省略了 Background。

### 1.4 权限说明

| 权限 | 用途 |
|------|------|
| `storage` | 存取任务配置（选择器、目标时间、状态） |
| `activeTab` | 获取当前活跃标签页信息 |
| `tabs` | 查询标签页 URL、发送消息 |
| `scripting` | 动态注入 `content.js`（当页面打开早于插件安装/更新时，`content_scripts` 不会自动注入） |

### 1.5 CSP 限制

Chrome 扩展的 Popup 页面受到 **Content Security Policy** 约束：

- ❌ 不能使用 `<script src="https://cdn.xxx.com/...">` 加载外部脚本。
- ❌ 不能使用内联 `<script>` 或 `onclick="..."` 等内联事件。
- ✅ 只能引用**插件包内的本地文件**。

因此第三方库（如 Flatpickr）必须**下载到 `vendor/` 目录后本地引用**。

---

## 二、定时精度 — 三阶段递进调度策略

### 2.1 问题背景

浏览器中的定时器精度受多重因素影响：

| 因素 | 影响 |
|------|------|
| `setTimeout` 最小延迟 | 规范要求嵌套 ≥5 层时最小 4ms；后台标签页可降至 1000ms |
| 事件循环阻塞 | JS 单线程，若有长任务在执行，定时器回调会被推迟 |
| 系统时钟精度 | `Date.now()` 通常精确到 1ms，但操作系统调度会引入抖动 |
| 浏览器节能策略 | Chrome 对非活跃标签页会限制定时器频率 |

### 2.2 三阶段策略

```
时间轴 ──────────────────────────────────────────────► 触发时间
         │◄── Phase 0 ──►│◄── Phase 1 ──►│◄ Phase 2 ►│
         │   setTimeout   │  setInterval   │    RAF     │
         │   粗等待        │   1ms 轮询     │  紧逼循环   │
         │                │   + 预缓存DOM   │            │
                          ▲                ▲
                       T - 2s           T - 100ms
```

- **Phase 0**：`setTimeout` 粗等待，CPU 开销几乎为零。
- **Phase 1**：`setInterval(fn, 1)` 精细轮询，同时预缓存目标 DOM 元素。
- **Phase 2**：`requestAnimationFrame` 紧逼循环，每帧检查 `Date.now() >= triggerAt`，误差限制在一帧内（60Hz ≈ 16ms，144Hz ≈ 7ms）。

### 2.3 DOM 元素预缓存

```javascript
// Phase 1 阶段提前查询
cachedTarget = document.querySelector(task.selector);
cachedPaymentEl = document.querySelector(task.flashSale.paymentSelector);
```

在 Phase 1 提前缓存目标 DOM 元素，避免触发时刻的查询延迟（淘宝订单页 DOM 节点数可达数千，查询开销 2-5ms）。

---

## 三、抢购模式 — 校准双发策略 (v3.2)

### 3.1 核心问题

抢购场景下，提交按钮在开售时间 T-0 之前处于禁用状态。传统方案刷新页面会引入 1-3 秒的不可控延迟。

### 3.2 解决思路

**切换支付宝勾选** → 触发局部 AJAX 刷新（不刷新页面）→ 服务器返回最新订单状态 → 按钮变为可点击 → 立刻提交。

关键约束：
- 切换支付宝勾选最多 5 次（超过会触发人机检测）
- AJAX 往返约 120-180ms（实测）
- 需要让请求**恰好在 T-0 之后**到达服务器

### 3.3 五次点击预算分配

```
Phase 1 — 校准（2 次点击）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
T-3s     Click ① 取消勾选 → 测量 RTT₁
         Click ② 重新勾选 → 测量 RTT₂，恢复支付宝状态
         
         → 计算 RTT_min = min(RTT₁, RTT₂)
         → 计算 oneWay = RTT_min / 2

Phase 2 — 双发交叉（2 次点击）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
T-Xms    Click ③ 取消勾选（先手）
           X = oneWay - 10ms（安全余量）
           → 请求到达服务器 ≈ T + 10ms ← 刚过开售！
           
T-0 🔔   Click ④ 重新勾选（准点补发）
           → 请求到达服务器 ≈ T + oneWay ← 稳过开售！
           → 支付宝恢复勾选状态 ✅

Phase 3 — 应急兜底（1 次点击）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Click ⑤  仅当 ③④ 都未能触发提交时才使用
         → 在 max(RTT) + 200ms 后检查
         → 未提交则强制点击 + 补发切换
```

### 3.4 状态流转

```
初始:    支付宝 ✅（已勾选）
Click ①: ❌ 取消（校准）
Click ②: ✅ 勾回（校准完成，恢复）
Click ③: ❌ 取消（先手，T - oneWay + 10ms）
Click ④: ✅ 勾回（准点，T-0）← 最终状态正确！
         → AJAX 响应回来 → 提交按钮状态变化 → 立即点击
```

### 3.5 为什么准点放在 Click ④ 而不是 ⑤？

Click ④ 在 T-0 发射，请求在 T + oneWay 到达服务器。即使 Click ③ 到达过早（服务器还未开售），Click ④ 也能确保在开售后到达。

Click ⑤ 是**应急兜底**，在 ③④ 都失败后才触发，而不是等 ④ 的响应回来再发——那样太晚了。

---

## 四、RTT 测量 — 双源交叉校验

### 4.1 测量难点

切换支付宝勾选后，页面表现为：
1. 勾选状态变化（<10ms，点击自身的 UI 反馈）
2. 页面中间出现 loading 转圈（~10-30ms）
3. AJAX 请求飞行中...
4. loading 转圈消失，页面数据更新（~120-180ms）
5. 提交按钮状态**可能**变化（取决于是否已过开售时间）

其中步骤 1-2 是"噪声"，步骤 4 才是 AJAX 完成的信号。

### 4.2 双信号源架构

```
syntheticToggle(支付宝)
         │
         ├──── MutationObserver (Source A)
         │     监听 document.body 的 DOM 变化
         │     • <40ms 的变化 → 噪声，跳过
         │     • ≥40ms 的变化 → AJAX 响应信号
         │     • 20ms 静默确认 → DOM 稳定 → 记录 mutRTT
         │
         └──── PerformanceObserver (Source B)
               监听 Resource Timing API
               • 捕获 toggle 后第一个完成的 XHR/fetch
               • 记录 perfRTT（网络层时间）
               • 交叉校验 mutRTT
```

### 4.3 噪声过滤

```javascript
const RTT_NOISE_THRESHOLD_MS = 40;  // 跳过 <40ms 的 DOM 变化
const RTT_SETTLE_MS = 20;           // 20ms 静默 = DOM 稳定

// MutationObserver 回调中：
if (elapsed < RTT_NOISE_THRESHOLD_MS) return; // 跳过勾选动画/转圈出现
// ...
debounceTimer = setTimeout(() => {
  finish(mutRTT, "DOM变化");  // 转圈消失后 20ms 无变化 → 确认 AJAX 完成
}, RTT_SETTLE_MS);
```

为什么用 40ms：
- 点击事件本身的 UI 反馈（勾选动画）通常在 <10ms 内产生 DOM 变化
- loading 转圈出现通常在 10-30ms
- 40ms 阈值足以过滤这些噪声，而正常 AJAX RTT (120-180ms) 远大于此

### 4.4 交叉校验

两个信号源独立测量，日志中输出对比：

```
[MiaoTiDan][20:00:57.150] ✅ RTT = 148ms
   MutationObserver: 148ms (12次DOM变化)
   PerformanceObserver: 142ms
   📐 RTT交叉校验 | DOM: 148ms | 网络: 142ms | 差值: 6ms
```

差值通常 <10ms，说明两者一致。若差值过大，可能有其他 AJAX 请求干扰。

---

## 五、响应检测与提交

### 5.1 三重监控机制

Click ③④ 发射后，同时启动三种监控：

| 方法 | 原理 | 优势 |
|------|------|------|
| MutationObserver | 监听 DOM 变化（loading 转圈消失） | 最能反映页面可交互状态 |
| PerformanceObserver | 监听网络请求完成 | 直接捕获 AJAX 响应，不受 DOM 干扰 |
| 按钮状态轮询 (5ms) | `setInterval` 检查按钮是否变为可点击 | 兜底保障 |

### 5.2 立即点击策略

AJAX 响应到达后（任一监控检测到），**立即执行提交**：

```javascript
// 不等按钮自然变 enabled，直接 force-enable + 点击
if (task.flashSale?.forceEnable) forceEnableElement(el);
syntheticClick(el, false);
```

这样做的原因：
- 框架可能在 AJAX 响应后还需要额外时间更新按钮状态
- force-enable 直接移除 disabled 属性 + 修复 CSS
- 省掉等待框架渲染的时间（可能 10-50ms）

### 5.3 多次尝试

最多点击 3 次 (`MAX_SUBMIT_ATTEMPTS = 3`)，每次来源不同的信号触发：

```
第1次: AJAX响应(toggle+148ms)     ← MutationObserver 触发
第2次: 网络响应(toggle+142ms)     ← PerformanceObserver 触发
第3次: 按钮可点击(T+155ms)        ← 轮询触发
```

只要有一次成功，后续触发自动跳过。

---

## 六、合成点击事件

### 6.1 完整事件序列

```javascript
function syntheticClick(element) {
  element.scrollIntoView({ block: "center", behavior: "instant" });
  
  // 完整的指针事件序列（模拟真实用户操作）
  element.dispatchEvent(new PointerEvent("pointerdown", eventInit));
  element.dispatchEvent(new MouseEvent("mousedown", eventInit));
  element.dispatchEvent(new PointerEvent("pointerup", eventInit));
  element.dispatchEvent(new MouseEvent("mouseup", eventInit));
  element.dispatchEvent(new MouseEvent("click", eventInit));
  
  // 兜底：原生 click()
  element.click();
}
```

淘宝/天猫使用 React 框架，可能监听 `pointerdown`、`mousedown` 等事件。完整的事件序列能最大程度模拟真实点击。

### 6.2 事件参数

所有事件携带真实的坐标信息（`clientX/Y`, `screenX/Y`），计算自元素中心点，进一步模拟真人行为。

---

## 七、日志体系

### 7.1 日志格式

```
[MiaoTiDan][HH:MM:SS.mmm][T±Nms] 消息内容
```

- **绝对时间**：`HH:MM:SS.mmm` — 便于和服务器时间对比
- **T-0 偏移**：`T-3000ms` 或 `T+76ms` — 所有时间以目标时间为锚点

### 7.2 关键日志节点

| 阶段 | 日志内容 |
|------|----------|
| 启动 | 提交按钮/支付复选框缓存状态、目标时间、距目标时间 |
| 校准 Click ①② | RTT₁/RTT₂ 值、MutationObserver/PerformanceObserver 交叉校验、oneWay 计算 |
| 双发计算 | Click ③/④ 的预计发射时刻、预计到达服务器时刻、预计响应回到浏览器时刻 |
| Click ③ 发射 | 实际发射时间、与预计的偏差 |
| Click ④ 发射 | 实际发射时间、与预计的偏差 |
| 响应检测 | AJAX 响应到达时间（toggle 后 Nms）、T-0 后 Nms |
| 网络请求 | URL、请求耗时、toggle 后偏移 |
| 提交点击 | 第 N/3 次尝试、来源、距 T-0 偏移 |
| 任务完成 | 总点击次数、最终延迟 |

### 7.3 测试模式日志

使用「🧪 测试切换」按钮时，会输出完整的 RTT 测量结果表格：

```
[MiaoTiDan] ┌─────────────────────────────────────────┐
[MiaoTiDan] │  📊 测试结果:                           │
[MiaoTiDan] │    RTT₁ = 148   ms (取消勾选)           │
[MiaoTiDan] │    RTT₂ = 140   ms (重新勾选)           │
[MiaoTiDan] │    RTT_min = 140 ms                     │
[MiaoTiDan] │    oneWay  = 70  ms                     │
[MiaoTiDan] │  🎯 预计提交延迟:                       │
[MiaoTiDan] │    先手Click③ 到点后 ≈ +80  ms 收到响应 │
[MiaoTiDan] │    准点Click④ 到点后 ≈ +140 ms 收到响应 │
[MiaoTiDan] └─────────────────────────────────────────┘
```

---

## 八、精度参考

### 8.1 三阶段定时精度（普通模式）

| 显示器刷新率 | 理论最大误差 | 实测典型误差 |
|-------------|-------------|-------------|
| 60 Hz  | ~16.7ms | 5-15ms |
| 144 Hz | ~6.9ms  | 2-7ms  |
| 240 Hz | ~4.2ms  | 1-5ms  |

### 8.2 抢购模式预计延迟

假设 RTT 实测 120-180ms：

| 指标 | 值 |
|------|-----|
| RTT_min | 120ms |
| oneWay | 60ms |
| Click ③ 请求到达服务器 | T + 10ms |
| Click ③ 响应回到浏览器 | T + 70ms |
| **最快提交时间** | **≈ T + 71ms** |
| Click ④ 请求到达服务器 | T + 60ms |
| Click ④ 响应回到浏览器 | T + 120ms |
| 兜底提交时间 | ≈ T + 121ms |

对比刷新页面（1-3 秒），**快了 10-40 倍**。

---

## 附录：关键数据流

```
用户操作流程 (v3.2)
═══════════════════

1. 选择提交按钮
   popup.js ──sendMessage("START_PICKER", {target:"submit"})──► content.js
   content.js: 监听 mousemove/click → 生成 CSS 选择器
   content.js ──chrome.storage.local.set()──► 持久化
   content.js ──sendMessage("SELECTOR_PICKED")──► popup.js

2. 选择支付宝复选框（抢购模式）
   popup.js ──sendMessage("START_PICKER", {target:"payment"})──► content.js
   同上流程，选择器存入 task.flashSale.paymentSelector

3. 测试切换（验证选择 + RTT 测量）
   popup.js ──sendMessage("TEST_PAYMENT_TOGGLE")──► content.js
   content.js: 双源 RTT 测量 → console 输出结果表格

4. 设置时间 + 启动定时
   popup.js: Flatpickr 选时间 + 毫秒微调 → triggerAt 时间戳
   popup.js ──chrome.storage.local.set({ armed: true })──► 持久化
   popup.js ──sendMessage("ARM_TASK")──► content.js

5a. 普通模式 → 三阶段调度
   content.js: Phase 0 → Phase 1 → Phase 2 → syntheticClick

5b. 抢购模式 → 校准双发策略
   content.js:
     T-3s:    校准 Click ①② → 测 RTT → 计算 oneWay
     T-Xms:   Click ③ 先手取消勾选
     T-0:     Click ④ 准点重新勾选
     响应到达: MutationObserver/PerformanceObserver/轮询 → 立即点击提交
     兜底:    Click ⑤ 应急

6. 结果持久化
   content.js ──chrome.storage.local.set({ lastResult })──► 持久化
   popup.js: onChanged 监听 → 更新 UI 状态
```
