# CI/CD 设计说明

本文记录简记的自动化流水线：它解决什么问题、为什么这样分层、以及哪些环节必须人工配置。
对应文件是 `.github/workflows/` 下的两个工作流。

---

## 一、先分清 CI 和 CD

这两个词经常被混着说，但它们的约束完全不同：

| | CI（持续集成） | CD（持续交付 / 部署） |
| --- | --- | --- |
| 触发时机 | 每次推送、每个 PR | 打标签、手动确认 |
| 目的 | **拦住坏代码** | **产出可交付物** |
| 失败代价 | 几行红叉，改完重推 | 用户已经下载到一个坏包 |
| 关键要求 | 快、反馈明确 | 可复现、版本可追溯 |

推论很直接：**两者的门禁强度必须反过来。**
CI 要跑得快、跑得勤；CD 要跑得慢、跑得稳，且必须把 CI 的结论当作前置条件。
简记原先的发布流程恰好违反了这一点 —— 推标签直接打包发布，回归根本没跑，
等于拿线上 Release 当测试环境。现在改成发布前强制过回归。

### 一条流水线的常见分层

```
            ┌─────────────┐
  提交/PR → │  lint 静态检查 │  语法、格式、产物同源性    ← 秒级，最先拦
            └──────┬──────┘
                   ▼
            ┌─────────────┐
            │  test 自动化测试 │  回归套件                  ← 分钟级，核心门禁
            └──────┬──────┘
                   ▼
            ┌─────────────┐
            │  build 构建   │  打包成安装包               ← 只在打标签时跑
            └──────┬──────┘
                   ▼
            ┌─────────────┐
            │  release 发布 │  创建 Release、挂产物       ← 唯一对外可见的一步
            └─────────────┘
```

分层的意义在于**失败点尽可能靠前**：能靠语法检查挡住的错误，不该浪费 10 分钟跑回归才暴露。

---

## 二、GitHub Actions 的四个概念

只记住四个词就够了，其余都是它们的组合：

| 概念 | 含义 | 在简记里 |
| --- | --- | --- |
| **workflow** | 一个 YAML 文件 = 一条流水线 | `ci.yml`、`release.yml` |
| **job** | 一个独立任务，**默认跑在各自独立的虚拟机上** | `regression`、`build` |
| **step** | job 里的一步，可以是命令或现成 action | `npm test` |
| **runner** | 执行 job 的虚拟机，选 OS 就是选它 | `windows-latest` |

两个最容易踩的点：

1. **job 之间不共享文件系统。** 所以 `build` 产出的安装包要传给 `release`，
   必须显式用 `upload-artifact` / `download-artifact` 中转，不能指望它还在 `dist/`。
2. **`needs` 是唯一的串行手段。** 不写 `needs` 的 job 全部并行跑。

---

## 三、谁写这些配置

一个常见的误解是「GitHub 会帮我把 CI 建好」。**不会 —— 配置必须由你写进仓库。**
但把分工拆开看，真正要你动手的部分很少：

| 事项 | 谁负责 | 说明 |
| --- | --- | --- |
| workflow 的 YAML | **你**（本项目已写好） | Actions 页面只有 starter 模板，选中后仍要改成自己的仓库能跑的 |
| runner 虚拟机 | GitHub 提供 | 公开仓库不计时长；私有仓库 Free 方案每月 2000 分钟 |
| `GITHUB_TOKEN` | GitHub 自动注入 | 不用手动创建，权限由 YAML 里的 `permissions:` 控制 |
| 依赖缓存 | 机制 GitHub 给，开关你写 | 一行 `cache: npm` 即可 |
| 分支保护规则 | **你**，且只能在网页点选 | 唯一无法用代码表达的门禁 |
| Secrets（签名证书等） | **你**，网页配置 | 本项目当前一个都不需要 |

一句话总结：**配置是你写的，机器是 GitHub 出的。**

写完之后的日常是「无感的」—— 你只管提交和打标签，流水线自己跑。
只有三种情况需要再碰它：改打包目标平台、加新的检查项、或依赖大版本升级。

> 这也是 CI 值得一次性投入的原因：它把「每次发版前手工跑一遍回归、手工传安装包、
> 手工写 Release 说明」这类重复劳动，变成了一次性写 100 行 YAML。

---

## 四、现状盘点

改造前仓库里已经有两个工作流，方向是对的，但有四处实质缺口：

| 问题 | 后果 | 严重度 |
| --- | --- | --- |
| `release.yml` 只打 macOS | **README 向用户承诺了 Windows 安装包，流水线却产不出来。** 一旦完全依赖 CI 发版，Windows 用户会直接断供 | 高 |
| 发布前不跑回归 | 坏包直达用户 | 高 |
| `ci.yml` 只监听 `main` / `dev` | 实际开发发生在 `release/macos-build` 分支上，**这条线全程没跑过 CI**；另外 `dev` 分支远端并不存在，是条死配置 | 中 |
| 无版本一致性校验 | 标签、`package.json`、`CHANGELOG` 三处版本可能对不上 | 中 |

补充观察：`v1.1.0` 这个 Release 里只有两个 Windows 产物（手工上传），
而 `package.json` 已经是 `1.2.0` —— 说明"打包"和"发版"目前还是两条手工路径在并行。

---

## 五、目标设计

### 工作流一：`ci.yml`（质量门禁）

| job | runner | 内容 |
| --- | --- | --- |
| `regression` | windows-latest | 91 条端到端回归；失败时把 `.tmp-*.png` 截图捞出来 |
| `lint` | ubuntu-latest | 全量 JS `node --check`；重建 `vendor/cm6.js` 后比对，强制产物与源码同源 |

触发：`main` / `dev` / `release/**` 的 push，指向 `main` / `dev` 的 PR，以及手动触发。

几个设计取舍：

- **为什么回归跑在 Windows**：`scripts/lib/browser.js` 默认探测系统 Edge，
  Windows 镜像自带，省掉下载浏览器的一步。换到 Linux 就要额外装浏览器，得不偿失。
- **为什么 `lint` 单独一个 job**：它跑在 Linux 上，与 Windows 的回归并行，互不阻塞。
- **`vendor/cm6.js` 同源校验**：`CONTRIBUTING.md` 明令"不要手改 `vendor/cm6.js`"，
  但此前没有任何机制兜住这条规则。现在 CI 重打一次产物再 `git diff`，
  把文档里的约定变成可执行的约束。
- **`concurrency` + `cancel-in-progress`**：同一分支连推多次时取消上一次，
  避免排队的旧运行白白吃掉 runner 额度。

### 工作流二：`release.yml`（打包发布）

```
check-version ─┐
               ├─→ build (矩阵：Windows / macOS / Linux) ─→ release
regression ────┘
```

| job | runner | 内容 |
| --- | --- | --- |
| `check-version` | ubuntu-latest | 标签 = `package.json` = `CHANGELOG` 段落，三处必须一致 |
| `regression` | windows-latest | 与 `ci.yml` 同一套回归 |
| `build` | 矩阵 | Windows 出 `.exe`；macOS 出 arm64 + x64 的 `.dmg` / `.zip`；Linux 出 AppImage |
| `release` | ubuntu-latest | 汇总三平台产物，从 `CHANGELOG.md` 抽本版说明，创建 Release |

几个关键决策：

- **为什么必须用矩阵而不是一台机器串行打包**：electron-builder 的硬限制 ——
  Mac 包只能在 macOS 上打，其他平台会直接报
  `Build for macOS is supported only on macOS`。
- **为什么 `build` 用 `--publish never`，发布收口到独立 job**：
  三个平台各自 `--publish onTag` 会并发抢同一个 Release，容易打架；
  而且产物没齐就可能已经建出 Release，用户会看到"只有 Mac 包"的中间态。
- **为什么发布说明从 CHANGELOG 抽**：项目本来就在维护 `CHANGELOG.md`，
  再让 GitHub 按 commit 自动生成一份，等于同一件事维护两遍、且两份会对不上。
  用 `awk` 抽 `## [x.y.z]` 到下一个 `## [` 之间的内容即可。
- **`concurrency` 不取消**：发布被打断会留下半截 Release，比等它跑完更糟。
- **Linux 先挂 `continue-on-error`**：`package.json` 的 Linux 目标此前只声明了
  `category`，产物名会退化成带中文的默认值。现已补上 `target: AppImage` 与
  `artifactName`，但仍先设为非阻塞 —— 是否正式支持 Linux 版由你决定。

### 触发矩阵总览

| 事件 | `ci.yml` | `release.yml` |
| --- | --- | --- |
| push 到 `main` / `dev` / `release/**` | ✅ | — |
| PR 到 `main` / `dev` | ✅ | — |
| push 标签 `v*` | — | ✅ 全流程并发布 |
| 手动触发 | ✅ 只跑检查 | ✅ 只出 Artifacts，不发 Release |

---

## 六、必须人工在网页端完成的配置

工作流文件只是"能跑"，下面这几项决定了它"能不能拦住人"。**这些无法通过提交代码完成。**

### 1. 分支保护（最重要）

`Settings → Branches → Add branch protection rule`，对 `main` 配置：

- ✅ Require a pull request before merging
- ✅ **Require status checks to pass before merging**
  → 勾选 `回归套件（91 条断言）` 与 `静态检查`
- ✅ Require branches to be up to date before merging

> 注意：状态检查的名字要在工作流**至少成功跑过一次**之后才会出现在候选列表里。
> 如果找不到，先随便推一次让它跑起来。

这一步是整条流水线的价值所在 —— 没有它，CI 只是"能跑出红叉"，挡不住任何人合并。

### 2. 确认 Actions 权限

`Settings → Actions → General → Workflow permissions`，
`release.yml` 里已声明 `permissions: contents: write`，仓库级保持默认或只读均可。

### 3. 暂不需要的 Secrets

当前流水线**零自定义 Secret**，全部使用 GitHub 自动注入的 `GITHUB_TOKEN`。

只有在将来办 Apple 开发者账号后，才需要新增：
`CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`，
并把 `package.json` 的 `mac.identity` 从 `null` 改成证书名称、`gatekeeperAssess` 改回 `true`。

### 4. 远端分支对齐

`ci.yml` 监听了 `dev`，但远端目前只有 `main` 和 `release/macos-build`。
要么建出 `dev`，要么从触发列表里去掉它 —— 留着一条永远不会触发的配置只会误导人。

---

## 七、发一个版本的完整流程

```bash
# 1. 在 main 上把版本号改到位
#    package.json 的 version、CHANGELOG.md 新增 "## [x.y.z] - 日期"
# 2. 提交并推送
git add package.json CHANGELOG.md
git commit -m "chore: 发布 v1.2.0"
git push origin main
# 3. 打标签 —— 这一步才真正触发流水线
git tag v1.2.0
git push origin v1.2.0
```

推完标签后：`check-version` → `regression` → 三平台并行打包 → 汇总发布。
任一门禁不过，Release 就不会产生。

**只想试打包不发版**：Actions →「打包发布」→ Run workflow，
产物在当次运行页的 Artifacts 里下载，不会动 Release。

---

## 八、可以继续加的东西

按性价比排序，都没做，需要时再加：

1. **`dependabot.yml`** —— 自动升级依赖与 Actions 版本。
   本项目有 12 个 `@codemirror/*` 依赖和若干 `uses: xxx@v4` 需要跟进。
   代价是会定期收到 PR，对个人项目可能算噪音。
2. **CodeQL 代码扫描** —— 公开仓库免费。本项目后端零鉴权，安全边界靠"只监听回环"撑着，
   多一道自动扫描是划算的。
3. **PR 模板** —— `.github/pull_request_template.md`，
   强制作者勾选"已跑过 `npm test`"。注意这属于社交约束，不是技术门禁。
4. **`dist/` 缓存** —— 打包每次都要重新下载 Electron 二进制（约 100 MB）。
   `actions/cache` 缓存 `~/AppData/Local/electron/Cache` 可以省时间，
   但要处理好缓存 key 与 Electron 版本的对应关系，收益有限，暂不加。
