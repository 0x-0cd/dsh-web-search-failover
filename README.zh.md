# dsh-web-search-failover

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件：给内置的 `web_search` 工具加上 **Exa 主 + 官方 DeepSeek 搜索自动备用** —— Exa 端点挂掉、key 失效或服务不可用时，agent 不会失去搜索能力。

## 为什么需要它

`ctx.web`（dsh 的 web 能力接缝）每次调用只解析**一个** provider：钉了 `searchProvider` 就用它，否则要求恰好只有一个可用。`available()` 只是廉价的本地检查，provider 抛错后接缝**不会**去试别的后端。所以同时挂上 `@deepseek-ai/dsh-web-search-exa` 和 `@deepseek-ai/dsh-web-search-deepseek` 并不会带来任何回退——钉住的那个要么答，要么整个工具调用失败。

本插件注册一个额外的 provider，内部组合两个官方实现。回退发生在一个 provider 内部，上层完全无感：`web_search` 的工具名、入参 schema、结果格式、系统提示都不变。

## 工作原理

```
web_search (dsh-tool-web)
      │
      ▼
ctx.web  ── searchProvider: exa-deepseek
      │
      ▼
FailoverSearchProvider  (本插件)
      ├── ExaSearchProvider        ← 主   (@deepseek-ai/dsh-web-search-exa)
      └── DeepSeekSearchProvider   ← 备用 (@deepseek-ai/dsh-web-search-deepseek)
```

两条腿都是**官方包导出的官方类**（`ExaSearchProvider`、`DeepSeekSearchProvider`，连 `DEEPSEEK_DEFAULT_*` 常量都是 import 的）。本插件只负责顺序、取消保护和合并后的错误信息，没有重新实现任何搜索逻辑。

### 回退规则

| 情况 | 行为 |
|---|---|
| Exa 本地不可用（key 空、`baseURL` 无法解析） | 直接由 DeepSeek 作答，不报错 |
| Exa 抛错（网络失败、超时、401/402、5xx、响应不可解析） | 打一条 logger `warn`，转由 DeepSeek 作答 |
| 调用被取消 / 超时（`signal.aborted`、`WEB_ABORTED`） | 原样抛出——**不回退**，避免超时后白发一次付费搜索 |
| Exa 成功但 0 条结果 | 原样返回——空结果是合法答案，不是故障 |
| 两条腿都失败 | 保留 Exa 的错误码与消息，附上备用腿的失败原因并链为 `cause` |

由备用腿作答时，仍会写入官方的 `web/deepseek-search-llm-request` 会话事件，回退可审计（这也是验证回退是否触发的最干净手段，见下文）。

## 前置条件

- dsh `0.1.7-rc.2`（`package.json` 里的 peer 与运行时版本精确对齐，见[升级 dsh](#升级-dsh)）
- profile 里已安装 `@deepseek-ai/dsh-web-search-exa@0.1.7-rc.2`
- 一个 Exa API key（`EXA_API_KEY`）和一个 DeepSeek 凭据（`DEEPSEEK_API_KEY`）

## 安装

```sh
dsh plugin --profile web add github:0x-0cd/dsh-web-search-failover
```

git 安装会拉取仓库当前发布的内容，想固定版本就 pin 一个 tag 或 commit：
`dsh plugin --profile web add github:0x-0cd/dsh-web-search-failover#v0.1.0`。

本包刻意**不声明 `dsh.bundle`**，因此以普通依赖安装（CLI 会打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`，这是预期行为），再由 profile patch 挂载它的行。同时装上 Exa provider，然后把接缝钉到 failover provider：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-web-search-exa@0.1.7-rc.2
```

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml（可直接抄 examples/cordis.patch.yml）
- insert:
    - id: web-search-failover
      name: dsh-web-search-failover
      config:
        exaSearchType: auto
    - id: web-search-exa
      name: '@deepseek-ai/dsh-web-search-exa'
      config:
        searchType: auto
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: exa-deepseek
    fetchProvider: http   # patch 是整块替换 config，这行千万别删
```

密钥放在启动环境能看到的地方，`$DSH_HOME/.env` 即可：

```dotenv
EXA_API_KEY=exa-...
DEEPSEEK_API_KEY=sk-...
```

安装包或改 `.env` 后需要重启 `dsh web`（Exa provider 在挂载时读启动环境快照）；只改 patch 文件则会热重载。

`web_fetch` 不受影响：保留 `fetchProvider: http` 即可。

## 配置字段

全部可选。

| 字段 | 默认 | 说明 |
|---|---|---|
| `exaApiKey` | `$EXA_API_KEY` | 字面 Exa key；空或纯空白则回落到启动环境 |
| `exaBaseURL` | `https://api.exa.ai` | Exa 端点基址，其后追加 `/search` |
| `exaSearchType` | `auto` | `auto` / `keyword` / `neural` |
| `exaNumResults` | 未设 | 请求未带 `maxResults` 时的默认条数 |
| `exaHighlightsPerResult` | `1` | 每条结果请求的 highlight 句数 |
| `deepseekApiKeyEnv` | `DEEPSEEK_API_KEY` | 备用腿的凭证引用，每次搜索经 `ctx.credentials` 解析 |
| `deepseekBaseURL` | `$DEEPSEEK_SEARCH_BASE_URL` → `https://api.deepseek.com/anthropic/v1` | 备用腿的 Messages 端点 |
| `deepseekModel` | `deepseek-v4-flash` | 辅助搜索那一轮使用的模型 |
| `deepseekApiVersion` | `2023-06-01` | `anthropic-version` 头 |
| `deepseekMaxTokens` | `4096` | 辅助请求的生成 token 上限 |
| `deepseekMaxUses` | `5` | 单次辅助请求允许的原生 `web_search` 次数 |

### 切换后端

改 profile patch 里的一行即可，热重载、无需重启：

| `searchProvider` | 效果 |
|---|---|
| `exa-deepseek` | Exa 主 + DeepSeek 备用（本插件） |
| `exa` | 只用 Exa |
| `deepseek-official` | 只用内置 DeepSeek 搜索 |

## 验证回退是否真的生效

把 Exa 腿指向一个必然连不上的地址，保存 patch（热重载），然后搜索一次：

```yaml
- insert:
    - id: web-search-failover
      name: dsh-web-search-failover
      config:
        exaBaseURL: http://127.0.0.1:9   # 临时故障注入
```

回退生效的表现：工具调用**仍然返回结果**，日志里出现
`web-search-failover: Exa failed, using the DeepSeek fallback — …`，且会话日志恰好新增一条
`web/deepseek-search-llm-request` 事件。测完把注入的 `exaBaseURL` 删掉。

会话日志为 `session.v4.jsonl.zstd` 时，可以这样数审计事件：

```sh
zstd -dc "$DSH_HOME"/sessions/*/session-*/session.v4.jsonl.zstd \
  | python3 -c "import sys,json; print(sum(1 for l in sys.stdin if json.loads(l).get('type')=='web/deepseek-search-llm-request'))"
```

## 注意事项

- **备用腿读的是本插件的配置 + 启动环境，不读 GUI 页面。** 「设置 → 插件 → 网页搜索」改的是官方 `web-search-deepseek` 那一行的端点与单请求搜索次数预算，只作用于那一行的 provider，不影响这里构造的备用腿。需要备用腿对齐就在本行设置 `deepseekBaseURL` / `deepseekMaxUses`。凭据是共享的：`deepseekApiKeyEnv` 解析的就是 Models 页写入的同一个 `ctx.credentials` 存储。
- **`EXA_API_KEY` 来自启动环境快照**，改 `$DSH_HOME/.env` 后要重启 `dsh web`；patch 里的配置字段则热重载。
- **`file:` 安装是拷贝。** 如果你从本地检出开发并改了源码，要重新执行 `dsh plugin --profile web add file:/path/to/dsh-web-search-failover`（或在 profile 目录 `pnpm install`）才会刷新 profile 实际加载的内容。

### 升级 dsh

五个 `@deepseek-ai/dsh-*` peer 与运行时版本精确对齐。升级 dsh 后要把它们改成新版本再重装，否则启动兼容检查会拒绝加载（它会打印确切的 `dsh plugin allow-version … --accept-risk` 命令；授予豁免是真实风险，不是走形式）。本插件只依赖公开导出，若未来某版改了 provider 的选项字段名，加载会明确报错，按新字段小幅修改 `index.js` 即可。

## 卸载

```sh
dsh plugin --profile web remove dsh-web-search-failover
```

然后删掉插入的那两行，把 `searchProvider` 改回 `exa` 或 `deepseek-official`。

## 开发

```
index.js                     插件全文（Cordis 函数插件：name / inject / Config / apply）
package.json                 peer 与 dsh 运行时对齐；刻意不含 dsh.bundle
examples/cordis.patch.yml    可直接复制的 profile patch
```

对着运行中的 profile 做本地迭代：

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-web-search-failover
```

`link:` 会软链检出目录，改动在下次插件加载时生效；`file:` 则是拷贝。

## 许可证

[MIT](LICENSE)
