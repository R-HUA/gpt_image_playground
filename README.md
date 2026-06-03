<div align="center">

# 🎨 GPT Image Playground

[![GitHub Repo stars](https://img.shields.io/github/stars/CookSleep/gpt_image_playground?style=flat-square&color=eab308)](https://github.com/CookSleep/gpt_image_playground/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/CookSleep/gpt_image_playground?style=flat-square&color=3b82f6)](https://github.com/CookSleep/gpt_image_playground/network/members)
[![License](https://img.shields.io/badge/license-MIT-10b981?style=flat-square)](https://github.com/CookSleep/gpt_image_playground/blob/main/LICENSE)
[![React](https://img.shields.io/badge/React-19-20232A?style=flat-square&logo=react&logoColor=61DAFB)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**基于 OpenAI gpt-image-2 API 的图片生成与编辑工具**

提供简洁精美的 Web UI，支持 OpenAI / OpenAI 兼容接口、fal.ai 与可导入的自定义 HTTP 服务商。<br>
支持文本生图、参考图与遮罩编辑，数据纯本地化存储，带来流畅的历史记录与参数管理体验。

<br>

[![Vercel 在线体验](https://img.shields.io/badge/Vercel-%E5%9C%A8%E7%BA%BF%E4%BD%93%E9%AA%8C-black?style=for-the-badge&logo=vercel&logoColor=white)](https://gpt-image-playground.cooksleep.dev)
&nbsp;&nbsp;&nbsp;
[![GitHub Pages 在线体验](https://img.shields.io/badge/GitHub%20Pages-%E5%9C%A8%E7%BA%BF%E4%BD%93%E9%AA%8C-222222?style=for-the-badge&logo=github&logoColor=white)](https://cooksleep.github.io/gpt_image_playground)

</div>

<br>

> 💡 **提示**：若需调用非 HTTPS 的内网或本地 HTTP API，请使用 GitHub Pages 版本或自行部署，Vercel 部署的体验版绑定的 `.dev` 域名因安全策略通常要求接口必须为 HTTPS。

---

## 📸 界面预览

<details>
<summary><b>点击展开截图展示</b></summary>
<br>

<div align="center">
  <b>桌面端主界面</b><br>
  <img src="docs/images/example_pc_1.jpg" alt="桌面端主界面" />
</div>

<br>

<div align="center">
  <b>任务详情与实际参数</b><br>
  <img src="docs/images/example_pc_2.jpg" alt="任务详情与实际参数" />
</div>

<br>

<div align="center">
  <b>桌面端批量选择</b><br>
  <img src="docs/images/example_pc_3.jpg" alt="桌面端批量选择" />
</div>

<br>

<div align="center">
  <b>桌面端 Agent 模式</b><br>
  <img src="docs/images/example_pc_4.jpg" alt="桌面端 Agent 模式" />
</div>

<br>

<div align="center">
  <b>移动端主界面</b><br>
  <img src="docs/images/example_mb_1.jpg" alt="移动端主界面" width="420" />
</div>

<br>

<div align="center">
  <b>移动端侧滑多选</b><br>
  <img src="docs/images/example_mb_2.jpg" alt="移动端侧滑多选" width="420" />
</div>

</details>

---

## ✨ 核心特性

### 🎨 强大的图像生成与编辑
- **参考图与遮罩**：支持上传最多 16 张参考图（支持剪贴板和拖拽）。内置可视化遮罩编辑器，自动预处理以符合官方分辨率限制。
- **批量与迭代**：支持单次多图生成；一键将满意结果转为参考图，无缝开启下一轮修改。
- **流式生成预览**：`Images API` 与 `Responses API` 模式均支持流式接收中间步骤图像，缓解连接超时问题。

### 🤖 Agent 多轮对话模式
- **多轮对话与上下文记忆**：基于 Responses API 的对话式生成，Agent 会理解上下文并按需调用图像工具；支持 `@` 引用参考图或前面轮次生成的图片，并自动识别上下文中的图片。
- **并发批量生成**：内置 `generate_image_batch` 工具，让 Agent 在一次轮次中并发生成多张关联图像，并通过 `continue_generation` 自动追加新一轮以处理依赖关系。
- **分支与重新生成**：编辑某轮消息重新发送或重新生成某轮消息会产生可切换的分支，引用解析严格限定在当前分支路径内，避免误用其他分支的图片。
- **画廊同步与隔离删除**：Agent 生成的图片会同步到画廊；删除对话默认保留画廊记录，删除画廊任务时也会自动清理对话中残留的图片引用。
- **可选 Web 搜索**：可开启 `web_search` 工具，Agent 会在需要时搜索网络信息并附带引用链接。

### ⚙️ 精细化参数追踪
- **智能尺寸控制**：提供 1K/2K/4K 快速预设，自定义宽高时会自动规整至模型安全范围（16 的倍数、总像素校验等）。
- **实际参数对比**：自动提取 API 响应中真实生效的尺寸、质量、耗时以及**模型改写后的提示词**，与你的请求参数高亮对比。支持定制化的参数列表横向平滑滚动体验。

### 📁 高效历史管理 (纯本地)
- **瀑布流与画廊**：历史任务自动保存，支持按状态过滤、全屏大图预览与快捷下载。
- **快捷批量操作**：桌面端支持鼠标拖拽框选、Ctrl/⌘ 连选，移动端支持顺滑侧滑多选；轻松实现批量收藏与清理。
- **优化的图片查看与下载**：大图预览支持左右滑动切换、移动端长按弹出操作菜单，支持快捷下载与批量下载。
- **极致性能与隐私**：所有记录与图片均存放在浏览器 IndexedDB 中（采用 SHA-256 去重压缩），不经过任何第三方服务器。支持一键打包导出 ZIP 备份。

### 🔌 多配置与服务商增强
- **多配置管理**：支持创建并保存多个 API 配置（包含服务商、API Key、模型等），按需快速切换；支持一键复制当前配置到列表底部，并通过拖拽对配置列表与服务商列表进行自定义排序。
- **多服务商接入**：内置 OpenAI 兼容接口（含 `Images API` 和 `Responses API`）、fal.ai（支持队列），并支持通过 JSON 导入自定义 HTTP 服务商配置（兼容同步/异步任务）。
- **API 代理**：OpenAI 兼容接口与 fal.ai 均可配置自定义代理。其中 OpenAI 兼容接口可开启同源 `/api-proxy/` 代理，交由 Docker 或本地开发环境转发至真实 API，绕开浏览器 CORS 限制。
- **Codex CLI 兼容模式**：对上游为 Codex CLI 的 API，开启后应用 Codex CLI 实际支持的参数，并将多图生成拆分为并发单图。
- **提示词防改写**：Responses API 会始终在请求文本前加入强制指令防止提示词被改写；开启 Codex CLI 模式后，Images API 也会获得同等保护。
- **智能诊断提示**：当检测到接口异常改写行为或缺少常规参数时，自动提示开启相应的兼容模式。
- **习惯配置**：支持设置提交后清空输入、重启后保留历史输入、临时复用历史任务 API 配置等。

---

## 🚀 部署与使用

项目提供两种部署模式：**纯前端静态部署**（无后端，API 请求直连上游）和 **全栈 Server 部署**（含 Node.js 后端，支持用户认证、图片存储与管理后台）。

---

### 🐳 Docker 全栈 Server 部署（推荐）

全栈模式包含 Node.js 后端，支持**用户登录认证**、**服务端图片存储与归档**、**Admin 管理后台**等完整功能。

#### 前置准备

**1. 创建用户配置文件**

复制示例文件并修改为你的用户名和密码：

```bash
cp config/users.example.json config/users.json
```

编辑 `config/users.json`：

```json
{
  "users": [
    {
      "username": "your-username",
      "password": "your-strong-password"
    }
  ]
}
```

> ⚠️ **务必修改默认的 `change-me` 密码**，否则任何看到默认配置的人都能登录。

**2. 创建环境变量文件（可选）**

复制环境变量示例并按需修改：

```bash
cp .env.docker.example .env
```

`.env` 文件完整变量说明：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `GIP_HTTP_PORT` | `8080` | 宿主机暴露的端口 |
| `GIP_GENERATION_CONCURRENCY` | `1` | 后端同时执行的图片生成任务数 |
| `GIP_CUSTOM_POLL_TIMEOUT_SECONDS` | `900` | 自定义异步服务商轮询超时（秒） |
| `GIP_ADMIN_API_KEY` | *(空)* | Admin 管理后台 API 密钥。为空时管理接口不可访问 |

#### 启动服务

```bash
docker compose up -d
```

`docker-compose.yml` 关键配置：

```yaml
services:
  gpt-image-playground:
    build:
      context: .
      dockerfile: deploy/Dockerfile.server
    image: gpt-image-playground:local
    container_name: gpt-image-playground
    restart: unless-stopped
    environment:
      PORT: "3000"
      GIP_DATA_DIR: /app/data
      GIP_USERS_CONFIG: /app/config/users.json
      GIP_GENERATION_CONCURRENCY: "${GIP_GENERATION_CONCURRENCY:-1}"
      GIP_CUSTOM_POLL_TIMEOUT_SECONDS: "${GIP_CUSTOM_POLL_TIMEOUT_SECONDS:-900}"
      GIP_ADMIN_API_KEY: "${GIP_ADMIN_API_KEY:-}"
    ports:
      - "${GIP_HTTP_PORT:-8080}:3000"
    volumes:
      - gip-data:/app/data          # 持久化数据库与图片
      - ./config:/app/config:ro      # 挂载用户配置（只读）
```

#### 环境变量详解（Server 模式）

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 容器内 Node.js 监听端口 |
| `GIP_DATA_DIR` | `/app/data` | 数据存储目录（SQLite 数据库 + 图片文件） |
| `GIP_USERS_CONFIG` | `/app/config/users.json` | 用户认证配置文件路径 |
| `GIP_GENERATION_CONCURRENCY` | `1` | 并发图片生成任务上限 |
| `GIP_CUSTOM_POLL_TIMEOUT_SECONDS` | `900` | 自定义异步服务商轮询超时 |
| `GIP_ADMIN_API_KEY` | *(空)* | Admin 管理后台密钥。设置后可通过 `/admin` 页面访问管理功能 |

#### Admin 管理后台

设置 `GIP_ADMIN_API_KEY` 后，访问 `http://<your-host>:<port>/admin` 即可进入管理后台。管理后台支持：

- 查看所有用户的生成图片（活跃与已删除）
- 按状态过滤、分页浏览
- 查看任务详情与实际 API 参数

#### 数据持久化

- **`gip-data` 卷**：存储 SQLite 数据库（用户数据、任务记录、图片元数据）和所有上传/生成的图片文件。删除此卷将丢失所有数据。
- **`config` 目录**：以只读方式挂载 `./config`，包含 `users.json` 用户认证文件。修改后重启容器生效。

#### 更新与升级

```bash
# 重新构建镜像并更新
docker compose build --no-cache
docker compose up -d

# 或拉取新镜像后更新（若使用预构建镜像）
docker compose pull && docker compose up -d
```

---

### 🐳 Docker 纯前端静态部署

仅部署前端静态文件（Nginx），无后端服务。所有 API 请求从浏览器直连上游，数据存储在用户浏览器 IndexedDB 中。

#### 环境变量说明

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEFAULT_API_URL` | *(空)* | 设置页面默认显示的 API 地址。也支持 `.json` 配置 URL 或带 `settings` 参数的分享 URL |
| `API_PROXY_URL` | *(空)* | API 代理实际转发的完整 API 基础地址。代理不会自动补 `/v1`，OpenAI 兼容接口需填至版本前缀 |
| `ENABLE_API_PROXY` | `false` | 设为 `true` 开启 Nginx 同源代理，解决浏览器 CORS 限制 |
| `LOCK_API_PROXY` | `false` | 设为 `true` 锁定前端 API 代理开关为开启状态，用户无法关闭 |
| `HOST` / `PORT` | `0.0.0.0:80` | 容器内 Nginx 监听的地址和端口 |

> ⚠️ **安全警告**：开启 API 代理后，任何人都能将你的服务器作为代理请求目标 API。建议仅在有访问控制或本地网络中开启。

#### CLI 启动示例

```bash
docker run -d -p 8080:80 \
  -e DEFAULT_API_URL=https://api.openai.com/v1 \
  -e ENABLE_API_PROXY=true \
  -e LOCK_API_PROXY=true \
  -e API_PROXY_URL=https://api.openai.com/v1 \
  ghcr.io/cooksleep/gpt_image_playground:latest
```

#### Docker Compose 示例

```yaml
services:
  gpt-image-playground:
    image: ghcr.io/cooksleep/gpt_image_playground:latest
    environment:
      - DEFAULT_API_URL=https://api.openai.com/v1
    ports:
      - "8080:80"
    restart: unless-stopped
```

#### 隐藏真实 API 地址

配合 `ENABLE_API_PROXY=true` 和 `LOCK_API_PROXY=true` 可将真实 API 地址保留在服务器侧：

```bash
docker run -d -p 8080:80 \
  -e DEFAULT_API_URL= \
  -e API_PROXY_URL=https://real-api.example.com/v1 \
  -e ENABLE_API_PROXY=true \
  -e LOCK_API_PROXY=true \
  ghcr.io/cooksleep/gpt_image_playground:latest
```

> 前端设置页只会显示空值或占位地址，真实 API 地址仅存在于服务器侧的 `API_PROXY_URL`。

#### 导入自定义服务商配置

`DEFAULT_API_URL` 除了填写普通 API 地址，也支持填写 `.json` 配置 URL 或带 `settings` 参数的分享 URL，页面启动后会自动导入自定义服务商和 API 配置。

#### 旧版兼容

旧版本的 `API_URL` 已拆分为 `DEFAULT_API_URL` + `API_PROXY_URL`。容器启动时会自动将遗留的 `API_URL` 作为两个新变量的兜底值。

---

### ▲ Vercel 一键部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FCookSleep%2Fgpt_image_playground&project-name=gpt-image-playground&repository-name=gpt-image-playground)

点击上方按钮导入仓库即可。在 Vercel 项目的 **Settings → Environment Variables** 中添加 `VITE_DEFAULT_API_URL`（如 `https://api.openai.com/v1`），然后重新部署即可生效。

> 💡 Vercel 仅支持前端静态部署，无后端服务。如需用户认证和数据持久化，请使用 Docker 全栈 Server 部署。

> 💡 **绑定自定义域名（国内直连）**：Vercel 默认分配的 `.vercel.app` 域名在国内通常无法直接访问，可在 **Settings → Domains** 中绑定自己的域名。

> 💡 **自动更新**：在 Vercel **Settings → Git → Deploy Hooks** 创建 Hook（Branch 填 `main`），将生成的 URL 存入 Fork 仓库的 GitHub Secret `VERCEL_DEPLOY_HOOK`，每次 Sync fork 后自动触发部署。

---

### ☁️ Cloudflare Workers 部署

项目已内置 Wrangler 配置，可将 Vite 构建产物作为 Cloudflare Workers 静态资源部署。

```bash
npx wrangler login
VITE_DEFAULT_API_URL=https://api.openai.com/v1 npm run deploy:cf
```

PowerShell 示例：

```powershell
npx wrangler login
$env:VITE_DEFAULT_API_URL="https://api.openai.com/v1"; npm run deploy:cf
```

> 💡 Workers 仅支持前端静态部署，无后端服务。

---

### 💻 本地开发与静态构建

**1. 环境准备与启动**

在项目根目录新建 `.env.local` 配置默认 API URL（如 `VITE_DEFAULT_API_URL=https://api.openai.com/v1`），然后：

```bash
npm install
npm run dev
```

**2. 本地开发跨域代理（可选）**

遇到浏览器 CORS 限制时，可开启本地代理转发：

```bash
cp dev-proxy.config.example.json dev-proxy.config.json
```

修改 `dev-proxy.config.json` 中的 `target` 为完整 API 地址（含 `/v1`），重启开发服务器后在页面设置中开启 **API 代理**。

**3. 本地故障模拟 API（可选）**

```powershell
npm run mock:api
```

详见 [本地故障模拟 API](docs/mock-image-api.md)。

**4. 构建静态产物**

```bash
npm run build
```

输出位于 `dist/` 目录，可部署至任意静态文件服务器。

---

## 🛠️ URL 传参快速填充

应用支持通过 URL 查询参数快速填入配置，非常适合创建书签或集成分享。根据你的服务商类型，选择对应的方式：

**方式一：标准 OpenAI 兼容服务商**
直接使用简短的查询参数配置：
- `?apiUrl=https://你的代理地址.com`
- `?apiKey=sk-xxxx`
- `?apiMode=images` 或 `?apiMode=responses`（未传时默认为 `images`）
- `?model=gpt-image-2`（未传时按 `apiMode` 使用默认模型）
- `?codexCli=true`（开启 Codex CLI 兼容模式）

例如，集成到 New API 的聊天系统：

```text
https://gpt-image-playground.cooksleep.dev?apiUrl={address}&apiKey={key}&model={model}
```

```text
https://cooksleep.github.io/gpt_image_playground?apiUrl={address}&apiKey={key}&model={model}
```

**方式二：自定义格式服务商**
如果需要导入自定义格式的 API 配置，请使用 `settings` 参数并传入 URL 编码后的完整 JSON：
- `?settings={URL编码后的JSON}`（只读取 `customProviders` 和 `profiles` 列表）

> 推荐先在项目内完成配置生成与导入：
>
> **设置 - API 配置 - 服务商类型 - 创建自定义服务商 - AI 一键生成与导入**
>
> 完成后可在 **API 配置 - 当前配置** 使用右侧快捷按钮：
>
> - **链接按钮**：复制可导入配置的 URL。复制时可选择不包含 API Key，并使用 `{address}`、`{key}`、`{model}` 等变量，便于在 New API 等平台中集成分享。
> - **复制按钮**：将当前配置复制一份到配置列表底部，新配置名称会追加“（复制）”。

JSON 结构示例：

```json
{
  "customProviders": [
    {
      "id": "custom-example-task",
      "name": "示例异步任务服务商",
      "submit": {
        "path": "images/generations",
        "method": "POST",
        "contentType": "json",
        "body": {
          "model": "$profile.model",
          "prompt": "$prompt",
          "size": "$params.size",
          "quality": "$params.quality",
          "output_format": "$params.output_format",
          "output_compression": "$params.output_compression",
          "n": "$params.n",
          "image_urls": "$inputImages.dataUrls"
        },
        "taskIdPath": "data.0.task_id"
      },
      "poll": {
        "path": "tasks/{task_id}",
        "method": "GET",
        "intervalSeconds": 5,
        "statusPath": "data.status",
        "successValues": ["completed"],
        "failureValues": ["failed", "cancelled"],
        "errorPath": "data.error.message",
        "result": {
          "imageUrlPaths": ["data.result.images.*.url.*"],
          "b64JsonPaths": []
        }
      }
    }
  ],
  "profiles": [
    {
      "name": "示例异步任务服务商",
      "provider": "custom-example-task",
      "baseUrl": "https://api.example.com/v1",
      "model": "example-image-model",
      "apiMode": "images"
    }
  ]
}
```

第三方服务商可以参考 [自定义服务商 LLM 提示词](docs/custom-provider-llm-prompt.md)，让 LLM 根据自己的 API 文档生成可导入的完整配置。导入后只需要在设置里补充 API Key。

---

## 💻 技术栈

<div align="center">
  <br>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React_19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React 19" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-B73BFE?style=for-the-badge&logo=vite&logoColor=FFD62E" alt="Vite" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwind_CSS_3-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white" alt="Tailwind CSS 3" /></a>
  <a href="https://zustand.docs.pmnd.rs/"><img src="https://img.shields.io/badge/Zustand-764ABC?style=for-the-badge&logo=react&logoColor=white" alt="Zustand" /></a>
  <br>
  <br>
</div>

## 📄 许可证 & 致谢

本项目基于 [MIT License](LICENSE) 开源。

特别致谢：[LINUX DO](https://linux.do)

## 💜 赞助支持

<div align="center">

如果这个项目对你有帮助，欢迎通过爱发电赞助支持，你的每一份鼓励都是持续更新的动力！

<br>
<br>

<a href="https://www.ifdian.net/a/cooksleep">
  <img src="https://img.shields.io/badge/%E7%88%B1%E5%8F%91%E7%94%B5-%E8%B5%9E%E5%8A%A9%E4%BD%9C%E8%80%85-946ce6?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0xMiAyMS4zNWwtMS40NS0xLjMyQzUuNCAxNS4zNiAyIDEyLjI4IDIgOC41IDIgNS40MiA0LjQyIDMgNy41IDNjMS43NCAwIDMuNDEuODEgNC41IDIuMDlDMTMuMDkgMy44MSAxNC43NiAzIDE2LjUgMyAxOS41OCAzIDIyIDUuNDIgMjIgOC41YzAgMy43OC0zLjQgNi44Ni04LjU1IDExLjU0TDEyIDIxLjM1eiIvPjwvc3ZnPg==&logoColor=white" alt="爱发电赞助" />
</a>

<br>
<br>

</div>

## ⭐ Star History

<div align="center">
  <a href="https://www.star-history.com/#CookSleep/gpt_image_playground&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=CookSleep/gpt_image_playground&type=Date&theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=CookSleep/gpt_image_playground&type=Date" />
      <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=CookSleep/gpt_image_playground&type=Date" />
    </picture>
  </a>
</div>
