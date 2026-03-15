const STORAGE_KEY = "autoSubmitTask";
const MAX_CLICK_RETRY_MS = 10000;
const CLICK_RETRY_INTERVAL_MS = 200;

let taskTimer = null;
let pickerEnabled = false;
let hoverElement = null;
let cleanupPicker = null;

async function savePickedSelector(selector, text) {
  const old = await chrome.storage.local.get(STORAGE_KEY);
  const task = old[STORAGE_KEY] || {};
  task.selector = selector;
  task.pickedText = text || "";
  task.pickedAt = Date.now();

  // Avoid accidental auto-submit with outdated schedule after a new target is picked.
  if (task.armed) {
    task.armed = false;
    task.lastResult = "已重新选择按钮，请重新启动定时任务";
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: task });
}

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

function syntheticClick(element) {
  const events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  for (const name of events) {
    element.dispatchEvent(
      new MouseEvent(name, {
        bubbles: true,
        cancelable: true,
        view: window
      })
    );
  }
  element.click();
}

async function updateTaskResult(resultText, armed = false) {
  const old = await chrome.storage.local.get(STORAGE_KEY);
  const task = old[STORAGE_KEY] || {};
  task.lastResult = resultText;
  task.armed = armed;
  await chrome.storage.local.set({ [STORAGE_KEY]: task });
}

async function tryClickWithRetry(selector, source) {
  const start = Date.now();
  let clicked = false;

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
    await updateTaskResult(`点击成功（${source}）`, false);
  } else {
    await updateTaskResult("点击失败：未找到目标元素", false);
  }
}

function clearTaskTimer() {
  if (!taskTimer) return;
  clearTimeout(taskTimer);
  taskTimer = null;
}

function scheduleTask(task) {
  clearTaskTimer();
  if (!task || !task.armed) return;

  const delay = task.triggerAt - Date.now();
  if (delay <= 0) {
    void tryClickWithRetry(task.selector, "超时补触发");
    return;
  }

  taskTimer = setTimeout(() => {
    void tryClickWithRetry(task.selector, "定时触发");
  }, delay);
}

function disablePicker() {
  if (!pickerEnabled) return;
  pickerEnabled = false;
  if (cleanupPicker) cleanupPicker();
  cleanupPicker = null;
  if (hoverElement) {
    hoverElement.style.outline = "";
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
    }
    hoverElement = target;
    hoverElement.style.outline = "2px solid #ff5000";
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
      payload: {
        selector,
        text
      }
    }).catch(() => {});
  };

  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);

  cleanupPicker = () => {
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
  };
}

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
    clearTaskTimer();
    disablePicker();
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "RUN_NOW") {
    void tryClickWithRetry(message.payload.selector, "手动测试");
    sendResponse({ ok: true });
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!changes[STORAGE_KEY]) return;
  scheduleTask(changes[STORAGE_KEY].newValue);
});

async function bootTaskOnPageLoad() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const task = result[STORAGE_KEY];
  if (task?.armed) scheduleTask(task);
}

void bootTaskOnPageLoad();

