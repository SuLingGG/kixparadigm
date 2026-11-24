# kixparadigm — DSH-only distribution

> 本仓库是 [olicesx/kixparadigm](https://github.com/olicesx/kixparadigm) 的 **DeepSeek Harness 专用提取版**：
> 只保留 `dsh/` preset、插件、子代理预设、安装器与兼容性补丁；不含 VS Code Copilot 分发、`en/` 双语包和渲染基准。
> 目标：在 **DSH 0.2.2-rc.5** 上恢复当前部署（0.1.5 / 0.2.0 时代）的 kix 特性，且不出现功能缺失、功能异常和 Bug。

## 结论先说

| 项 | 状态 |
|---|---|
| 目标 DSH | **0.2.2-rc.5**（已端到端实测） |
| preset 可见性 | `kixparadigm`、`kixparadigm-classic` + 4 个角色子代理 preset 全部 `broken=OK` |
| 会话/模型 | 已建会话并用真实模型完成对话、工具调用、子代理派发 |
| 子代理 | generic / cross / lite / thinker / vision / reviewer / qa / dev 全部可用 |
| 压缩 | `/compact` 成功；绝对上限 `maxThresholdTokens` / `maxRetainTokens` 经运行时补丁恢复 |
| 本地资源 | 全部安装到 `$DSH_HOME`，不写系统目录；`uninstall` 可完全移除 |
| 唯一上游损失 | 0.2.2 移除了 `native + PTC(run_code)` 并存的 `both` 模式；本发行版选 **native**（详见下文） |

分析全文：[docs/dsh-0.2.2-compat.md](docs/dsh-0.2.2-compat.md)。
完整使用手册（安装、推荐用法、逐个工具场景与范例）：[docs/usage-guide.md](docs/usage-guide.md)。

## 安装

前置：已安装 DSH `0.2.2-rc.5`，并且至少启动过一次 `dsh web`（生成 `$DSH_HOME/profiles/web/`）。

```bash
# 从本仓库安装（推荐）
git clone https://github.com/SuLingGG/kixparadigm.git
cd kixparadigm
./install.sh

# 或 npm 全局安装；npm 12+ 可能拦截 postinstall，安装后手动跑一次 kixparadigm install
npm i -g .
kixparadigm install
```

安装器做五件事：

1. 把 `dsh/preset`、`dsh/preset-classic` 镜像到 `$DSH_HOME/.agent-presets/`；
2. 把 4 个角色子代理预设（`children/`）一并复制；
3. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 写入受管 preset 声明块（幂等，`BEGIN/END` 标记内可重复更新）；
4. 把 preset 正文物化到 `$DSH_HOME/profiles/web/kix-presets/`（真实目录，保证 `@deepseek-ai/*` 走宿主解析层）；
5. 安装 vision-bridge，并给已安装 DSH 打 7 处兼容补丁（`scripts/patch-dsh-runtime.js`）。

然后重启 DSH：

```bash
dsh web
```

在模式选择器里选 **kixparadigm**（或 classic），建会话。

> 选择器里还会看到 `kix-lite` / `kix-reviewer` / `kix-qa` / `kix-dev`：它们是子代理内部
> 预设（描述以“内部子代理模式”开头），由 `subagent_lite/reviewer/qa/dev` 自动选用，
> 不需要手动选择。

### 指定 DSH 运行时

安装器会自动从 `which dsh`、`npm root -g`、`~/.local`、`/usr/local` 查找运行时。找不到时：

```bash
KIX_DSH_NODE_MODULES=/path/to/@deepseek-ai/dsh/node_modules ./install.sh
```

### 自检 / 卸载

```bash
node bin/kixparadigm.js doctor
node bin/kixparadigm.js uninstall                # 移除 preset、声明、vision-bridge
node bin/kixparadigm.js uninstall --revert-runtime  # 同时还原 DSH 运行时补丁
```

`uninstall` 只动 `$DSH_HOME` 与本安装器打过的补丁，不触碰其他 DSH 实例、端口、会话或 provider 配置。

## 修复内容（0.2.2-rc.5）

### 1. preset 装载机制：目录不再被读取

0.2.x 的 `dsh-agent-preset-registry` **不扫描** `.agent-presets/`；preset 必须是 profile 里的
`@deepseek-ai/dsh-agent-preset` 声明行，用 `cordis:include` 指回已复制的 preset 文件。

- 修复：安装器写入受管 patch 块；`doctor` 校验。
- 证据：`agentPresets/list` 从“只有 4 个内置模式”变为列出 6 个 kix 模式。

### 2. `tool-presentation` 的 `both` 被移除

0.2.2 只接受 `native` / `ptc`，且两者互斥。`both`（native + run_code 并存）是 0.2.0 的旧机制。

- 修复：preset 显式挂 `@deepseek-ai/dsh-tool-executor-native`。
- 后果：主会话不再有 `run_code`；机械批处理改为“脚本文件 + bash”或 `workflow`。persona 已同步改写，不再承诺 `run_code`。

### 3. 子代理 `persona` / `toolFilter` 被移除

0.2.2 的 `dsh-tool-subagent` 对这两个字段**加载即报错**，要求把角色组合放进独立的 Agent Preset，并用 `agentPreset` 选择。

- 修复：新增 4 个角色子代理预设：`kix-lite`、`kix-reviewer`、`kix-qa`、`kix-dev`；
  `subagent_lite/reviewer/qa/dev` 分别绑定；`persona`/`toolFilter` 从工具行和动态激活表删除。
- 效果：lite 仍是 8 个工具 + 8K 帽；reviewer/qa/dev 恢复各自角色人格；generic/cross/thinker/vision 仍并入主 preset。

### 4. 压缩 schema 删除了绝对上限字段

0.2.2 的 `dsh-compaction-basic` 只支持比例 + headroom，无法表达“任意窗口都不超过 N token”的绝对上限。

- 修复：`scripts/patch-dsh-runtime.js` 恢复 `maxThresholdTokens` / `maxRetainTokens` 两个字段并在解析 token 预算时取 min。
- preset 配置：默认档 `T=min(512K, 0.8·W)`、`R=min(64K, 0.044·W)`；classic 档 `T=200K`。
- 证据：`/compact` 返回 `Compacted 97 history items (~10649 tokens)`。

### 5. `kix-route` 哨兵模型被适配器预检拒绝

0.2.2 在子代理启动前调用 `llm.resolveCallConfig` 校验 `agentOptions.model`，`kix-route:cross/thinker/vision` 这类虚拟模型直接 `UNKNOWN_MODEL`。

- 修复 A（运行时补丁）：预检遇到 `kix-route:` 前缀时跳过。
- 修复 B（插件）：路由解析从被禁止的 `agent/request` 改写迁移到 `agent/created` + `agent.model.select()`，在 step 准备前写入真实路由。
- 证据：`subagent_cross` 子代理实际使用 `deepseek-official/deepseek-flash`（与主模型 `opencode-go` 不同厂商）并返回 `CROSS-OK`。

### 6. `agent/request` 不再允许改 reasoning effort

0.2.2 对 effort 变化同样硬报错，而 `kix-cost` 的复杂度感知 effort 正是在该钩子注入。

- 修复（运行时补丁）：移除该 effort 一致性 throw；provider/model 仍由 `agent/created` 保证一致。

### 7. 消息来源 `kind: 'plugin'` 已不存在

0.2.2 的 source 是 merge-extensible，每个生产者声明 `plugin:<name>`；旧的 catch-all `plugin` 不再合法。

- 修复：所有 kix 插件的 notice 改为 `plugin:<name>`（`plugin:kix-guards` 等）。

### 8. `tool-subagent-control/list-agents` 子路径被删除

`list_agents` 现在由 `dsh-tool-subagent-control` 主入口默认注册。

- 修复：删除 `tool-subagent-list-agents` 行；`list_agents` 仍可用。

### 9. 工具配置字段变为必填

0.2.2 的 `dsh-tool-fs-search` 要求 `sampleOverCapGlobResults`、`dsh-tool-todo` 要求 `allowParallelInProgress`，缺省即挂载失败。

- 修复：主 preset 与子代理预设都显式写入。

### 10. `{{cwd}}` 提示变量被移除

0.2.2 只注册 `provider` / `model` 两个 prompt variable；persona 直接因 `UNKNOWN_PROMPT_VARIABLE` 失败。

- 修复：persona 改为“Working directory: the workspace.”，cwd 由运行时上下文提供。

### 11. 动态激活语义调整

0.2.2 在工具执行中再次 `tools.execute` 同一批次会被拒绝（`Tool batch execution failed`）。

- 修复：`kix_capability_call` 首次激活时返回“已激活，下一轮可直接调用”，不再同批执行；下一轮直呼成功。
- `kix-focus` 的 `restrict` 先登记/失败回滚，避免 0.2.x `tools/change` 同步重入导致栈溢出。

## 目录结构

```
dsh/
├── preset/                 # 默认激励面（安装为 kixparadigm）
│   ├── children/           # 4 个角色子代理 preset 组合
│   ├── plugins/            # kix 机制插件 + 测试
│   ├── prompts/ skills/ memories/ patches/
│   └── agent.cordis.yml
├── preset-classic/         # 经典全文（安装为 kixparadigm-classic）
├── preset-null/            # 消融对照（不安装）
└── vision-bridge/          # 无缝识图插件
scripts/
├── install-lib.js          # 安装器：preset + 声明块 + 链接 + 补丁
├── patch-dsh-runtime.js    # 7 处 0.2.2 兼容补丁（幂等/可回滚）
└── check-dsh-consistency.cjs
```

## 验证

```bash
npm test                 # 安装器 + 补丁 apply/revert + 一致性 + 全部插件单测
```

本仓库的 E2E 验证在**隔离环境**完成，未触碰现有 DSH：

- 独立 `npm --prefix iso/dsh0225` 安装 `@deepseek-ai/dsh@0.2.2-rc.5`；
- 独立 `DSH_HOME=iso/state0225`、端口 3098；
- 另建 `iso/dsh0225-clean` 从**未打补丁**的官方包跑完整安装 → apply → 会话 → uninstall → revert；
- 验证后 clean 运行时 `--check` 回到未打补丁状态，`$DSH_HOME` 无 kix/vision-bridge 残留。

## 已知边界

- **仅目标 0.2.2-rc.5**。0.2.0 的 compaction 已有绝对字段、`both` 仍存在，补丁锚点不匹配；安装器会明确报错而不是静默降级。
- 运行时补丁写在 `node_modules`，**每次升级 DSH 后必须重跑** `node scripts/patch-dsh-runtime.js`（`doctor` 会提示）。
- `kix-route` 的 provider 熔断 failover 依赖 `agent/request` 改写；0.2.2 禁止该改写，因此仅保留“首轮路由选择”，不再在同一 step 内换 provider。跨厂商首轮选择正常。
- `kix_capability_call` 首次使用多一轮往返（激活 → 下一轮直呼）。
- `run_code` 在 native 模式下不可用；需要 Code Mode 时请选 DSH 内置 `ptc` 模式。

## License

MIT，继承上游 `olicesx/kixparadigm`。
