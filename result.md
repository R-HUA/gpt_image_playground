This is a READ-ONLY planning task. DO NOT modify any files.You are investigating why adding images to the input area is slow, and why submitting tasks with images is also slow. Your perspective: Simplicity & Maintainability.Your task: Trace the COMPLETE image upload and submission pipeline in this codebase. Focus on understanding the data flow from user action to final storage/API call.Key areas to explore:
How images are added to the input bar (clipboard paste, drag-drop, file picker) - look in src/components/InputBar.tsx and related files
How images are processed after being added (resize, compression, conversion to data URL) - look in src/lib/canvasImage.ts, src/lib/mask.ts, src/lib/maskPreprocess.ts
How images are stored (client-side IndexedDB via src/lib/db.ts, server-side via src/lib/backendApi.ts)
How task submission works with images (src/lib/api.ts, src/lib/agentApi.ts) - what data format is sent
Image size handling - are images being converted to base64 data URLs? What's the typical size?
Any synchronous heavy operations on the main thread
Process:
Start by reading InputBar.tsx to find image add handlers
Follow the code path for image processing (canvas operations, data URL generation)
Check store.ts for how images are stored and managed
Check db.ts and backendApi.ts for storage operations
Check api.ts for submission payload construction
Look for any await chains, synchronous loops, or heavy computations
Required output format:
Exploration Summary: Key findings with specific file paths and line numbers
Approach Overview: Summary of bottlenecks found and optimization opportunities
Implementation Steps: Numbered tasks with specific file paths
Dependencies: Which steps depend on which
Risks and Mitigations
Critical Files: List 3-5 most critical files
已探索
12文件 34检索 6目录
Now I have a comprehensive understanding of the entire pipeline. Let me compile the analysis.
1. 探索总结：完整图片上传与提交管线追踪
阶段一：图片添加到输入栏
入口点（全部在 InputBar.tsx）：
入口  位置  调用链
剪贴板粘贴 handlePaste (L1337-1353)  → handleFiles (L1131)
拖拽放置  handleDrop (L1381-1411) → handleFiles (L1131)
文件选择器 handleFileUpload (L1218-1221) → handleFiles (L1131)
Agent 拖拽  handleDrop (L1400-1411) → ensureImageCached → addInputImage
处理链（store.ts + db.ts）：
handleFiles (InputBar.tsx:1131)
  └── for (const file of toAdd)           ← ⚠️ 串行循环，每张图片依次处理
       └── addImageFromFile(file)          (store.ts:5316-5320)
            └── createInputImageFromFile   (store.ts:5322-5328)
                 ├── fileToDataUrl(file)   (store.ts:5339-5346)
                 │    └── FileReader.readAsDataURL → 整个文件转 base64 字符串
                 │        ⚠️ 无压缩/无缩放，4K 图片可达 10-20MB+
                 │
                 └── storeImage(dataUrl, 'upload')  (db.ts:146-165)
                      ├── safeCreateImageThumbnail(dataUrl) (db.ts:176-196)
                      │    ├── new Image() + 加载完整 data URL  ⚠️ 主线程 DOM 操作
                      │    ├── canvas.getContext('2d') + drawImage
                      │    └── canvas.toDataURL('image/webp', 0.9)  ⚠️ 主线程编码
                      │
                      └── backendImages.store({dataUrl, thumbnail, ...})
                           └── POST /api/images/store (backendApi.ts:281-282)
                                ⚠️ 整个 data URL 作为 JSON body 发送
服务端存储（server/src/index.ts）：
POST /api/images/store (L2694-2734)
  ├── createStoredImageId(dataUrl, source)  (L720-723)
  │    └── createHash('sha256').update(dataUrl).digest('hex')
  │         ⚠️ 对整个 base64 字符串做 SHA-256，大图 CPU 密集
  │
  └── putStoredFile(...)  (L763-789)
       ├── dataUrlToBuffer(dataUrl)  (L685-693)
       │    └── Buffer.from(payload, 'base64')  ⚠️ 同步 base64 解码
       └── writeFileSync(absolute, bytes)  (L771)  ⚠️ 同步文件写入！
关键发现：原始图片不做任何压缩/缩放即存储。一张 4K 图片的 data URL 可达 ~15MB 字符串。
阶段二：任务提交
submitTask (store.ts:2627-2773) 调用链：
submitTask()
  ├── [如果有遮罩] validateMaskMatchesImage(maskDataUrl, imageDataUrl)  (L2676)
  │    └── 加载两张图片到 canvas，逐像素比较 alpha 通道  ⚠️ 主线程 CPU 密集
  │
  ├── [如果有遮罩] storeImage(maskDraft.maskDataUrl, 'mask')  (L2689)
  │    └── 又一次完整 storeImage 调用
  │
  ├── materializeInputImages(orderedInputImages)  (L2702) ← 🔴 核心瓶颈
  │    └── for (const image of images)  (store.ts:420-436)
  │         └── storeImage(image.dataUrl, 'upload')  ⚠️ 每张图片再次完整存储！
  │              包括：缩略图生成 + JSON POST + SHA-256 哈希 + 文件写入
  │              ❌ 图片在添加时已经存储过一次，这是冗余操作
  │
  └── enqueueGenerationTask(task, request)  (L2757)
       └── backendGeneration.createTask(...)  (backendApi.ts:262-263)
            └── POST /api/generation/tasks { task, request }
                 ⚠️ request 包含 inputImageIds（仅 ID，不含数据）
服务端生成工作线程（server/src/index.ts）：
executeGenerationJob (L1865-1940)
  └── executeGenerationRequest (L2451-2456)
       └── executeOpenAICompatibleImageApi (L2232-2292)
            ├── readTaskImageDataUrls(userId, inputImageIds)  (L2235)
            │    └── for each ID: readFileSync(filePath)  ⚠️ 同步文件读取
            │         + base64 编码重建 data URL  (L791-799)
            │
            └── 两种路径:
                 ├── [Responses API] → providerJsonRequest
                 │    └── 整个 data URL 列表作为 JSON body 发送  ⚠️ 巨大 JSON
                 │
                 └── [Images Edit API] → dataUrlToBuffer → FormData
                      ⚠️ 同步 base64 解码后作为 Blob 发送
阶段三：客户端 API 调用路径（死代码但值得注意）
executeTask (store.ts:4359-4500) 虽然定义了但当前未被调用，实际生成由服务端工作线程完成。客户端仅通过 refreshIncompleteTasks (L1994) 每 2 秒轮询状态。
2. 方法概述：瓶颈与优化机会
🔴 严重瓶颈
# 瓶颈  位置  影响
B1  materializeInputImages 冗余存储 store.ts:420-436, 2702  提交时对每张输入图重新执行完整 storeImage（缩略图+SHA-256+文件写入），而图片在添加时已存储。4 张图 = 4 次冗余完整存储周期
B2  原始图片零压缩 store.ts:5322-5328  一张 4000×3000 的 PNG 截图 data URL ≈ 15-20MB 字符串。所有后续操作（网络传输、SHA-256、base64 编解码）都处理这个巨大字符串
B3  服务端同步文件 I/O server/index.ts:771 (writeFileSync), 794 (readFileSync) 阻塞 Node.js 事件循环。并发用户时成为严重瓶颈
B4  服务端同步 SHA-256 server/index.ts:720-723 createHash('sha256').update(hugeDataUrlString) 对 15MB+ 字符串同步哈希，阻塞事件循环
🟡 中等瓶颈
# 瓶颈  位置  影响
B5  fileToDataUrl 主线程 FileReader  store.ts:5339-5346  将整个文件读为 base64 字符串。虽异步但占主线程内存
B6  缩略图生成主线程 Canvas db.ts:176-196 new Image() 加载完整 data URL + Canvas 操作，大图时导致 UI 卡顿
B7  图片添加串行处理  InputBar.tsx:1147-1148  for...of await 串行处理每张图片，4 张图 × 2 秒/张 = 8 秒阻塞
B8  blobToDataUrl 同步循环  imageApiShared.ts:84-94 String.fromCharCode 逐块循环 + btoa() 在大 buffer 上同步执行
B9  data URL ↔ Blob 反复转换  openaiCompatibleImageApi.ts:580-586 提交时 data URL → Image → Canvas → Blob，每次转换涉及 DOM 操作
数据流大小估算
一张典型 4K 截图（3840×2160 PNG）的完整流程：
原始文件: ~5MB
Data URL 字符串: ~6.7MB (base64 膨胀 33%)
SHA-256 处理: 对 6.7MB 字符串同步哈希
JSON 传输: ~7MB HTTP body（含 JSON 转义）
服务端 base64 解码: 6.7MB 字符串 → 5MB Buffer（同步）
磁盘写入: 5MB（同步 writeFileSync）
3. 实施步骤
Task 1: 消除 materializeInputImages 的冗余存储
文件: src/store.ts (L420-436, L2702)
操作: 输入图片在 createInputImageFromFile (L5322) 中已通过 storeImage 存储。materializeInputImages 应检查图片是否已存在（通过 backendImages.get(id) 或本地标记），仅对未持久化的图片（如从 Agent 拖拽的图片）执行存储
预期收益: 提交时间减少 50%+ (消除 N 次冗余 SHA-256 + 文件写入 + 缩略图生成)
Task 2: 添加图片时在客户端压缩/缩放
文件: src/store.ts (L5322-5328), 新增 src/lib/imageCompress.ts
操作: 在 createInputImageFromFile 中，使用 Canvas 或 createImageBitmap + OffscreenCanvas 将图片缩放到 API 可接受的最大尺寸（如 2048px 最长边），转为 JPEG/WebP 压缩格式。参考 maskPreprocess.ts:34-57 中 calculateMaskWorkingSize 的模式
预期收益: 图片体积从 ~7MB 降至 ~500KB-1.5MB，所有后续步骤加速 5-10×
Task 3: 将同步文件 I/O 改为异步
文件: server/src/index.ts (L763-789, L791-799, L903-908)
操作:
writeFileSync → await writeFile（从 node:fs/promises）
readFileSync → await readFile（从 node:fs/promises）
rowToDataUrl → async function rowToDataUrl
预期收益: 消除 Node.js 事件循环阻塞，提升并发性能
Task 4: SHA-256 改用异步 + 基于 Buffer 而非字符串
文件: server/src/index.ts (L720-723)
操作: 将 createHash('sha256').update(dataUrl) 改为对 base64 payload 的 Buffer 做哈希（更小更快），并使用 crypto.webcrypto.subtle.digest() 异步 API 或 worker thread
预期收益: 减少 CPU 阻塞时间
Task 5: 并行化图片添加
文件: src/components/InputBar.tsx (L1147-1148)
操作: 将 for (const file of toAdd) { await addImageFromFile(file) } 改为 await Promise.all(toAdd.map(f => addImageFromFile(f)))（或分批并发）
预期收益: 4 张图并行添加 vs 串行，总耗时从 ~8s 降至 ~2s
Task 6: 缩略图生成使用 OffscreenCanvas / Web Worker
文件: src/lib/db.ts (L176-196)
操作: 使用 createImageBitmap(blob) 代替 new Image() + OffscreenCanvas 代替 DOM Canvas，避免主线程阻塞。可考虑在 Web Worker 中执行
预期收益: 消除缩略图生成期间的主线程卡顿
Task 7: 优化 data URL 编解码
文件: src/lib/imageApiShared.ts (L84-94)
操作: blobToDataUrl 中的逐块 String.fromCharCode 循环 + btoa 替换为 FileReader.readAsDataURL(blob) 或使用 Blob → Response → arrayBuffer + 分段 base64 编码
预期收益: 避免大字符串拼接导致的主线程卡顿
Task 8: 服务端存储原始二进制而非 data URL
文件: server/src/index.ts (L685-693, L763-789, L791-799)
操作: 客户端发送图片时，先解码 data URL 为 Blob/ArrayBuffer，通过 multipart 或 binary POST 发送到服务端，避免服务端再做 base64 解码。服务端直接存储二进制文件
预期收益: 减少 ~33% 网络传输量，消除服务端 base64 解码开销
4. 依赖关系
Task 2 (客户端压缩) ── 前置 ──→ Task 1 (消除冗余存储)
                                  ↓
Task 5 (并行添加) ── 独立 ──→   加速效果叠加

Task 3 (异步文件 I/O) ── 独立 ──→ 服务端并发提升
Task 4 (异步 SHA-256) ── 依赖 ──→ Task 3 (同一文件改动)

Task 6 (OffscreenCanvas) ── 独立 ──→ 主线程流畅度
Task 7 (优化编解码) ── 独立 ──→ 减少卡顿

Task 8 (二进制传输) ── 重大重构 ──→ 影响 Task 1-4 的所有环节
推荐优先级: Task 1 → Task 2 → Task 5 → Task 3 → Task 6 → Task 4 → Task 7 → Task 8
5. 风险与缓解
风险  影响步骤  缓解措施
客户端压缩导致图片质量损失 Task 2  保留原始文件 hash 用于去重；对需要遮罩编辑的图片保留原始分辨率（参考 maskPreprocess.ts 的 DEFAULT_MASK_WORKING_MAX_EDGE=1920 模式）；提供"不压缩"选项
消除冗余存储导致去重失效  Task 1  storeImage 的 SHA-256 ID 机制依赖完整 dataUrl。如果跳过存储，需确保 ID 一致性。可改为在 createInputImageFromFile 中记录 alreadyStored: true 标记
异步文件 I/O 改变执行顺序 Task 3  确保 putStoredFile 中的 ensureParent 和 writeFile 原子性；使用文件锁或队列避免并发写入冲突
OffscreenCanvas 浏览器兼容性  Task 6  Safari 对 OffscreenCanvas 支持不完整；需 fallback 到主线程 Canvas
并行添加导致 UI 更新风暴  Task 5  使用 useStore.setState 批量更新而非逐张 addInputImage；限制并发数为 2-3
二进制传输是破坏性变更 Task 8  需要客户端和服务端同步升级；可先用 feature flag 灰度
6. 关键文件
src/store.ts (5347 行) — 核心状态管理，包含 addImageFromFile (L5316), createInputImageFromFile (L5322), materializeInputImages (L420), submitTask (L2627), storeImage 调用链。几乎所有瓶颈函数都在此文件中。
src/lib/db.ts (205 行) — 图片存储抽象层，storeImage (L146) 和 createImageThumbnail (L176) 定义了缩略图生成与服务端存储逻辑。
server/src/index.ts (~2870 行) — 服务端处理，putStoredFile (L763) 使用 writeFileSync，rowToDataUrl (L791) 使用 readFileSync，createStoredImageId (L720) 做同步 SHA-256。所有同步阻塞操作集中于此。
src/lib/openaiCompatibleImageApi.ts (1022 行) — API 调用层，callImagesApiSingle (L538) 做 data URL → Blob 转换链，createResponsesInput (L208) 将完整 data URL 嵌入 JSON body。
src/components/InputBar.tsx (2645 行) — 用户交互入口，handleFiles (L1131) 中的串行循环是添加多图时用户感知延迟的直接原因。



Guide
图片上传性能分析-性能可扩展
已完成
This is a READ-ONLY planning task. DO NOT modify any files.You are investigating performance bottlenecks in image handling. Your perspective: Performance & Scalability.Your task: Identify ALL performance-critical code paths related to image addition and task submission. Quantify potential bottlenecks.Key areas to explore:
Image processing pipeline - canvas operations, data URL generation, resize operations. Look in:
src/lib/canvasImage.ts (canvas operations)
src/lib/maskPreprocess.ts (mask preprocessing)
src/components/InputBar.tsx (paste/drop handlers)
src/components/MaskEditorModal.tsx (mask editing)
Data URL vs Blob usage - search for toDataURL, toBlob, dataUrl, base64, data:image across the src/ directory. Data URLs are ~33% larger than binary and block the main thread during conversion.
Storage pipeline performance:
src/lib/db.ts - how images are stored/retrieved
src/lib/backendApi.ts - upload API calls
Are there batch operations or is each image uploaded individually?
Task submission payload:
src/lib/api.ts - how input images are included in API requests
src/lib/agentApi.ts - agent mode image handling
src/lib/imageApiShared.ts - shared image API logic
Are all image data URLs included inline in the request body?
Main thread blocking:
Search for synchronous canvas operations, large base64 encoding
Search for createImageBitmap, drawImage, toDataURL usage
Check if any processing uses Web Workers or OffscreenCanvas
Thumbnail generation - search for thumbnail in src/ to understand when/how thumbnails are created
Process:
Grep for performance-sensitive APIs (toDataURL, toBlob, canvas, createImageBitmap)
Read the key files identified above
Measure data flow: how many times is an image copied/converted?
Check for redundant processing (same image processed multiple times)
Required output format:
Exploration Summary: Key findings with specific file paths and line numbers, including data sizes where relevant
Approach Overview: Performance bottleneck analysis
Implementation Steps: Numbered optimization tasks with specific file paths
Dependencies
Risks and Mitigations
Critical Files: List 3-5 most critical files
深度思考 · 2s
I'll start by exploring the project structure and then systematically investigate each performance-critical area.
已探索
2文件 2目录
Now let me read the remaining key files:
已探索
3文件
Now let me read InputBar.tsx and the API files:
已探索
3文件 2检索
Now let me look at InputBar.tsx paste/drop handlers and the actual API call implementations:
已探索
2文件 1检索
Now let me look at the InputBar paste handler in detail, and search for Web Workers, thumbnails, and the store.ts (image caching):
已探索
1文件 2检索
Let me check the handleFiles function in InputBar.tsx and the store.ts for image handling:
已探索
4检索
Now let me examine the full submitTask flow and how data URLs are collected for the API call:
已探索
1文件 2检索
Now let me check how the server resolves image data URLs for the actual API calls:
已探索
1文件 9检索 2目录
Let me now look at the MaskEditorModal to understand the mask pipeline:
已探索
1文件 3检索
Now let me check the image caching mechanism:
已探索
2检索
Now let me do one final check on the blobToDataUrl in imageApiShared.ts and check if there are any createImageBitmap uses:
已探索
2文件 1检索
Now I have a thorough understanding of all the performance-critical paths. Let me compile the comprehensive analysis.
图片处理性能瓶颈分析报告
1. 探索摘要 (Exploration Summary)
1.1 图片添加流程：File → DataURL → 全链路传播
入口点 (src/store.ts, 第5322-5345行)：
File → FileReader.readAsDataURL() → storeImage(dataUrl) → cacheImage() → InputImage
createInputImageFromFile (第5322行): 使用 FileReader.readAsDataURL() 将文件转换为 data URL。这是主线程同步阻塞操作，对于一张 10MB 的 PNG 图片，FileReader 会生成 ~13.3MB 的 base64 字符串。
每次添加图片都会立即调用 storeImage()（第5325行），该函数会：
调用 safeCreateImageThumbnail(dataUrl)（src/lib/db.ts 第147行）——创建 canvas、drawImage、toDataURL
发送 HTTP POST 到 /api/images/store，将整个 dataUrl 作为 JSON body 传输
1.2 Data URL 的全链路使用 —— 最核心的性能问题
关键发现：整个系统使用 data URL 作为图片数据的唯一传递格式。
阶段   文件   行号   操作   数据大小影响
文件上传 store.ts  5339-5345 FileReader.readAsDataURL(file)     原始二进制 → +33% base64
缩略图生成     db.ts     176-196   canvas.toDataURL('image/webp', 0.9)     主线程阻塞
存储上传 db.ts     146-165   POST /api/images/store (JSON body 含完整 dataUrl)    ~13.3MB JSON per 10MB image
内存缓存 store.ts  68-74     imageCache: Map<string, string> — 最多8条  8张×13.3MB = ~106MB 常驻内存
任务执行 store.ts  4391-4396 循环 ensureImageCached() 收集所有输入图片的 dataUrl     再次加载到内存
API 调用    openaiCompatibleImageApi.ts   579-606   编辑模式：dataUrl → Blob → FormData     二次转换开销
Responses API  openaiCompatibleImageApi.ts   969-1021  dataUrl 直接嵌入 JSON body input_image.image_url JSON body 膨胀
Agent API agentApi.ts    336-338   dataUrl 作为 input_image.image_url 嵌入     JSON body 膨胀
fal.ai    backendApi.ts  394-415   inputImageDataUrls 数组直接嵌入 JSON body     JSON body 膨胀
1.3 缩略图生成：主线程 Canvas 操作
src/lib/db.ts 第176-196行 — createImageThumbnail():
const image = await loadImage(dataUrl)          // Image 解码
const canvas = document.createElement('canvas')  // DOM Canvas 创建
canvas.width = Math.round(width * scale)         // 最大 720px
ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
canvas.toDataURL('image/webp', 0.9)             // 同步编码
这是主线程操作，每次新图片存储时执行
loadImage 创建 HTMLImageElement，依赖浏览器解码管线
缩略图版本控制 (THUMBNAIL_VERSION = 2)：版本不匹配时会重新生成（第96-97行）
1.4 遮罩编辑流水线：多次 DataURL 转换
src/components/MaskEditorModal.tsx + src/lib/maskPreprocess.ts:
加载阶段 (MaskEditorModal.tsx, 第489行):
dataUrl → prepareMaskTargetDataUrl() → loadImage() → Canvas drawImage (resize) → canvasToBlob() → blobToDataUrl()
maskPreprocess.ts 第59-89行：如果图片最长边 > 1920px，会经过 Canvas 缩放 → PNG Blob → 再转回 dataUrl。这产生了 3 次数据格式转换。
编辑阶段 (MaskEditorModal.tsx):
3 个独立 Canvas 元素（imageCanvas, maskCanvas, previewCanvas），同尺寸同分辨率
撤销栈保存 ImageData（第383行），最多 40 帧——对于 1920×1080 图片，每帧 ~8.3MB，栈最大 ~332MB
保存阶段 (MaskEditorModal.tsx, 第792-794行):
canvasToBlob(maskCanvas, 'image/png') → blobToDataUrl() → storeImage(sourceDataUrl, 'upload')
又一次 Blob → DataURL 转换，加上 storeImage 内部的 thumbnail 生成。
1.5 任务提交中的重复处理
src/store.ts 第2627-2773行 — submitTask():
遮罩验证 (第2676行): validateMaskMatchesImage() 加载两张图片到 Canvas，执行 getImageData 逐像素分析（canvasImage.ts 第56-71行）
输入图片 materialization (第2702行): materializeInputImages() 对每张输入图片再次调用 storeImage()，产生重复的 thumbnail 生成和网络请求
遮罩存储 (第2689行): storeImage(maskDraft.maskDataUrl, 'mask') — 又一次 dataUrl → thumbnail → HTTP POST
服务端 (server/src/index.ts):
图片读取 (第831-842行): readTaskImageDataUrls() 从 SQLite 读取完整 dataUrl
Data URL → Buffer 转换 (第685-693行): dataUrlToBuffer() 在服务端将 dataUrl 解码为 Buffer
编辑模式 FormData 构建 (第2269-2276行): Buffer → Blob → FormData —— 又一次转换
1.6 遮罩预览生成
src/lib/canvasImage.ts 第73-112行 — createMaskPreviewDataUrl():
加载 2 张图片 → 创建 3 个 Canvas → 逐像素循环处理 alpha 通道（第96-102行，for 循环遍历每个像素的 RGBA 4 字节）→ canvas.toDataURL('image/png')
对于 1920×1080 图片：循环迭代 ~207 万次，纯主线程 JavaScript 计算
1.7 无 Web Worker 或 OffscreenCanvas 使用
整个 src/ 目录中：
Web Worker: 0 处使用（仅有 Service Worker 注册 src/main.tsx 第11行，用于 PWA 缓存）
OffscreenCanvas: 0 处使用
createImageBitmap: 仅 1 处（src/lib/clipboard.ts 第103行，剪贴板复制操作）
所有图片处理均在主线程执行。
1.8 图片缓存内存影响
src/store.ts 第68-75行:
const imageCache = new Map<string, string>()  // dataUrl 字符串
const MAX_IMAGE_CACHE_ENTRIES = 8
8 条缓存 × 13.3MB (10MB 图片的 base64) = ~106MB 常驻堆内存
LRU 策略通过 Map 的 delete + set 实现（第163-180行），但单条 dataUrl 字符串本身可能非常大
2. 方法概述 (Approach Overview)
性能瓶颈可分为 5 个层级：
层级   严重程度 描述
L1: 数据格式膨胀     🔴 严重 全链路使用 data URL，比二进制大 33%，且每次 JSON 序列化/反序列化都需处理完整字符串
L2: 主线程阻塞 🔴 严重 Canvas 操作、FileReader、toDataURL、缩略图生成均在主线程——无 Worker 卸载
L3: 重复处理  🟡 中等 同一张图片在添加、提交、执行阶段被多次 storeImage → thumbnail 生成
L4: 内存压力  🟡 中等 全尺寸 dataUrl 字符串缓存、遮罩撤销栈的 ImageData 副本
L5: 序列化瓶颈 🟡 中等 大 JSON body（包含多张 dataUrl 图片）通过 HTTP 在前后端间传输
3. 实施步骤 (Implementation Steps)
Step 1: 引入 Blob/ArrayBuffer 替代 Data URL 作为内部数据格式
文件: src/store.ts (第5339-5345行), src/lib/db.ts, src/lib/imageApiShared.ts
内容: 使用 FileReader.readAsArrayBuffer() 或 File.arrayBuffer() 代替 readAsDataURL()。内部传递使用 Blob 对象，仅在需要显示（<img src>）时创建 URL.createObjectURL()。
预期收益: 减少 33% 内存占用，消除 base64 编码/解码开销
Step 2: 将缩略图生成移至 Web Worker
文件: src/lib/db.ts (第176-196行)
内容: 创建 thumbnail.worker.ts，使用 OffscreenCanvas + createImageBitmap() 在 Worker 中生成缩略图。主线程仅传递 ArrayBuffer/Blob，接收结果 Blob。
预期收益: 消除主线程阻塞，UI 不再卡顿
Step 3: 消除重复 storeImage 调用
文件: src/store.ts (第415-461行 materializeInputImages, 第438-461行 materializeInputImageIds)
内容: 在提交时检查图片是否已存储（通过 ID 比对），避免对已存储的图片重复调用 storeImage() 和 storeImage() 内部的 safeCreateImageThumbnail()。
预期收益: 提交延迟降低（减少 HTTP 请求和 Canvas 操作次数）
Step 4: 服务端改用文件路径而非 dataUrl 存储
文件: server/src/index.ts (第2694-2734行 /api/images/store, 第831-842行 readTaskImageDataUrls)
内容: 上传图片时服务端直接写入磁盘文件，后续 API 调用时从文件读取 Buffer 而非从 SQLite 读取完整 dataUrl JSON。客户端使用 multipart 上传 Blob 而非 JSON 发送 dataUrl。
预期收益: 减少 JSON 序列化/反序列化开销，降低 SQLite 存储膨胀
Step 5: 优化遮罩编辑器的 Canvas 操作
文件: src/lib/maskPreprocess.ts (第59-89行), src/components/MaskEditorModal.tsx (第489行, 第792-794行)
内容:
避免 prepareMaskTargetDataUrl 中 Blob → DataURL 的回转：直接保留 Blob
遮罩保存时直接传 Blob 到后端而非先转 DataURL
撤销栈存储压缩后的差异数据而非完整 ImageData（或限制为更低分辨率）
Step 6: 优化遮罩预览的像素级循环
文件: src/lib/canvasImage.ts (第73-112行 createMaskPreviewDataUrl)
内容: 将逐像素 alpha 循环替换为 Canvas composite operations（globalCompositeOperation），或使用 Uint32Array 视图代替 Uint8ClampedArray 进行 4 字节批量操作。
预期收益: 对于 1920×1080 图片，循环次数从 ~830 万次降至 ~207 万次（4× 加速），或接近 0（使用 composite）
Step 7: API 请求使用 multipart 而非 JSON 传输图片数据
文件: src/lib/openaiCompatibleImageApi.ts (第969-1021行 callResponsesImageApiSingle), src/lib/agentApi.ts (第596-651行)
内容: Responses API 和 Agent API 目前将 dataUrl 嵌入 JSON body。考虑改为 multipart 传输或引用服务端已存储的图片 ID/路径，避免大 JSON body 通过代理传输。
预期收益: 减少网络传输量 ~33%，降低 JSON 序列化开销
Step 8: 优化内存缓存策略
文件: src/store.ts (第68-75行, 第163-180行)
内容: 缓存使用 URL.createObjectURL() 引用而非完整 dataUrl 字符串。引入基于内存字节数的 LRU 上限（而非简单条目数），并增加弱引用或及时 revoke 机制。
预期收益: 内存占用从 ~106MB 降至 ~数 MB（仅缩略图缓存）
4. 依赖关系 (Dependencies)
步骤   前置依赖 说明
Step 2 (Worker 缩略图) Step 1 (Blob 格式)    Worker 接收 Blob/ArrayBuffer 而非 dataUrl
Step 3 (去重 storeImage)   无    可独立实施
Step 4 (服务端文件存储)    Step 1 (Blob 上传)    客户端需发送 Blob 而非 JSON dataUrl
Step 5 (遮罩优化)  Step 1 (Blob 格式)    遮罩管线使用 Blob 代替 dataUrl
Step 6 (像素循环)  无    可独立实施
Step 7 (multipart API)   Step 4 (服务端支持) 需要服务端配合
Step 8 (内存缓存)  Step 1 (Blob 格式)    缓存 URL.createObjectURL 引用
独立可实施的快速优化: Step 3 (去重), Step 6 (像素循环优化)
5. 风险与缓解 (Risks and Mitigations)
风险   影响   缓解策略
Blob URL 生命周期管理不当导致内存泄漏  内存增长 封装 revokeObjectURL() 到 useEffect cleanup 或 store 的 delete 回调中
OffscreenCanvas 浏览器兼容性   Safari < 16.4 不支持   提供 fallback：检测 OffscreenCanvas 支持，不支持时回退到主线程
Web Worker 中 Canvas 操作的错误处理   调试困难 Worker 通过 postMessage 传递结构化错误，包含 stack trace
服务端存储格式从 SQLite JSON 迁移到文件    数据迁移风险    渐进迁移：新图片用文件存储，旧图片保持 dataUrl 读取，提供迁移脚本
multipart API 与现有 provider proxy 的兼容性   代理透传问题    已有 providerMultipartFetch 机制（backendApi.ts 第331-356行），复用现有 multipart 代理通道
遮罩撤销栈差异压缩的复杂度  实现成本高     可先用更简单方案：限制撤销栈深度为 20 或使用较小工作分辨率
6. 关键文件 (Critical Files)
src/store.ts — 核心状态管理，图片缓存（第68行）、文件上传入口（第5316-5345行）、任务提交（第2627行）、任务执行（第4359行）的 dataUrl 全链路汇聚点。最大的性能影响文件。
src/lib/db.ts — 缩略图生成（第176-196行，主线程 Canvas 操作）、storeImage() 函数（第146行，每次图片添加都触发）
src/lib/openaiCompatibleImageApi.ts — API 调用时图片格式转换（dataUrl→Blob→FormData，第579-606行）和 Responses API 的 dataUrl 内嵌 JSON（第969-1021行）
src/lib/canvasImage.ts — 所有 Canvas 操作的基础设施：图片加载、格式转换、遮罩验证（逐像素循环）、遮罩预览生成
src/components/MaskEditorModal.tsx — 遮罩编辑器的完整管线：3 个 Canvas、撤销栈的 ImageData 内存占用、加载时的多次格式转换


This is a READ-ONLY planning task. DO NOT modify any files.You are investigating image handling performance with a focus on minimal-risk optimizations. Your perspective: Minimal Change & Risk Reduction.Your task: Find the LOWEST-RISK, HIGHEST-IMPACT optimizations for image upload and task submission speed.Key areas to explore:
What happens when a user pastes or drops an image into the input bar?
Read src/components/InputBar.tsx - find paste/drop event handlers
What processing happens before the image appears in the UI?
Is there any blocking work that makes the UI feel unresponsive?
Image preprocessing chain:
Read src/lib/canvasImage.ts completely
What resize/compression settings are used?
Are there unnecessary quality levels or redundant passes?
Server-side image storage:
Read server/src/index.ts - find the image store endpoint (search for '/api/images/store')
How does the server handle incoming data URLs?
Is there any server-side processing bottleneck?
Thumbnail pipeline:
When are thumbnails generated? (search for 'thumbnail' in src/lib/db.ts and InputBar.tsx)
Is thumbnail generation blocking the UI?
Are thumbnails generated on the client or server?
Task submission:
Read src/lib/api.ts - how are images sent to the API?
Are images sent as data URLs or file uploads?
How many images can be in a single request?
Check the server-side generation handler:
Read server/src/index.ts - search for 'generation' route handlers
How does the server forward images to upstream APIs (OpenAI, fal.ai)?
Any conversion or processing on the server side?
Process:
Read the key files completely
Map the exact sequence of operations from paste → display → store → submit → upstream API
Identify which operations are on the critical path (user waits for them)
Identify which operations could be deferred, parallelized, or eliminated
Required output format:
Exploration Summary: Key findings with specific file paths and line numbers
Approach Overview: Safest high-impact optimizations
Implementation Steps: Numbered tasks with specific file paths, ordered by risk (lowest first)
Dependencies
Risks and Mitigations
Critical Files: List 3-5 most critical files
已探索
9文件 27检索
现在我已经全面分析了整个图片处理管线。下面是完整的规划报告：
图片处理性能优化规划 — 最小变更 & 风险降低视角
1. 探索摘要：关键发现
完整操作序列（粘贴 → 显示 → 存储 → 提交 → 上游 API）
粘贴/拖拽 File
  → fileToDataUrl(file)             [FileReader, 异步]
  → safeCreateImageThumbnail(dataUrl) [Canvas 缩略图生成, 阻塞]
  → backendImages.store(...)          [POST /api/images/store, 发送完整 dataUrl + 缩略图]
    → server: dataUrlToBuffer → writeFileSync → SQLite INSERT  [同步 I/O]
  → cacheImage(id, dataUrl)           [内存缓存]
  → addInputImage({ id, dataUrl })    [此时图片才出现在 UI]
  
提交任务:
  → materializeInputImages(orderedInputImages) [再次调用 storeImage 对每张图做一遍]
  → enqueueGenerationTask(task, request)        [POST /api/generation/tasks, 只发送 ID]
  
服务端生成:
  → readTaskImageDataUrls(userId, ids)  [从磁盘读回完整 dataUrl]
  → 转发至 OpenAI/fal.ai（edit 时再 dataUrl→Blob 转换）
发现 1：UI 显示被整个管线阻塞（关键路径）
文件：src/components/InputBar.tsx 第 1147-1149 行
多文件使用 for...of + await 串行处理，每张图片必须完成全部管线（读文件 → 缩略图 → 服务器存储）后，下一张才开始
图片只有在 addInputImage 调用后才出现在 UI（store.ts 第 5319 行）
影响：粘贴 3 张大图时，用户可能需要等待 3-6 秒才能看到第一张
发现 2：缩略图在上传前阻塞生成
文件：src/lib/db.ts 第 146-165 行
storeImage() 在发送服务器请求前同步等待 safeCreateImageThumbnail()
缩略图配置（第 4-6 行）：THUMBNAIL_MAX_SIZE = 720，THUMBNAIL_QUALITY = 0.9（WebP）
720px + 0.9 quality 对于列表中的小缩略图展示来说过大过高质量
发现 3：materializeInputImages 重复存储
文件：src/store.ts 第 420-435 行
提交任务时对每张输入图片再次调用 storeImage(image.dataUrl, 'upload')
如果图片已经通过 addImageFromFile 存储过，这会触发又一次完整的 缩略图生成 + HTTP POST + 服务器磁盘写入
虽然服务端有去重逻辑（createStoredImageId 基于 SHA-256），但客户端仍会发送完整数据
发现 4：服务端同步 I/O 阻塞事件循环
文件：server/src/index.ts 第 771 行 writeFileSync(absolute, bytes)
第 794 行 readFileSync(absolute)（读取时）
大图（5-20MB）的同步读写会阻塞 Node.js 事件循环，影响并发请求处理
发现 5：生成时图片从磁盘重新读取
文件：server/src/index.ts 第 831-841 行
readTaskImageDataUrls 对每张输入图片逐个从磁盘读取并重新编码为 base64 dataUrl
对于 16 张大图（API 上限），这是 16 次同步 readFileSync + base64 编码
发现 6：Edit 模式下多余的 dataUrl→Blob 转换
文件：src/lib/openaiCompatibleImageApi.ts 第 579-586 行
客户端 edit 请求对每张输入图做 dataUrlToBlob() 或 imageDataUrlToPngBlob()
dataUrlToBlob 使用 fetch(dataUrl) 转换（第 22-26 行 canvasImage.ts）
imageDataUrlToPngBlob 会加载完整图片到 Canvas 再导出 PNG（第 28-37 行），对于大图非常耗时
发现 7：blobToDataUrl 手动拼接效率低
文件：src/lib/imageApiShared.ts 第 84-94 行
使用 for 循环 + String.fromCharCode 逐 32KB 块拼接二进制字符串，再 btoa 编码
对大图片（10MB+）这是 CPU 密集操作
2. 方法概述：最安全的高影响优化
按风险从低到高排序：
优先级  优化项  预期影响 风险级别
P0   即时 UI 反馈（先显示占位/原图，后台处理）  ⭐⭐⭐⭐⭐     极低
P1   缩小缩略图尺寸 + 降低质量 ⭐⭐⭐⭐ 极低
P2   并行处理多文件上传 ⭐⭐⭐⭐ 低
P3   materializeInputImages 去重短路   ⭐⭐⭐  低
P4   服务端异步文件 I/O    ⭐⭐⭐  低-中
P5   服务端生成前图片内存缓存   ⭐⭐   低
3. 实施步骤（按风险从低到高排列）
步骤 1：即时 UI 反馈 — 先显示图片，后台存储
风险：极低 | 影响：极高
文件：src/components/InputBar.tsx（第 1131-1163 行）、src/store.ts（第 5316-5328 行）当前流程：
file → fileToDataUrl → storeImage(含缩略图+网络) → cacheImage → addInputImage → UI显示
优化流程：
file → fileToDataUrl → addInputImage(立即显示) → 后台: storeImage → cacheImage
具体变更：
修改 createInputImageFromFile（store.ts 第 5322 行）：先返回 { id: tempId, dataUrl } 供 UI 立即显示
将 storeImage 放到后台执行（不 await），完成后用真实 ID 替换临时 ID
或者更简单：在 handleFiles（InputBar.tsx 第 1147 行）中，先用 URL.createObjectURL(file) 立即显示占位图，后台完成存储后更新
验证方式：粘贴多张大图后，UI 应在 < 100ms 内显示图片缩略图/占位符
步骤 2：缩小缩略图配置
风险：极低 | 影响：高
文件：src/lib/db.ts（第 4-6 行）变更：
// 当前
const THUMBNAIL_MAX_SIZE = 720
const THUMBNAIL_QUALITY = 0.9

// 建议
const THUMBNAIL_MAX_SIZE = 360   // 或 480，足够 InputBar 缩略图显示
const THUMBNAIL_QUALITY = 0.7    // WebP 0.7 在 360px 下视觉差异极小
同时：将 THUMBNAIL_VERSION 从 2 改为 3（第 6 行），触发已有缩略图的自动重新生成影响分析：
720px WebP 0.9 → 约 40-80KB/张
360px WebP 0.7 → 约 10-25KB/张
减少 ~60-70% 的缩略图数据量，加速 storeImage 的网络传输和服务器写入
步骤 3：多文件并行处理
风险：低 | 影响：高
文件：src/components/InputBar.tsx（第 1147-1149 行）当前：
for (const file of toAdd) {
  await addImageFromFile(file)
}
优化：
await Promise.all(toAdd.map(file => addImageFromFile(file)))
注意事项：
需确认 addInputImage（zustand store action）是线程安全的（zustand 的 set 是同步的，应该没问题）
服务器的 /api/images/store 是无状态的（基于内容哈希去重），支持并发
如果结合步骤 1（即时 UI），并行化主要影响后台存储完成速度，对用户感知影响较小
步骤 4：materializeInputImages 去重短路
风险：低 | 影响：中
文件：src/store.ts（第 420-435 行）当前：每次提交任务都对所有输入图片重新调用 storeImage，即使它们已经通过 addImageFromFile 存储过了。优化：在 storeImage 或 materializeInputImages 中添加检查逻辑：
如果图片已有有效 ID（以 in_ 前缀开头），且 getCachedImage(id) 返回有效数据，则跳过 storeImage 调用
或者在 createInputImageFromFile 返回时标记 alreadyStored: true，materializeInputImages 据此跳过
步骤 5：服务端异步文件 I/O
风险：低-中 | 影响：中
文件：server/src/index.ts变更点 1（第 771 行）：
// 当前
writeFileSync(absolute, bytes)

// 优化
const { writeFile } = require('fs/promises')
await writeFile(absolute, bytes)
变更点 2（第 794 行）：
// 当前
const bytes = readFileSync(absolute)

// 优化
const { readFile } = require('fs/promises')
const bytes = await readFile(absolute)
注意：rowToDataUrl（第 791 行）需要变为 async，所有调用方需要相应调整（getStoredFile、readTaskImageDataUrl 等）。这涉及较多函数签名变更，但逻辑简单。
步骤 6：服务端生成前图片缓存
风险：低 | 影响：低-中
文件：server/src/index.ts（第 831-841 行附近）在 executeGenerationJob 开始执行前，readTaskImageDataUrls 会同步从磁盘读取所有输入图片。可以考虑：
在 putStoredFile（第 763 行）写入时，将 dataUrl 缓存到一个 LRU Map 中（key: userId:id）
readTaskImageDataUrl（第 831 行）先查缓存，命中则直接返回
缓存容量控制在 ~50 条目或 ~200MB，避免内存膨胀
4. 依赖关系
步骤 1 (即时UI) ← 独立，可立即实施
步骤 2 (缩略图) ← 独立，可立即实施
步骤 3 (并行化) ← 最好在步骤 1 之后（否则并行化带来的 UI 改善不如即时反馈明显）
步骤 4 (去重)   ← 独立，但与步骤 1 配合效果最好
步骤 5 (异步IO) ← 独立，但涉及较多函数签名变更
步骤 6 (缓存)   ← 最好在步骤 5 之后（异步 I/O 已经改善了基线性能）
推荐实施顺序：步骤 1 + 2 同时 → 步骤 3 → 步骤 4 → 步骤 5 → 步骤 6
5. 风险与缓解措施
风险   影响   缓解措施
步骤 1：临时 ID 替换导致 UI 闪烁    低    使用 URL.createObjectURL 作为即时预览源，不依赖 dataUrl；ID 替换通过 zustand 的 replaceInputImage 实现，React 会复用 DOM
步骤 1：后台存储失败时图片已在 UI 中    低    存储失败时移除对应 UI 条目并显示 toast 错误提示（当前已有 catch 逻辑）
步骤 2：缩小缩略图导致已有缓存失效  极低   通过 THUMBNAIL_VERSION 自增自动触发重新生成（已有机制，db.ts 第 97 行）
步骤 3：并发上传导致服务器压力    低    最多 16 张图（API_MAX_IMAGES），服务端 /api/images/store 是无状态哈希去重，可承受
步骤 4：跳过存储导致 ID 不一致  低    只在图片 ID 已为正式 ID（in_ 前缀 + SHA-256）时跳过，确保幂等性
步骤 5：async 改造范围过大引入 bug  中    逐步替换，先改 putStoredFile，验证后再改 getStoredFile；所有路径已有 async 外层
6. 关键文件
文件   作用   涉及步骤
src/components/InputBar.tsx   粘贴/拖拽入口，handleFiles 串行处理循环    1, 3
src/store.ts   addImageFromFile、createInputImageFromFile、materializeInputImages、submitTask     1, 3, 4
src/lib/db.ts  storeImage、createImageThumbnail、缩略图常量   2, 4
server/src/index.ts /api/images/store、putStoredFile（writeFileSync）、getStoredFile（readFileSync）、readTaskImageDataUrls    5, 6
src/lib/openaiCompatibleImageApi.ts     Edit 模式下 dataUrl→Blob 转换（imageDataUrlToPngBlob）   参考（未来优化方向）