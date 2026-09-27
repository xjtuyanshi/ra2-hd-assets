# 红警2 高清重制：项目规划 v1

- **日期**：2026-09-27
- **依据**：本轮调研档案。内容包括 11 个候选底座的克隆、构建和测试，对重点候选的对抗性复核，以及画面目标、资产管线、渲染技术、法律、AI 工具五个专题。
- **标注约定**：【已验证】表示调研中直接核实过（读过代码、跑过构建、查过 API 或官方页面）。（推断）表示这是我的判断，或者尚未核实。
- 法律部分只是整理事实，不构成法律意见。

---

## 1. 一句话结论与推荐路线

**一句话结论**：推荐用 **RA2 VM**（[ra2-games/ra2](https://github.com/ra2-games/ra2)，在线版 [ra2.games](https://ra2.games)）做底座。

- 在所有候选里，只有它同时满足四个条件：是网页版；采用 GPL，可以合法 fork；不是从 Chrono Divide 衍生的；原版功能完整。
- 第一步"原版功能"基本不用做就有。
- 第二步照 C&C Remastered 的做法：原版游戏逻辑一行不改，只在上面新写一层 HD 渲染，并且先做 YR。
- 这个推荐是**有条件的**。HD 渲染桥是整个项目最大的技术风险，必须先通过两道关卡；任何一道没过，就切换到备选 **vera20k**。

### 有两件事需要先说明

1. **你记得的"网页版红警2"不能直接拿来改。**
   - 它很可能是 **Chrono Divide（时空分裂）**，或者它的中文镜像 RA2WEB。ra2web.com 自称是 Chronodivide 的镜像站【已验证】。
   - Chrono Divide 是闭源项目，服务条款保留全部权利【已验证：[chronodivide.com/tos.html](https://chronodivide.com/tos.html)】。
   - GitHub 上那些"红警2源代码（TypeScript）"仓库，都是对它客户端的**反编译重建**。其中主仓库的维护者在 2026-09-03 把 LICENSE 改成了"Chrono Divide 衍生代码不受 GPL-3.0 或任何开源许可授权"【已验证：[commit 898d8918](https://github.com/huangkaoya/ts-redalert2/commit/898d8918)】。
   - 所以"在那个网页版上直接改"没有合法授权可依。
2. **另有一个真正开源的网页版**，就是 RA2 VM（2026-09-12 公开）。它的做法完全不同：用 v86 x86 模拟器在浏览器里直接运行 **EA 原版的 game.exe / gamemd.exe**。规则、AI、战役、YR、联机、过场动画、存读档都是原版程序本身在跑【已验证：代码与文档】。

### 为什么选 RA2 VM

- **网页版，许可干净**：采用 GPL-3.0-or-later，与 Chrono Divide 没有代码关联。拿 CD 客户端里 5,343 条长字符串去比对，只命中 2 条通用字符串【已验证】。
- **第一步的保真度最高**：运行的就是原版程序。本机上 `pnpm run check` 通过，918 个单元测试全部通过【已验证】。不过因为本机还没有游戏文件，真实游戏测试一次都没跑过。
- **每个候选的 HD 层都得新写**：CD 系列用的是调色板渲染，vera20k 则是逐像素复刻 RGB565。各候选之间的区别只在于新渲染层怎样拿到游戏状态。RA2 VM 要通过"读模拟器内存加钩住绘制调用"来拿。这是我们为"合法、网页、100% 原版逻辑"付出的代价（推断）。
- **复核发现了有利条件**【已验证】：
  - 宿主可以直接读到所有 DirectDraw surface（`inspectSurfaceObjects`）和客体内存。自定义固件不开分页，所以客体内存就是一整块平坦的 buffer。
  - YR 1.001 的地址与开源的 [YRpp](https://github.com/Phobos-developers/YRpp) 对得上，例如帧计数器 `0xA8ED84`。
  - 因此 YR 的 HD 渲染桥有一张公开地址表可以依靠。我估计原型的工作量以"月"计，而不是以"年"计（推断）。

### 两道硬关卡

- **G1（Phase 0）：你的 exe 能不能用**
  - RA2 VM 的所有补丁都锁定了特定的 exe 哈希：game.exe 是 `06f99496…`，gamemd.exe 是 `7b8a0685…`。
  - 现有代码**总是用从 oldgame.store 下载的 exe 覆盖玩家自己的 exe**【已验证】。我们必须改成用你的正版 exe。
  - 你从 Steam 或 EA 买到的 exe，哈希是否一致还不知道【未验证】。
  - 如果不一致，要么重新逆向推导所有补丁地址（至少几周，推断），要么切换到 vera20k。
- **G2（Phase 2 Spike）：HD 渲染桥能不能做出来**
  - 要做出"捕获绘制调用，再由宿主用 HD 素材重画"，替换一辆坦克和一个步兵。
  - 标准：在 M5 Pro 上帧率达标，而且不影响游戏逻辑。
  - 做不出来就切换到 vera20k。

### 备选方案：vera20k（[YuriPlanet/vera20k](https://github.com/YuriPlanet/vera20k)）

- **是什么**：用 Rust 加 wgpu（在 Mac 上走 Metal）重写的 YR 引擎，GPL-3.0，不是 CD 衍生。模拟和渲染在代码层面被强制分离，所以 HD 层在这里最容易做。
- **本机实测**【已验证】：release 构建 1 分 59 秒；9,564 个测试通过；在 Metal 上正常启动。
- **代价**：
  - **不是网页版**。以后可以移植到 WebGPU，但至少要几周（推断）。
  - 玩法还是 pre-alpha：AI 是占位实现；没有战役；没有联网传输；核弹、超时空传送、心灵控制器都无法发射。

### 有条件的选项：拿到 Chrono Divide 作者的授权

- CD 用的是 Three.js 3D 正交场景，体素已经是真正的 3D 网格，是最适合做 HD 的渲染基础。
- [StillM8/RedAlert2-Engine](https://github.com/StillM8/RedAlert2-Engine) 的 beta 分支是 CD 系列里技术上最完整的：有 RA2 和 YR 遭遇战、超武、海军、驻军、LAN 联机、存读档【已验证】。
- 前提是拿到作者 Alexandru Ciucă 的书面授权，最好附带源码。
- 作者联系得上：contact@chronodivide.com、Discord、GitHub @use-strict。他以前在 2 小时内就批准过小请求（mod-sdk issue #7）【已验证】。
- 建议 Phase 0 就发信。这件事零成本，可以和其他工作并行。

### 否决的候选

| 候选 | 否决原因 | 置信度 |
|---|---|---|
| [huangkaoya/ts-redalert2](https://github.com/huangkaoya/ts-redalert2)（即 huangkaoya/redalert2，同一仓库改了名） | 自己承认是从 CD 客户端重建的，LICENSE 已声明不授权。另外带有未授权的 Supalosa AI 和 EA 的 INI 数据。 | 高。维护者自己改的 LICENSE 加上 [issue #39](https://github.com/huangkaoya/ts-redalert2/issues/39)。代码里有 453 条 CD 字符串，连 CD 的拼写错误 "alredy" 都一样。 |
| DD-Channel/ra2-web、OpenRA2/RA2Web | 都是上游的旧快照，自己没有独立提交。里面的 GPL 文件是已撤回授权的旧版本。功能更少，tsc 构建失败。 | 高 |
| StillM8/RedAlert2-Engine | 同属 CD 血统，GPL 声明无效，自己的第三方声明里也承认"授权未经验证"。技术上最强，但只有拿到授权才能用。 | 高 |
| Chrono Divide 官方（没有授权时） | 闭源。mod SDK 只允许替换同规格的 8 位资产，改不了渲染器。 | 高 |
| TaiYouWeb/ra2 | 只是 RA2 VM 的收藏式分叉，落后上游 9 个提交。要用就直接用上游。 | 高 |
| OpenRA/ra2 | C# 桌面程序，自称 pre-alpha，2026 年没有代码提交。没有战役和 YR，移植到浏览器很难。 | 高 |
| harshilmathur/openra2（Vanguard） | 法律上最干净，但只有苏军 11 种单位和 2 张地图。资产只能靠 Node 开发服务器解码。第一步等于重写整个游戏。 | 高 |
| rust-alert/ra2.exe | 不是网页版（ra-wasm 只是占位）。所谓渲染其实是 CPU 合成整张图。git 提交日期是伪造的。 | 高 |
| sheng-neo/ra2-web、openyrweb、rustalarm 等 | 要么不是忠实复刻的引擎，要么是 CD 客户端镜像换了个许可证。 | 中 |

补充：即使只在私下用 CD 衍生代码，复制和修改未授权代码本身仍然构成侵权，只是被追究的可能性低。我不建议把项目建在这上面（推断，非法律意见）。

---

## 2. 候选底座对比表

| 候选 | 许可 | 来源判定 | 原版完整度 | 渲染器 | 本机构建 | HD 可扩展性 | 评分 |
|---|---|---|---|---|---|---|---|
| **RA2 VM** ra2-games/ra2 | GPL-3.0-or-later。仓库里有从 game.exe 提取的 EA 图标，要删掉。 | 独立原创，置信度高。但公开历史是压缩过的快照，审计不了。 | 跑原版 exe：遭遇战、YR、中继联机、过场动画、存读档都在代码里。战役没做回归测试。本机没实际跑过。 | 客体内软件渲染，WebGL2 负责呈现。宿主只拿到最终帧。已带 FSR、Anime4K、SweetFX。 | 通过，918 个测试，约 11–17 秒 | L0 滤镜容易；L1 读内存拿辅助缓冲中等；L2/L3 钩绘制、宿主重画较难（YR 有 YRpp 可依） | 两份独立评估分别为 7 和 4；对抗复核后都落在 **5–6**（法律 6、技术 6；另一份法律 5、技术 5） |
| **vera20k** | GPL-3.0-only | 原创逆向（Ghidra 加 Unicorn），不是 CD。约 108 份文档里有反编译伪代码，另有少量零售数据 .bin 文件。 | YR 遭遇战，pre-alpha。AI 是占位。没有战役和联网。部分超武不能发射。有存读档。 | Rust wgpu 27，走 Metal。按 RGB565 逐像素复刻。 | release 1 分 59 秒，9,564 个测试通过，Metal 启动正常 | 模拟和渲染强制分离，需要另写一条并行的 HD 呈现路径，中等偏难。不是网页版。 | **6**（两轮复核都维持） |
| StillM8/RedAlert2-Engine | 声称 GPL，实际无效 | CD 衍生（自己承认） | RA2 和 YR 遭遇战、超武、海军、驻军、LAN、存读档。没有战役和在线对战。 | three r183 3D 正交场景，体素是网格，有阴影 | beta 分支：构建通过，858 个测试，类型检查通过。main 分支有 68 个 tsc 错误。 | 技术上 7–8/10 | 4（未复核） |
| huangkaoya/ts-redalert2 | 无（LICENSE 明确不授权） | CD 衍生，高置信 | RA2 遭遇战、LAN、回放。没有战役、YR、存档。 | three r183 | bun 构建通过 | 技术上 7/10 | 2 |
| DD-Channel/ra2-web | 旧 GPL 文本（上游已撤回） | CD 衍生的旧快照 | 只有遭遇战，AI 部署完基地车就不动了 | three r177 | tsc 失败 | — | 1 |
| OpenRA2/RA2Web | 同上 | README 自称是"AI 反编译" | 不可玩，所有模式都是"开发中"提示 | three r177 | tsc 失败，引用了 17 个已被 three 删除的 API | — | 1 |
| Chrono Divide 官方 | 专有 | 原创，黑盒复刻 | 在线对战、遭遇战、回放。没有战役、没有可玩的 YR、没有存档。 | three r94，WebGL1，不处理 Retina 分辨率 | 没有源码 | mod SDK 做不了 HD。有授权和源码的话约 8 分。 | 3 |
| OpenRA/ra2 | GPL-3.0 | 社区原创 | pre-alpha，没有战役和 YR，AI 弱 | C# OpenGL 桌面程序 | 未构建（本机没有 .NET） | 要 fork 引擎，移植到浏览器极难 | 3 |
| Vanguard | GPL-3.0-or-later | 净室原创 | 苏军 11 种单位，2 张图 | three r169，没有光照 | 通过，1,954 个测试 | 已有 renderScale HD 钩子，但资产依赖 Node | 4 |
| rust-alert/ra2.exe | Apache-2.0 | 原创，但 git 日期伪造 | 遭遇战切片，没有弹道、迷雾，超武只有闪电风暴 | 名义上 wgpu，实际是 CPU 合成整图 | 部分通过，wasm 构建失败 | 需要重写 GPU 渲染 | 3 |

更正一个流传的说法：HN 帖子 [45991853](https://news.ycombinator.com/item?id=45991853)（"Red Alert 2 in web browser"）链接的是 Chrono Divide，不是 RA2 VM【已验证】。

---

## 3. 法律与合规边界

**事实**

- EA 没有开源 RA2/YR 的引擎和资产【已验证】。
  - 2025-02-27 以 GPL 发布源码的只有 TD、RA1、Renegade、Generals/ZH（[来源](https://www.gamingonlinux.com/2025/02/ea-just-open-sourced-command-conquer-red-alert-renegade-and-generals/)）。
  - RA2 时代只开源了地图编辑器 FinalAlert2（[GPL，2024](https://github.com/electronicarts/CNC_TS_and_RA2_Mission_Editor)）。
  - 这些 GPL 附加条款都不授予商标权。
- **EA《C&C 模组指南》**（Rev.2，2025-02-27）【已验证：[来源](https://www.ea.com/games/command-and-conquer/command-and-conquer-remastered/news/modding-faq)】：
  - 授予一种可撤销的非商业许可，允许在模组里使用 C&C 资产。
  - **不得包含任何 C&C 音乐文件**。
  - 必须显著声明 "EA has not endorsed and does not support this product"。
  - 不得收费，不得放广告。
  - EA 可以随时撤销这项许可。
  - 第三方的独立重实现算不算"模组"，指南里没说清楚（推断）。
- **EA 用户协议**（2026-05-14 版）：除非获得授权或法律允许，否则不得逆向工程【已验证：[来源](https://www.ea.com/legal/user-agreement)】。RA2 VM 的补丁和 vera20k 的逻辑都依赖逆向，属于灰色地带，结论取决于所在司法辖区（推断）。
- **AI 放大或重绘 EA 美术，得到的是 EA 的衍生作品。** 在本地、私下、用自己的文件生成，风险最低；一旦分发就会暴露风险【已验证：[美国版权局报告](https://www.copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-2-Copyrightability-Report.pdf)；另有广州奥特曼案】。OpenAI 只转让它自己拥有的输出权利，EA 的权利不在其中。
- **执法现状**：
  - 截至 2026-09-25，没有发现 EA 针对 RA2 同人或网页项目发过 DMCA。CD 从 2018 年运营至今也没见到 EA 采取行动【已验证】。
  - 但容忍不等于许可。EA 已在 2026-08-04 私有化（[来源](https://www.ea.com/news/ea-announces-completion-of-acquisition)），新东家的态度可能会变（推断）。

**我们的操作模式**

1. 只做个人、非商业用途。用私有仓库，只在 localhost 运行。不部署到公网，也不把 build 或网址发给任何人，发给朋友也算分发。
2. 自带正版。从 Steam [app 2229850](https://store.steampowered.com/app/2229850/) 或 [Ultimate Collection](https://store.steampowered.com/bundle/39394/Command__Conquer_The_Ultimate_Collection/) 购买，只从你自己的安装目录导入文件。
3. 不使用任何第三方来源的游戏文件：oldgame.store 上的 exe，以及 archive.org、xwis.net 上的安装包和音乐。CD 的默认配置就指向这些地址。
4. 以下内容一律不进仓库，统一放在仓库外的 `gameres/` 目录，用 `.gitignore` 加 pre-commit 钩子拦截：`*.mix`、`*.exe`、`*.dll`、提取出的 SHP/VXL/TMP/PAL 文件、转换或放大后的纹理、音乐、视频、含原版美术的截图。仓库里只放代码和转换脚本。
5. 建立资产溯源清单，每个资产记录：来源、所用模型及版本、提示词、许可、审批人。
6. 现在就按 EA 模组指南执行：加免责声明、不放音乐、名称里不用 EA 商标。这样日后想分享时还有余地。
7. 清理 fork：
   - 删除 oldgame.store 的预下载逻辑和 `downloadCatalog` 里的外部链接。
   - 删除从 game.exe 提取的图标，以及来源不明的背景图。
   - 7z-wasm 带有 unRAR 限制条款。纯私用没有影响，分发前要处理。
8. 任何分享之前都要重新做一次合规复核：CD 的授权、底座的许可、EA 指南、GPL 的源码义务、EA 是否已经推出官方 RA2 重制版。最好再请你所在辖区的律师看一下。

---

## 4. 总体技术架构（HD 层如何挂到底座上）

**核心思路**（推断，基于调研中的 L0–L3 分层设计）：

- 原版 exe 在 Worker 里的 v86 中运行，游戏逻辑一行不改。
- HD 层是一个新写的"宿主合成器"，从客体取三类数据：
  1. 最终帧；
  2. 从内存读出的状态，包括视口、地图格、水面、Z-buffer、迷雾；
  3. 绘制记录，包括资源名、帧号、朝向、屏幕坐标、阵营色。
- 采用**渐进替换**：
  - 还没替换的对象，仍由原版画出，放大后作为底层。
  - 已经替换的对象，由宿主用 HD 素材重画，同时让原版跳过它的绘制。
  - 这样项目任何时候都是一局完整可玩的游戏。

```
┌──────────────────── Web Worker ────────────────────┐
│ v86 (JIT → WASM)                                     │
│  └ 原版 gamemd.exe 1.001（YR 优先；你的正版 exe）      │
│     · 规则 / AI / 寻路 / 联机 / 存档：原样运行          │
│     · 软件渲染 → DirectDraw surface                    │
│     · [新] 绘制钩子 trampoline（哈希 + 指令签名校验）    │
│        SHP 绘制 / 体素绘制 / 地块 / 动画                │
│        → 写入客体环形缓冲；对已替换对象跳过原版绘制        │
└──────┬──────────────────┬──────────────────┬──────────┘
       │① VmFrame 最终帧    │② 只读内存读取       │③ 绘制记录
       │  (RGB565)          │  视口/地图格/水面    │  名称+帧+朝向
       │                    │  Z-buffer/迷雾      │  +坐标+阵营色
       ▼                    ▼                     ▼
┌──────────────── 主线程：RenderState 快照 ───────────────┐
└──────┬────────────────────────────────────┬─────────────┘
       │ Classic 模式                         │ HD 模式
       ▼                                      ▼
  现有 vmFrameRenderer             HD 合成器：three.js r186 WebGPURenderer
  （WebGL2，原版像素）              （自动回退 WebGL2）
                                   ├ 资产解析 hd-manifest.json（缺失 → 回退原版像素）
                                   ├ 地形：PBR 材质 splat + 高度场
                                   ├ 对象：HD 精灵(texture array) / glTF 车辆
                                   ├ G-buffer → 光照累积
                                   │   太阳/环境 = 地图 [Lighting]；短时点光（炮口/爆炸）
                                   ├ 水面：水格掩码 + 距离场泡沫 + 波浪 + 反射 + 尾迹
                                   ├ 天气：GPU 雨雪、湿地、雾、云影、闪电
                                   ├ VFX：GPU 粒子、flipbook、畸变、焦痕、震屏
                                   ├ 后处理：半分辨率 AO/Bloom/雾
                                   │   → 全分辨率一次合成：AgX/Neutral + LUT + RCAS 锐化
                                   └ UI：侧栏先用原版帧区域，后期 HD 重绘
       ▲─────────── 一个快捷键实时切换（同一局、同一模拟）───────────▲
```

**关键设计点**

- **渲染管线**
  - three.js r186 已经以 TSL 节点形式提供 GTAO、Bloom、Lut3D、SMAA/FXAA、RCAS Sharpen、SSR、ClusteredLighting 等【已验证：[r186 display nodes](https://github.com/mrdoob/three.js/tree/r186/examples/jsm/tsl/display)】。
  - RA2 VM 本身没有用 three.js，所以 HD 层是全新代码，不需要迁移任何旧的调色板材质（推断，这是一个优点）。
- **相机**
  - 锁定为正交 2:1 等距视角（偏航 45°，俯仰 30°），与原版 60×30 的地块格子一致。不加相机旋转。
  - 客体分辨率（比如 1024×768）决定视野范围；宿主按屏幕原生的 3456×2234 渲染，约放大 3.4 倍，所以资产母版按 4 倍密度做（推断）。
  - 客体分辨率越低，模拟器越省力，因为原版的软件渲染开销随像素数增长。
- **资产覆盖系统**
  - 用以下键查找 HD 资产：(SHP 名, 帧号)、(VXL 名, section)、(TMP 名, 格)。
  - 格式用 KTX2/Basis 压缩的 2D texture array。
  - 每帧包含：预乘的 albedo、视空间法线、高度或深度、粗糙度与自发光、阵营色掩码（对应原调色板索引 16–31）、自发光掩码（索引 240–254）【已验证：调色板约定】。
  - 按战区分包，流式加载。
- **确定性安全**
  - HD 层对游戏只读，使用自己的随机数，天气和昼夜不回写游戏。
  - 钩子只做两件事：记录绘制，以及跳过绘制。
  - 预期联机不受影响（推断，列入 G2 验收）。
- **Feature flags 与画质档位**
  - 分四档：Ultra（WebGPU，在 XDR 屏上输出 HDR）、High、Medium（WebGL2 回退）、Classic。
  - 前 10 秒用 timestamp query 测量后自动选档，你可以手动覆盖（推断）。
- **性能预算**（推断）
  - 目标：在原生分辨率下 60 fps，GPU 耗时不超过约 11 ms，全分辨率 pass 不超过 8 个。
  - 瓶颈会是显存带宽，不是算力。M5 Pro 的带宽是 307 GB/s【已验证：[Apple](https://www.apple.com/newsroom/2026/03/apple-debuts-m5-pro-and-m5-max-to-supercharge-the-most-demanding-pro-workflows/)】。
- **分层推进**

  | 层级 | 内容 | 工作量 |
  |---|---|---|
  | L0 | 滤镜（项目里已有） | 几天 |
  | L1 | 读内存拿辅助缓冲 | 几周 |
  | L2 | 捕获绘制调用并替换为 HD，YR 优先 | 几个月 |
  | L3（可选） | 宿主完全接管战场画面 | — |

- **代码组织**：新代码放在 `src/hd/*` 和 `src/games/yr/hd*` 下，尽量不改模拟器 shim，方便以后跟上游 rebase（推断）。
- **如果切换到 vera20k**：HD 层挂在 `app/presentation` 的并行呈现路径上，流程是 HDR 离屏目标、后处理链，最后画侧栏。模拟通过 `SimFrameOutput` 事件驱动粒子和灯光。游戏数据直接可得，不需要逆向【已验证：这些钩子点都存在】。

---

## 5. 分阶段计划

每周给你一次简报。每个阶段结束时做一次演示，你来做决策。每阶段的报告控制在 2 页以内，你可以贴给 GPT-6 Pro 要第二意见。

**粗略总时长**（推断，Phase 3 结束后重估）：

| 里程碑 | 预计时间 |
|---|---|
| 原版在浏览器里可玩 | 2–4 周 |
| 垂直切片 | 约 4–6 个月后能看到 |
| 全部内容 HD 化 | 以年计 |

### Phase 0：环境、正版文件、基线、合规清理（1–2 周，取决于你拿到文件的时间）

- **目标**：用**你自己的正版文件**，在你 Mac 的浏览器里跑起原版 RA2/YR，并回答 G1。
- **任务**：
  1. 在私有仓库里 fork RA2 VM，锁定上游 commit `f25986b`。**首次启动之前**完成以下清理：
     - 删掉 `src/main.ts` 里的 `preloadThirdPartyFiles`；
     - 删掉 `src/games/manifest.ts` 里的 oldgame.store 地址；
     - 删掉 `src/games/downloadCatalog.ts` 里的外部链接；
     - 删掉 `public/icons/*` 和 favicon（都是 EA 图标）以及背景图；
     - 在 `gameSourcePicker.ts` 里改为使用玩家自己的 exe，并输出哈希报告；
     - 加上 EA 免责声明、`.gitignore` 和资产溯源清单模板。
  2. 核对哈希：把你的 game.exe 和 gamemd.exe 分别与 RA2 VM 锁定的 `06f99496…` / `7b8a0685…` 比较，再与 vera20k 开发工具接受的 `1cdd1180…` 比较。这两个项目锁定的 YR 1.001 哈希并不相同，说明市面上至少有两个 1.001 变体（推断）。
  3. 如果哈希一致：跑遭遇战、存读档、一关战役、一场 1080p 的后期大战，分别测模拟逻辑帧率和呈现帧率。
  4. 如果哈希不一致：评估差异有多大，是加了壳，还是只差少量字节。给出"重新推导补丁"和"切换 vera20k"两条路的对比。
  5. 并行：构建 vera20k，用你的文件跑原生版本做对照。它只需要安装目录，玩的时候不需要 exe。
  6. 并行：我起草给 Chrono Divide 作者的授权请求信，由你本人发送。
  7. 准备后续资产管线要用的环境：安装 Blender，用 uv 管理 Python 环境。
- **你会看到**：
  - 用你的文件在浏览器里跑原版的录屏；
  - 一页 G1 结论（哈希、能否启动、FPS、内存占用）；
  - vera20k 原生版的对照截图。
- **验收标准**：
  - 用你的 exe 在浏览器里进入遭遇战，完整打完 10 分钟；
  - 仓库里没有任何 EA 文件；
  - 网络面板里没有任何第三方游戏文件请求。
- **你的决策点**：D1 选底座（看 G1 结果）；D2 先做 YR 还是先做 RA2；是否发信给 CD 作者。

### Phase 1：原版功能验收（1–2 周）

- **目标**：把原版功能逐项打勾，形成一条基线，以后 HD 版必须不低于它。
- **检查清单**：

| 项目 | 调研里的状态 | 验收方法 |
|---|---|---|
| 遭遇战，AI 简单/中等/冷酷 | 原版 AI，但测试只证明了"能开局"，AI 行为没测过 | 每个难度打一局 |
| 盟军/苏军/尤里战役 | 没做回归测试 | 每个阵营打前 2 关，外加一关带过场动画的 |
| 超武：核弹、超时空传送、铁幕、天气控制、心灵控制器、基因突变器 | 属于原版逻辑，未单独测试 | 每个触发一次 |
| 海军、桥梁摧毁与修复、驻军、老兵等级、间谍、工程师 | 同上 | 用专门的小地图测试 |
| 存档与读档，含冷启动读档 | 代码里有，也有真实游戏测试。上游修过一个 macOS 存档 bug。 | 实际操作 |
| 联机（两个浏览器加自建中继） | 只测过双人短局 | 打 20 分钟不出现不同步 |
| 导入 .yrm/.mpr 自定义地图 | 代码里有 | 导入 2 张 |
| EVA 语音、音乐、过场动画 | 代码里有 | 实际观看 |
| 1080p 下 8 人后期大战的性能 | 没测过 | 测模拟帧率和呈现帧率 |

- **任务**：只修模拟器 shim 层的问题，不碰游戏逻辑。用 Playwright 建立 Classic 模式的截图回归。截图里含原版美术，只存本地，不进仓库。
- **你会看到**：打好勾的清单，每项配一段短视频，外加一份"已知问题"列表。
- **验收标准**：核心项目 100% 通过；战役抽查通过率不低于 90%。这两个门槛由你拍板。
- **你的决策点**：哪些问题必须修，哪些可以接受；要不要放开分辨率上限。1920×1080 只是 UI 里的白名单，模拟器 shim 实际支持到 2560×1600【已验证】。

### Phase 2：定稿视觉目标，同时做 HD 渲染桥 Spike（3–5 周）

- **目标**：同时锁定"要做成什么样"和"技术上能不能做到"，后者就是 G2。
- **任务 A：视觉目标**。照搬 C&C Remastered 的 "Visual Target image" 做法【已验证：[Remastered 团队 AMAA](https://www.reddit.com/r/Games/comments/gswgbw/amaa_were_the_team_behind_the_command_conquer/)】。
  - 用你自己游戏的真实截图做输入，在 ChatGPT Images 2.5 里重绘 3 张目标图：温带白天基地加水岸、雪地加爆炸、雨夜城市。
  - 锁定原版相机角度和光向（光从左上来，影子投向右），阵营色保持饱和。
  - 你直接在图上用 Image comments 圈出要改的地方。
  - 参考素材：
    - B 站 洱海Adais 的系列（[BV1xpG16MEFU](https://www.bilibili.com/video/BV1xpG16MEFU/)、[BV13EN46CETV](https://www.bilibili.com/video/BV13EN46CETV/)）；
    - 小黑戏游记 [BV1EQjW6CEt6](https://www.bilibili.com/video/BV1EQjW6CEt6/)；
    - 偏忠实风格的 [BV1akKs6GEaE](https://www.bilibili.com/video/BV1akKs6GEaE/)。
  - 写下"正典规则"，沿用 C&C Remastered 的原则：游戏内资产说了算，决定剪影、比例和配色；过场动画和 AI 概念图只能提供点缀【已验证：[来源](https://www.reddit.com/r/commandandconquer/comments/bea82f/remaster_update_and_first_art_preview/)】。
- **任务 B：L0 快速演示**。用项目里现成的 FSR、Anime4K、SweetFX 做一个当天就能玩的滤镜版。局限很明显：侧栏也会被一起处理，而且没有深度信息。
- **任务 C：Spike（G2）**
  - **L1**：从客体内存读视口、地图格（水面和高度）、Z-buffer；在水格上叠一层水面 shader。
  - **L2**：钩住 YR 的 SHP 绘制和体素绘制，把美国大兵和灰熊坦克换成临时 HD 素材（先用 AI 放大或简模），测帧率，检查遮挡、阵营色、阴影是否正确。
  - 测量 Worker 到主线程的数据带宽。
  - 对比 three r186 WebGPURenderer 在 Chrome 和 Safari 上的表现，以及强制 WebGL2 回退时的表现。
- **你会看到**：
  - 3 张目标图，等你批准；
  - 可玩的 L0 滤镜版；
  - Spike 并排视频：左边原版，右边 HD，画面上叠加 FPS；
  - 一页 G2 结论。
- **验收标准（G2）**：
  - 在 1080p 视野、100 个以上单位的场景里，两个替换对象的遮挡、阵营色、阴影都正确；
  - M5 Pro 上呈现帧率不低于 60 fps，模拟逻辑帧率不低于 Classic 模式的 90%（门槛可以调，推断）；
  - 联机时一边开 HD、一边开 Classic，20 分钟不出现不同步。
- **工作量**：3–5 周（推断）。L2 是专门的 x86 逆向工作，不确定性最大。
- **你的决策点**：
  - D3 视觉风格；
  - G2 通过就继续；不通过就切换 vera20k，Phase 0–1 做好的原版对照在那条路上照样有用；
  - D5 像素密度。

### Phase 3：垂直切片（2–4 个月）

- **目标**：一张地图、约 10 个单位和建筑、水面、一种天气、爆炸效果，全部做到目标画质。之后再决定要不要规模化。
- **内容**：
  - **地图**：一张温带多人图，要有水、岸线、悬崖、桥和树，由你挑。
  - **车辆（实时 glTF）**：灰熊坦克、犀牛坦克、矿车；可以加一艘驱逐舰，用来展示尾迹。
  - **步兵（预渲染 8 方向、4 倍密度的精灵表）**：美国大兵、动员兵。
  - **建筑（3D 重建后逐帧预渲染，与原版帧对齐）**：盟军建造厂、发电厂、兵营、矿场、战车工厂。
  - **地形**：这个战区大约 8 套 PBR 材质 splat 加高度场；特殊地块先用放大版回退。
  - **水面**：水格掩码；用 JFA 距离场做岸线泡沫；Gerstner 波加法线波纹；天空反射；船只尾迹。
  - **天气**：下雨。雨丝会被建筑挡住，地面有湿润反光、积水和涟漪。可以加闪电。
  - **爆炸**：坦克炮弹命中、建筑被摧毁、燃烧。做法是 flipbook 序列帧，加 GPU 火花和碎片、短时点光源、冲击波畸变、焦痕和震屏。
  - 完整的后处理链，以及 Classic 与 HD 之间的快捷键切换。
  - 其余所有对象自动走放大回退，保证整局都能玩。
- **你会看到**：本机可玩的 build；Classic 与 HD 的对比视频；与 Phase 2 目标图的并排对照。
- **验收标准**：
  - **可读性门槛**：默认缩放下每种单位都认得出来；缩到 50% 并转成灰度后仍然认得出来；阵营色一眼可见；占地面积与原版一致。
  - **帧预算**：原生分辨率下 60 fps（推断）。
  - 与 Classic 联机不出现不同步。
  - 你签字确认"这就是我要的方向"。
- **你的决策点**：满意就进入规模化，并定下资产优先级；不满意就调整风格或技术方案；同时确定预算，包括 API 和 3D 生成订阅。

### Phase 4：资产管线规模化（按批交付，6–12 个月以上，推断）

- **规模**（下限估计，推断；Phase 0 会从你的 MIX 文件里精确统计）：

  | 类别 | 数量 |
  |---|---|
  | 体素单位 | 约 90–100 个 |
  | 步兵 | 约 65 种，共 1.6–2 万帧 |
  | 阵营与科技建筑 | 约 60 个 |
  | 民用建筑 | 250 个以上 |
  | 战区与地块 | 5–6 个战区，约 1.5 万格 |
  | 动画 SHP | 约 300 个 |
  | cameo 图标 | 约 250 个 |

- **批次顺序**：阵营单位与建筑 → 战区地形 → 步兵 → 民用建筑与道具 → 动画 → 图标。
- **任务**：
  - 资源提取：RA2 VM 自己没有格式解析器，改用 [cnc-formats](https://github.com/iron-curtain-engine/cnc-formats)（Rust，MIT/Apache 许可）。
  - VXL 转 glTF 毛坯；3D 生成后用 Blender 清理和烘焙；批量放大和重绘；做质检联系图；维护溯源清单。
- **你会看到**：每批一张对比联系图，外加一个可玩 build。
- **验收标准**：每个资产都通过可读性门槛，占地与原版一致；由你逐批签字。
- **你的决策点**：每批的优先级；3D 生成服务和云 GPU 怎么取舍；什么时候开始做 RA2 原版 game.exe（也就是原版战役）的 HD。
  - 原版 RA2 战役跑在 game.exe 上，而 1.006 版几乎没有公开的逆向资料。所以在相当长一段时间里，这部分可能只能保持 Classic 画面（推断）。

### Phase 5：环境、天气、水面全面铺开（1–2 个月，可与 Phase 4 并行）

- **各战区**：
  - 温带和城市：雨、雾、云影；
  - 雪地：降雪、积雪、冷色调 LUT；
  - 沙漠：热浪、沙尘；
  - 月球：没有大气，硬阴影。
- **光照**：由地图的 `[Lighting]` 段驱动太阳、环境光和 LUT。原版每张图都定义了 Ambient、Red、Green、Blue、Ground、Level【已验证：[ModEnc](https://modenc.renegadeprojects.com/Lighting)】。离子风暴、心灵控制器、核弹这几种状态分别对应一套调色变化。
- **默认行为**：天气和昼夜是可选的装饰，默认保持地图原有的光照。
- **验收标准**：每个战区一段示范视频；由你评审原版氛围有没有被改掉。

### Phase 6：VFX 全面铺开（1–2 个月，可并行）

- **映射表**：把原版弹头名和动画名映射到 HD 特效预制件。覆盖：核弹蘑菇云、超时空蓝环、闪电风暴、铁幕、特斯拉电弧、光棱、心灵控制连线。
- **HDR 输出**：XDR 屏幕上的 HDR 输出做成开关，只在 WebGPU 下可用【已验证：three PR #29573】。
- **验收标准**：出一段特效库演示；峰值场景（例如核弹）不超出帧预算。

### Phase 7：性能与打磨（1–2 个月）

- **压力测试**：画质档位与自动选档；8 人大战（约 1,500 个单位、1 万个粒子、200 个光源，推断）。
- **显存**：常驻显存不超过 1–1.5 GB（推断）。
- **UI**：侧栏和图标 HD 重绘。
- **兼容与回归**：Safari 和 Firefox 兼容；回归测试自动化。
- **验收标准**：出一份性能报告；Classic 模式与原版逐像素一致，没有退化。

---

## 6. 资产高清化方案

| 资产类别 | 可选方案 | 推荐 | 理由与注意事项 |
|---|---|---|---|
| **体素车辆、飞机、船只** | a) 平滑原 VXL 后映射 PBR（快，但细节仍然少）<br>b) 以 VXL 导出的模型为毛坯，用 AI 3D 生成（Rodin、Meshy、Tripo，或本地跑 TRELLIS.2），再用 Blender 清理，按车体、炮塔、炮管拆分，枢轴取自 HVA，以 glTF 实时渲染<br>c) 预渲染 32 方向精灵 | **b** | 朝向一致性自然解决，动态光照也自然具备。钩子拿到的"VXL 名加朝向"正好对应网格。约每辆 1–2 人日（调研估计，推断）。 |
| **步兵** | a) AI 放大后用 ControlNet 锁住剪影重绘<br>b) 每个阵营做一个 3D 基础人体，绑骨后重定向约 15 套动作，渲染成 8 方向、4 倍密度的精灵表<br>c) 实时蒙皮网格 | 主力单位用 **b**，长尾用 **a** | b 就是 C&C Remastered 和 AoE II DE 的做法【已验证：[AoE DE](https://www.forgottenempires.net/age-of-empires-definitive-edition-is-it-a-3d-or-a-2d-game)】。帧数与原版一致，才能对上绘制钩子的"帧号"。c 在同屏几百个步兵时开销大，还可能丢掉原版的精灵质感。 |
| **建筑** | a) AI 放大<br>b) 3D 重建后逐帧预渲染（包括建造、受损、动态动画），附带法线、深度、自发光、阵营色贴图<br>c) 实时 glTF 加着色器实现建造动画 | **b** | 钩子提供的"资源名加帧号"与逐帧预渲染天然对应，最接近 C&C Remastered。带法线和深度，就能在雨天和夜间重新打光。c 作为备选。 |
| **地形** | a) 逐格 AI 放大 TMP 地块（有接缝问题，每个战区未压缩约 345 MB，推断）<br>b) 按地表类型分类，用约 8 套可平铺的 PBR 材质做 splat，再由格子高度和坡型生成高度场；悬崖用三平面投影或模块化网格 | **b** 为主，**a** 用于特殊地块的回退 | 需要 L1 读出地图格数据。 |
| **水面** | 专门的 shader 平面（做法见 Phase 3） | 同左 | AI 只用来生成可平铺的法线和泡沫纹理。 |
| **VFX** | a) flipbook 序列帧<br>b) 实时 GPU 粒子加 shader<br>c) 两者混合 | **c**：实时为主，重头爆炸用 flipbook | EmberGen 的官方定价页写着暂不支持 macOS【已验证：[来源](https://jangafx.com/software/pricing)】，EmberGen 2 公测排在 2026 年第四季度。Mac 上用 Blender 做烟雾模拟，再用 six-way 光照。 |
| **UI 与 cameo 图标** | a) AI 重绘，保留原构图<br>b) 从最终的 3D 模型渲染，再做风格化 | 单位图标用 **b**，其他用 **a** | 侧栏保持原版布局和皮肤，只做 HiDPI 重绘。 |

**通用规则**

- **掩码**：阵营色掩码对应索引 16–31，自发光掩码对应 240–254。影子帧单独处理，不做 AI 放大。使用预乘 alpha，边缘做渗色，避免出现光晕。
- **光照数据**：优先从 3D 烘焙。长尾资产可以用 AI 估计：[Depth Anything 3](https://github.com/ByteDance-Seed/Depth-Anything-3)（选 Apache 许可的版本）、[Marigold](https://huggingface.co/prs-eth/marigold-normals-v1-1) 法线和材质。要注意这类方法在动画帧之间会闪烁。
- **不要**把屏幕空间 AI 滤镜（DLSS 5 之类）当成最终方案：
  - 社区在红警2上实测，效果被评价为"油腻"、"糊"（[BV1FtYx6dEW8](https://www.bilibili.com/video/BV1FtYx6dEW8/)）；
  - 而且只支持 RTX 50 系列显卡。

---

## 7. AI 工具分工

**先澄清你提到的两个模型名**

- 实际上**不存在叫 "ChatGPT 6 Ultra" 的模型**【已验证：[OpenAI Models 文档](https://learn.chatgpt.com/docs/models)】。
  - 当前的文本旗舰是 GPT-6 Astra（2026-09-03 发布），还有 GPT-6 Sol 和 Luna（09-22 发布）。
  - "Ultra" 是推理强度的一个档位（会调用子代理），不是图像模型。
- 当前最强的图像模型是 **ChatGPT Images 2.5**（2026-09-08 发布）。
  - API 里分两个型号：`gpt-image-2.5-sunburst` 用于精修，`gpt-image-2.5-flare` 用于快速出图。
  - 支持透明背景、多张参考图、多轮编辑，以及在图上圈改的 Image comments【已验证：[来源](https://www.unite.ai/openai-releases-chatgpt-images-2-5-with-sketch-and-two-new-api-models/)、[API](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)】。
- 你说的"Pro 模式"对应 GPT-6 Pro。Pro $100 套餐每周大约 50 条，$200 套餐大约 200 条；另外也有 5.6 Sol Pro 可选【较可能：[第三方来源](https://9to5mac.com/2026/09/04/openai-releasing-major-upgrade-to-chatgpt-and-codex-with-gpt-6-astra-details-here/)】。

| 工作 | 工具 | 谁来操作 | 吞吐与成本 | 备注 |
|---|---|---|---|---|
| 全部代码：fork 清理、钩子、HD 渲染器、提取与转换脚本、批处理编排、质检联系图、回归测试 | Claude Code | 我 | — | 主力 |
| 风格探索、视觉目标图、圈改反馈 | ChatGPT 网页版 Images 2.5 | 你 | 约每小时 20–60 张（推断） | 数量少，需要你在场 |
| 方案与阶段报告的第二意见 | GPT-6 Pro | 你（我准备材料） | 受每周额度限制 | 每个阶段结束审一次 |
| 批量出图：cameo、概念三视图、贴图种子 | OpenAI API（2.5 sunburst/flare；gpt-image-2 走 Batch 可打五折） | 我写脚本，你提供 API key | 最低一档每分钟 5 张，最高档 250 张。每张 1024² 约 $0.006–0.21（第三方计算器）。5,000 张 high 质量约 $265（推断），另需预留 2–4 倍返工。 | 可能需要做组织认证（[价格页](https://developers.openai.com/api/docs/pricing)） |
| 小批量出图，用订阅额度 | Codex CLI 的 `codex exec` 加 `$imagegen`（用的是 gpt-image-2） | 我调用 | 每次消耗的额度是文本回合的 3–5 倍 | 官方途径（[文档](https://learn.chatgpt.com/docs/image-generation)）。本机尚未安装。 |
| 机械结构概念图的第二选择 | Gemini Nano Banana Pro 或 2 | 我 | 每张约 $0.067–0.24，Batch 五折 | 可选 |
| 放大、深度、法线、材质估计，风格 LoRA 重绘 | 本机 M5 Pro（64 GB）：Upscayl/chaiNNer、SeedVR2、Depth Anything 3、Marigold、FLUX.2 klein 4B（Apache 许可，用 Draw Things 或 mflux 跑） | 我 | 零边际成本，可以通宵跑 | 注意有些模型是非商用许可 |
| 图生 3D | Rodin、Meshy、Tripo（在线服务），或本地跑 [TRELLIS.2 的 Mac 移植版](https://github.com/shivampkumar/trellis-mac)（在 M4 Pro 上每个约 5 分钟） | 我执行，你批准 | 第三方估计约 1/10 的结果可以直接用 | 清理这一步省不掉 |
| 3D 清理与烘焙、渲染精灵表、烟雾 flipbook | Blender（需要安装） | 我用脚本驱动 | — | — |

**需要你了解的现实情况**

- 我不会用浏览器自动化去批量操作 chatgpt.com。OpenAI 条款禁止程序化提取输出，而且这样做很慢【已验证：[条款](https://openai.com/policies/row-terms-of-use/)】。你在场时做少量辅助操作是可以的。
- 2D 生图模型没法稳定保持多个朝向、多帧之间的一致性。凡是需要一致性的资产，一律走 3D 路线。
- 真正的瓶颈是审阅和返工，而不是出图速度（推断）。

---

## 8. 需要你决定的事项

1. **底座路线**
   - A：RA2 VM。网页、合法、原版功能完整，但 HD 最难做。
   - B：vera20k。HD 最好做，但不是网页版，玩法还不完整。
   - C：先等 CD 作者授权。HD 基础最好，但结果不确定，可能要等。
   - D：私下用 CD 衍生代码。不推荐，没有授权。
   - **推荐 A**，前提是通过 G1 和 G2。如果你觉得网页版不是必须的，B 就有很强的竞争力，我会在 Phase 0 做一次实测对比再定。
2. **先对哪个版本做 HD**
   - A：YR（gamemd.exe 1.001），有 YRpp 地址表可依，遭遇战里也有盟军和苏军。
   - B：RA2 原版（game.exe），逆向资料很少。
   - C：两个一起做。
   - **推荐 A**。RA2 原版战役会在较长时间内保持 Classic 画面（推断）。
3. **视觉风格**
   - A：忠实 HD，也就是 C&C Remastered 的做法，可读性最好。
   - B：电影感，接近洱海Adais 的 AI 壁纸，最惊艳，但单位不好辨认。
   - C：混合。单位和建筑按 A 的方式做，环境、光照、水面、天气、特效按 B 的方式做。
   - **推荐 C**。
4. **单位和建筑的资产形式**
   - A：全部 2D 重绘。
   - B：车辆用实时 3D，建筑和步兵用 3D 重建后预渲染。
   - C：全部实时 3D。
   - **推荐 B**。
5. **HD 像素密度**
   - A：2 倍。省显存和下载量。
   - B：4 倍。在 Retina 屏上清晰。
   - C：多档可选。
   - **推荐**：母版按 4 倍制作，运行时提供 2 倍和 4 倍两档；垂直切片阶段由你看效果再定。
6. **天气和昼夜**
   - A：纯装饰，默认沿用地图原有光照，天气可选。
   - B：默认开启动态天气和昼夜。
   - C：影响玩法。
   - **推荐 A**。C 会改变原版规则，不建议。
7. **Classic 与 HD 的实时切换键**
   - 要：会约束资产必须与原版逐帧对齐，但也正好保护了原版手感。
   - 不要：资产自由度更大。
   - **推荐：要。**
8. **浏览器和渲染后端**
   - A：Chrome 优先，three r186 WebGPURenderer，自动回退到 WebGL2。
   - B：从一开始就 Safari 和 Chrome 并重。
   - C：只用 WebGL2。
   - **推荐 A**。WebGPU 在 Chrome、Safari 26、Firefox 145 以上（Apple Silicon）都已上线【已验证：[web.dev](https://web.dev/blog/webgpu-supported-major-browsers)】。
9. **正版从哪里来，怎么把文件放到 Mac 上**
   - A：Steam 单品 2229850。
   - B：Ultimate Collection 合集（常在 6 美元左右）。
   - C：已有的光盘或 The First Decade。
   - Steam 版只支持 Windows，需要在 Windows 电脑、虚拟机或 CrossOver 里安装后，把整个目录拷过来。用 steamcmd 强制下载 Windows 版的方法未验证。
   - **推荐 A 或 B。**
10. **AI 账户和预算**
    - A：只用你的 ChatGPT 订阅加本地模型。
    - B：再加一个 OpenAI API key，设定每月上限。
    - C：再加 3D 生成服务订阅或云 GPU。
    - **推荐 B 起步，Phase 3 再评估要不要 C。**
11. **分享范围**
    - A：只有你自己。
    - B：给朋友。
    - C：公开。
    - **推荐 A。** B 和 C 都算分发，必须先拿到授权并做完合规复核。
12. **要不要联系 CD 作者**
    - 要：零成本；万一获批，有可能换到最好的 HD 底座。
    - 不要。
    - **推荐：要。** 我起草，你本人发送。

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 你的 exe 与 RA2 VM 锁定的哈希不一致（G1） | 所有补丁都失效 | Phase 0 第一件事就核对哈希，评估差异大小；备好切换 vera20k 的方案。**不去**下载第三方 exe。 |
| RA2 VM 锁定的 game.exe 可能是 XWIS 联机版，不是零售版【复核：来源无法确认】 | 用零售版 exe 时，RA2 部分的补丁可能对不上 | 先做 YR；RA2 部分单独评估。 |
| HD 渲染桥（L2）做不出来，或者太慢（G2） | 第二步受阻 | Phase 2 的 Spike 就是专门验证这件事的，失败就切换 vera20k。原版对照的成果可以复用。 |
| v86 模拟性能的上限未知，尤其是高分辨率和后期大战 | 卡顿 | 客体用低分辨率（1024×768），宿主渲染高分辨率；Phase 0/1 实测。 |
| Worker 与主线程之间的数据带宽；SharedArrayBuffer 需要跨源隔离（推断） | 延迟、掉帧 | 在 Spike 里测量；本地开发服务器配置好 COOP/COEP 响应头。 |
| 浏览器内存：每局客体需要 640 MB 内存【已验证】，再加 HD 纹理 | 标签页崩溃 | 按战区流式加载，用 KTX2 压缩，常驻显存控制在 1–1.5 GB 以内（推断）。 |
| 上游 RA2 VM 还是 Alpha，公开才两周，真正的开发分支是私有的 | 很难跟进上游 | 锁定 commit；新代码尽量放在独立模块里，少改 shim。 |
| 法律风险：EA 知识产权、衍生作品、逆向工程的灰色地带 | 被要求下架，或承担责任 | 严格按第 3 节的操作模式执行：私用、自带正版、不入库、写免责声明。 |
| AI 资产在多朝向、多帧之间不一致 | 画面闪烁、单位"变形" | 需要一致性的一律走 3D；AI 只用于概念图、贴图种子和长尾资产。 |
| 追求写实导致可读性下降、红警味道流失 | 背离初衷 | 执行正典规则和可读性门槛；只把写实用在环境、水面、天气和特效上。 |
| 资产量巨大 | 工期失控 | 分批推进；未完成的部分自动回退到原版；每批由你签字。 |
| 用浏览器自动化操作 ChatGPT 违反条款 | 账号风险 | 批量任务走 API 或 Codex CLI，网页版只由你本人操作。 |
| 显存带宽成为瓶颈（3456×2234 分辨率） | 掉帧 | 全分辨率 pass 不超过 8 个；AO、Bloom、雾用半分辨率；用 timestamp query 测量耗时。 |
| 工期估计不准 | 预期落空 | 所有估计都标了"推断"，Phase 3 结束后重新估计。 |

---

## 10. 下一步

**你批准之后，我马上执行以下工作（这些都不需要游戏文件）：**

1. 在项目目录 `/Users/lukegogogo/claude code projects/红警2高清重制/` 下，建立 RA2 VM 的私有 fork，锁定 `f25986b`。
2. 在首次启动**之前**完成合规清理：
   - 删除第三方 exe 的预下载逻辑和下载外链；
   - 删除 EA 图标和背景图；
   - 改为使用玩家自己的 exe，并输出哈希报告；
   - 加上 EA 免责声明、`.gitignore`、pre-commit 拦截和溯源清单。
3. 跑 `pnpm run check` 作为基线；写好哈希核对脚本（同时对比三个已知哈希）；构建 vera20k 备用。
4. 起草给 Chrono Divide 作者的英文授权请求信，你来发送。

**需要你提供的：**

1. **正版游戏文件**：购买或确认你已有 RA2 + YR（Steam 2229850 或 Ultimate Collection）。把**整个安装目录**拷到 Mac 上仓库之外的位置，比如 `~/RA2-Game`。至少要包含：
   - RA2：`game.exe`、`ra2.mix`、`language.mix`、`Binkw32.dll`、`Blowfish.dll`
   - YR：`gamemd.exe`、`ra2md.mix`、`langmd.mix`
   - 可选：`theme.mix`、`thememd.mix`、`multi.mix`、`multimd.mix`、`maps*.mix`、`movies*.mix`、`expandmd01.mix`
2. **回复决策 1、2、11**（底座、先做哪个版本、分享范围），或者只回复"同意先做 Phase 0"。
3. **告诉我你的 ChatGPT 套餐**（Plus、Pro $100 还是 Pro $200），以及能否创建 OpenAI API key、每月预算上限是多少。
4. **3–5 张你最喜欢的参考图**。小红书上的那些"AI 红警2"图需要登录才能看，我这边看不到。

拿到游戏文件之后，一般 1–2 周内交付 Phase 0 的成果：一段用你的文件在浏览器里跑原版的录屏，加一页 G1 结论（能不能用你的 exe、帧率多少、下一步怎么走）。