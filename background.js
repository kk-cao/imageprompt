importScripts("history-db.js");

const MENU_ID = "reverse-image-prompt";
const STORAGE_KEYS = {
  apiKey: "ript_api_key",
  apiUrl: "ript_api_url",
  model: "ript_model",
  provider: "ript_provider",
  history: "ript_history",
  historyLimit: "ript_history_limit",
  outputFormats: "ript_output_formats"
};

const DEFAULT_API_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_HISTORY_LIMIT = 100;
const OUTPUT_FORMATS = ["zh", "en", "json"];
const DEFAULT_OUTPUT_FORMATS = [...OUTPUT_FORMATS];
const CONNECTION_TEST_TIMEOUT_MS = 20000;
const IMAGE_ANALYSIS_TIMEOUT_MS = 90000;
const pendingRequests = new Map();

chrome.runtime.onInstalled.addListener(setupContextMenu);
chrome.runtime.onStartup.addListener(setupContextMenu);

function setupContextMenu() {
  chrome.contextMenus.remove(MENU_ID, () => {
    chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "反推图片提示词",
      contexts: ["image"]
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id || !info.srcUrl) return;

  let clickPoint = { x: 120, y: 120 };
  try {
    await ensureContentScript(tab.id);
    clickPoint = await getLastImageContextPoint(tab.id);

    await startReverseImageFlow({
      tabId: tab.id,
      srcUrl: info.srcUrl,
      point: clickPoint
    });
  } catch (error) {
    await sendToTab(tab.id, {
      type: "RIPT_SHOW_ERROR",
      message: normalizeError(error),
      imagePreview: info.srcUrl,
      point: clickPoint
    }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const bindingMessageTypes = new Set([
    "RIPT_TEST_SAVE_BINDING",
    "RIPT_SAVE_BINDING_AND_RUN"
  ]);

  if (message?.type === "RIPT_ANALYZE_IMAGE") {
    const tabId = sender.tab?.id;
    const srcUrl = String(message.srcUrl || "").trim();
    if (!tabId || !srcUrl) {
      sendResponse({
        ok: false,
        message: "缺少图片地址，无法开始反推。"
      });
      return false;
    }

    startReverseImageFlow({
      tabId,
      srcUrl,
      point: message.point || { x: 120, y: 120 }
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({
        ok: false,
        message: normalizeError(error)
      }));
    return true;
  }

  if (message?.type === "RIPT_REWRITE_JSON_PROMPT") {
    handlePromptRewrite(message)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({
        ok: false,
        message: normalizeError(error)
      }));
    return true;
  }

  if (!bindingMessageTypes.has(message?.type)) return false;

  handleBindingMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({
      ok: false,
      message: normalizeError(error)
    }));

  return true;
});

async function handlePromptRewrite(message) {
  const { apiKey, apiUrl, model, outputFormats } = await getApiSettings();
  const format = normalizePromptFormat(message.format);
  const currentText = String(message.currentText || message.currentJson || "").trim();
  const rewriteTarget = String(message.rewriteTarget || "").trim();

  if (!apiKey || !apiUrl || !model) {
    throw new Error("请先绑定 API URL、API Key 和模型名称。");
  }

  if (!currentText || !rewriteTarget) {
    throw new Error("当前提示词和调整目标都不能为空。");
  }

  const rewritten = await rewritePromptText({
    apiKey,
    apiUrl,
    model,
    format,
    currentText,
    rewriteTarget
  });
  const text = format === "json"
    ? normalizeRewrittenJson(rewritten)
    : cleanupPlainText(rewritten);

  return {
    ok: true,
    format,
    text
  };
}

async function startReverseImageFlow({ tabId, srcUrl, point }) {
  const requestId = createRequestId();
  pendingRequests.set(tabId, {
    requestId,
    srcUrl,
    point,
    createdAt: Date.now()
  });

  const { apiKey, apiUrl, model, outputFormats } = await getApiSettings();

  if (!apiKey || !apiUrl || !model) {
    await sendToTab(tabId, {
      type: "RIPT_SHOW_BINDING",
      apiUrl: apiUrl || DEFAULT_API_URL,
      model,
      imagePreview: srcUrl,
      point
    });
    return;
  }

  await analyzeImage({
    tabId,
    requestId,
    srcUrl,
    point,
    apiKey,
    apiUrl,
    model,
    outputFormats
  });
}

async function handleBindingMessage(message, sender) {
  const tabId = sender.tab?.id;
  const apiUrl = String(message.apiUrl || "").trim();
  const apiKey = String(message.apiKey || "").trim();
  const model = String(message.model || DEFAULT_MODEL).trim();
  const outputFormats = normalizeOutputFormats(message.outputFormats);
  if (!apiUrl || !apiKey || !model) {
    throw new Error("API URL、API Key 和模型名称都需要填写。");
  }

  const workingEndpoint = await testApiConnection({ apiKey, apiUrl, model });

  await chrome.storage.sync.set({
    [STORAGE_KEYS.apiUrl]: workingEndpoint,
    [STORAGE_KEYS.model]: model,
    [STORAGE_KEYS.outputFormats]: outputFormats
  });
  await chrome.storage.local.set({
    [STORAGE_KEYS.apiKey]: apiKey
  });
  await chrome.storage.sync.remove([
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.provider
  ]);

  if (message.type === "RIPT_TEST_SAVE_BINDING") {
    return {
      ok: true,
      message: "检测成功，绑定已保存。"
    };
  }

  if (!tabId) {
    return {
      ok: true,
      message: "检测成功，绑定已保存。"
    };
  }

  const pending = pendingRequests.get(tabId);
  if (!pending) {
    return {
      ok: true,
      message: "绑定成功。请重新右键图片开始反推。"
    };
  }

  void analyzeImage({
    tabId,
    requestId: pending.requestId,
    srcUrl: pending.srcUrl,
    point: pending.point,
    apiKey,
    apiUrl: workingEndpoint,
    model,
    outputFormats
  });

  return { ok: true };
}

async function getApiSettings() {
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

async function testApiConnection({ apiKey, apiUrl, model }) {
  const endpoint = normalizeApiUrl(apiUrl);
  const resolved = await resolveWorkingEndpoint({ apiKey, endpoint, model, imageDataUrl: null, testOnly: true });
  return resolved.endpoint;
}

async function resolveWorkingEndpoint({ apiKey, endpoint, model, imageDataUrl, testOnly = false }) {
  const mode = detectApiMode(endpoint);
  const attempts = buildEndpointAttempts(endpoint, mode);
  let lastError = null;

  for (const attempt of attempts) {
    try {
      if (testOnly) {
        if (attempt.mode === "anthropic") {
          await testAnthropicMessages({ apiKey, endpoint: attempt.endpoint, model });
        } else if (attempt.mode === "chat") {
          await testChatCompletions({ apiKey, endpoint: attempt.endpoint, model });
        } else {
          await testResponses({ apiKey, endpoint: attempt.endpoint, model });
        }
      } else if (attempt.mode === "anthropic") {
        return {
          endpoint: attempt.endpoint,
          mode: attempt.mode,
          result: await callAnthropicMessages({ apiKey, endpoint: attempt.endpoint, model, imageDataUrl })
        };
      } else if (attempt.mode === "chat") {
        return {
          endpoint: attempt.endpoint,
          mode: attempt.mode,
          result: await callChatCompletions({ apiKey, endpoint: attempt.endpoint, model, imageDataUrl })
        };
      } else {
        return {
          endpoint: attempt.endpoint,
          mode: attempt.mode,
          result: await callResponses({ apiKey, endpoint: attempt.endpoint, model, imageDataUrl })
        };
      }

      return {
        endpoint: attempt.endpoint,
        mode: attempt.mode
      };
    } catch (error) {
      lastError = error;
      if (!isEndpointNotFoundError(error)) {
        throw error;
      }
    }
  }

  throw lastError || new Error("API URL 不存在，请检查接口路径。");
}

async function analyzeImage({ tabId, requestId, srcUrl, point, apiKey, apiUrl, model, outputFormats = DEFAULT_OUTPUT_FORMATS }) {
  let imagePreview = srcUrl;
  try {
    await sendProgress(tabId, point, 8, "准备读取图片", imagePreview);
    await sendProgress(tabId, point, 22, "正在转换图片", imagePreview);
    const imageDataUrl = await imageUrlToDataUrl(srcUrl);
    imagePreview = await createHistoryThumbnail(imageDataUrl, 360).catch(() => srcUrl);

    await sendProgress(tabId, point, 58, "正在请求 AI 分析", imagePreview);
    const result = await reverseImagePrompt({
      apiKey,
      apiUrl,
      model,
      imageDataUrl,
      outputFormats
    });

    await sendProgress(tabId, point, 92, "正在整理结果", imagePreview);
    await saveHistoryItem({
      srcUrl,
      model,
      result,
      imageDataUrl
    }).catch(() => {});
    if (!isCurrentPendingRequest(tabId, requestId)) return;
    await sendToTab(tabId, {
      type: "RIPT_SHOW_RESULT",
      result,
      imagePreview,
      point
    });
  } catch (error) {
    if (!isCurrentPendingRequest(tabId, requestId)) return;
    await sendToTab(tabId, {
      type: "RIPT_SHOW_ERROR",
      message: normalizeError(error),
      imagePreview,
      point
    });
  } finally {
    clearPendingRequest(tabId, requestId);
  }
}

function createRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isCurrentPendingRequest(tabId, requestId) {
  const pending = pendingRequests.get(tabId);
  return pending?.requestId === requestId;
}

function clearPendingRequest(tabId, requestId) {
  if (isCurrentPendingRequest(tabId, requestId)) {
    pendingRequests.delete(tabId);
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "RIPT_PING" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  }
}

async function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function sendProgress(tabId, point, percent, label, imagePreview = "") {
  await sendToTab(tabId, {
    type: "RIPT_SHOW_PROGRESS",
    percent,
    label,
    imagePreview,
    point
  });
}

async function saveHistoryItem({ srcUrl, model, result, imageDataUrl }) {
  const image = await createHistoryThumbnail(imageDataUrl).catch(() => "");
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    srcUrl,
    image,
    model,
    zh: result?.zh || "",
    en: result?.en || "",
    json: result?.json || ""
  };

  await saveHistoryWithFallback(item);
}

async function saveHistoryWithFallback(item) {
  const attempts = [item, { ...item, image: "" }];
  let lastError = null;

  for (const nextItem of attempts) {
    try {
      await RiptHistoryStore.put(nextItem);
      await RiptHistoryStore.enforceLimit(await getHistoryLimit());
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("History save failed.");
}

async function getHistoryLimit() {
  const settings = await chrome.storage.local.get(STORAGE_KEYS.historyLimit);
  const limit = Number(settings[STORAGE_KEYS.historyLimit]);
  return Number.isFinite(limit) ? limit : DEFAULT_HISTORY_LIMIT;
}

async function createHistoryThumbnail(imageDataUrl, maxSide = 144) {
  if (!imageDataUrl) return "";

  const response = await fetch(imageDataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close?.();
    return "";
  }

  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const thumbnailBlob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: 0.68
  });
  const base64 = await blobToBase64(thumbnailBlob);
  return `data:image/jpeg;base64,${base64}`;
}

async function getLastImageContextPoint(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "RIPT_GET_LAST_CONTEXT_POINT"
    });
    if (response?.point) return response.point;
  } catch {
    // Use the default point below if the page did not answer in time.
  }

  return { x: 120, y: 120 };
}

async function imageUrlToDataUrl(url) {
  if (url.startsWith("data:image/")) {
    return url;
  }

  const response = await fetch(url, {
    credentials: "include",
    cache: "force-cache"
  });

  if (!response.ok) {
    throw new Error(`图片读取失败：HTTP ${response.status}`);
  }

  const blob = await response.blob();
  const maxBytes = 8 * 1024 * 1024;
  if (blob.size > maxBytes) {
    throw new Error("图片过大，请换一张小于 8MB 的图片。");
  }

  const mimeType = blob.type || "image/png";
  const compressed = await compressImageBlob(blob).catch(() => null);
  if (compressed) return compressed;

  const base64 = await blobToBase64(blob);
  return `data:${mimeType};base64,${base64}`;
}

async function compressImageBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const maxSide = 896;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const outputBlob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: 0.76
  });

  const base64 = await blobToBase64(outputBlob);
  return `data:image/jpeg;base64,${base64}`;
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function reverseImagePrompt({ apiKey, apiUrl, model, imageDataUrl, outputFormats }) {
  const endpoint = normalizeApiUrl(apiUrl);
  const mode = detectApiMode(endpoint);
  const formats = normalizeOutputFormats(outputFormats);

  if (mode === "anthropic") {
    return callAnthropicMessages({
      apiKey,
      endpoint,
      model,
      imageDataUrl,
      outputFormats: formats
    });
  }

  if (mode === "responses") {
    return callResponses({
      apiKey,
      endpoint,
      model,
      imageDataUrl,
      outputFormats: formats
    });
  }

  const chatEndpoint = endpoint.includes("/chat/completions")
    ? endpoint
    : endpoint.replace(/\/responses\/?$/, "/chat/completions");
  return callChatCompletions({
    apiKey,
    endpoint: chatEndpoint,
    model,
    imageDataUrl,
    outputFormats: formats
  });
}

async function rewritePromptText({ apiKey, apiUrl, model, format, currentText, rewriteTarget }) {
  const endpoint = normalizeApiUrl(apiUrl);
  const mode = detectApiMode(endpoint);

  if (mode === "anthropic") {
    return rewritePromptWithAnthropicMessages({
      apiKey,
      endpoint,
      model,
      format,
      currentText,
      rewriteTarget
    });
  }

  if (mode === "chat") {
    return rewritePromptWithChatCompletions({
      apiKey,
      endpoint,
      model,
      format,
      currentText,
      rewriteTarget
    });
  }

  return rewritePromptWithResponses({
    apiKey,
    endpoint,
    model,
    format,
    currentText,
    rewriteTarget
  });
}

async function rewritePromptWithResponses({ apiKey, endpoint, model, format, currentText, rewriteTarget }) {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: getHeaders(apiKey),
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: getRewritePrompt({ format, currentText, rewriteTarget })
            }
          ]
        }
      ],
      temperature: 0.1,
      max_output_tokens: getRewriteMaxTokens(format)
    })
  }, IMAGE_ANALYSIS_TIMEOUT_MS);

  const payload = await parseJsonResponse(response);
  return cleanupJsonText(extractResponsesText(payload));
}

async function rewritePromptWithChatCompletions({ apiKey, endpoint, model, format, currentText, rewriteTarget }) {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: getHeaders(apiKey),
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        {
          role: "user",
          content: getRewritePrompt({ format, currentText, rewriteTarget })
        }
      ],
      max_tokens: getRewriteMaxTokens(format)
    })
  }, IMAGE_ANALYSIS_TIMEOUT_MS);

  const payload = await parseJsonResponse(response);
  return cleanupJsonText(payload?.choices?.[0]?.message?.content || "");
}

async function rewritePromptWithAnthropicMessages({ apiKey, endpoint, model, format, currentText, rewriteTarget }) {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: getAnthropicHeaders(apiKey),
    body: JSON.stringify({
      model,
      max_tokens: getRewriteMaxTokens(format),
      temperature: 0.1,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: getRewritePrompt({ format, currentText, rewriteTarget })
            }
          ]
        }
      ]
    })
  }, IMAGE_ANALYSIS_TIMEOUT_MS);

  const payload = await parseJsonResponse(response);
  return cleanupJsonText(extractAnthropicText(payload));
}

async function testResponses({ apiKey, endpoint, model }) {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: getHeaders(apiKey),
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "连接测试。请只回复 OK。"
            }
          ]
        }
      ],
      max_output_tokens: 16
    })
  }, CONNECTION_TEST_TIMEOUT_MS);

  await parseJsonResponse(response);
}

async function testChatCompletions({ apiKey, endpoint, model }) {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: getHeaders(apiKey),
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: "连接测试。请只回复 OK。"
        }
      ],
      max_tokens: 16
    })
  }, CONNECTION_TEST_TIMEOUT_MS);

  await parseJsonResponse(response);
}

async function testAnthropicMessages({ apiKey, endpoint, model }) {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: getAnthropicHeaders(apiKey),
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "连接测试。请只回复 OK。"
            }
          ]
        }
      ]
    })
  }, CONNECTION_TEST_TIMEOUT_MS);

  await parseJsonResponse(response);
}

function normalizeApiUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    throw new Error("请先填写 API URL。");
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("API URL 格式不正确，请填写完整的 https:// 地址。");
  }

  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");

  if (!url.pathname || url.pathname === "/") {
    if (isAnthropicEndpoint(url.toString())) {
      url.pathname = "/v1/messages";
    } else {
      url.pathname = isOfficialOpenAIEndpoint(url.toString()) ? "/v1/responses" : "/v1/chat/completions";
    }
  } else if (url.pathname === "/v1") {
    if (isAnthropicEndpoint(url.toString())) {
      url.pathname = "/v1/messages";
    } else {
      url.pathname = isOfficialOpenAIEndpoint(url.toString()) ? "/v1/responses" : "/v1/chat/completions";
    }
  }

  return url.toString();
}

function detectApiMode(endpoint) {
  if (isAnthropicEndpoint(endpoint) || endpoint.includes("/messages")) return "anthropic";
  return endpoint.includes("/chat/completions") ? "chat" : "responses";
}

function buildEndpointAttempts(endpoint, mode) {
  if (mode === "anthropic") {
    return [{ endpoint, mode }];
  }

  if (mode === "chat") {
    return [{ endpoint, mode }];
  }

  const fallback = endpoint.replace(/\/responses\/?$/, "/chat/completions");

  if (!isOfficialOpenAIEndpoint(endpoint) && fallback !== endpoint) {
    return [
      {
        endpoint: fallback,
        mode: "chat"
      },
      {
        endpoint,
        mode: "responses"
      }
    ];
  }

  const attempts = [{ endpoint, mode: "responses" }];
  if (fallback !== endpoint) {
    attempts.push({
      endpoint: fallback,
      mode: "chat"
    });
  }
  return attempts;
}

function isOfficialOpenAIEndpoint(endpoint) {
  try {
    const hostname = new URL(endpoint).hostname;
    return hostname === "api.openai.com";
  } catch {
    return false;
  }
}

function isAnthropicEndpoint(endpoint) {
  try {
    const hostname = new URL(endpoint).hostname;
    return hostname === "api.anthropic.com" || hostname.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}

function isEndpointNotFoundError(error) {
  return error?.status === 404 || /HTTP 404|not found|不存在/i.test(error?.message || "");
}

async function callResponses({ apiKey, endpoint, model, imageDataUrl, outputFormats = DEFAULT_OUTPUT_FORMATS }) {
  const formats = normalizeOutputFormats(outputFormats);
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: getHeaders(apiKey),
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: getPromptText(formats)
            },
            {
              type: "input_image",
              image_url: imageDataUrl,
              detail: "high"
            }
          ]
        }
      ],
      temperature: 0.1,
      max_output_tokens: getInitialMaxTokens(formats)
    })
  }, IMAGE_ANALYSIS_TIMEOUT_MS);

  const payload = await parseJsonResponse(response);
  return parseAIResponse(extractResponsesText(payload), formats);
}

async function callChatCompletions({ apiKey, endpoint, model, imageDataUrl, outputFormats = DEFAULT_OUTPUT_FORMATS }) {
  const formats = normalizeOutputFormats(outputFormats);
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: getHeaders(apiKey),
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: {
        type: "json_object"
      },
      messages: [
        {
          role: "system",
          content: "你是图像反推 JSON 助手。只输出合法 JSON 对象，不要解释。"
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: getPromptText(formats)
            },
            {
              type: "image_url",
              image_url: {
                url: imageDataUrl,
                detail: "high"
              }
            }
          ]
        }
      ],
      max_tokens: getInitialMaxTokens(formats)
    })
  }, IMAGE_ANALYSIS_TIMEOUT_MS);

  const payload = await parseJsonResponse(response);
  const text = payload?.choices?.[0]?.message?.content || "";
  return parseAIResponse(text, formats);
}

async function callAnthropicMessages({ apiKey, endpoint, model, imageDataUrl, outputFormats = DEFAULT_OUTPUT_FORMATS }) {
  const formats = normalizeOutputFormats(outputFormats);
  const image = parseDataImageUrl(imageDataUrl);
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: getAnthropicHeaders(apiKey),
    body: JSON.stringify({
      model,
      max_tokens: getInitialMaxTokens(formats),
      temperature: 0.1,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: getPromptText(formats)
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: image.mediaType,
                data: image.base64
              }
            }
          ]
        }
      ]
    })
  }, IMAGE_ANALYSIS_TIMEOUT_MS);

  const payload = await parseJsonResponse(response);
  return parseAIResponse(extractAnthropicText(payload), formats);
}

function getHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`
  };
}

function getAnthropicHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01"
  };
}

async function fetchWithTimeout(url, options, timeoutMs = IMAGE_ANALYSIS_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError" || /aborted/i.test(error?.message || "")) {
      throw new Error(`请求超时或连接中断，已等待 ${Math.round(timeoutMs / 1000)} 秒。`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function parseJsonResponse(response) {
  const text = await response.text().catch(() => "");
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {};
    }
  }
  if (!response.ok) {
    const fallbackMessage = text && !payload?.error?.message
      ? text.replace(/\s+/g, " ").trim().slice(0, 220)
      : "";
    const message = payload?.error?.message || fallbackMessage || `AI 请求失败：HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function cleanupJsonText(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] || trimmed).trim();
}

function cleanupPlainText(text) {
  const cleaned = cleanupJsonText(text).trim();
  const quoted = cleaned.match(/^"([\s\S]*)"$/);
  return (quoted ? quoted[1] : cleaned).trim();
}

function normalizeRewrittenJson(text) {
  const cleaned = cleanupJsonText(text);
  try {
    return JSON.stringify(JSON.parse(cleaned), null, 2);
  } catch {
    return cleaned;
  }
}

function parseDataImageUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    throw new Error("图片格式无法转换为 Claude 支持的 base64 输入。");
  }

  return {
    mediaType: match[1] || "image/jpeg",
    base64: match[2]
  };
}

function extractResponsesText(payload) {
  if (payload.output_text) return payload.output_text;

  const parts = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

function extractAnthropicText(payload) {
  const parts = [];
  for (const content of payload?.content || []) {
    if (content?.type === "text" && content.text) {
      parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function extractSection(text, startTitle, endTitle) {
  const escapedStart = escapeRegExp(`【${startTitle}】`);
  const escapedEnd = endTitle ? escapeRegExp(`【${endTitle}】`) : "$";
  const pattern = endTitle
    ? new RegExp(`${escapedStart}\\s*([\\s\\S]*?)\\s*${escapedEnd}`, "i")
    : new RegExp(`${escapedStart}\\s*([\\s\\S]*)`, "i");
  const match = text.match(pattern);
  return match?.[1]?.trim() || "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeError(error) {
  const message = error?.message || "未知错误，请稍后重试。";
  if (/401|api key|unauthorized|Incorrect API key/i.test(message)) {
    return "API Key 无效或权限不足，请检查后重试。";
  }
  if (/token|令牌|无效的令牌/i.test(message)) {
    return "API Key 或令牌无效，请确认 API URL 和 Key 来自同一个服务商。";
  }
  if (/rate limit|429/i.test(message)) {
    return "请求过于频繁或额度不足，请稍后重试。";
  }
  if (/无可用渠道|distributor|channel/i.test(message)) {
    return "当前模型在你的账号分组下没有可用渠道。请在绑定窗口把模型名称改成公司内部已开放的视觉模型。";
  }
  if (/too large|maximum|图片过大/i.test(message)) {
    return "图片过大，请换一张较小的图片。";
  }
  if (/HTTP 404|not found|不存在/i.test(message)) {
    return "API URL 路径不存在。请确认接口地址是否应填写为 /v1/chat/completions，很多第三方中转不支持 /v1/responses。";
  }
  if (/Failed to fetch|NetworkError/i.test(message)) {
    return "无法连接 API URL，请检查地址是否正确，或该接口是否允许浏览器扩展访问。";
  }
  if (/aborted|abort|请求超时|连接中断/i.test(message)) {
    return "AI 请求已等待 90 秒仍未返回。可能是图片较大、JSON 生成过长、模型渠道排队或接口网关超时，请稍后重试或换更快的视觉模型。";
  }
  return message;
}

function normalizeOutputFormats(value, options = {}) {
  const allowDefault = options.allowDefault !== false;
  const values = Array.isArray(value) ? value : [];
  const formats = OUTPUT_FORMATS.filter((format) => values.includes(format));
  return formats.length > 0 ? formats : allowDefault ? DEFAULT_OUTPUT_FORMATS : [];
}

function getInitialMaxTokens(outputFormats) {
  const formats = normalizeOutputFormats(outputFormats);
  const budget = formats.reduce((total, format) => {
    if (format === "json") return total + 1800;
    return total + 1300;
  }, 450);
  return Math.min(3600, Math.max(1600, budget));
}

function getPromptText(outputFormats = DEFAULT_OUTPUT_FORMATS) {
  const formats = normalizeOutputFormats(outputFormats);
  const fieldRules = [];
  if (formats.includes("zh")) {
    fieldRules.push("zh：中文自然语言提示词，适合直接复制到绘图工具。以一段紧凑但细节充分的自然语言覆盖主体、年龄/性别、外貌、表情、姿态、发型、服装、场景、背景、构图、光线、色彩、材质、摄影/绘画风格、镜头/景深、氛围和关键细节。");
  }
  if (formats.includes("en")) {
    fieldRules.push("en：英文自然语言提示词，信息量和 zh 对齐，适合直接复制到英文绘图工具。用紧凑自然的英文覆盖 subject, appearance, expression, pose, hair, clothing, scene, background, composition, lighting, colors, materials, style, camera/lens/depth of field, mood, key details。");
  }
  if (formats.includes("json")) {
    fieldRules.push("json：结构化对象，字段使用 subject, appearance, expression, pose, scene, composition, lighting, style, colors, camera, clothing, hair, accessories, environment, props, materials, mood, key_details, negative_details。字段值尽量使用中文短语、短句或数组，信息要细致、具体、可复现，但不要把同一细节在多个字段里反复展开成完整长句。");
  }

  return [
    "你是专业的图像反推提示词专家。请仔细观察图片，输出一个高保真、低冗余、可用于尽量复现原图的合法 JSON 对象，不要解释，不要 Markdown。",
    `JSON 顶层只允许包含这些字段：${formats.join("、")}。不要输出未选择的字段。`,
    [
      ...fieldRules,
      "没有看到的内容不要编造，可写空字符串、空数组或“不明显”。",
      "优先保留能影响复现的视觉细节，删除泛泛而谈的形容词堆叠；允许提示词较长，但必须提高信息密度，避免重复、废话和与图片无关的新设定。"
    ].join("\n")
  ].join("\n");
}

function parseAIResponse(text, outputFormats = DEFAULT_OUTPUT_FORMATS) {
  if (!text) {
    throw new Error("AI 没有返回可解析内容。");
  }

  const formats = normalizeOutputFormats(outputFormats);
  const cleaned = cleanupJsonText(text);
  try {
    const parsed = JSON.parse(cleaned);
    const jsonValue = parsed?.json_prompt || parsed?.json;
    return {
      zh: formats.includes("zh") ? String(parsed?.zh || parsed?.chinese || "").trim() : "",
      en: formats.includes("en") ? String(parsed?.en || parsed?.english || "").trim() : "",
      json: formats.includes("json") && jsonValue ? typeof jsonValue === "string"
        ? cleanupJsonText(jsonValue)
        : JSON.stringify(jsonValue, null, 2) : "",
      raw: text
    };
  } catch {
    if (formats.length === 1) {
      return {
        zh: formats[0] === "zh" ? cleaned : "",
        en: formats[0] === "en" ? cleaned : "",
        json: formats[0] === "json" ? cleanupJsonText(cleaned) : "",
        raw: text
      };
    }

    return {
      zh: formats.includes("zh") ? extractSection(text, "中文提示词", "英文提示词") : "",
      en: formats.includes("en") ? extractSection(text, "英文提示词", "JSON 格式的关键词标签") : "",
      json: formats.includes("json") ? cleanupJsonText(extractSection(text, "JSON 格式的关键词标签") || text || "") : "",
      raw: text
    };
  }
}

function normalizePromptFormat(format) {
  return ["zh", "en", "json"].includes(format) ? format : "zh";
}

function getRewriteMaxTokens(format) {
  return format === "json" ? 2200 : 1400;
}

function getRewritePrompt({ format, currentText, rewriteTarget }) {
  const formatLabel = format === "en" ? "英文自然语言提示词" : format === "json" ? "JSON 结构化提示词" : "中文自然语言提示词";
  const outputRule = format === "json"
    ? "只输出调整后的合法 JSON 对象，不要输出 zh/en 包装字段，不要解释，不要 Markdown。"
    : `只输出调整后的${formatLabel}正文，不要输出 JSON，不要解释，不要 Markdown。`;

  return [
    "你是专业的 AI 绘画提示词局部编辑助手。",
    `当前正在编辑的是：${formatLabel}。`,
    "根据用户的调整目标，对当前提示词做最小必要修改。",
    outputRule,
    "必须尽量保留原文本的表达顺序、结构、详细程度和未被要求修改的信息。",
    "只修改用户明确要求的内容，以及与该修改直接冲突、必须同步修正的少量细节。",
    "不要重写整段提示词，不要改变原来的写法风格，不要主动补充新设定，不要把提示词扩写成另一种格式。",
    "如果用户只要求替换主体属性，例如性别、年龄、服装或背景，只替换对应属性，并保留构图、光线、风格、镜头、氛围等原有描述。",
    `用户调整目标：${rewriteTarget}`,
    "当前提示词：",
    currentText
  ].join("\n");
}
