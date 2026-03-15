/**
 * MiaoTiDan Content Script v3.0
 * =============================
 * Runs in 淘宝/天猫 pages. Handles:
 * 1. Element picker (visual selector for submit button AND payment checkbox)
 * 2. High-precision timed click (RAF-based tight loop)
 * 3. Flash-sale strategy:
 *    - At trigger time: toggle Alipay checkbox (uncheck → recheck) to force
 *      a lightweight AJAX refresh of the order/payment state WITHOUT full page
 *      reload.  Only ONE round-trip to avoid bot detection.
 *    - Immediately after toggle: MutationObserver + high-frequency polling watches
 *      the submit button.  The instant its state changes (enabled / class change /
 *      attribute change), we fire a synthetic click.
 */

const STORAGE_KEY = "autoSubmitTask";

// ─── Timing Tuning ───
const PHASE1_THRESHOLD_MS = 2000;   // 2s before → fine-grained polling
const PHASE2_THRESHOLD_MS = 100;    // 100ms before → RAF tight loop
const BUTTON_POLL_INTERVAL_MS = 5;  // Poll submit button every 5ms after toggle
const BUTTON_POLL_TIMEOUT_MS = 15000; // Give up after 15s

// ─── State ───
let taskTimer = null;
let taskInterval = null;
let taskRaf = null;
let cachedTarget = null;
let cachedPaymentEl = null;
let currentTask = null;
let pickerEnabled = false;
let pickerTarget = "submit"; // "submit" or "payment"
let hoverElement = null;
let cleanupPicker = null;
let domObserver = null;
let domObserverClickDone = false;
let buttonPollTimer = null;

// ══════════════════════════════════════════
// Selector persistence
// ══════════════════════════════════════════
async function savePickedSelector(selector, text, target) {
  const old = await chrome.storage.local.get(STORAGE_KEY);
  const task = old[STORAGE_KEY] || {};

  if (target === "payment") {
    // Save payment selector into flashSale config
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
  if (shouldForceEnable) {
    forceEnableElement(element);
  }

  element.scrollIntoView({ block: "center", behavior: "instant" });

  const rect = element.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const eventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: cx,
    clientY: cy,
    screenX: cx + window.screenX,
    screenY: cy + window.screenY,
    button: 0,
    buttons: 1,
  };

  element.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, pointerId: 1 }));
  element.dispatchEvent(new MouseEvent("mousedown", eventInit));
  element.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, pointerId: 1 }));
  element.dispatchEvent(new MouseEvent("mouseup", eventInit));
  element.dispatchEvent(new MouseEvent("click", eventInit));

  element.click();
}

// ══════════════════════════════════════════
// Synthetic checkbox toggle (mimics real user click on checkbox/label)
// ══════════════════════════════════════════
function syntheticToggle(element) {
  if (!element) return;
  element.scrollIntoView({ block: "center", behavior: "instant" });

  const rect = element.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const eventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: cx,
    clientY: cy,
    screenX: cx + window.screenX,
    screenY: cy + window.screenY,
    button: 0,
    buttons: 1,
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
// Check if submit button is "clickable" (not disabled)
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
// Strategy: Toggle payment checkbox → watch button → click
// This is the core flash-sale strategy:
// 1. Uncheck the Alipay checkbox (triggers AJAX refresh)
// 2. Wait ~80ms, then recheck it (only 1 round-trip total)
// 3. Immediately start polling + MutationObserver on submit button
// 4. The instant submit button becomes enabled → click it
// ══════════════════════════════════════════
async function executePaymentToggleStrategy(task) {
  const submitSelector = task.selector;
  const paymentSelector = task.flashSale?.paymentSelector;
  const forceEnable = task.flashSale?.forceEnable;

  // Locate the payment element
  let paymentEl = cachedPaymentEl || document.querySelector(paymentSelector);
  if (!paymentEl && paymentSelector) {
    paymentEl = document.querySelector(paymentSelector);
  }

  if (!paymentEl) {
    console.warn("[MiaoTiDan] 支付宝复选框未找到，直接尝试点击提交按钮");
    void executeDirectClick(submitSelector, forceEnable);
    return;
  }

  console.log("[MiaoTiDan] 执行支付方式切换策略...");

  // Step 1: Uncheck (first toggle)
  syntheticToggle(paymentEl);
  console.log("[MiaoTiDan] 第一次切换（取消勾选）完成");

  // Step 2: Wait a short moment, then recheck
  // 80ms is enough for the AJAX to fire but short enough to be fast
  await new Promise((resolve) => setTimeout(resolve, 80));

  // Re-locate in case DOM changed
  paymentEl = document.querySelector(paymentSelector) || paymentEl;
  syntheticToggle(paymentEl);
  console.log("[MiaoTiDan] 第二次切换（重新勾选）完成，开始监控提交按钮状态...");

  // Step 3: Start aggressive monitoring of the submit button
  startButtonWatch(task);
}

// ══════════════════════════════════════════
// Button watcher: MutationObserver + high-frequency polling
// Fires the instant the submit button state changes
// ══════════════════════════════════════════
function startButtonWatch(task) {
  const submitSelector = task.selector;
  const forceEnable = task.flashSale?.forceEnable;
  let clicked = false;
  const startTime = Date.now();

  const doClick = (source) => {
    if (clicked) return;
    clicked = true;
    stopButtonWatch();
    const el = cachedTarget || document.querySelector(submitSelector);
    if (el) {
      if (forceEnable) forceEnableElement(el);
      syntheticClick(el, false);
      const delay = Date.now() - task.triggerAt;
      void updateTaskResult(`✅ 点击成功（${source}，延迟 ${delay}ms）`, false);
      console.log(`[MiaoTiDan] ✅ 按钮已点击！来源: ${source}，距目标时间延迟: ${delay}ms`);
    } else {
      void updateTaskResult("❌ 点击失败：提交按钮未找到", false);
    }
  };

  const checkButton = () => {
    const el = document.querySelector(submitSelector);
    if (!el) return;
    cachedTarget = el;

    if (isButtonClickable(el) || forceEnable) {
      doClick("按钮状态变化");
    }
  };

  // High-frequency polling (every 5ms)
  buttonPollTimer = setInterval(() => {
    if (clicked) return;
    // Timeout safeguard
    if (Date.now() - startTime > BUTTON_POLL_TIMEOUT_MS) {
      console.warn("[MiaoTiDan] 按钮监控超时，尝试强制点击...");
      doClick("超时强制点击");
      return;
    }
    checkButton();
  }, BUTTON_POLL_INTERVAL_MS);

  // MutationObserver for attribute/DOM changes
  stopDomObserver();
  domObserverClickDone = false;
  domObserver = new MutationObserver(() => {
    if (clicked) return;
    checkButton();
  });

  domObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "class", "style", "aria-disabled"],
  });

  // Also do an immediate check — the button might already be ready
  checkButton();
}

function stopButtonWatch() {
  if (buttonPollTimer) {
    clearInterval(buttonPollTimer);
    buttonPollTimer = null;
  }
  stopDomObserver();
}

// ══════════════════════════════════════════
// Direct click (non-flash-sale, or fallback)
// ══════════════════════════════════════════
async function executeDirectClick(selector, forceEnable) {
  const start = Date.now();
  let el = cachedTarget || document.querySelector(selector);

  if (el) {
    syntheticClick(el, forceEnable);
    const delay = Date.now() - start;
    await updateTaskResult(`✅ 点击成功（定时触发，延迟 ${delay}ms）`, false);
    return;
  }

  // Retry loop (up to 10 seconds)
  const retryEnd = start + 10000;
  while (Date.now() < retryEnd) {
    el = document.querySelector(selector);
    if (el) {
      syntheticClick(el, forceEnable);
      const delay = Date.now() - start;
      await updateTaskResult(`✅ 点击成功（定时触发，延迟 ${delay}ms）`, false);
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  await updateTaskResult("❌ 点击失败：未找到目标元素", false);
}

// ══════════════════════════════════════════
// Clear all timers
// ══════════════════════════════════════════
function clearAllTimers() {
  if (taskTimer) { clearTimeout(taskTimer); taskTimer = null; }
  if (taskInterval) { clearInterval(taskInterval); taskInterval = null; }
  if (taskRaf) { cancelAnimationFrame(taskRaf); taskRaf = null; }
  cachedTarget = null;
  cachedPaymentEl = null;
  currentTask = null;
  stopButtonWatch();
}

// ══════════════════════════════════════════
// DOM Mutation Observer helpers
// ══════════════════════════════════════════
function stopDomObserver() {
  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }
  domObserverClickDone = false;
}

// ══════════════════════════════════════════
// High-precision scheduling (3-phase)
// ══════════════════════════════════════════
function scheduleTask(task) {
  clearAllTimers();
  if (!task || !task.armed || !task.selector || !task.triggerAt) return;

  currentTask = task;
  const now = Date.now();
  const delay = task.triggerAt - now;

  if (delay <= 0) {
    // Already past trigger time
    onTriggerTime(task);
    return;
  }

  if (delay <= PHASE2_THRESHOLD_MS) {
    enterPhase2(task);
    return;
  }

  if (delay <= PHASE1_THRESHOLD_MS) {
    enterPhase1(task);
    return;
  }

  // Phase 0: coarse wait until 2s before trigger
  taskTimer = setTimeout(() => {
    enterPhase1(task);
  }, delay - PHASE1_THRESHOLD_MS);
}

function enterPhase1(task) {
  // Pre-cache submit button
  cachedTarget = document.querySelector(task.selector);

  // Pre-cache payment checkbox (for flash sale)
  if (task.flashSale?.enabled && task.flashSale?.paymentSelector) {
    cachedPaymentEl = document.querySelector(task.flashSale.paymentSelector);
  }

  taskInterval = setInterval(() => {
    const remaining = task.triggerAt - Date.now();

    // Keep trying to cache elements
    if (!cachedTarget) {
      cachedTarget = document.querySelector(task.selector);
    }
    if (!cachedPaymentEl && task.flashSale?.paymentSelector) {
      cachedPaymentEl = document.querySelector(task.flashSale.paymentSelector);
    }

    if (remaining <= PHASE2_THRESHOLD_MS) {
      clearInterval(taskInterval);
      taskInterval = null;
      enterPhase2(task);
    }
  }, 1);
}

function enterPhase2(task) {
  if (!cachedTarget) {
    cachedTarget = document.querySelector(task.selector);
  }
  if (!cachedPaymentEl && task.flashSale?.paymentSelector) {
    cachedPaymentEl = document.querySelector(task.flashSale.paymentSelector);
  }

  const tick = () => {
    if (Date.now() >= task.triggerAt) {
      taskRaf = null;
      onTriggerTime(task);
      return;
    }
    taskRaf = requestAnimationFrame(tick);
  };
  taskRaf = requestAnimationFrame(tick);
}

// ══════════════════════════════════════════
// On trigger time — decide which strategy to use
// ══════════════════════════════════════════
function onTriggerTime(task) {
  const isFlashSale = task.flashSale?.enabled;
  const hasTogglePayment = isFlashSale && task.flashSale?.togglePayment && task.flashSale?.paymentSelector;

  if (hasTogglePayment) {
    // Flash sale: toggle payment → watch button → click
    console.log("[MiaoTiDan] 到达目标时间，执行支付切换策略");
    void executePaymentToggleStrategy(task);
  } else {
    // Normal mode or flash sale without payment toggle: direct click
    console.log("[MiaoTiDan] 到达目标时间，执行直接点击");
    const forceEnable = isFlashSale && task.flashSale?.forceEnable;
    void executeDirectClick(task.selector, forceEnable);
  }
}

// ══════════════════════════════════════════
// Element Picker (supports both submit and payment targets)
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
    const forceEnable = flashSale?.enabled && flashSale?.forceEnable;
    void executeDirectClick(selector, forceEnable);
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
    console.log("[MiaoTiDan] 测试切换：第一次点击（取消勾选）");
    syntheticToggle(el);
    setTimeout(() => {
      const el2 = document.querySelector(paymentSelector) || el;
      console.log("[MiaoTiDan] 测试切换：第二次点击（重新勾选）");
      syntheticToggle(el2);
    }, 80);
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
  if (task?.armed) {
    scheduleTask(task);
  }
});

// ══════════════════════════════════════════
// Boot: restore task on page load
// ══════════════════════════════════════════
async function bootTaskOnPageLoad() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const task = result[STORAGE_KEY];
  if (task?.armed) scheduleTask(task);
}

void bootTaskOnPageLoad();
