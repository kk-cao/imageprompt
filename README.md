# 图片反推提示词浏览器插件

一个 Manifest V3 Chrome/Edge 扩展 MVP：右键网页图片，调用支持视觉输入的 AI 接口，反推中文提示词、英文提示词和 JSON 标签。

## 文件说明

- `manifest.json`：扩展权限、右键菜单、后台 service worker、content script 声明。
- `background.js`：右键菜单、API URL/Key 检查、图片 URL 转 Base64、AI 接口调用、进度通知。
- `popup.html` / `popup.js`：API URL、API Key、模型名称绑定、保存、清除。
- `content.js`：页面内绑定窗口、进度条、错误提示、结果浮窗、切换和复制按钮。
- `style.css`：popup 扁平风格样式。网页浮窗样式使用 Shadow DOM 内联隔离，避免污染原网页。

## 本地加载

1. 打开 Chrome/Edge 的扩展管理页。
2. 开启开发者模式。
3. 选择“加载已解压的扩展程序”。
4. 选择本目录：`C:\Users\18701\Documents\Codex\2026-05-05\new-chat-2`。
5. 在网页图片上右键，点击“反推图片提示词”。
6. 首次使用会直接在网页里弹出绑定窗口，填写 API URL、API Key 和模型名称后点击“检测并开始”。
7. 插件会先发送一次轻量连接测试，检测通过才保存绑定并继续分析图片。

也可以点击浏览器右上角扩展图标提前绑定或修改 API URL、API Key 和模型名称。

## API URL 规则

默认值是：

```text
https://api.openai.com/v1/responses
```

公司内部中转这类 base URL 也可以直接填写：

```text
https://new-api.jishu666.com/v1
```

也支持 OpenAI-compatible 的 Chat Completions 接口：

```text
https://your-api-host.example.com/v1/chat/completions
```

如果填写的是域名根路径或 `/v1`，扩展会自动补为 `/v1/responses`。如果该路径返回 404，扩展会自动尝试同域名的 `/v1/chat/completions`，这对很多第三方中转更友好。检测成功后会保存实际可用的完整接口地址。

模型名称默认是 `gpt-4o`，如果内部网关提示“无可用渠道”，请改成公司账号分组实际开放的视觉模型名称。

API Key 通过 `chrome.storage.sync` 保存在浏览器同步存储中，不会写入代码文件。
