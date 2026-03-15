const STORAGE_KEY = "autoSubmitTask";

const selectorInput = document.getElementById("selectorInput");
const timeInput = document.getElementById("timeInput");
const pickedHint = document.getElementById("pickedHint");
const statusText = document.getElementById("statusText");
const pickBtn = document.getElementById("pickBtn");
const testBtn = document.getElementById("testBtn");
const armBtn = document.getElementById("armBtn");
const cancelBtn = document.getElementById("cancelBtn");

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function formatDateTimeForInput(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const pad = (n, size = 2) => String(n).padStart(size, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

function parseInputTimeToTimestamp(value) {
  if (!value) return NaN;
  const date = new Date(value);
  return date.getTime();
}

function renderStatus(task) {
  if (!task || !task.armed) {
    statusText.textContent = "状态：未启动";
    return;
  }

  const triggerAt = new Date(task.triggerAt);
  const result = task.lastResult ? `，最近结果：${task.lastResult}` : "";
  statusText.textContent = `状态：已启动，执行时间 ${triggerAt.toLocaleString()}${result}`;
}

async function loadTask() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const task = result[STORAGE_KEY];
  if (!task) return;

  selectorInput.value = task.selector || "";
  timeInput.value = formatDateTimeForInput(task.triggerAt);
  if (task.selector) {
    const textPart = task.pickedText ? `（${task.pickedText}）` : "";
    pickedHint.textContent = `已选择：${task.selector}${textPart}`;
  }
  renderStatus(task);
}

async function saveAndArmTask() {
  const selector = selectorInput.value.trim();
  const triggerAt = parseInputTimeToTimestamp(timeInput.value);

  if (!selector) {
    alert("请先设置提交按钮选择器。");
    return;
  }
  if (!Number.isFinite(triggerAt)) {
    alert("请先设置有效的提交时间。");
    return;
  }
  if (triggerAt <= Date.now()) {
    alert("提交时间必须晚于当前时间。");
    return;
  }

  const task = {
    selector,
    triggerAt,
    armed: true,
    lastResult: ""
  };

  await chrome.storage.local.set({ [STORAGE_KEY]: task });
  renderStatus(task);

  const tab = await getActiveTab();
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: "ARM_TASK", payload: task }).catch(() => {});
}

async function cancelTask() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const task = result[STORAGE_KEY] || {};
  task.armed = false;
  task.lastResult = "任务已取消";

  await chrome.storage.local.set({ [STORAGE_KEY]: task });
  renderStatus(task);

  const tab = await getActiveTab();
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: "CANCEL_TASK" }).catch(() => {});
}

async function requestPickSelector() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    alert("无法获取当前标签页。");
    return;
  }

  const sendStartPicker = () => chrome.tabs.sendMessage(tab.id, { type: "START_PICKER" });
  const canInject = /^https?:\/\/.+\.(taobao|tmall)\.com\//i.test(tab.url || "");

  const started = await sendStartPicker().then(() => true).catch(async () => {
    if (!canInject) {
      throw new Error("NOT_TAOBAO_PAGE");
    }

    // After extension reload/update, existing tabs may not have content script yet.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    await sendStartPicker();
    return true;
  }).catch((error) => {
    if (error?.message === "NOT_TAOBAO_PAGE") {
      alert("当前页面不是淘宝/天猫页面，请切到订单页后再试。");
      return false;
    }
    alert("当前页脚本注入失败。请刷新订单页后重试。");
    return false;
  });

  if (started) {
    pickedHint.textContent = "已进入选择模式：请到页面点击“提交订单”按钮，选完后重新打开插件查看结果。";
  }
}

async function runTestClickNow() {
  const selector = selectorInput.value.trim();
  if (!selector) {
    alert("请先设置按钮选择器。");
    return;
  }
  const tab = await getActiveTab();
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, {
    type: "RUN_NOW",
    payload: { selector }
  }).catch(() => {
    alert("执行失败，请确认当前页面属于淘宝/天猫订单页。");
  });
}

pickBtn.addEventListener("click", requestPickSelector);
armBtn.addEventListener("click", saveAndArmTask);
cancelBtn.addEventListener("click", cancelTask);
testBtn.addEventListener("click", runTestClickNow);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "SELECTOR_PICKED") return;

  selectorInput.value = message.payload.selector || "";
  pickedHint.textContent = `已选择：${message.payload.selector}`;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]) return;
  const task = changes[STORAGE_KEY].newValue;
  if (!task) return;

  selectorInput.value = task.selector || "";
  if (task.selector) {
    const textPart = task.pickedText ? `（${task.pickedText}）` : "";
    pickedHint.textContent = `已选择：${task.selector}${textPart}`;
  }
  renderStatus(task);
});

loadTask();

