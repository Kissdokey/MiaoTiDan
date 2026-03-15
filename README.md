# Taobao Auto Submit Extension

Chrome extension for Taobao/Tmall order page auto-submit at a target local time.

## Features

- Pick the submit button directly from page UI (selector capture).
- Set an exact local datetime (supports millisecond input from `datetime-local`).
- Auto run click at target time with retry window (up to 10 seconds).
- Manual "click now" test.

## Install

1. Open Chrome and go to `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `taobao-auto-submit-extension`.

## How to use

1. Open Taobao order confirm page.
2. Open extension popup.
3. Click **在页面中选择按钮**, then click the order submit button on page.
4. Set **提交时间**.
5. Click **启动定时任务**.
6. Keep the order page open until task executes.

## Notes

- This script only simulates user click events; page behavior depends on Taobao page logic.
- If Taobao updates DOM structure, recapture selector before next run.
- Please use on your own account and follow platform rules.

