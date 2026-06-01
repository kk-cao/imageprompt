const STORAGE_KEYS = {
  apiKey: "ript_api_key",
  apiUrl: "ript_api_url",
  model: "ript_model",
  provider: "ript_provider",
  history: "ript_history",
  historyLimit: "ript_history_limit",
  outputFormats: "ript_output_formats",
  historyMigrated: "ript_history_indexeddb_migrated"
};

const DEFAULT_API_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_HISTORY_LIMIT = 100;
const OUTPUT_FORMATS = ["zh", "en", "json"];
const DEFAULT_OUTPUT_FORMATS = [...OUTPUT_FORMATS];

const apiUrlInput = document.querySelector("#apiUrl");
const apiKeyInput = document.querySelector("#apiKey");
const modelInput = document.querySelector("#modelName");
const historyLimitInput = document.querySelector("#historyLimit");
const outputFormatInputs = Array.from(document.querySelectorAll(".ript-popup__format-options input[type='checkbox']"));
const statusEl = document.querySelector("#status");
const saveButton = document.querySelector("#saveKey");
const clearButton = document.querySelector("#clearKey");
const clearHistoryButton = document.querySelector("#clearHistory");
const importHistoryButton = document.querySelector("#importHistory");
const exportHistoryButton = document.querySelector("#exportHistory");
const importHistoryFileInput = document.querySelector("#importHistoryFile");
const viewAllHistoryButton = document.querySelector("#viewAllHistory");
const openSettingsButton = document.querySelector("#openSettings");
const backToMainButton = document.querySelector("#backToMain");
const extensionVersion = document.querySelector("#extensionVersion");
const historyTitle = document.querySelector("#historyTitle");
const historyList = document.querySelector("#historyList");
const historyDetail = document.querySelector("#historyDetail");
const historyDetailMeta = document.querySelector("#historyDetailMeta");
const historyDetailImage = document.querySelector("#historyDetailImage");
const historyDetailText = document.querySelector("#historyDetailText");
const closeHistoryDetailButton = document.querySelector("#closeHistoryDetail");
const copyHistoryDetailButton = document.querySelector("#copyHistoryDetail");
const historyRewriteInput = document.querySelector("#historyRewriteInput");
const historyRewriteButton = document.querySelector("#historyRewriteButton");
const historyRewriteStatus = document.querySelector("#historyRewriteStatus");

let viewMode = "main";
let activeHistoryId = "";
let activeDetailMode = "zh";
let activeDetailTexts = {
  zh: "",
  en: "",
  json: "{}"
};

initPopup();

async function initPopup() {
  await migrateLegacyHistory();

  extensionVersion.textContent = `v${chrome.runtime.getManifest().version}`;

  const settings = await getPopupSettings();

  apiUrlInput.value = settings.apiUrl || DEFAULT_API_URL;
  apiKeyInput.value = settings.apiKey || "";
  modelInput.value = settings.model || DEFAULT_MODEL;
  historyLimitInput.value = String(await getHistoryLimit());
  setOutputFormatInputs(settings.outputFormats);
  setStatus(settings.apiKey && settings.apiUrl && settings.model
    ? "已绑定，可通过图片右键菜单使用。"
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
  const historyLimit = parseHistoryLimitInput();
  const outputFormats = parseOutputFormatsInput();
  if (historyLimit === null) return;
  if (outputFormats === null) return;

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
    await saveHistoryLimit(historyLimit);
    await saveOutputFormats(outputFormats);
    response = await chrome.runtime.sendMessage({
      type: "RIPT_TEST_SAVE_BINDING",
      apiUrl,
      apiKey,
      model,
      outputFormats
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
    STORAGE_KEYS.provider,
    STORAGE_KEYS.outputFormats
  ]);
  await chrome.storage.local.remove(STORAGE_KEYS.apiKey);
  apiUrlInput.value = DEFAULT_API_URL;
  apiKeyInput.value = "";
  modelInput.value = DEFAULT_MODEL;
  setOutputFormatInputs(DEFAULT_OUTPUT_FORMATS);
  setStatus("已清除绑定。");
});

clearHistoryButton.addEventListener("click", async () => {
  const historyCount = await getHistoryCount();
  if (historyCount === 0) return;

  const confirmed = window.confirm(`确定清空全部 ${historyCount} 条历史记录吗？此操作无法撤销。`);
  if (!confirmed) return;

  await RiptHistoryStore.clear();
  viewMode = "main";
  await render();
});

exportHistoryButton.addEventListener("click", async () => {
  const history = await getAllHistory();
  if (history.length === 0) return;

  const blob = new Blob([JSON.stringify({
    exportedAt: new Date().toISOString(),
    version: 1,
    count: history.length,
    history
  }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ript-history-${formatExportDate(new Date())}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
});

importHistoryButton.addEventListener("click", () => {
  importHistoryFileInput.click();
});

importHistoryFileInput.addEventListener("change", async () => {
  const file = importHistoryFileInput.files?.[0];
  importHistoryFileInput.value = "";
  if (!file) return;

  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const entries = Array.isArray(payload) ? payload : payload.history;
    if (!Array.isArray(entries)) {
      window.alert("导入失败：文件中没有可识别的历史记录。 ");
      return;
    }

    const importedCount = await RiptHistoryStore.importEntries(entries);
    await RiptHistoryStore.enforceLimit(await getHistoryLimit());
    await render();
    window.alert(`已导入 ${importedCount} 条历史记录。`);
  } catch (error) {
    window.alert(error?.message || "导入失败，请检查 JSON 文件格式。");
  }
});

historyList.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;

  const item = button.closest("[data-history-id]");
  const id = item?.dataset?.historyId;
  if (!id) return;

  if (button.dataset.action === "open") {
    await openHistoryDetail(id);
  }

  if (button.dataset.action === "copy") {
    const mode = button.dataset.copyMode || "zh";
    const entry = await RiptHistoryStore.get(id);
    if (!entry) return;

    const text = getHistoryTextByMode(entry, mode);
    if (!text) return;

    await copyText(text);
    const originalText = button.textContent;
    button.textContent = "已复制";
    button.disabled = true;
    window.setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 1200);
  }

  if (button.dataset.action === "delete") {
    const summary = item.querySelector("p")?.textContent?.trim();
    const confirmed = window.confirm(summary
      ? `确定删除这条历史记录吗？\n\n${summary}`
      : "确定删除这条历史记录吗？");
    if (!confirmed) return;

    await RiptHistoryStore.remove(id);
    await render();
  }
});

closeHistoryDetailButton.addEventListener("click", closeHistoryDetail);

historyDetail.addEventListener("click", (event) => {
  if (event.target === historyDetail) {
    closeHistoryDetail();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !historyDetail.hidden) {
    closeHistoryDetail();
  }
});

historyDetail.querySelectorAll("[data-detail-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    if (tab.disabled) return;
    setHistoryDetailMode(tab.dataset.detailTab || "json");
  });
});

copyHistoryDetailButton.addEventListener("click", async () => {
  const text = historyDetailText.value || activeDetailTexts[activeDetailMode] || "";
  if (!text) return;

  await copyText(text);
  const originalText = copyHistoryDetailButton.textContent;
  copyHistoryDetailButton.textContent = "已复制";
  copyHistoryDetailButton.disabled = true;
  window.setTimeout(() => {
    copyHistoryDetailButton.textContent = originalText;
    copyHistoryDetailButton.disabled = false;
  }, 1200);
});

historyRewriteButton.addEventListener("click", async () => {
  const rewriteTarget = historyRewriteInput.value.trim();
  if (!activeHistoryId || !rewriteTarget) {
    setHistoryRewriteStatus("请输入调整目标。", true);
    return;
  }

  historyRewriteButton.disabled = true;
  historyRewriteInput.disabled = true;
  historyDetailText.disabled = true;
  historyRewriteButton.classList.add("is-loading");
  historyRewriteButton.textContent = "调整中";
  setHistoryRewriteStatus("正在同步调整提示词。", false);
  activeDetailTexts[activeDetailMode] = historyDetailText.value || activeDetailTexts[activeDetailMode] || "";
  const rewriteMode = activeDetailMode;

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "RIPT_REWRITE_JSON_PROMPT",
      format: rewriteMode,
      currentText: activeDetailTexts[rewriteMode] || historyDetailText.value,
      rewriteTarget
    });
  } catch (error) {
    restoreHistoryRewriteControls();
    setHistoryRewriteStatus(error?.message || "调整失败，请稍后重试。", true);
    return;
  }

  restoreHistoryRewriteControls();

  if (!response?.ok) {
    setHistoryRewriteStatus(response?.message || "调整失败，请稍后重试。", true);
    return;
  }

  const rewrittenText = response.text || "";
  if (rewriteMode === "json") {
    activeDetailTexts.json = formatJsonText(rewrittenText || activeDetailTexts.json || "{}");
  } else {
    activeDetailTexts[rewriteMode] = rewrittenText || activeDetailTexts[rewriteMode] || "";
  }
  historyDetailText.value = activeDetailTexts[activeDetailMode] || "";
  await updateHistoryEntry(activeHistoryId, activeDetailTexts);
  historyRewriteInput.value = "";
  setHistoryRewriteStatus("已调整当前格式并保存到历史。", false);
  await render();
});

async function render() {
  const historyCount = await getHistoryCount();
  if (viewMode === "history" && historyCount <= 5) {
    viewMode = "main";
  }
  const history = viewMode === "history"
    ? await getAllHistory()
    : await getHistory(5);

  document.body.classList.toggle("is-settings-view", viewMode === "settings");
  document.body.classList.toggle("is-history-view", viewMode === "history");

  clearHistoryButton.disabled = historyCount === 0;
  exportHistoryButton.disabled = historyCount === 0;
  viewAllHistoryButton.hidden = historyCount <= 5;
  viewAllHistoryButton.textContent = viewMode === "history" ? "返回最近" : "查看全部";
  historyTitle.textContent = viewMode === "history" ? `全部历史 (${historyCount})` : "历史记录";
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
    const json = item.json ? formatJsonText(item.json) : "";
    const summary = item.zh || item.en || (json ? getHistorySummary(json) : "未生成可复制内容");
    const zhDisabled = item.zh ? "" : " disabled";
    const enDisabled = item.en ? "" : " disabled";
    const jsonDisabled = json ? "" : " disabled";
    return `
      <article class="ript-history-item" data-history-id="${escapeHtml(item.id)}">
        <button class="ript-history-item__image" type="button" data-action="open" aria-label="查看历史详情">
          ${item.image
            ? `<img src="${escapeAttribute(item.image)}" alt="">`
            : `<span>无图</span>`}
        </button>
        <div class="ript-history-item__body">
          <div class="ript-history-item__meta">
            <span>${escapeHtml(formatDate(item.createdAt))}</span>
            <span>${escapeHtml(item.model || "")}</span>
          </div>
          <p>${escapeHtml(summary)}</p>
          <div class="ript-history-item__actions">
            <button type="button" data-action="copy" data-copy-mode="zh"${zhDisabled}>中文</button>
            <button type="button" data-action="copy" data-copy-mode="en"${enDisabled}>英文</button>
            <button type="button" data-action="copy" data-copy-mode="json"${jsonDisabled}>JSON</button>
            <button type="button" data-action="delete">删除</button>
          </div>
        </div>
      </article>
    `;
  }).join("");
}

async function openHistoryDetail(id) {
  const entry = await RiptHistoryStore.get(id);
  if (!entry) return;

  activeHistoryId = id;
  activeDetailTexts = {
    zh: entry.zh || "",
    en: entry.en || "",
    json: entry.json ? formatJsonText(entry.json) : ""
  };
  activeDetailMode = getFirstAvailableDetailMode(activeDetailTexts);

  historyDetailMeta.textContent = `${formatDate(entry.createdAt)}${entry.model ? ` · ${entry.model}` : ""}`;
  historyDetailImage.innerHTML = entry.image
    ? `<img src="${escapeAttribute(entry.image)}" alt="">`
    : "<span>无图</span>";
  historyRewriteInput.value = "";
  setHistoryRewriteStatus("", false);
  historyDetail.hidden = false;
  document.documentElement.classList.add("is-detail-open");
  document.body.classList.add("is-detail-open");
  setHistoryDetailMode(activeDetailMode, false);
  historyDetailText.focus();
}

function closeHistoryDetail() {
  activeHistoryId = "";
  historyDetail.hidden = true;
  document.documentElement.classList.remove("is-detail-open");
  document.body.classList.remove("is-detail-open");
  restoreHistoryRewriteControls();
}

function setHistoryDetailMode(mode, saveCurrent = true) {
  if (!hasDetailText(mode)) return;
  if (saveCurrent) {
    activeDetailTexts[activeDetailMode] = historyDetailText.value || activeDetailTexts[activeDetailMode] || "";
  }
  activeDetailMode = mode;
  historyDetail.querySelectorAll("[data-detail-tab]").forEach((tab) => {
    const tabMode = tab.dataset.detailTab || "zh";
    const available = hasDetailText(tabMode);
    tab.disabled = !available;
    tab.title = available ? "" : "该记录未生成此格式";
    tab.classList.toggle("is-active", tabMode === mode);
  });
  historyDetailText.value = activeDetailTexts[mode] || "";
  historyRewriteButton.disabled = !historyDetailText.value;
  historyRewriteInput.disabled = !historyDetailText.value;
  copyHistoryDetailButton.disabled = !historyDetailText.value;
  copyHistoryDetailButton.textContent = mode === "json" ? "复制 JSON" : mode === "en" ? "复制英文" : "复制中文";
}

function getFirstAvailableDetailMode(texts) {
  return texts.zh ? "zh" : texts.en ? "en" : texts.json ? "json" : "zh";
}

function hasDetailText(mode) {
  return Boolean(activeDetailTexts[mode]);
}

function restoreHistoryRewriteControls() {
  historyRewriteButton.disabled = false;
  historyRewriteInput.disabled = false;
  historyDetailText.disabled = false;
  historyRewriteButton.classList.remove("is-loading");
  historyRewriteButton.textContent = "同步调整";
}

function setHistoryRewriteStatus(message, isError) {
  historyRewriteStatus.textContent = message;
  historyRewriteStatus.dataset.state = isError ? "error" : "ok";
}

async function updateHistoryEntry(id, texts) {
  await RiptHistoryStore.update(id, {
    zh: texts.zh || "",
    en: texts.en || "",
    json: texts.json || ""
  });
}

function getHistoryTextByMode(entry, mode) {
  if (mode === "en") return entry.en || "";
  if (mode === "json") return entry.json ? formatJsonText(entry.json) : "";
  return entry.zh || "";
}

async function copyText(value) {
  await navigator.clipboard.writeText(value);
}

async function getHistory(limit) {
  return RiptHistoryStore.getRecent(limit);
}

async function getPopupSettings() {
  const syncSettings = await chrome.storage.sync.get([
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.apiUrl,
    STORAGE_KEYS.model,
    STORAGE_KEYS.outputFormats
  ]);
  const localSettings = await chrome.storage.local.get(STORAGE_KEYS.apiKey);
  const legacySyncApiKey = syncSettings[STORAGE_KEYS.apiKey];
  const localApiKey = localSettings[STORAGE_KEYS.apiKey];

  if (!localApiKey && legacySyncApiKey) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.apiKey]: legacySyncApiKey
    });
    await chrome.storage.sync.remove(STORAGE_KEYS.apiKey);
  }

  return {
    apiKey: localApiKey || legacySyncApiKey || "",
    apiUrl: syncSettings[STORAGE_KEYS.apiUrl] || "",
    model: syncSettings[STORAGE_KEYS.model] || DEFAULT_MODEL,
    outputFormats: normalizeOutputFormats(syncSettings[STORAGE_KEYS.outputFormats])
  };
}

function setOutputFormatInputs(formats) {
  const selected = new Set(normalizeOutputFormats(formats));
  outputFormatInputs.forEach((input) => {
    input.checked = selected.has(input.value);
  });
}

function parseOutputFormatsInput() {
  const selected = outputFormatInputs
    .filter((input) => input.checked)
    .map((input) => input.value);
  const formats = normalizeOutputFormats(selected, { allowDefault: false });
  if (formats.length === 0) {
    setStatus("至少需要选择一种生成格式。", true);
    return null;
  }
  return formats;
}

async function saveOutputFormats(formats) {
  await chrome.storage.sync.set({
    [STORAGE_KEYS.outputFormats]: normalizeOutputFormats(formats)
  });
}

function normalizeOutputFormats(value, options = {}) {
  const allowDefault = options.allowDefault !== false;
  const values = Array.isArray(value) ? value : [];
  const formats = OUTPUT_FORMATS.filter((format) => values.includes(format));
  return formats.length > 0 ? formats : allowDefault ? DEFAULT_OUTPUT_FORMATS : [];
}

async function getAllHistory() {
  return RiptHistoryStore.getAll();
}

async function getHistoryCount() {
  return RiptHistoryStore.count();
}

async function getHistoryLimit() {
  const settings = await chrome.storage.local.get(STORAGE_KEYS.historyLimit);
  const limit = Number(settings[STORAGE_KEYS.historyLimit]);
  return Number.isFinite(limit) ? limit : DEFAULT_HISTORY_LIMIT;
}

function parseHistoryLimitInput() {
  const rawValue = historyLimitInput.value.trim();
  if (!rawValue) return DEFAULT_HISTORY_LIMIT;

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0) {
    setStatus("最大历史数量需要填写 0 或正整数。", true);
    return null;
  }
  return value;
}

async function saveHistoryLimit(limit) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.historyLimit]: limit
  });
  await RiptHistoryStore.enforceLimit(limit);
}

async function migrateLegacyHistory() {
  const settings = await chrome.storage.local.get([
    STORAGE_KEYS.history,
    STORAGE_KEYS.historyMigrated,
    STORAGE_KEYS.historyLimit
  ]);
  if (settings[STORAGE_KEYS.historyMigrated]) return;

  const legacyHistory = Array.isArray(settings[STORAGE_KEYS.history])
    ? settings[STORAGE_KEYS.history]
    : [];
  if (legacyHistory.length > 0) {
    await RiptHistoryStore.importEntries(legacyHistory, { keepIds: true });
  }
  if (settings[STORAGE_KEYS.historyLimit] === undefined) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.historyLimit]: DEFAULT_HISTORY_LIMIT
    });
  }
  await chrome.storage.local.set({
    [STORAGE_KEYS.historyMigrated]: true
  });
  await chrome.storage.local.remove(STORAGE_KEYS.history);
  await RiptHistoryStore.enforceLimit(await getHistoryLimit());
}

function formatExportDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0")
  ].join("");
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
