# dsh-web-search-failover

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that gives the built-in `web_search` tool an **Exa primary** and the **official DeepSeek search provider as an automatic fallback** — so a dead Exa endpoint, an expired key, or an Exa outage no longer leaves the agent without web search.

## Why this plugin exists

`ctx.web` — the harness web capability seam — resolves **exactly one** provider per call: a pinned `searchProvider` id wins, otherwise the single usable provider is chosen. `available()` is only a cheap local check, and when a provider throws, the seam **does not retry another backend**. Mounting `@deepseek-ai/dsh-web-search-exa` and `@deepseek-ai/dsh-web-search-deepseek` side by side therefore gives you no failover at all: the pinned provider either answers or the tool call fails.

This plugin registers one extra provider that composes both official implementations, so the failover lives inside a single provider and everything above it — the `web_search` tool name, its schema, its result formatting, the system-prompt guidance — stays untouched.

## How it works

```
web_search (dsh-tool-web)
      │
      ▼
ctx.web  ── searchProvider: exa-deepseek
      │
      ▼
FailoverSearchProvider  (this plugin)
      ├── ExaSearchProvider        ← primary   (@deepseek-ai/dsh-web-search-exa)
      └── DeepSeekSearchProvider   ← fallback  (@deepseek-ai/dsh-web-search-deepseek)
```

Both legs are the **official classes, imported from the official packages** (`ExaSearchProvider`, `DeepSeekSearchProvider`, and the `DEEPSEEK_DEFAULT_*` constants). This plugin adds only the ordering, the cancellation guard, and the combined error — it re-implements no search logic.

### Fallback rules

| Situation | Behavior |
|---|---|
| Exa locally unusable (empty key, unparseable `baseURL`) | Answered by DeepSeek directly; no error |
| Exa throws (network failure, timeout, 401/402, 5xx, unparseable body) | One `warn` on the harness logger, then answered by DeepSeek |
| Call cancelled / timed out (`signal.aborted`, `WEB_ABORTED`) | Rethrown as is — **no fallback**, so a timed-out call never starts a second paid search |
| Exa succeeds with zero sources | Returned as is — an empty result is a real answer, not a failure |
| Both legs fail | The Exa error keeps its code and message, with the fallback failure appended and chained as `cause` |

When the DeepSeek leg answers, it still records the official `web/deepseek-search-llm-request` session event, so a fallback search stays auditable in the session log. (That event is also the cleanest way to prove the fallback fired — see [Verifying](#verifying-that-failover-really-works).)

## Requirements

- dsh `0.1.7-rc.2` (the peers in `package.json` are pinned to the runtime version — see [Upgrading dsh](#upgrading-dsh))
- `@deepseek-ai/dsh-web-search-exa@0.1.7-rc.2` installed in the profile
- An Exa API key (`EXA_API_KEY`) and a DeepSeek credential (`DEEPSEEK_API_KEY`)

## Install

```sh
dsh plugin --profile web add github:0x-0cd/dsh-web-search-failover
```

A git install runs whatever the repository publishes, so pin a revision when you want a fixed one:
`dsh plugin --profile web add github:0x-0cd/dsh-web-search-failover#v0.1.0`.

The package deliberately declares **no `dsh.bundle`**, so it installs as a plain dependency (the CLI prints `declares no dsh.bundle — installed as a plain dependency, not a profile layer`; that is expected) and you mount its row from the profile patch. Mount the Exa provider too, then pin the seam to the failover provider:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-web-search-exa@0.1.7-rc.2
```

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml  (see examples/cordis.patch.yml)
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
    fetchProvider: http   # a patch replaces the whole config; never drop this line
```

Put the keys where the launch environment can see them — `$DSH_HOME/.env` works:

```dotenv
EXA_API_KEY=exa-...
DEEPSEEK_API_KEY=sk-...
```

Restart `dsh web` after installing packages or changing `.env` (the Exa provider reads the launch-environment snapshot at mount). Editing the patch file alone is hot-reloaded.

Meanwhile `web_fetch` is untouched: keep `fetchProvider: http` and it keeps working as before.

## Configuration

Every field is optional.

| Field | Default | Meaning |
|---|---|---|
| `exaApiKey` | `$EXA_API_KEY` | Literal Exa key; empty/blank falls back to the launch environment |
| `exaBaseURL` | `https://api.exa.ai` | Exa endpoint base; `/search` is appended |
| `exaSearchType` | `auto` | `auto`, `keyword`, or `neural` |
| `exaNumResults` | unset | Default result count when a request carries no `maxResults` |
| `exaHighlightsPerResult` | `1` | Highlight sentences requested per result |
| `deepseekApiKeyEnv` | `DEEPSEEK_API_KEY` | Credential reference for the fallback leg, resolved per search through `ctx.credentials` |
| `deepseekBaseURL` | `$DEEPSEEK_SEARCH_BASE_URL` → `https://api.deepseek.com/anthropic/v1` | Messages endpoint for the fallback leg |
| `deepseekModel` | `deepseek-v4-flash` | Model used for the auxiliary search turn |
| `deepseekApiVersion` | `2023-06-01` | `anthropic-version` header |
| `deepseekMaxTokens` | `4096` | Generated-token cap for the auxiliary request |
| `deepseekMaxUses` | `5` | Native `web_search` server-tool uses per auxiliary request |

### Switching backends

Change one line in the profile patch — hot-reloaded, no restart:

| `searchProvider` | Effect |
|---|---|
| `exa-deepseek` | Exa primary, DeepSeek fallback (this plugin) |
| `exa` | Exa only |
| `deepseek-official` | The built-in DeepSeek search only |

## Verifying that failover really works

Point the Exa leg at an address that cannot answer, save the patch (hot-reloaded), and search once:

```yaml
- insert:
    - id: web-search-failover
      name: dsh-web-search-failover
      config:
        exaBaseURL: http://127.0.0.1:9   # temporary fault injection
```

A working fallback means: the tool call still returns results, the harness logs
`web-search-failover: Exa failed, using the DeepSeek fallback — …`, and the session log gains exactly one
`web/deepseek-search-llm-request` event. Remove the injected `exaBaseURL` when done.

With session logs stored as `session.v4.jsonl.zstd`, the audit event can be counted with:

```sh
zstd -dc "$DSH_HOME"/sessions/*/session-*/session.v4.jsonl.zstd \
  | python3 -c "import sys,json; print(sum(1 for l in sys.stdin if json.loads(l).get('type')=='web/deepseek-search-llm-request'))"
```

## Caveats

- **The fallback leg reads this plugin's config and the launch environment, not the GUI page.** Settings → Plugins → Web search edits the official `web-search-deepseek` row (its endpoint and per-request search budget); those overrides apply to that row's provider, not to the fallback built here. Set `deepseekBaseURL` / `deepseekMaxUses` in this row if you need the fallback to match. Credentials are shared: `deepseekApiKeyEnv` resolves through the same `ctx.credentials` store the Models page writes.
- **`EXA_API_KEY` comes from the launch-environment snapshot**, so changing it in `$DSH_HOME/.env` requires a `dsh web` restart. Config fields in the patch hot-reload.
- **`file:` installs are copies.** If you develop from a local checkout and edit the source, re-run `dsh plugin --profile web add file:/path/to/dsh-web-search-failover` (or `pnpm install` in the profile) to refresh what the profile loads.

### Upgrading dsh

The five `@deepseek-ai/dsh-*` peers are pinned to the runtime version. After upgrading dsh, bump them to the new version and reinstall, or the startup compatibility check refuses the plugin (it prints the exact `dsh plugin allow-version … --accept-risk` command; granting it is a real risk, not a formality). This plugin depends only on public exports, so if a future release renames a provider option, the load fails loudly and the fix is a small edit to `index.js`.

## Uninstall

```sh
dsh plugin --profile web remove dsh-web-search-failover
```

Then remove the two inserted rows and point `searchProvider` back to `exa` or `deepseek-official`.

## Development

```
index.js                     the whole plugin (Cordis function plugin: name, inject, Config, apply)
package.json                 peers pinned to the dsh runtime; no dsh.bundle on purpose
examples/cordis.patch.yml    ready-to-copy profile patch
```

Local iteration against a live profile:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-web-search-failover
```

`link:` symlinks the checkout so edits take effect on the next plugin load; `file:` copies it.

## License

[MIT](LICENSE)
