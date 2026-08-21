---
name: codeaudit-methodology
description: 代码审计方法论与可重放 POC 构造规范（配合 codeaudit_* 工具链使用）。规划审计意图、验证发现、排查防护点或编写 HTTP POC 时使用。Use when planning audit intents, verifying findings against sanitizers, or constructing replayable HTTP POCs in 代码审计模式 sessions.
---

# 代码审计方法论与 POC 构造规范

本技能补充 `codeaudit:protocol`：协议规定"记录什么"，本技能规定"怎么查、怎么写 POC"。

## 意图拆解：模块 × 漏洞类矩阵

对每个业务模块逐一对照下表拆分意图（有入口/有数据的格子才立项，避免空转）：

| 漏洞类 | 高价值入口特征 |
|---|---|
| SQL/命令/表达式注入 | 字符串拼接进查询/解释器；`Runtime.exec`、`ProcessBuilder`、OGNL/SpEL/EL |
| 鉴权与越权 | 路由缺少权限注解/中间件；对象 id 直接来自请求参数（水平越权）；管理接口暴露 |
| 反序列化 | `ObjectInputStream`、`pickle`、`yaml.load`、`unserialize`、fastjson/jackson 多态 |
| 文件操作 | 上传路径拼接（穿越）、下载参数可控、`include`/模板包含 |
| SSRF | URL 参数直接发起请求（回调、导入、预览、代理） |
| XSS / 前端 | 模板变量未转义、`v-html`/`innerHTML`、富文本 |
| 密钥与弱加密 | 硬编码密钥/密码、ECB/无 IV、`Math.random` 做令牌、弱哈希存口令 |
| 配置与依赖 | debug 开关、CORS `*`、依赖清单对照已知 CVE |

## 验证定级（误报控制）

发现 sink 后**必须**完成三步再定级：

1. **向上追**：入口参数如何到达此处（完整数据流，途经每一层记录为 dataflow 证据）；
2. **查防护**：入口校验、参数化查询、编码输出、框架防护（过滤器/中间件/注解）——排查过的防护记为 `sanitizer` 证据；
3. **下结论**：防护确认缺失/可绕过 → `confirmed`；防护存在但无法确认可绕过、或触发条件未验证 → `suspected`，并在 description 写明未验证点。

## POC 构造规范

- `poc` 只放**纯 HTTP raw**（请求行 + 头 + 体），可直粘 Yakit/Burp 重放，**绝不夹任何注释**；
- 参数生成规则、占位符含义、前置条件（如需先登录拿 token）一律写 `pocNote`，并注明「静态构造，未经发送验证」或「已动态验证」；
- 占位符约定：目标 `http://<target>`、受害者标识 `<victim>`、可控参数用真实参数名；
- 从代码可推导出完整请求的漏洞**即使未发送也要构造**；确实构造不出可重放请求的（密钥硬编码、配置缺陷）才留空 `poc`；
- 有测试环境时先在 `.codeaudit-scratch/` 用 curl 发送验证，成功后原样记录报文。

示例——`riddle` 参数由时间戳派生时：

- poc（纯报文）：
  ```
  GET /auth/authentication_authority.do?time=1700000000000&riddle=f9fa31362e69440321752d939aaa7337&temptoken=<victim> HTTP/1.1
  Host: <target>
  ```
- pocNote（说明）：`riddle=md5("besto"+time)，time 为毫秒时间戳；<victim> 为受害者标识。静态构造，未经发送验证。`

## 证据质量

- 每条证据带 `file:line` 与关键代码片段（`snippet`，只贴决定性几行，不贴整段源码）；
- 证据链服务于结论：入口(dataflow/entry) → 传播 → sink，逐条可回放；
- 意图收敛后提醒指挥官出报告；收益递减（连续 3 个意图无新发现）时建议终止。
