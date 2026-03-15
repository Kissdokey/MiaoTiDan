/**
 * MiaoTiDan Content Script v2.1
 * =============================
 * Runs in 淘宝/天猫 pages. Handles:
 * 1. Element picker (visual selector)
 * 2. High-precision timed click (RAF-based tight loop)
 * 3. Flash-sale mode: force-enable, auto-refresh, DOM mutation watch
 */

const STORAGE_KEY = "autoSubmitTask";

// ─── Timing Tuning ───
const PHASE1_THRESHOLD_MS = 2000;
const PHASE2_THRESHOLD_MS = 100;
const MAX_CLICK_RETRY_MS = 10000;
const CLICK_RETRY_INTERVAL_MS = 50;

// ─── State ───
let taskTimer = null;
let taskInterval = null;
let taskRaf = null;
let cachedTarget = null;
let currentTask = null;
let pickerEnabled = false;
let hoverElement = null;
let cleanupPicker = null;
let domObserver = null;
let domObserverClickDone = false;

// ══════════════════════════════════════════
// Selector persistence
// ══════════════════════════════════════════
async function savePickedSelector(selector, text) {
  const old = await chrome.storage.local.get(STORAGE_KEY);
  const task = old[STORAGE_KEY] || {};
  task.selector = selector;
  task.pickedText = text || "";
  task.pickedAt = Date.now();

  if (task.armed) {
    task.armed = false;
    task.lastResult = "已重新选择按钮，请重新启动定时任务";
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

  // Remove common disabled patterns
  el.removeAttribute("disabled");
  el.removeAttribute("aria-disabled");
  el.classList.remove("disabled", "btn-disabled", "is-disabled", "submit-btn-disabled");

  // Fix pointer-events and opacity
  el.style.pointerEvents = "auto";
  el.style.opacity = "1";
  el.style.cursor = "pointer";

  // Also check parent (some frameworks wrap buttons)
  const parent = el.parentElement;
  if (parent) {
    parent.style.pointerEvents = "auto";
    parent.style.opacity = "1";
  }
}

// ══════════════════════════════════════════
// Synthetic click (full event sequence)
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
// Post-trigger click with retry
// ══════════════════════════════════════════
async function executeClick(selector, source, flashSale) {
  const forceEnable = flashSale?.enabled && flashSale?.forceEnable;
  const start = Date.now();
  let clicked = false;

  // First attempt: use cached element
  if (cachedTarget) {
    try {
      syntheticClick(cachedTarget, forceEnable);
      clicked = true;
    } catch (_) {
      cachedTarget = null;
    }
  }

  if (clicked) {
    const delay = Date.now() - start;
    await updateTaskResult(`✅ 点击成功（${source}，延迟 ${delay}ms）`, false);
    stopDomObserver();
    return;
  }

  // Retry loop
  while (Date.now() - start <= MAX_CLICK_RETRY_MS) {
    const target = document.querySelector(selector);
    if (target) {
      syntheticClick(target, forceEnable);
      clicked = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, CLICK_RETRY_INTERVAL_MS));
  }

  if (clicked) {
    const delay = Date.now() - start;
    await updateTaskResult(`✅ 点击成功（${source}，延迟 ${delay}ms）`, false);
  } else {
    await updateTaskResult("❌ 点击失败：未找到目标元素", false);
  }
  stopDomObserver();
}

// ══════════════════════════════════════════
// Clear all timers
// ══════════════════════════════════════════
function clearAllTimers() {
  if (taskTimer) { clearTimeout(taskTimer); taskTimer = null; }
  if (taskInterval) { clearInterval(taskInterval); taskInterval = null; }
  if (taskRaf) { cancelAnimationFrame(taskRaf); taskRaf = null; }
  cachedTarget = null;
  currentTask = null;
  stopDomObserver();
}

// ══════════════════════════════════════════
// DOM Mutation Observer (flash sale)
// Watches for the target button appearing or becoming enabled
// ══════════════════════════════════════════
function stopDomObserver() {
  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }
  domObserverClickDone = false;
}

function startDomObserver(task) {
  stopDomObserver();
  if (!task?.flashSale?.watchDom) return;
  if (!task.selector) return;

  domObserverClickDone = false;

  const tryClickIfReady = () => {
    if (domObserverClickDone) return;
    // Only trigger after the scheduled time
    if (Date.now() < task.triggerAt) return;

    const el = document.querySelector(task.selector);
    if (!el) return;

    // Check if the element is now enabled
    const isDisabled = el.disabled || el.getAttribute("aria-disabled") === "true" ||
                       el.classList.contains("disabled") || el.classList.contains("btn-disabled");

    if (!isDisabled || (task.flashSale?.forceEnable)) {
      domObserverClickDone = true;
      if (task.flashSale?.forceEnable) forceEnableElement(el);
      syntheticClick(el, false);
      void updateTaskResult("✅ 点击成功（DOM变化触发）", false);
      stopDomObserver();
    }
  };

  domObserver = new MutationObserver(() => {
    tryClickIfReady();
  });

  domObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "class", "style", "aria-disabled"],
  });
}

// ══════════════════════════════════════════
// Auto-refresh page strategy (flash sale)
// ══════════════════════════════════════════
function scheduleAutoRefresh(task) {
  if (!task?.flashSale?.autoRefresh) return;

  const advanceMs = task.flashSale.refreshAdvanceMs || 500;
  const refreshAt = task.triggerAt - advanceMs;
  const delay = refreshAt - Date.now();

  if (delay <= 0) {
    // Already past refresh time — just go straight to click
    return;
  }

  // Schedule a page reload just before trigger time.
  // After reload, bootTaskOnPageLoad() will fire and immediately execute click.
  const refreshTimer = setTimeout(() => {
    // Mark that we should click immediately on next page load
    // (the boot logic handles delay <= 0 as immediate click)
    window.location.reload();
  }, delay);

  // Store timer so we can cancel if needed
  const originalClear = clearAllTimers;
  clearAllTimers = function () {
    clearTimeout(refreshTimer);
    originalClear();
  };
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

  // Flash sale mode: start DOM observer early
  if (task.flashSale?.enabled && task.flashSale?.watchDom) {
    startDomObserver(task);
  }

  if (delay <= 0) {
    void executeClick(task.selector, "超时补触发", task.flashSale);
    return;
  }

  // Flash sale: schedule auto-refresh if enabled
  if (task.flashSale?.enabled && task.flashSale?.autoRefresh) {
    scheduleAutoRefresh(task);
    // If auto-refresh will trigger before our click time,
    // still set up the normal schedule as fallback
    // (in case refresh is faster than expected)
  }

  if (delay <= PHASE2_THRESHOLD_MS) {
    enterPhase2(task);
    return;
  }

  if (delay <= PHASE1_THRESHOLD_MS) {
    enterPhase1(task);
    return;
  }

  // Phase 0: coarse wait
  taskTimer = setTimeout(() => {
    enterPhase1(task);
  }, delay - PHASE1_THRESHOLD_MS);
}

function enterPhase1(task) {
  cachedTarget = document.querySelector(task.selector);

  // Force-enable during cache if flash sale
  if (cachedTarget && task.flashSale?.enabled && task.flashSale?.forceEnable) {
    forceEnableElement(cachedTarget);
  }

  taskInterval = setInterval(() => {
    const remaining = task.triggerAt - Date.now();

    if (!cachedTarget) {
      cachedTarget = document.querySelector(task.selector);
      if (cachedTarget && task.flashSale?.enabled && task.flashSale?.forceEnable) {
        forceEnableElement(cachedTarget);
      }
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
  if (cachedTarget && task.flashSale?.enabled && task.flashSale?.forceEnable) {
    forceEnableElement(cachedTarget);
  }

  const tick = () => {
    if (Date.now() >= task.triggerAt) {
      taskRaf = null;
      void executeClick(task.selector, "定时触发", task.flashSale);
      return;
    }
    taskRaf = requestAnimationFrame(tick);
  };
  taskRaf = requestAnimationFrame(tick);
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

function enablePicker() {
  disablePicker();
  pickerEnabled = true;

  const onMouseMove = (event) => {
    if (!pickerEnabled) return;
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (hoverElement && hoverElement !== target) {
      hoverElement.style.outline = "";
      hoverElement.style.outlineOffset = "";
    }
    hoverElement = target;
    hoverElement.style.outline = "2px solid #00d4ff";
    hoverElement.style.outlineOffset = "2px";
  };

  const onClick = (event) => {
    if (!pickerEnabled) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const target = event.target;
    if (!(target instanceof Element)) return;

    const selector = getElementCssSelector(target);
    const text = target.innerText?.slice(0, 60) || "";
    disablePicker();

    void savePickedSelector(selector, text);

    chrome.runtime.sendMessage({
      type: "SELECTOR_PICKED",
      payload: { selector, text }
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
    enablePicker();
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
    void executeClick(message.payload.selector, "手动测试", message.payload.flashSale);
    sendResponse({ ok: true });
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
