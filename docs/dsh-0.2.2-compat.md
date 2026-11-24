# kixparadigm × DeepSeek Harness 0.2.2-rc.5 兼容性分析与修复

调查时间：2026-11-24
环境：Arch Linux / Node v26.13.1 / DSH `0.2.2-rc.5`
隔离位置：`iso/dsh0225`（运行时）、`iso/state0225`（DSH_HOME）、端口 3098；
另有 `iso/dsh0225-clean`（未打补丁的官方包）用于完整安装/卸载/回滚验证。
现有 DSH（`~/.local` + `~/.dsh` + 3080）全程未改动。

## 一、结论摘要

| 维度 | 结论 |
|---|---|
| preset 是否可见/可挂载 | 修复后 6 个 kix 模式 + 4 个角色子代理全部 `broken=OK` |
| 会话是否可用 | 修复后可建会话、真实模型对话、工具调用、`/compact` |
| 子代理 | generic/cross/lite/thinker/vision/reviewer/qa/dev 均端到端可用 |
| 安装是否可移除 | `uninstall --revert-runtime` 后 DSH 运行时回到 pristine，`$DSH_HOME` 无残留 |
| 现存功能差异 | 仅 0.2.2 上游移除的 `native + PTC` 并存模式；本发行版选 native |

共定位 **11 类** 不兼容点，分布在装载机制、preset 内容、运行时 API、消息模型、工具 schema 五个层。

## 二、复现方法

### 2.1 隔离安装

```bash
mkdir -p iso/dsh0225
npm install --prefix iso/dsh0225 --cache iso/.npm-cache @deepseek-ai/dsh@0.2.2-rc.5
mkdir -p iso/state0225
# 首次启动生成 profile
DSH_HOME=$PWD/iso/state0225 node iso/dsh0225/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3098 --no-open
# 安装本仓库
DSH_HOME=$PWD/iso/state0225 KIX_DSH_NODE_MODULES=$PWD/iso/dsh0225/node_modules \
  node kixparadigm-dsh/bin/kixparadigm.js install
```

### 2.2 查询 roster

```bash
TOK=$(grep -o 'token=[A-Za-z0-9_-]*' iso/state0225/web.log | tail -1 | cut -d= -f2)
curl -s -c /tmp/c -L "http://127.0.0.1:3098/?token=$TOK" -o /dev/null
curl -s -b /tmp/c -X POST http://127.0.0.1:3098/api/agentPresets/list \
  -H 'content-type: application/json' -H 'Origin: http://127.0.0.1:3098' \
  -d '{"type":"client-request","rpcId":"p1","method":"agentPresets/list","payload":{"args":{}}}'
```

修复前（默认档）的 `broken` 字段：

```
tool-presentation: $.mode expected "native" | "ptc" but got "both"
compaction-basic: BasicCompactionConfig: unknown key "maxThresholdTokens"
tool-subagent-list-agents: never started
tool-subagent: toolFilter is no longer supported
tool-subagent-cross: toolFilter is no longer supported
tool-subagent-reviewer/qa/dev: persona is no longer supported
```

### 2.3 会话级验证

```bash
# session/create -> session/prompt，再解压会话日志
zstd -dc iso/state0225/sessions/*/session.v4.jsonl.zstd | tail
```

`roster 可见 ≠ 能挂载/能跑`：第一轮只修 roster 后，建会话仍因 `{{cwd}}` 变量失败；
必须做到 `session/prompt` 有真实 `assistant/message` 才算通过。

## 三、根因逐项

### 3.1 装载机制：`.agent-presets/` 目录不再被扫描（决定性）

- 0.2.x 的 `@deepseek-ai/dsh-agent-preset-registry` README：
  > The Web definitions come from the dsh-web-app bundle. **The registry neither scans directories nor accepts preset paths.**
- preset 必须是 profile 里的 `@deepseek-ai/dsh-agent-preset` 声明，`plugins` 用 `cordis:include` 指向文件。
- 旧安装器只复制目录，所以任何模式都不可见。
- 修复：安装器生成受管 patch 块；并把 preset 正文物化到 `profiles/web/kix-presets/`。宿主按 include 文件的 **realpath** 定解析基准，只有 `profiles/` 树内的真实路径才命中 `@deepseek-ai/*` 拦截层；放在 `.agent-presets` 或放链接会退化成裸 Node 解析，可能命中机器上另一份 DSH。

### 3.2 `tool-presentation` 的 `both` 被移除

- 0.2.2 schema：`mode: 'native' | 'ptc'`；`both` 在 0.2.0 由 `dsh-tools.presentAs('both')` 实现，0.2.2 已随执行器重构删除。
- `dsh-tool-executor-native` 与 `dsh-tool-executor-ptc` 注释：one scope permits only one executor。
- 修复：显式 `tool-executor-native`。persona 同步删去 run_code 承诺。

### 3.3 子代理 `persona` / `toolFilter` 被移除

- `dsh-tool-subagent` 源码：
  ```js
  for (const field of ["persona", "toolFilter"])
    if (Object.hasOwn(config, field)) throw new Error(`tool-subagent: ${field} is no longer supported; ...`)
  ```
- 新契约：`agentPreset` / `allowedAgentPresets` 选择**独立子代理 preset**；角色人格与工具组合都在 preset 里。
- 修复：
  - `dsh/preset/children/lite.cordis.yml`：机械人格 + read/grep/glob/shell（8 工具、8K 帽）。
  - `children/role-tools.cordis.yml` + `reviewer/qa/dev.cordis.yml`：角色人格 + fs/search/shell/todo/web/jobs。
  - `agent.cordis.yml` 的 4 个工具行绑定 `agentPreset`；`kix-focus` 动态激活表同步。

### 3.4 压缩配置 schema 不兼容（阻断挂载）

0.2.2 只接受：

| 字段 | 含义 |
|---|---|
| `thresholdRatio` | `floor(min(W×r, W−O−headroom))` |
| `headroomTokens` | 压力余量 |
| `retainRatio` / `retainTokens` | 保留尾部（互斥） |
| `maxTokens` | 摘要输出帽 |

没有 `maxThresholdTokens` / `maxRetainTokens`。原 preset 传这两个键 → `unknown key` → 整个 preset `broken`。

修复选择：**恢复字段**而非改为纯比例。原因：kix 的上下文预算是不变量
`T=min(512K,0.8W)`、`R=min(64K,0.044W)`，纯比例无法对 >1.25M 窗口保持 512K 绝对上限。
补丁在 `resolveCompactSpec` 取 min，并保留原 ratio 作为小窗口兜底。

### 3.5 `kix-route` 虚拟模型被预检拒绝

0.2.2 `dsh-tool-subagent` 新增：

```js
await llm.resolveCallConfig({ provider, model, ... })
```

`agentOptions.model = 'kix-route:cross'` 不是真实目录模型 → `UNKNOWN_MODEL`，子代理未启动即失败。

两层修复：

1. 运行时补丁：预检遇 `kix-route:` 前缀直接 return（虚拟路由由插件解析）。
2. 插件迁移：0.2.2 `agent/request` 之后不允许改 provider/model：
   ```
   agent/request proposed "..." after step preparation fixed "..."; use agent.model.select() before step preparation
   ```
   因此 `kix-route` 改在 `agent/created`（首个 step 之前）解析 tier 并 `agent.model.select()`。
   旧的 `agent/request` 改写保留为兼容/测试路径；生产路径不会触发（created 已写入真实路由）。

实测：cross 子代理日志 `provider: deepseek-official, model: deepseek-flash`，主模型 `opencode-go`，返回 `CROSS-OK`。

### 3.6 effort 不能在 `agent/request` 改

同类 guard 还检查 `reasoningEffort`。`kix-cost` 的复杂度感知 effort 正在此处注入 → 硬错误。
补丁移除该 throw，保留 provider/model 的一致性检查。

### 3.7 消息来源 `kind: 'plugin'` 失效

`dsh-llm` 的 `MessageSourceMap` 注释：
> there is no shared catch-all `plugin` kind
每个生产者声明自己的 `plugin:<name>`。旧插件写 `{kind:'plugin', plugin:name}` 会被 UI/消费者按未知 kind 处理。
修复：全部 notice 改 `plugin:kix-*`。

### 3.8 `list-agents` 子路径消失

`dsh-tool-subagent-control` 的 `package.json#exports` 只有 `.`；`./list-agents` 不存在 → “never started”。
`list_agents` 已由主插件默认注册，删除该行即可。

### 3.9 工具配置字段变必填

- `dsh-tool-fs-search`：`sampleOverCapGlobResults` 必填。
- `dsh-tool-todo`：`allowParallelInProgress` 必填。
主 preset 恰好已有；新建的子代理 preset 遗漏 → 子 preset `broken`。补齐后通过。

### 3.10 persona 模板变量收缩

0.2.2 `dsh-persona` 只注册 `provider` / `model`；`{{cwd}}` 触发
`unknown prompt variable "{{cwd}}" in section "deployment:persona-prefix"`，整个 turn 直接 error。
修复：persona 改为静态句子；cwd 仍由 runtime context 注入。

### 3.11 动态激活不能同批执行

0.2.2 中在工具执行里再次 `tools.execute` 同一批次返回 `Tool batch execution failed`。
但 `ctx.plugin` 激活本身成功。修复：首次激活只返回激活结果，下一轮直呼。
另外 `kix-focus` 的 `restrict` 在 0.2.x `tools/change` 同步重入下会无限递归，已改为先登记后 restrict、失败回滚。

## 四、验证矩阵

| 验证 | 方法 | 结果 |
|---|---|---|
| roster | `agentPresets/list` | 6 kix + 4 子预设 `broken=OK` |
| 模型对话 | `session/prompt` | `FRESH-OK` / `CLEAN-OK` |
| 工具 | `bash`、`write`、`kix_discipline_spec` | 成功；guards 拦截 `git push --force` |
| 通知 | kix-orchestration/settle | `source.kind = plugin:kix-*`，无异常 |
| 子代理 generic | `subagent` | `SUBAGENT-OK` |
| 子代理 cross | `subagent_cross` | `CROSS-OK`，异厂商路由 |
| 子代理 lite | 激活 + 直呼 | 8 工具、8K 帽、`LITE2-OK` |
| 子代理 thinker | 激活 + 直呼 | `THINK2-OK` |
| 子代理 vision | 激活 + 直呼 | `VISION2-OK` |
| 子代理 reviewer | 直呼 | 角色人格恢复 |
| 压缩 | `/compact` | `Compacted 97 history items (~10649 tokens)` |
| 安装 | 全新 HOME + 未打补丁运行时 | 自动打 7 hunk，roster 全绿 |
| 卸载 | `uninstall --revert-runtime` | 无 preset/声明/bridge 残留；`--check` 回到 exit 1 |
| 单测 | `npm test` | 安装器 4 + 补丁 1 + 一致性 + 插件 73 |

## 五、未覆盖与残余风险

1. **`run_code`**：0.2.2 执行器互斥，native 模式下无 run_code；这是上游删除，不是本仓库可以无侵入恢复的能力。需要 Code Mode 时选内置 `ptc` 模式。
2. **同 step provider failover**：`kix-route` 的熔断换厂商依赖 `agent/request` 改写；0.2.2 禁止。首轮跨厂商选择正常，同 step 内 failover 不再换路由。
3. **运行时补丁维护**：升级 DSH 后必须重跑；锚点不匹配时脚本报错并回滚，不静默。
4. **0.2.0 不在目标内**：0.2.0 的 compaction 已有绝对字段、`both` 仍在，补丁锚点不同；本安装器面向 0.2.2-rc.5。
5. **跨厂商依赖 provider 配置**：cross/vision/thinker 仍需要目录里有对应厂商/能力模型；没有时按原设计响亮失败并给出配置建议，不静默降级。

## 六、变更文件索引

| 文件 | 作用 |
|---|---|
| `scripts/install-lib.js` | 复制 preset、写受管声明块、node_modules 链接、vision-bridge、调用补丁 |
| `scripts/patch-dsh-runtime.js` | 7 个 hunk，幂等、`--check`、`--revert`、`.kix-backup` |
| `dsh/preset/agent.cordis.yml` | executor、compaction 绝对上限、去 persona/toolFilter、agentPreset、去 list-agents、去 `{{cwd}}` |
| `dsh/preset/children/*` | 4 个角色子代理 preset |
| `dsh/preset/plugins/kix-route.js` | `agent/created` + `model.select` 路由 |
| `dsh/preset/plugins/kix-focus.js` | 动态激活表清理 + 同批执行回退 + restrict 重入修复 |
| `dsh/preset/plugins/kix-*.js` | notice source `plugin:<name>` |
| `README.md` | 使用说明、修复清单、验证方法 |
