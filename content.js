/**
 * MiaoTiDan Content Script v3.2
 * =============================
 * Flash-sale strategy: Calibrated Double-Tap with RTT Cross-Validation
 *
 * 5-click budget:
 *   Click ①② (T-3s)  : Calibration — measure RTT via MutationObserver + PerformanceObserver
 *   Click ③  (T-Xms)  : Pre-fire uncheck — request arrives server ~T+10ms
 *   Click ④  (T-0)    : Precision recheck — request arrives server ~T+oneWay
 *   Click ⑤  (safety) : Emergency retry after max(RTT) if ③④ didn't enable button
 *
 * RTT Measurement (dual-source):
 *   Source A — MutationObserver on document.body:
 *     Catches loading spinner lifecycle (appear=noise <40ms, disappear=AJAX done).
 *     Uses debounce (20ms quiet) to confirm DOM settled.
 *   Source B — PerformanceObserver (resource timing):
 *     Catches actual XHR/fetch response timing from the browser's network stack.
 *     Cross-validates MutationObserver measurement.
 *
 * Response Detection (post-toggle at T-0):
 *   After toggle AJAX returns (spinner gone), immediately try clicking submit
 *   with force-enable — don't wait for the framework to update button state,
 *   because that may add extra delay.
 */

const STORAGE_KEY = "autoSubmitTask";

// ─── Timing Constants ───
const PHASE1_THRESHOLD_MS = 2000;
const PHASE2_THRESHOLD_MS = 100;
const CALIBRATION_LEAD_MS = 3000;     // Start calibration 3s before T
const RTT_NOISE_THRESHOLD_MS = 40;    // Ignore DOM changes faster than this (click UI feedback)
const RTT_SETTLE_MS = 20;             // DOM quiet period = AJAX cycle done
const DEFAULT_RTT_MS = 150;           // Fallback if calibration fails
const SAFETY_MARGIN_MS = 10;          // Ensure request arrives AFTER T-0
const BUTTON_POLL_INTERVAL_MS = 5;
const BUTTON_POLL_TIMEOUT_MS = 15000;
const MAX_SUBMIT_ATTEMPTS = 3;

// ─── State ───
let taskTimer = null;
let taskInterval = null;
let taskRaf = null;
let cachedTarget = null;
let cachedPaymentEl = null;
let currentTask = null;
let pickerEnabled = false;
let pickerTarget = "submit";
let hoverElement = null;
let cleanupPicker = null;
let domObserver = null;
let buttonPollTimer = null;
let flashTimers = [];
let submitClickDone = false;
let submitAttempts = 0;
let lastToggleClickTime = 0;    // performance.now() of last toggle click
let lastToggleDateNow = 0;      // Date.now() of last toggle click

// ─── Calibration ───
let calibration = {
  samples: [],       // { mutRTT, perfRTT, source }
  rttMin: DEFAULT_RTT_MS,
  oneWay: Math.round(DEFAULT_RTT_MS / 2),
};

// ══════════════════════════════════════════
// Logging — all entries show absolute time + offset from T-0
// ══════════════════════════════════════════
function log(task, ...args) {
  const now = Date.now();
  const abs = new Date(now);
  const absStr = `${String(abs.getHours()).padStart(2,"0")}:${String(abs.getMinutes()).padStart(2,"0")}:${String(abs.getSeconds()).padStart(2,"0")}.${String(abs.getMilliseconds()).padStart(3,"0")}`;
  let prefix = `[MiaoTiDan][${absStr}]`;
  if (task?.triggerAt) {
    const rel = now - task.triggerAt;
    const sign = rel < 0 ? "" : "+";
    prefix += `[T${sign}${rel}ms]`;
  }
  console.log(prefix, ...args);
}

// ══════════════════════════════════════════
// Selector persistence
// ══════════════════════════════════════════
async function savePickedSelector(selector, text, target) {
  const old = await chrome.storage.local.get(STORAGE_KEY);
  const task = old[STORAGE_KEY] || {};

  if (target === "payment") {
    if (!task.flashSale) task.flashSale = {};
    task.flashSale.paymentSelector = selector;
    task.flashSale.paymentPickedText = text || "";
  } else {
    task.selector = selector;
    task.pickedText = text || "";
    task.pickedAt = Date.now();
    if (task.armed) {
      task.armed = false;
      task.lastResult = "已重新选择按钮，请重新启动定时任务";
    }
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: task });
}

// ══════════════════════════════════════════
// CSS Selector generator
// ══════════════════════════════════════════
function getElementCssSelector(element) {
  if (!(element instanceof Element)) return "";
  if (element.id) return `#${CSS.escape(element.id)}`;

  const path = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let selector = current.nodeName.toLowerCase();
    if (current.classList.length > 0) {
      selector += `.${Array.from(current.classList).slice(0, 2).map((c) => CSS.escape(c)).join(".")}`;
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((n) => n.nodeName === current.nodeName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }
    path.unshift(selector);
    const full = path.join(" > ");
    if (document.querySelectorAll(full).length === 1) return full;
    current = current.parentElement;
  }
  return path.join(" > ");
}

// ══════════════════════════════════════════
// Force-enable a disabled element
// ══════════════════════════════════════════
function forceEnableElement(el) {
  if (!el) return;
  el.removeAttribute("disabled");
  el.removeAttribute("aria-disabled");
  el.classList.remove("disabled", "btn-disabled", "is-disabled", "submit-btn-disabled");
  el.style.pointerEvents = "auto";
  el.style.opacity = "1";
  el.style.cursor = "pointer";
  const parent = el.parentElement;
  if (parent) {
    parent.style.pointerEvents = "auto";
    parent.style.opacity = "1";
  }
}

// ══════════════════════════════════════════
// Synthetic click (full event sequence mimicking real user)
// ══════════════════════════════════════════
function syntheticClick(element, shouldForceEnable = false) {
  if (shouldForceEnable) forceEnableElement(element);

  element.scrollIntoView({ block: "center", behavior: "instant" });
  const rect = element.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const eventInit = {
    bubbles: true, cancelable: true, view: window,
    clientX: cx, clientY: cy,
    screenX: cx + window.screenX, screenY: cy + window.screenY,
    button: 0, buttons: 1,
  };
  element.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, pointerId: 1 }));
  element.dispatchEvent(new MouseEvent("mousedown", eventInit));
  element.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, pointerId: 1 }));
  element.dispatchEvent(new MouseEvent("mouseup", eventInit));
  element.dispatchEvent(new MouseEvent("click", eventInit));
  element.click();
}

// ══════════════════════════════════════════
// Synthetic toggle (for checkbox / payment option)
// ══════════════════════════════════════════
function syntheticToggle(element) {
  if (!element) return;
  element.scrollIntoView({ block: "center", behavior: "instant" });
  const rect = element.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const eventInit = {
    bubbles: true, cancelable: true, view: window,
    clientX: cx, clientY: cy,
    screenX: cx + window.screenX, screenY: cy + window.screenY,
    button: 0, buttons: 1,
  };
  element.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, pointerId: 1 }));
  element.dispatchEvent(new MouseEvent("mousedown", eventInit));
  element.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, pointerId: 1 }));
  element.dispatchEvent(new MouseEvent("mouseup", eventInit));
  element.dispatchEvent(new MouseEvent("click", eventInit));
  element.click();
}

// ══════════════════════════════════════════
// Task result persistence
// ══════════════════════════════════════════
async function updateTaskResult(resultText, armed = false) {
  const old = await chrome.storage.local.get(STORAGE_KEY);
  const task = old[STORAGE_KEY] || {};
  task.lastResult = resultText;
  task.armed = armed;
  await chrome.storage.local.set({ [STORAGE_KEY]: task });
}

// ══════════════════════════════════════════
// Check if submit button is "clickable"
// ══════════════════════════════════════════
function isButtonClickable(el) {
  if (!el) return false;
  if (el.disabled) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  if (el.classList.contains("disabled") || el.classList.contains("btn-disabled") ||
      el.classList.contains("is-disabled") || el.classList.contains("submit-btn-disabled")) return false;
  const style = window.getComputedStyle(el);
  if (style.pointerEvents === "none") return false;
  return true;
}

// ══════════════════════════════════════════
// Timer management
// ══════════════════════════════════════════
function clearAllTimers() {
  if (taskTimer) { clearTimeout(taskTimer); taskTimer = null; }
  if (taskInterval) { clearInterval(taskInterval); taskInterval = null; }
  if (taskRaf) { cancelAnimationFrame(taskRaf); taskRaf = null; }
  for (const t of flashTimers) clearTimeout(t);
  flashTimers = [];
  stopButtonWatch();
  cachedTarget = null;
  cachedPaymentEl = null;
  currentTask = null;
  submitClickDone = false;
  submitAttempts = 0;
  lastToggleClickTime = 0;
  lastToggleDateNow = 0;
  calibration = {
    samples: [],
    rttMin: DEFAULT_RTT_MS,
    oneWay: Math.round(DEFAULT_RTT_MS / 2),
  };
}

function stopDomObserver() {
  if (domObserver) { domObserver.disconnect(); domObserver = null; }
}

function stopButtonWatch() {
  if (buttonPollTimer) { clearInterval(buttonPollTimer); buttonPollTimer = null; }
  stopDomObserver();
}

// ══════════════════════════════════════════════════════════════════════
//
//  RTT MEASUREMENT — Dual Source (MutationObserver + PerformanceObserver)
//
//  流程：
//    1. 记录 t0 = performance.now()
//    2. syntheticToggle(支付宝)
//    3. MutationObserver 监听 document.body：
//       - <40ms 的变化 = 点击自身UI反馈（勾选动画、loading转圈出现）→ 跳过
//       - ≥40ms 的变化 = loading转圈消失 = AJAX响应已处理 → 记录 mutRTT
//       - 20ms 静默 = DOM稳定 → 确认 mutRTT
//    4. PerformanceObserver 监听网络请求：
//       - 捕获 toggle 后第一个完成的 XHR/fetch → 记录 perfRTT
//    5. 取两者中的实测值，优先使用 mutRTT（更能反映页面可交互时间）
//
// ══════════════════════════════════════════════════════════════════════
function measureToggleRTT(task, paymentEl, onComplete) {
  const t0Perf = performance.now();
  const t0Date = Date.now();
  let done = false;
  let lastMutTime = 0;
  let debounceTimer = null;
  let mutationCount = 0;
  let mutRTT = null;
  let perfRTT = null;
  let perfObserver = null;

  log(task, `   ⏱️ RTT计时开始 | t0 = ${t0Date}`);

  const finish = (rtt, source) => {
    if (done) return;
    done = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    mutObserver.disconnect();
    if (perfObserver) { try { perfObserver.disconnect(); } catch (_) {} }

    log(task, `   ✅ RTT = ${rtt}ms`);
    log(task, `      来源: ${source}`);
    log(task, `      MutationObserver: ${mutRTT !== null ? mutRTT + "ms" : "未触发"} (${mutationCount}次DOM变化)`);
    log(task, `      PerformanceObserver: ${perfRTT !== null ? perfRTT + "ms" : "未捕获"}`);

    onComplete(rtt);
  };

  // ─── Source A: MutationObserver ───
  const mutObserver = new MutationObserver((mutations) => {
    const elapsed = performance.now() - t0Perf;
    mutationCount += mutations.length;

    // Skip click's own UI feedback (checkbox toggle animation, spinner appearing)
    if (elapsed < RTT_NOISE_THRESHOLD_MS) return;

    lastMutTime = elapsed;

    // Reset debounce: wait for DOM to settle (spinner disappearing + page update)
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      mutRTT = Math.round(lastMutTime);
      // If we also have perfRTT, log comparison
      if (perfRTT !== null) {
        log(task, `   📐 RTT交叉校验 | DOM: ${mutRTT}ms | 网络: ${perfRTT}ms | 差值: ${Math.abs(mutRTT - perfRTT)}ms`);
      }
      finish(mutRTT, "DOM变化(loading转圈消失)");
    }, RTT_SETTLE_MS);
  });

  mutObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });

  // ─── Source B: PerformanceObserver (network timing) ───
  try {
    perfObserver = new PerformanceObserver((list) => {
      if (done) return;
      for (const entry of list.getEntries()) {
        // Only consider requests that started after our toggle
        // entry.startTime is relative to performance.timeOrigin
        if (entry.startTime >= t0Perf && entry.responseEnd > entry.startTime) {
          const networkDuration = Math.round(entry.responseEnd - entry.startTime);
          const fromToggle = Math.round(entry.responseEnd - t0Perf);
          perfRTT = fromToggle;
          log(task, `   🌐 网络请求捕获 | URL: ${entry.name.slice(-60)}`);
          log(task, `      请求耗时: ${networkDuration}ms | toggle后: ${fromToggle}ms`);
          try { perfObserver.disconnect(); } catch (_) {}

          // If MutationObserver hasn't fired yet and perf is ready,
          // don't finish yet — wait for DOM to actually update
          // (perf is faster because it fires before DOM rendering)
          break;
        }
      }
    });
    perfObserver.observe({ entryTypes: ["resource"] });
  } catch (e) {
    // PerformanceObserver might not be available in all contexts
    log(task, `   ⚠️ PerformanceObserver 不可用: ${e.message}`);
  }

  // Fire the toggle
  syntheticToggle(paymentEl);

  // Timeout protection (3s)
  const timeout = setTimeout(() => {
    if (done) return;
    if (mutRTT !== null) {
      finish(mutRTT, "超时但MutObs已有值");
    } else if (perfRTT !== null) {
      log(task, `   ⚠️ DOM无有效变化，使用网络层RTT`);
      finish(perfRTT, "PerformanceObserver(DOM无变化)");
    } else {
      log(task, `   ⚠️ 超时无信号（共${mutationCount}次mutation），使用默认 ${DEFAULT_RTT_MS}ms`);
      finish(DEFAULT_RTT_MS, "超时默认值");
    }
  }, 3000);
  flashTimers.push(timeout);
}

// ══════════════════════════════════════════
// Direct click (non-flash-sale or fallback)
// ══════════════════════════════════════════
async function executeDirectClick(task, source) {
  const selector = typeof task === "string" ? task : task.selector;
  const forceEnable = typeof task === "object" && task.flashSale?.enabled && task.flashSale?.forceEnable;
  const taskObj = typeof task === "object" ? task : null;
  const start = Date.now();

  let el = cachedTarget || document.querySelector(selector);
  if (el) {
    syntheticClick(el, forceEnable);
    const delay = Date.now() - start;
    if (taskObj) log(taskObj, `💥 直接点击提交！来源: ${source}，耗时: ${delay}ms`);
    await updateTaskResult(`✅ 点击成功（${source || "直接点击"}，延迟 ${delay}ms）`, false);
    return;
  }

  // Retry loop
  const retryEnd = start + 10000;
  while (Date.now() < retryEnd) {
    el = document.querySelector(selector);
    if (el) {
      syntheticClick(el, forceEnable);
      const delay = Date.now() - start;
      await updateTaskResult(`✅ 点击成功（${source || "直接点击"}，延迟 ${delay}ms）`, false);
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await updateTaskResult("❌ 点击失败：未找到目标元素", false);
}

// ══════════════════════════════════════════════════════════════════
//
//   FLASH SALE STRATEGY: Calibrated Double-Tap
//
// ══════════════════════════════════════════════════════════════════

// ─── Entry point ───
function scheduleFlashSaleStrategy(task) {
  const T = task.triggerAt;
  const now = Date.now();
  const timeUntilT = T - now;

  // Reset state
  calibration = { samples: [], rttMin: DEFAULT_RTT_MS, oneWay: Math.round(DEFAULT_RTT_MS / 2) };
  submitClickDone = false;
  submitAttempts = 0;
  lastToggleClickTime = 0;
  lastToggleDateNow = 0;

  // Pre-cache
  cachedPaymentEl = document.querySelector(task.flashSale.paymentSelector);
  cachedTarget = document.querySelector(task.selector);

  log(task, "");
  log(task, "═══════════════════════════════════════════════════════════");
  log(task, "🔥 抢购模式启动 — 校准双发策略 v3.2");
  log(task, "═══════════════════════════════════════════════════════════");
  log(task, `📌 提交按钮: ${task.selector} ${cachedTarget ? "✅已缓存" : "⚠️未找到"}`);
  log(task, `📌 支付复选框: ${task.flashSale.paymentSelector} ${cachedPaymentEl ? "✅已缓存" : "⚠️未找到"}`);
  log(task, `📌 目标时间 T-0: ${new Date(T).toLocaleString()}.${String(new Date(T).getMilliseconds()).padStart(3, "0")}`);
  log(task, `📌 距目标: ${timeUntilT}ms`);
  log(task, `📌 强制解锁: ${task.flashSale.forceEnable ? "是" : "否"}`);
  log(task, `📌 按钮状态监听: ${task.flashSale.watchDom ? "是" : "否"}`);
  log(task, "");

  if (!cachedPaymentEl) {
    log(task, "⚠️ 支付宝复选框未找到，降级为直接点击模式");
    scheduleDirectClickPhases(task);
    return;
  }

  if (timeUntilT < 500) {
    log(task, "⚠️ 距目标不足500ms，跳过策略直接点击");
    void executeDirectClick(task, "时间不足直接点击");
    return;
  }

  if (timeUntilT < 1500) {
    log(task, "⚠️ 距目标不足1.5s，跳过校准使用默认RTT");
    log(task, `📊 使用默认 RTT = ${DEFAULT_RTT_MS}ms, oneWay = ${calibration.oneWay}ms`);
    scheduleDoubleTap(task);
    return;
  }

  // Schedule calibration at T-3s (or immediately if less than 3s)
  const calibrationDelay = Math.max(0, timeUntilT - CALIBRATION_LEAD_MS);
  log(task, `⏳ ${calibrationDelay > 0 ? calibrationDelay + "ms后" : "立即"}开始校准...`);

  if (calibrationDelay > 0) {
    const timer = setTimeout(() => startCalibration(task), calibrationDelay);
    flashTimers.push(timer);
  } else {
    startCalibration(task);
  }
}

// ─── Phase 1: Calibration (Click ①②) ───
function startCalibration(task) {
  log(task, "");
  log(task, "┌─────────────────────────────────────────┐");
  log(task, "│  🔬 校准阶段 — 2次点击测量 RTT          │");
  log(task, "└─────────────────────────────────────────┘");

  const paymentEl = document.querySelector(task.flashSale.paymentSelector);
  if (!paymentEl) {
    log(task, "⚠️ 校准失败：支付宝复选框未找到，使用默认RTT");
    scheduleDoubleTap(task);
    return;
  }

  // Click ① — Uncheck
  log(task, "");
  log(task, "🔬 Click ① 取消勾选（第1次校准）");
  measureToggleRTT(task, paymentEl, (rtt1) => {
    calibration.samples.push({ rtt: rtt1, label: "①取消勾选" });
    log(task, "");

    // Click ② — Recheck (restore state)
    const paymentEl2 = document.querySelector(task.flashSale.paymentSelector) || paymentEl;
    log(task, "🔬 Click ② 重新勾选（第2次校准，恢复状态）");
    measureToggleRTT(task, paymentEl2, (rtt2) => {
      calibration.samples.push({ rtt: rtt2, label: "②重新勾选" });

      // Calculate timing parameters
      calibration.rttMin = Math.min(rtt1, rtt2);
      calibration.oneWay = Math.round(calibration.rttMin / 2);

      log(task, "");
      log(task, "┌─────────────────────────────────────────┐");
      log(task, "│  📊 校准完成                             │");
      log(task, "└─────────────────────────────────────────┘");
      log(task, `📊 RTT₁ = ${rtt1}ms (${calibration.samples[0].label})`);
      log(task, `📊 RTT₂ = ${rtt2}ms (${calibration.samples[1].label})`);
      log(task, `📊 RTT_min = ${calibration.rttMin}ms`);
      log(task, `📊 单程估计 oneWay = ${calibration.oneWay}ms`);
      log(task, "");
      log(task, "📐 双发计算:");
      log(task, `   Click ③ 发射时刻: T - ${calibration.oneWay - SAFETY_MARGIN_MS}ms`);
      log(task, `   Click ③ 到达服务器: ≈ T + ${SAFETY_MARGIN_MS}ms`);
      log(task, `   Click ③ 响应回到浏览器: ≈ T + ${SAFETY_MARGIN_MS + calibration.oneWay}ms`);
      log(task, `   Click ④ 发射时刻: T - 0 (准点)`);
      log(task, `   Click ④ 到达服务器: ≈ T + ${calibration.oneWay}ms`);
      log(task, `   Click ④ 响应回到浏览器: ≈ T + ${calibration.rttMin}ms`);
      log(task, "");

      scheduleDoubleTap(task);
    });
  });
}

// ─── Phase 2: Double-Tap (Click ③④) ───
function scheduleDoubleTap(task) {
  const T = task.triggerAt;
  const oneWay = calibration.oneWay;

  // Click ③: T - oneWay + SAFETY_MARGIN → request arrives ~T + SAFETY_MARGIN
  const click3Time = T - oneWay + SAFETY_MARGIN_MS;
  // Click ④: T-0 → request arrives ~T + oneWay
  const click4Time = T;

  const now = Date.now();

  log(task, "┌─────────────────────────────────────────┐");
  log(task, "│  🎯 双发准备                             │");
  log(task, "└─────────────────────────────────────────┘");
  log(task, `🎯 Click ③ 先手: 发射于 T-${T - click3Time}ms`);
  log(task, `   → 预计请求到达服务器: T+${SAFETY_MARGIN_MS}ms`);
  log(task, `   → 预计响应回到浏览器: T+${SAFETY_MARGIN_MS + oneWay}ms`);
  log(task, `🎯 Click ④ 准点: 发射于 T-0`);
  log(task, `   → 预计请求到达服务器: T+${oneWay}ms`);
  log(task, `   → 预计响应回到浏览器: T+${calibration.rttMin}ms`);
  log(task, `⏳ 距 Click ③: ${click3Time - now}ms`);
  log(task, `⏳ 距 Click ④: ${click4Time - now}ms`);
  log(task, "");

  // Start response monitoring BEFORE clicks fire
  startResponseWatch(task);

  // RAF-based precision loop for both clicks
  let click3Fired = false;
  let click4Fired = false;

  const rafLoop = () => {
    const now = Date.now();

    // Fire Click ③
    if (!click3Fired && now >= click3Time) {
      click3Fired = true;
      const pe = document.querySelector(task.flashSale.paymentSelector);
      if (pe) {
        lastToggleClickTime = performance.now();
        lastToggleDateNow = Date.now();
        syntheticToggle(pe);
        const drift = lastToggleDateNow - click3Time;
        log(task, `🎯 Click ③ 已发射！取消勾选 | 实际偏差: ${drift > 0 ? "+" : ""}${drift}ms`);
      } else {
        log(task, "⚠️ Click ③ 失败：支付宝元素未找到");
      }
    }

    // Fire Click ④
    if (!click4Fired && now >= click4Time) {
      click4Fired = true;
      const pe = document.querySelector(task.flashSale.paymentSelector);
      if (pe) {
        lastToggleClickTime = performance.now();
        lastToggleDateNow = Date.now();
        syntheticToggle(pe);
        const drift = lastToggleDateNow - click4Time;
        log(task, `🎯 Click ④ 已发射！准点重新勾选 | 实际偏差: ${drift > 0 ? "+" : ""}${drift}ms`);
      } else {
        log(task, "⚠️ Click ④ 失败：支付宝元素未找到");
      }
      // Schedule Click ⑤ safety net
      scheduleSafetyClick(task);
      return; // Exit RAF loop — both clicks done
    }

    taskRaf = requestAnimationFrame(rafLoop);
  };

  // Enter RAF loop 200ms before Click ③ for precision
  const rafStartTime = click3Time - 200;
  const delayToRaf = rafStartTime - Date.now();

  if (delayToRaf > 0) {
    const timer = setTimeout(() => {
      log(task, "⏱️ 进入 RAF 精准计时循环...");
      taskRaf = requestAnimationFrame(rafLoop);
    }, delayToRaf);
    flashTimers.push(timer);
  } else {
    log(task, "⏱️ 立即进入 RAF 精准计时循环...");
    taskRaf = requestAnimationFrame(rafLoop);
  }
}

// ─── Phase 3: Safety Click ⑤ ───
function scheduleSafetyClick(task) {
  // Fire after max expected RTT + buffer, only if no successful submit yet
  const safetyDelay = Math.max(calibration.rttMin, DEFAULT_RTT_MS) + 200;
  log(task, `🛡️ Click ⑤ 安全网: ${safetyDelay}ms 后检查是否需要补发`);

  const timer = setTimeout(() => {
    if (submitClickDone) {
      log(task, "🛡️ Click ⑤ 跳过（已成功点击提交）");
      return;
    }

    log(task, "");
    log(task, "⚠️ ═══ Click ⑤ 应急触发 ═══");

    // Try direct force-click first
    const submitEl = document.querySelector(task.selector);
    if (submitEl) {
      log(task, "⚠️ 直接强制点击提交按钮");
      doSubmitClick(task, "⑤应急直接点击");
    }

    // Also toggle once more as last resort
    const pe = document.querySelector(task.flashSale.paymentSelector);
    if (pe && submitAttempts < MAX_SUBMIT_ATTEMPTS) {
      lastToggleClickTime = performance.now();
      lastToggleDateNow = Date.now();
      syntheticToggle(pe);
      log(task, "⚠️ Click ⑤ 已发射（第五次切换）");

      // After this toggle's expected response time, try clicking again
      const timer2 = setTimeout(() => {
        if (!submitClickDone && submitAttempts < MAX_SUBMIT_ATTEMPTS) {
          log(task, "⚠️ Click ⑤ 响应后补点击");
          doSubmitClick(task, "⑤响应后补点击");
        }
      }, calibration.rttMin + 50);
      flashTimers.push(timer2);
    }
  }, safetyDelay);
  flashTimers.push(timer);
}

// ─── Submit button click (shared by all triggers) ───
function doSubmitClick(task, source) {
  if (submitClickDone) return;
  if (submitAttempts >= MAX_SUBMIT_ATTEMPTS) return;
  submitAttempts++;

  const el = document.querySelector(task.selector);
  if (!el) {
    log(task, `❌ 第${submitAttempts}/${MAX_SUBMIT_ATTEMPTS}次尝试：提交按钮未找到 (${task.selector})`);
    return;
  }

  // Always force-enable — don't wait for framework to update button state
  if (task.flashSale?.forceEnable) forceEnableElement(el);
  syntheticClick(el, false);

  const delay = Date.now() - task.triggerAt;
  log(task, `💥 第${submitAttempts}/${MAX_SUBMIT_ATTEMPTS}次点击提交！来源: ${source} | 距T-0: +${delay}ms`);

  if (submitAttempts >= MAX_SUBMIT_ATTEMPTS) {
    submitClickDone = true;
    stopButtonWatch();
    void updateTaskResult(`✅ 已发送${submitAttempts}次点击（T+${delay}ms）`, false);
    log(task, "");
    log(task, "═══════════════════════════════════════════════════════════");
    log(task, `🏁 任务完成！共点击 ${submitAttempts} 次，最终延迟 T+${delay}ms`);
    log(task, "═══════════════════════════════════════════════════════════");
  }
}

// ═══════════════════════════════════════════════════════════════════
// Response watcher — detects toggle AJAX completion → clicks submit
//
// 核心逻辑：
//   toggle发出 → loading转圈出现(<40ms, 忽略) → AJAX响应 →
//   loading转圈消失(≥40ms, 捕获) → 等DOM稳定(20ms) →
//   立刻点击提交按钮（不等按钮自然变enabled，直接force-enable+click）
// ═══════════════════════════════════════════════════════════════════
function startResponseWatch(task) {
  stopButtonWatch();

  let mutDebounce = null;
  let lastMutElapsed = 0;
  let totalMutations = 0;
  let responseDetected = false;

  log(task, "👁️ 响应监控已启动（MutationObserver + 按钮轮询 + PerformanceObserver）");

  // ─── Method 1: MutationObserver — detect loading spinner disappearance ───
  domObserver = new MutationObserver((mutations) => {
    if (submitClickDone || submitAttempts >= MAX_SUBMIT_ATTEMPTS) return;
    if (lastToggleClickTime === 0) return; // No toggle fired yet

    const elapsed = performance.now() - lastToggleClickTime;
    totalMutations += mutations.length;

    // Skip click's own UI feedback (checkbox animation, spinner appearing)
    if (elapsed < RTT_NOISE_THRESHOLD_MS) return;

    lastMutElapsed = elapsed;

    // Reset debounce — wait for DOM to settle (spinner gone, data updated)
    if (mutDebounce) clearTimeout(mutDebounce);
    mutDebounce = setTimeout(() => {
      if (submitClickDone) return;
      if (!responseDetected) {
        responseDetected = true;
        const sinceToggle = Math.round(lastMutElapsed);
        const sinceT0 = Date.now() - task.triggerAt;
        log(task, `📡 AJAX响应检测！loading消失`);
        log(task, `   toggle后: ${sinceToggle}ms | T-0后: +${sinceT0}ms | 累计${totalMutations}次mutation`);
        // Immediately try clicking — don't wait for button to naturally enable
        doSubmitClick(task, `AJAX响应(toggle+${sinceToggle}ms)`);
      }
    }, RTT_SETTLE_MS);
  });

  domObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });

  // ─── Method 2: PerformanceObserver — catch network request completion ───
  let perfObserver = null;
  try {
    perfObserver = new PerformanceObserver((list) => {
      if (submitClickDone || submitAttempts >= MAX_SUBMIT_ATTEMPTS) return;
      if (lastToggleClickTime === 0) return;

      for (const entry of list.getEntries()) {
        if (entry.startTime >= lastToggleClickTime && entry.responseEnd > entry.startTime) {
          const fromToggle = Math.round(entry.responseEnd - lastToggleClickTime);
          const sinceT0 = Date.now() - task.triggerAt;
          log(task, `🌐 网络响应完成 | toggle后: ${fromToggle}ms | T-0后: +${sinceT0}ms`);
          log(task, `   URL: ...${entry.name.slice(-80)}`);

          // Also try clicking (backup for MutationObserver)
          if (!responseDetected && submitAttempts < MAX_SUBMIT_ATTEMPTS) {
            responseDetected = true;
            doSubmitClick(task, `网络响应(toggle+${fromToggle}ms)`);
          }
          break;
        }
      }
    });
    perfObserver.observe({ entryTypes: ["resource"] });
  } catch (_) {}

  // ─── Method 3: Polling — check if button becomes clickable ───
  buttonPollTimer = setInterval(() => {
    if (submitClickDone || submitAttempts >= MAX_SUBMIT_ATTEMPTS) {
      clearInterval(buttonPollTimer);
      buttonPollTimer = null;
      if (perfObserver) { try { perfObserver.disconnect(); } catch (_) {} }
      return;
    }
    if (lastToggleClickTime === 0) return;

    const el = document.querySelector(task.selector);
    if (el && isButtonClickable(el)) {
      const sinceT0 = Date.now() - task.triggerAt;
      log(task, `📡 按钮状态变为可点击！T-0后: +${sinceT0}ms`);
      doSubmitClick(task, `按钮可点击(T+${sinceT0}ms)`);
    }
  }, BUTTON_POLL_INTERVAL_MS);

  // Timeout protection
  const timeout = setTimeout(() => {
    if (submitAttempts === 0) {
      log(task, "⏰ 监控超时（15s内无提交），尝试最后一次强制点击...");
      doSubmitClick(task, "超时强制点击");
    }
    stopButtonWatch();
    if (perfObserver) { try { perfObserver.disconnect(); } catch (_) {} }
  }, BUTTON_POLL_TIMEOUT_MS);
  flashTimers.push(timeout);
}

// ══════════════════════════════════════════
// Direct Click Scheduling (non-flash-sale, 3-phase)
// ══════════════════════════════════════════
function scheduleDirectClickPhases(task) {
  const now = Date.now();
  const delay = task.triggerAt - now;

  if (delay <= 0) {
    void executeDirectClick(task, "超时补触发");
    return;
  }
  if (delay <= PHASE2_THRESHOLD_MS) {
    enterDirectPhase2(task);
    return;
  }
  if (delay <= PHASE1_THRESHOLD_MS) {
    enterDirectPhase1(task);
    return;
  }

  taskTimer = setTimeout(() => enterDirectPhase1(task), delay - PHASE1_THRESHOLD_MS);
}

function enterDirectPhase1(task) {
  cachedTarget = document.querySelector(task.selector);

  taskInterval = setInterval(() => {
    if (!cachedTarget) cachedTarget = document.querySelector(task.selector);
    if (task.triggerAt - Date.now() <= PHASE2_THRESHOLD_MS) {
      clearInterval(taskInterval);
      taskInterval = null;
      enterDirectPhase2(task);
    }
  }, 1);
}

function enterDirectPhase2(task) {
  if (!cachedTarget) cachedTarget = document.querySelector(task.selector);

  const tick = () => {
    if (Date.now() >= task.triggerAt) {
      taskRaf = null;
      void executeDirectClick(task, "定时触发");
      return;
    }
    taskRaf = requestAnimationFrame(tick);
  };
  taskRaf = requestAnimationFrame(tick);
}

// ══════════════════════════════════════════
// Task scheduling — dispatcher
// ══════════════════════════════════════════
function scheduleTask(task) {
  clearAllTimers();
  if (!task || !task.armed || !task.selector || !task.triggerAt) return;

  currentTask = task;

  const isFlashToggle =
    task.flashSale?.enabled &&
    task.flashSale?.togglePayment &&
    task.flashSale?.paymentSelector;

  if (isFlashToggle) {
    scheduleFlashSaleStrategy(task);
  } else {
    scheduleDirectClickPhases(task);
  }
}

// ══════════════════════════════════════════
// Element Picker
// ══════════════════════════════════════════
function disablePicker() {
  if (!pickerEnabled) return;
  pickerEnabled = false;
  if (cleanupPicker) cleanupPicker();
  cleanupPicker = null;
  if (hoverElement) {
    hoverElement.style.outline = "";
    hoverElement.style.outlineOffset = "";
    hoverElement = null;
  }
}

function enablePicker(target) {
  disablePicker();
  pickerEnabled = true;
  pickerTarget = target || "submit";
  const highlightColor = pickerTarget === "payment" ? "#ff5000" : "#00d4ff";

  const onMouseMove = (event) => {
    if (!pickerEnabled) return;
    const el = event.target;
    if (!(el instanceof Element)) return;
    if (hoverElement && hoverElement !== el) {
      hoverElement.style.outline = "";
      hoverElement.style.outlineOffset = "";
    }
    hoverElement = el;
    hoverElement.style.outline = `2px solid ${highlightColor}`;
    hoverElement.style.outlineOffset = "2px";
  };

  const onClick = (event) => {
    if (!pickerEnabled) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const el = event.target;
    if (!(el instanceof Element)) return;
    const selector = getElementCssSelector(el);
    const text = el.innerText?.slice(0, 60) || "";
    disablePicker();
    void savePickedSelector(selector, text, pickerTarget);
    chrome.runtime.sendMessage({
      type: "SELECTOR_PICKED",
      payload: { selector, text, target: pickerTarget }
    }).catch(() => {});
  };

  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  cleanupPicker = () => {
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
  };
}

// ══════════════════════════════════════════
// Message handler
// ══════════════════════════════════════════
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) return;

  if (message.type === "START_PICKER") {
    const target = message.payload?.target || "submit";
    enablePicker(target);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "ARM_TASK") {
    scheduleTask(message.payload);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "CANCEL_TASK") {
    clearAllTimers();
    disablePicker();
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "RUN_NOW") {
    const { selector, flashSale } = message.payload;
    const fakeTask = { selector, flashSale };
    void executeDirectClick(fakeTask, "手动测试");
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "TEST_PAYMENT_TOGGLE") {
    const { paymentSelector } = message.payload;
    const el = document.querySelector(paymentSelector);
    if (!el) {
      console.warn("[MiaoTiDan] 测试切换：未找到支付宝复选框元素");
      sendResponse({ ok: false, error: "未找到元素" });
      return;
    }

    // Measure RTT during test toggle — full dual-source measurement
    console.log("[MiaoTiDan] ╔═══════════════════════════════════════╗");
    console.log("[MiaoTiDan] ║  📋 测试模式 — RTT 测量              ║");
    console.log("[MiaoTiDan] ╚═══════════════════════════════════════╝");

    const fakeTask = { triggerAt: null };

    log(fakeTask, "🔬 第一次切换（取消勾选）");
    measureToggleRTT(fakeTask, el, (rtt1) => {
      log(fakeTask, `📊 RTT₁ = ${rtt1}ms`);
      log(fakeTask, "");

      const el2 = document.querySelector(paymentSelector) || el;
      log(fakeTask, "🔬 第二次切换（重新勾选）");
      measureToggleRTT(fakeTask, el2, (rtt2) => {
        log(fakeTask, `📊 RTT₂ = ${rtt2}ms`);
        log(fakeTask, "");
        const rttMin = Math.min(rtt1, rtt2);
        const oneWay = Math.round(rttMin / 2);
        console.log("[MiaoTiDan] ┌─────────────────────────────────────────┐");
        console.log(`[MiaoTiDan] │  📊 测试结果:                           │`);
        console.log(`[MiaoTiDan] │    RTT₁ = ${String(rtt1).padEnd(6)}ms (取消勾选)         │`);
        console.log(`[MiaoTiDan] │    RTT₂ = ${String(rtt2).padEnd(6)}ms (重新勾选)         │`);
        console.log(`[MiaoTiDan] │    RTT_min = ${String(rttMin).padEnd(4)}ms                │`);
        console.log(`[MiaoTiDan] │    oneWay  = ${String(oneWay).padEnd(4)}ms                │`);
        console.log(`[MiaoTiDan] │                                         │`);
        console.log(`[MiaoTiDan] │  🎯 预计提交延迟:                       │`);
        console.log(`[MiaoTiDan] │    先手Click③ 到点后 ≈ +${String(SAFETY_MARGIN_MS + oneWay).padEnd(4)}ms 收到响应 │`);
        console.log(`[MiaoTiDan] │    准点Click④ 到点后 ≈ +${String(rttMin).padEnd(4)}ms 收到响应 │`);
        console.log("[MiaoTiDan] └─────────────────────────────────────────┘");
      });
    });

    sendResponse({ ok: true });
    return;
  }
});

// ══════════════════════════════════════════
// Storage change listener
// ══════════════════════════════════════════
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!changes[STORAGE_KEY]) return;
  const task = changes[STORAGE_KEY].newValue;
  if (task?.armed) scheduleTask(task);
});

// ══════════════════════════════════════════
// Boot
// ══════════════════════════════════════════
async function bootTaskOnPageLoad() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const task = result[STORAGE_KEY];
  if (task?.armed) scheduleTask(task);
}

void bootTaskOnPageLoad();
