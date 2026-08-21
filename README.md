# dsh-codeaudit

[![Release](https://img.shields.io/github/v/release/Ph03n1xRt/dsh-codeaudit)](https://github.com/Ph03n1xRt/dsh-codeaudit/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

[DSH](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）的**代码审计模式插件**：一个白盒源码审计工作流 agent。
指挥官 agent 测绘代码资产、拆解审计意图、并发委派子代理追踪数据流，所有证据/资产/漏洞沉淀为可回放的记录，
实时在 Web「代码审计」页可视化，最终产出带证据链与修复建议的中文审计报告。

```
审计任务 (engagement)
  └─ spawns ─> 审计意图 (intent)「追踪 /api/order 的查询参数」
                 ├─ yields ─> 代码证据 (evidence) [entry]  OrderController.java:42  + 代码片段
                 ├─ yields ─> 代码证据 (evidence) [sink]    OrderDao.java:87        + 代码片段
                 └─ proves ─> 漏洞发现 (finding)  [high|confirmed] SQL 注入
                                ↑ supports ────┘（证据链，逐条挂接）
```

## 特性

### 审计工作流

- **审计链路记录**：engagement → intent → evidence → derived intent → finding 六表存储域，每条关系都是显式边，
  `<kind>-<n>` 确定性 id，会话投影可从日志纯重放（存储与视图严守同一 id 不变量，失败写入连计数器一起回滚）。
- **证据链与代码片段**：finding 必须携带 `file:line` 位置与至少一条 `supports` 证据；evidence / finding 可附
  `snippet`（提交时截断到 4000 字符并冻结——代码之后改动，报告仍可复现）。
- **误报控制**：`sanitizer` 证据类型专门记录防护点；finding 分 `confirmed`（已排查防护）/ `suspected`（存疑待
  人工复核）两级状态。
- **指挥官/子代理分工**：决策 agent 测绘资产、按「模块 × 漏洞类」拆意图、并发委派深挖；子代理只经
  `codeaudit_submit` 单通道回写父意图（服务端解析父会话、拒绝占位符 id），提交即返回本批分配的真实 id，
  模型不需要也不允许臆测编号。
- **只读纪律**：协议约定目标仓库只读（读取/搜索/静态分析），动态验证限隔离目录。

### Web 可视化（会话旁「代码审计」标签页）

| 子视图 | 内容 |
|---|---|
| **探索链路** | 整张审计图（React Flow），为大规模链路做了三层压缩：**意图聚合折叠**——默认只显示 任务→意图→漏洞 骨架，每个意图卡片带「证据 N · 漏洞 M」计数徽章，点徽章按需展开该意图的证据（折叠时证据的 supports/derived_from 边自动重挂到所属意图，高层语义不丢；小图 ≤15 节点自动全展开）；**「仅漏洞链路」过滤**隐去无结论的死胡同探索；缩放范围 0.05–4 倍 + 右下角可拖拽 **MiniMap**；**横向/纵向**布局切换。点节点看详情，含代码位置与冻结代码片段 |
| **漏洞发现** | 按严重级排序的卡片列表；每条可下钻**完整漏洞链路**抽屉——任务 → 意图 → 逐条证据（kind 徽章 + 位置 + 代码片段）→ 漏洞结论（CWE/状态/修复建议） |
| **代码资产** | repo / module / file / class / function / endpoint / config / dependency 八类资产，列表分组与父子树图两种视图 |
| **报告** | 与 `codeaudit_report` 工具同构的中文 Markdown（执行摘要 / 探索链路 / 漏洞+证据链+修复建议 / 资产清单），可复制、可下载 `codeaudit-report-<target>.md` |

## 安装

前置要求：dsh ≥ rc.6，**Node ≥ 22.5**（`node:sqlite`）。

```bash
# 从 GitHub Release 安装（推荐）
dsh plugin --profile web add https://github.com/Ph03n1xRt/dsh-codeaudit/releases/latest/download/dsh-codeaudit.tar.gz

# 或从本地 tarball
dsh plugin --profile web add file:/绝对路径/dsh-codeaudit.tar.gz
```

重启 dsh，新建会话时预设选择器会出现「**代码审计模式**」。数据落在
`$DSH_HOME/storages/codeaudit-sessions.db`（官方 `@deepseek-ai/dsh-storage-sqlite` 后端）。

装完可用 `dsh --profile web --dump-config` 核对 patch 层四行（`ui-codeaudit` / `storage-sqlite` /
`storage-domain` 路由 / `codeaudit-preset-root`）；核心 `codeaudit` 行只随预设出现，不在 patch 里——这是设计如此
（防止选中预设时工具目录重复）。

## 使用

选中预设后，直接发一条包含**目标 + 审计目标**的消息，无需任何特殊指令：

```
审计 /home/kali/targets/shop-backend（Java/Spring 项目）。
审计目标：重点排查 SQL 注入、越权访问和硬编码密钥，其次看文件上传和 SSRF。
范围：只审 src/main/java，排除 test 和前端目录。
```

| 你说的 | 存入字段 | 作用 |
|---|---|---|
| 代码库路径/名称 | `target` | 审计对象（建议绝对路径） |
| 重点排查什么 | `objective` | 指挥官按「模块 × 漏洞类」拆意图的依据 |
| 只审/排除哪些目录 | `scope` | 越界意图会被协议拒绝 |
| 技术栈 | `stack` | 帮模型快速定位框架特性 |

流程：指挥官登记 engagement → 测绘资产 → 拆分意图 → 并发委派子代理追踪 source→sink 数据流 → 验证定级
（排查 sanitizer/框架防护后定 confirmed/suspected）→ 终止时调用 `codeaudit_report` 出报告。
过程中你只需要回答它的 ask_user 提问；想中途出报告就说一句「出最终报告」。

注意：**一次会话一个审计任务**——登记新 engagement 会清空本会话旧图（刻意的重置语义），换目标直接再发一条即可。

## 工作原理

### 数据模型（六表 + 显式边）

| 表 | 记录 | 关键字段 |
|---|---|---|
| `engagements` | 审计任务（每会话一个） | target, objective, scope, stack |
| `intents` | 审计意图 | title, detail（锚点：engagementId 或 derivedFromEvidenceId 恰一） |
| `evidences` | 代码证据 | kind: entry/sink/dataflow/sanitizer/config/dependency/info, location, detail, snippet, confidence |
| `findings` | 漏洞发现 | title, severity, **status: confirmed/suspected**, cwe, **location 必填**, snippet, fix |
| `assets` | 代码资产 | type: 八类, value, meta |
| `edges` | 语义边 | spawns / yields / derived_from / proves / **supports** / parent |

边语义：`spawns`（任务→意图）、`yields`（意图→证据）、`derived_from`（证据→新意图）、`proves`（意图→漏洞）、
`supports`（**证据→漏洞，构成证据链，finding 至少一条**）、`parent`（资产→资产）。

### 模型工具（9 个 `codeaudit_*`）

- 指挥官专用：`codeaudit_set_engagement`（重置整图）、`codeaudit_add_intent`、`codeaudit_add_evidence`、
  `codeaudit_add_finding`、`codeaudit_add_asset`、`codeaudit_state`（单行摘要防上下文膨胀）、
  `codeaudit_graph`、`codeaudit_report`
- 子代理专用：`codeaudit_submit`（服务端解析父会话；占位符 id 直接拒绝；返回本批真实 id；事务全或无回滚）

### 安全与质量护栏

写入边界引用校验（同会话同表、恰一锚点、位置必填、证据链必挂）→ 域 zod schema 在持久化边界二次校验 →
invariant 伴生在 `domain/changed` 三次校验边两端表 → 投影镜像拒绝 + CAP 200 防上下文膨胀；
子代理 toolFilter.deny 全部写/读工具只留 submit；scope 为协议层留痕约束，实际文件访问由部署的沙箱与审批层强制。

## 项目结构

```
dsh-codeaudit/
├── package.json              # 单包 bundle：exports 子路径 = Cordis 插件行；dsh.bundle.patch / dsh.client 声明
├── cordis.patch.yml          # 宿主 profile 层：UI 行、官方 sqlite 后端行、codeaudit 域路由、预设根行
├── preset/codeaudit/         # agent 预设：standard 副本 + 审计指挥官 persona + 仅 submit 的子代理 + 核心插件行
├── src/
│   ├── index.ts              # bundle 宿主入口（patch-only 惰性席位）
│   ├── invariant.ts          # 不变量伴生（引用纪律三道防线之一）
│   ├── preset-root.ts        # 注册包内只读预设根（rc.6 预设根替换的对冲）
│   ├── dsh-codeaudit/        # 核心插件：spec / store / tools / instructions / projection / types + tests
│   └── dsh-client-ui-codeaudit/  # 浏览器半：视图、布局纯函数、i18n、链路抽屉 + tests
├── scripts/build.mjs         # esbuild 构建管线（宿主半 ×5 + 浏览器 client 打包，含 CSS Modules 内联）
├── tests/bundle.spec.ts      # 发布清单契约测试
└── .github/workflows/release.yml  # tag 推送 → 测试 → 构建 → npm pack → GitHub Release
```

## 开发

```bash
npm install          # .npmrc 已带 legacy-peer-deps=true（dsh rc.6/rc.8 peer 冲突，与 dsh-pentest CI 做法一致）
npm test             # 96 个用例：host 工具/存储/投影/不变量 + client 布局/视图/注册门控 + bundle 契约
npm run check        # tsc --noEmit
npm run build        # 产出 lib/*（六个构建产物）
npm pack             # 自包含 tarball（10 文件）
```

浏览器端打包契约：`lib/ui-codeaudit.client.js` 以 `window.__ModuleLoader__.load({ id, factory })` 握手交付，
仅 `react` / `react-dom` / `react/jsx-runtime` 走 loader 模块表，其余（含 @xyflow/react）全部内联；
CSS Modules 哈希后经插件自有的 `<style data-plugin>` 标签注入。

## 发布

```bash
npm version 1.x.0                # 或手动改 package.json
git push && git push --tags      # 推送 v* 标签即触发 Actions：测试 → 构建 → 打包 → 发布 Release
```

Release 产物名固定为 `dsh-codeaudit.tar.gz`，即安装命令里的 URL。

## 已知边界

- `scope` 是协议层留痕而非门禁：文件访问的实际强制在部署的沙箱与审批层。
- 会话投影是最近 200 节点的窗口视图；完整记录以 `codeaudit_state` / `codeaudit_graph` / 报告为准。
- 一次会话一个 engagement；重置语义见上文。

## 致谢

架构大量参考了 [dsh-pentest](https://github.com/howmp/dsh-pentest)（同为 DSH 插件形式的成熟实践），
站在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件机制之上。

## License

[MIT](./LICENSE)
