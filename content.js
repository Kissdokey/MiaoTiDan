/**
 * MiaoTiDan Content Script
 * ========================
 * Runs in淘宝/天猫 pages. Handles:
 * 1. Element picker (visual selector)
 * 2. High-precision timed click (RAF-based tight loop)
 */

const STORAGE_KEY = "autoSubmitTask";

// ─── Timing Tuning ───
const PHASE1_THRESHOLD_MS = 2000;   // 2s before: switch from setTimeout to setInterval(1ms)
const PHASE2_THRESHOLD_MS = 100;    // 100ms before: enter RAF tight loop
const MAX_CLICK_RETRY_MS = 10000;   // After trigger: retry for 10s if element not found
const CLICK_RETRY_INTERVAL_MS = 50; // Retry interval during post-trigger

// ─── State ───
let taskTimer = null;
let taskInterval = null;
let taskRaf = null;
let cachedTarget = null;     // pre-queried DOM element
let currentTask = null;
let pickerEnabled = false;
let hoverElement = null;
let cleanupPicker = null;

// ─── Selector persistence ───
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

// ─── CSS Selector generator ───
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

// ─── Synthetic click (full event sequence) ───
function syntheticClick(element) {
  // Scroll into view first
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

  // Full pointer + mouse event sequence (mimics real user)
  element.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, pointerId: 1 }));
  element.dispatchEvent(new MouseEvent("mousedown", eventInit));
  element.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, pointerId: 1 }));
  element.dispatchEvent(new MouseEvent("mouseup", eventInit));
  element.dispatchEvent(new MouseEvent("click", eventInit));

  // Fallback: native click
  element.click();
}

// ─── Task result persistence ───
async function updateTaskResult(resultText, armed = false) {
  const old = await chrome.storage.local.get(STORAGE_KEY);
  const task = old[STORAGE_KEY] || {};
  task.lastResult = resultText;
  task.armed = armed;
  await chrome.storage.local.set({ [STORAGE_KEY]: task });
}

// ─── Post-trigger click with retry ───
async function executeClick(selector, source) {
  const start = Date.now();
  let clicked = false;

  // First attempt: use cached element
  if (cachedTarget) {
    try {
      syntheticClick(cachedTarget);
      clicked = true;
    } catch (_) {
      cachedTarget = null;
    }
  }

  if (clicked) {
    const delay = Date.now() - start;
    await updateTaskResult(`✅ 点击成功（${source}，延迟 ${delay}ms）`, false);
    return;
  }

  // Retry loop
  while (Date.now() - start <= MAX_CLICK_RETRY_MS) {
    const target = document.querySelector(selector);
    if (target) {
      syntheticClick(target);
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
}

// ─── Clear all timers ───
function clearAllTimers() {
  if (taskTimer) { clearTimeout(taskTimer); taskTimer = null; }
  if (taskInterval) { clearInterval(taskInterval); taskInterval = null; }
  if (taskRaf) { cancelAnimationFrame(taskRaf); taskRaf = null; }
  cachedTarget = null;
  currentTask = null;
}

// ─── High-precision scheduling ───
// Strategy:
//   Phase 0: delay > 2s    → setTimeout to Phase 1
//   Phase 1: delay ≤ 2s    → setInterval(1ms) pre-caching element, waiting for Phase 2
//   Phase 2: delay ≤ 100ms → RAF tight loop, fire as soon as Date.now() >= triggerAt
function scheduleTask(task) {
  clearAllTimers();
  if (!task || !task.armed || !task.selector || !task.triggerAt) return;

  currentTask = task;
  const now = Date.now();
  const delay = task.triggerAt - now;

  if (delay <= 0) {
    // Already past trigger time
    void executeClick(task.selector, "超时补触发");
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

  // Phase 0: coarse wait
  taskTimer = setTimeout(() => {
    enterPhase1(task);
  }, delay - PHASE1_THRESHOLD_MS);
}

function enterPhase1(task) {
  // Pre-cache the target element
  cachedTarget = document.querySelector(task.selector);

  // Fine-grained polling at ~1ms
  taskInterval = setInterval(() => {
    const remaining = task.triggerAt - Date.now();

    // Keep refreshing cached element
    if (!cachedTarget) {
      cachedTarget = document.querySelector(task.selector);
    }

    if (remaining <= PHASE2_THRESHOLD_MS) {
      clearInterval(taskInterval);
      taskInterval = null;
      enterPhase2(task);
    }
  }, 1);
}

function enterPhase2(task) {
  // Final cache attempt
  if (!cachedTarget) {
    cachedTarget = document.querySelector(task.selector);
  }

  // RAF tight loop — fires every ~16ms (or faster with high-refresh monitors)
  const tick = () => {
    if (Date.now() >= task.triggerAt) {
      taskRaf = null;
      void executeClick(task.selector, "定时触发");
      return;
    }
    taskRaf = requestAnimationFrame(tick);
  };
  taskRaf = requestAnimationFrame(tick);
}

// ─── Element Picker ───
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

// ─── Message handler ───
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
    void executeClick(message.payload.selector, "手动测试");
    sendResponse({ ok: true });
  }
});

// ─── Storage change listener ───
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!changes[STORAGE_KEY]) return;
  const task = changes[STORAGE_KEY].newValue;
  if (task?.armed) {
    scheduleTask(task);
  }
});

// ─── Boot: restore task on page load ───
async function bootTaskOnPageLoad() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const task = result[STORAGE_KEY];
  if (task?.armed) scheduleTask(task);
}

void bootTaskOnPageLoad();
