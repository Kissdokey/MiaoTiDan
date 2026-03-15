const STORAGE_KEY = "autoSubmitTask";

// ─── DOM refs ───
const selectorInput = document.getElementById("selectorInput");
const timeInput = document.getElementById("timeInput");
const msInput = document.getElementById("msInput");
const pickedHint = document.getElementById("pickedHint");
const statusText = document.getElementById("statusText");
const pickBtn = document.getElementById("pickBtn");
const testBtn = document.getElementById("testBtn");
const armBtn = document.getElementById("armBtn");
const cancelBtn = document.getElementById("cancelBtn");
const countdownCard = document.getElementById("countdownCard");
const cdH = document.getElementById("cdH");
const cdM = document.getElementById("cdM");
const cdS = document.getElementById("cdS");
const cdMS = document.getElementById("cdMS");
const countdownStatus = document.getElementById("countdownStatus");
const currentTimeEl = document.getElementById("currentTime");

// Flash sale mode elements
const flashModeCheck = document.getElementById("flashModeCheck");
const flashOptions = document.getElementById("flashOptions");
const forceEnableCheck = document.getElementById("forceEnableCheck");
const autoRefreshCheck = document.getElementById("autoRefreshCheck");
const refreshAdvanceInput = document.getElementById("refreshAdvanceInput");
const refreshAdvanceRow = document.getElementById("refreshAdvanceRow");
const watchDomCheck = document.getElementById("watchDomCheck");

// ─── Flatpickr setup ───
let fp = null;
function initFlatpickr() {
  fp = flatpickr(timeInput, {
    enableTime: true,
    time_24hr: true,
    enableSeconds: true,
    dateFormat: "Y-m-d H:i:S",
    locale: "zh",
    theme: "dark",
    allowInput: true,
    disableMobile: true,
  });
}

// ─── Helpers ───
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function getSelectedTimestamp() {
  if (!fp || !fp.selectedDates || fp.selectedDates.length === 0) return NaN;
  const date = new Date(fp.selectedDates[0]);
  const ms = parseInt(msInput.value, 10) || 0;
  date.setMilliseconds(Math.max(0, Math.min(999, ms)));
  return date.getTime();
}

function setPickerFromTimestamp(ts) {
  if (!ts || !Number.isFinite(ts)) return;
  const d = new Date(ts);
  if (fp) fp.setDate(d, true);
  msInput.value = d.getMilliseconds();
}

function getFlashSaleConfig() {
  return {
    enabled: flashModeCheck.checked,
    forceEnable: forceEnableCheck.checked,
    autoRefresh: autoRefreshCheck.checked,
    refreshAdvanceMs: parseInt(refreshAdvanceInput.value, 10) || 500,
    watchDom: watchDomCheck.checked,
  };
}

function setFlashSaleConfig(cfg) {
  if (!cfg) return;
  flashModeCheck.checked = !!cfg.enabled;
  forceEnableCheck.checked = cfg.forceEnable !== false;
  autoRefreshCheck.checked = cfg.autoRefresh !== false;
  refreshAdvanceInput.value = cfg.refreshAdvanceMs || 500;
  watchDomCheck.checked = cfg.watchDom !== false;
  toggleFlashOptions();
}

const pad = (n, size = 2) => String(n).padStart(size, "0");

// ─── Flash sale UI toggle ───
function toggleFlashOptions() {
  flashOptions.style.display = flashModeCheck.checked ? "" : "none";
  refreshAdvanceRow.style.display = autoRefreshCheck.checked ? "" : "none";
}

flashModeCheck.addEventListener("change", toggleFlashOptions);
autoRefreshCheck.addEventListener("change", toggleFlashOptions);

// ─── Status rendering ───
function renderStatus(task) {
  statusText.classList.remove("armed", "idle", "done", "error");

  if (!task || !task.armed) {
    const result = task?.lastResult || "";
    if (result.includes("成功")) {
      statusText.textContent = `状态：${result}`;
      statusText.classList.add("done");
    } else if (result.includes("失败") || result.includes("取消")) {
      statusText.textContent = `状态：${result}`;
      statusText.classList.add("error");
    } else {
      statusText.textContent = "状态：未启动";
      statusText.classList.add("idle");
    }
    return;
  }

  const triggerAt = new Date(task.triggerAt);
  const timeStr = `${triggerAt.toLocaleDateString()} ${pad(triggerAt.getHours())}:${pad(triggerAt.getMinutes())}:${pad(triggerAt.getSeconds())}.${pad(triggerAt.getMilliseconds(), 3)}`;
  const modeTag = task.flashSale?.enabled ? " [抢购模式]" : "";
  statusText.textContent = `状态：已启动${modeTag} → ${timeStr}`;
  statusText.classList.add("armed");
}

// ─── Countdown timer ───
let countdownRaf = null;
let targetTimestamp = null;

function startCountdown(triggerAt) {
  targetTimestamp = triggerAt;
  countdownCard.style.display = "";
  countdownCard.classList.add("armed");
  countdownCard.classList.remove("expired");

  if (countdownRaf) cancelAnimationFrame(countdownRaf);
  tickCountdown();
}

function stopCountdown() {
  if (countdownRaf) {
    cancelAnimationFrame(countdownRaf);
    countdownRaf = null;
  }
  countdownCard.classList.remove("armed");
}

function hideCountdown() {
  stopCountdown();
  countdownCard.style.display = "none";
}

function tickCountdown() {
  const now = Date.now();
  let diff = targetTimestamp - now;

  if (diff <= 0) {
    cdH.textContent = "00";
    cdM.textContent = "00";
    cdS.textContent = "00";
    cdMS.textContent = "000";
    countdownCard.classList.add("expired");
    countdownCard.classList.remove("armed");
    countdownStatus.textContent = "⚡ 已到达目标时间，正在执行...";
    return;
  }

  const h = Math.floor(diff / 3600000);
  diff %= 3600000;
  const m = Math.floor(diff / 60000);
  diff %= 60000;
  const s = Math.floor(diff / 1000);
  const ms = diff % 1000;

  cdH.textContent = pad(h);
  cdM.textContent = pad(m);
  cdS.textContent = pad(s);
  cdMS.textContent = pad(ms, 3);
  countdownStatus.textContent = "🟢 任务运行中...";

  countdownRaf = requestAnimationFrame(tickCountdown);
}

// ─── Current time display ───
function tickCurrentTime() {
  const now = new Date();
  currentTimeEl.textContent =
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  requestAnimationFrame(tickCurrentTime);
}
tickCurrentTime();

// ─── Load saved task ───
async function loadTask() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const task = result[STORAGE_KEY];
  if (!task) return;

  selectorInput.value = task.selector || "";
  setPickerFromTimestamp(task.triggerAt);
  setFlashSaleConfig(task.flashSale);
  if (task.selector) {
    const textPart = task.pickedText ? `（${task.pickedText}）` : "";
    pickedHint.textContent = `已选择：${task.selector}${textPart}`;
  }
  renderStatus(task);

  if (task.armed && task.triggerAt > Date.now()) {
    startCountdown(task.triggerAt);
  }
}

// ─── Arm task ───
async function saveAndArmTask() {
  const selector = selectorInput.value.trim();
  const triggerAt = getSelectedTimestamp();

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

  const flashSale = getFlashSaleConfig();

  const task = {
    selector,
    triggerAt,
    armed: true,
    lastResult: "",
    flashSale,
  };

  await chrome.storage.local.set({ [STORAGE_KEY]: task });
  renderStatus(task);
  startCountdown(triggerAt);

  const tab = await getActiveTab();
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: "ARM_TASK", payload: task }).catch(() => {});
}

// ─── Cancel task ───
async function cancelTask() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const task = result[STORAGE_KEY] || {};
  task.armed = false;
  task.lastResult = "任务已取消";

  await chrome.storage.local.set({ [STORAGE_KEY]: task });
  renderStatus(task);
  hideCountdown();

  const tab = await getActiveTab();
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: "CANCEL_TASK" }).catch(() => {});
}

// ─── Pick selector ───
async function requestPickSelector() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    alert("无法获取当前标签页。");
    return;
  }

  const sendStartPicker = () => chrome.tabs.sendMessage(tab.id, { type: "START_PICKER" });
  const canInject = /^https?:\/\/.+\.(taobao|tmall)\.com\//i.test(tab.url || "");

  const started = await sendStartPicker().then(() => true).catch(async () => {
    if (!canInject) throw new Error("NOT_TAOBAO_PAGE");

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
    alert("脚本注入失败，请刷新订单页后重试。");
    return false;
  });

  if (started) {
    pickedHint.textContent = '🔍 已进入选择模式：请点击页面上的「提交订单」按钮';
  }
}

// ─── Test click ───
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
    payload: { selector, flashSale: getFlashSaleConfig() }
  }).catch(() => {
    alert("执行失败，请确认当前页面属于淘宝/天猫订单页。");
  });
}

// ─── Event listeners ───
pickBtn.addEventListener("click", requestPickSelector);
armBtn.addEventListener("click", saveAndArmTask);
cancelBtn.addEventListener("click", cancelTask);
testBtn.addEventListener("click", runTestClickNow);

// Listen for selector picked from content script
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "SELECTOR_PICKED") return;
  selectorInput.value = message.payload.selector || "";
  const textPart = message.payload.text ? `（${message.payload.text}）` : "";
  pickedHint.textContent = `✅ 已选择：${message.payload.selector}${textPart}`;
});

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]) return;
  const task = changes[STORAGE_KEY].newValue;
  if (!task) return;

  selectorInput.value = task.selector || "";
  if (task.selector) {
    const textPart = task.pickedText ? `（${task.pickedText}）` : "";
    pickedHint.textContent = `已选择：${task.selector}${textPart}`;
  }
  setFlashSaleConfig(task.flashSale);
  renderStatus(task);

  if (task.armed && task.triggerAt > Date.now()) {
    startCountdown(task.triggerAt);
  } else {
    if (!task.armed) hideCountdown();
  }
});

// ─── Init ───
initFlatpickr();
loadTask();
