const STORAGE_KEYS = {
  apiKey: "ript_api_key",
  apiUrl: "ript_api_url",
  model: "ript_model",
  provider: "ript_provider",
  history: "ript_history"
};

const DEFAULT_API_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4o";

const apiUrlInput = document.querySelector("#apiUrl");
const apiKeyInput = document.querySelector("#apiKey");
const modelInput = document.querySelector("#modelName");
const statusEl = document.querySelector("#status");
const saveButton = document.querySelector("#saveKey");
const clearButton = document.querySelector("#clearKey");
const clearHistoryButton = document.querySelector("#clearHistory");
const viewAllHistoryButton = document.querySelector("#viewAllHistory");
const openSettingsButton = document.querySelector("#openSettings");
const backToMainButton = document.querySelector("#backToMain");
const historyTitle = document.querySelector("#historyTitle");
const historyList = document.querySelector("#historyList");

let viewMode = "main";

initPopup();

async function initPopup() {
  const settings = await chrome.storage.sync.get([
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.apiUrl,
    STORAGE_KEYS.model
  ]);

  apiUrlInput.value = settings[STORAGE_KEYS.apiUrl] || DEFAULT_API_URL;
  apiKeyInput.value = settings[STORAGE_KEYS.apiKey] || "";
  modelInput.value = settings[STORAGE_KEYS.model] || DEFAULT_MODEL;
  setStatus(settings[STORAGE_KEYS.apiKey] && settings[STORAGE_KEYS.apiUrl] && settings[STORAGE_KEYS.model]
    ? "已绑定，可通过图片悬浮菜单使用。"
    : "请填写 API URL、API Key 和模型名称。");

  await render();
}

openSettingsButton.addEventListener("click", async () => {
  viewMode = "settings";
  await render();
});

backToMainButton.addEventListener("click", async () => {
  viewMode = "main";
  await render();
});

viewAllHistoryButton.addEventListener("click", async () => {
  viewMode = viewMode === "history" ? "main" : "history";
  await render();
});

saveButton.addEventListener("click", async () => {
  const apiUrl = apiUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  const model = modelInput.value.trim();

  if (!apiUrl || !apiKey || !model) {
    setStatus("API URL、API Key 和模型名称都需要填写。", true);
    return;
  }

  if (!isValidHttpsUrl(apiUrl)) {
    setStatus("API URL 需要是完整的 https:// 地址。", true);
    return;
  }

  saveButton.disabled = true;
  saveButton.classList.add("is-loading");
  saveButton.textContent = "检测中...";
  setStatus("正在检测连接，请稍候。");

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "RIPT_TEST_SAVE_BINDING",
      apiUrl,
      apiKey,
      model
    });
  } catch (error) {
    saveButton.disabled = false;
    saveButton.classList.remove("is-loading");
    saveButton.textContent = "检测并绑定";
    setStatus(error?.message || "检测失败，请检查 API URL 和 Key。", true);
    return;
  }

  saveButton.disabled = false;
  saveButton.classList.remove("is-loading");
  saveButton.textContent = "检测并绑定";

  if (!response?.ok) {
    setStatus(response?.message || "检测失败，请检查 API URL 和 Key。", true);
    return;
  }

  setStatus(response.message || "检测成功，绑定已保存。");
});

clearButton.addEventListener("click", async () => {
  await chrome.storage.sync.remove([
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.apiUrl,
    STORAGE_KEYS.model,
    STORAGE_KEYS.provider
  ]);
  apiUrlInput.value = DEFAULT_API_URL;
  apiKeyInput.value = "";
  modelInput.value = DEFAULT_MODEL;
  setStatus("已清除绑定。");
});

clearHistoryButton.addEventListener("click", async () => {
  await chrome.storage.local.remove(STORAGE_KEYS.history);
  viewMode = "main";
  await render();
});

historyList.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;

  const item = button.closest("[data-history-id]");
  const id = item?.dataset?.historyId;
  if (!id) return;

  if (button.dataset.action === "copy") {
    await navigator.clipboard.writeText(button.dataset.text || "");
    button.textContent = "已复制";
    window.setTimeout(() => {
      button.textContent = "复制";
    }, 1200);
  }

  if (button.dataset.action === "delete") {
    const history = await getHistory();
    await chrome.storage.local.set({
      [STORAGE_KEYS.history]: history.filter((entry) => entry.id !== id)
    });
    await render();
  }
});

async function render() {
  const history = await getHistory();
  if (viewMode === "history" && history.length <= 5) {
    viewMode = "main";
  }

  document.body.classList.toggle("is-settings-view", viewMode === "settings");
  document.body.classList.toggle("is-history-view", viewMode === "history");

  clearHistoryButton.disabled = history.length === 0;
  viewAllHistoryButton.hidden = history.length <= 5;
  viewAllHistoryButton.textContent = viewMode === "history" ? "返回最近" : "查看全部";
  historyTitle.textContent = viewMode === "history" ? `全部历史 (${history.length})` : "历史记录";
  historyList.classList.toggle("is-full", viewMode === "history");

  renderHistory(history);
}

function renderHistory(history) {
  if (history.length === 0) {
    historyList.innerHTML = `
      <div class="ript-popup__empty">
        <span>暂无历史</span>
        <small>完成一次反推后会自动保存图片和提示词。</small>
      </div>
    `;
    return;
  }

  const visibleHistory = viewMode === "history" ? history : history.slice(0, 5);
  historyList.innerHTML = visibleHistory.map((item) => {
    const json = formatJsonText(item.json || "{}");
    const copyText = item.zh || item.en || json;
    const summary = item.zh || item.en || getHistorySummary(json);
    return `
      <article class="ript-history-item" data-history-id="${escapeHtml(item.id)}">
        <div class="ript-history-item__image">
          ${item.image
            ? `<img src="${escapeAttribute(item.image)}" alt="">`
            : `<span>无图</span>`}
        </div>
        <div class="ript-history-item__body">
          <div class="ript-history-item__meta">
            <span>${escapeHtml(formatDate(item.createdAt))}</span>
            <span>${escapeHtml(item.model || "")}</span>
          </div>
          <p>${escapeHtml(summary)}</p>
          <div class="ript-history-item__actions">
            <button type="button" data-action="copy" data-text="${escapeAttribute(copyText)}">复制</button>
            <button type="button" data-action="delete">删除</button>
          </div>
        </div>
      </article>
    `;
  }).join("");
}

async function getHistory() {
  const settings = await chrome.storage.local.get(STORAGE_KEYS.history);
  return Array.isArray(settings[STORAGE_KEYS.history])
    ? settings[STORAGE_KEYS.history]
    : [];
}

function getHistorySummary(json) {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed === "string") return parsed;
    const values = Object.values(parsed)
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value) => typeof value === "string" && value.trim());
    return values.slice(0, 3).join(" / ") || json;
  } catch {
    return json;
  }
}

function formatJsonText(value) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function formatDate(value) {
  const date = new Date(value || Date.now());
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function isValidHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.dataset.state = isError ? "error" : "ok";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
