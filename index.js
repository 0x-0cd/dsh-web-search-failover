/**
 * `dsh-web-search-failover` — a local `WebSearchProvider` for the harness web
 * seam (`ctx.web`) that runs **Exa first** and, when Exa cannot answer, the
 * **official DeepSeek search provider** as an automatic fallback.
 *
 * Why this exists: `ctx.web` resolves exactly one provider per call (a pinned id
 * wins, otherwise the single usable provider) and never retries another backend
 * after a provider throws, so mounting both `@deepseek-ai/dsh-web-search-exa`
 * and `@deepseek-ai/dsh-web-search-deepseek` gives no failover on its own. This
 * plugin registers one provider (`exa-deepseek`) that composes both official
 * implementations, so the model-facing `web_search` tool, its schema, and its
 * result formatting are all unchanged.
 *
 * Fallback rules:
 * - Exa locally unusable (`available() === false`) → the fallback answers directly.
 * - Exa throws while the call is live → the fallback answers.
 * - Cancellation never triggers a fallback: an aborted signal or a `WEB_ABORTED`
 *   error is rethrown as is (a timed-out tool call must not start a second search).
 * - An empty-but-successful Exa result is a real answer and is returned as is.
 * - When both legs fail, the Exa error keeps its code and message, with the
 *   fallback failure appended and chained as `cause`.
 *
 * This package is a plain dependency, not a bundle (`dsh.bundle` is deliberately
 * absent), so it is mounted as an ordinary row in the profile patch layer.
 *
 * @module dsh-web-search-failover
 */

import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { ExaSearchProvider } from '@deepseek-ai/dsh-web-search-exa'
import {
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DeepSeekSearchProvider,
} from '@deepseek-ai/dsh-web-search-deepseek'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-failover'
/** The web seam this provider registers into. */
export const inject = ['web']

/** Stable id this provider registers under; pin `searchProvider` to it. */
export const PROVIDER_ID = 'exa-deepseek'

/** Launcher environment variable carrying the Exa key (same one the official provider reads). */
const EXA_API_KEY_ENV = 'EXA_API_KEY'
/** Launcher environment variable overriding the DeepSeek search endpoint. */
const DEEPSEEK_SEARCH_BASE_URL_ENV = 'DEEPSEEK_SEARCH_BASE_URL'

export const Config = z.object({
  /** Literal Exa key; empty/absent falls back to `$EXA_API_KEY` from the launch environment. */
  exaApiKey: z.string(),
  /** Exa endpoint base; `/search` is appended. */
  exaBaseURL: z.string(),
  /** Exa retrieval mode. */
  exaSearchType: z.union(['auto', 'keyword', 'neural']),
  /** Default result count when a request carries no `maxResults`. */
  exaNumResults: z.number().step(1).min(1),
  /** Highlight sentences requested per result. */
  exaHighlightsPerResult: z.number().step(1).min(1),
  /** Credential reference for the fallback leg. */
  deepseekApiKeyEnv: z.string().default('DEEPSEEK_API_KEY'),
  /** Fallback endpoint base; empty/absent falls back to `$DEEPSEEK_SEARCH_BASE_URL`, then the official default. */
  deepseekBaseURL: z.string(),
  deepseekModel: z.string().default(DEEPSEEK_DEFAULT_MODEL),
  deepseekApiVersion: z.string().default(DEEPSEEK_DEFAULT_API_VERSION),
  deepseekMaxTokens: z.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_TOKENS),
  deepseekMaxUses: z.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_USES),
})

/** True for an error that means "the caller cancelled", never "the backend is down". */
function isCancellation(error) {
  if (error instanceof WebError && error.code === 'WEB_ABORTED') return true
  return typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError'
}

/** Machine-routable code of a provider failure, defaulting to the seam's generic provider error. */
function codeOf(error) {
  return error instanceof WebError && typeof error.code === 'string' ? error.code : 'WEB_PROVIDER_ERROR'
}

/** Readable one-line description of a failure. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One provider composing a primary and a fallback backend. Both are ordinary
 * `WebSearchProvider` implementations; this class only owns the ordering,
 * the cancellation guard, and the combined error message.
 */
class FailoverSearchProvider {
  id = PROVIDER_ID

  constructor(primary, fallback, onFallback) {
    this.primary = primary
    this.fallback = fallback
    this.onFallback = onFallback
  }

  /** Usable while either leg is usable, so the seam never reports the pair as dead. */
  available() {
    return this.primary.available() || this.fallback.available()
  }

  async search(request, signal) {
    if (!this.primary.available()) return await this.#viaFallback(request, signal, undefined)
    try {
      return await this.primary.search(request, signal)
    } catch (error) {
      if (signal?.aborted === true || isCancellation(error)) throw error
      this.onFallback(error)
      return await this.#viaFallback(request, signal, error)
    }
  }

  /** Answer through the fallback, or explain why neither leg could answer. */
  async #viaFallback(request, signal, primaryError) {
    if (!this.fallback.available()) {
      if (primaryError === undefined) {
        throw new WebError('neither the Exa primary nor the DeepSeek fallback is available', 'WEB_PROVIDER_UNAVAILABLE')
      }
      throw new WebError(
        `${messageOf(primaryError)}; the DeepSeek fallback is also unavailable`,
        codeOf(primaryError),
        { cause: primaryError },
      )
    }
    try {
      return await this.fallback.search(request, signal)
    } catch (error) {
      if (signal?.aborted === true || isCancellation(error)) throw error
      if (primaryError === undefined) throw error
      throw new WebError(
        `Exa primary failed (${messageOf(primaryError)}); DeepSeek fallback failed (${messageOf(error)})`,
        codeOf(primaryError),
        { cause: error },
      )
    }
  }
}

/**
 * Register the failover provider with `ctx.web`.
 *
 * @param ctx - plugin context carrying the web seam, credentials, and launch environment.
 * @param config - this row's config section.
 */
export function apply(ctx, config) {
  const launch = () => launchEnvironmentOf(ctx)
  const exaApiKey = nonEmpty(config.exaApiKey) ?? launch().get(EXA_API_KEY_ENV)?.value ?? ''

  const primary = new ExaSearchProvider({
    apiKey: exaApiKey,
    baseURL: config.exaBaseURL ?? 'https://api.exa.ai',
    searchType: config.exaSearchType ?? 'auto',
    highlightsPerResult: config.exaHighlightsPerResult ?? 1,
    ...config.exaNumResults !== undefined ? { numResults: config.exaNumResults } : {},
  })

  const apiKeyEnv = nonEmpty(config.deepseekApiKeyEnv) ?? 'DEEPSEEK_API_KEY'
  const fallback = new DeepSeekSearchProvider(() => ({
    // Resolved per search, so a key written on the Models page reaches the next call.
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      const ambient = launch().get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: nonEmpty(config.deepseekBaseURL)
      ?? nonEmpty(launch().get(DEEPSEEK_SEARCH_BASE_URL_ENV)?.value)
      ?? DEEPSEEK_DEFAULT_BASE_URL,
    model: config.deepseekModel,
    apiVersion: config.deepseekApiVersion,
    maxTokens: config.deepseekMaxTokens,
    maxUses: config.deepseekMaxUses,
    // Keep the official provider's audit event so a fallback search is still traceable.
    recordRequest: (request) => {
      try {
        ctx.get('agents')?.currentInitiator()?.session.append('web/deepseek-search-llm-request', request)
      } catch {
        /* logging must never fail a search */
      }
    },
  }))

  const onFallback = (error) => {
    try {
      ctx.logger?.warn?.(`web-search-failover: Exa failed, using the DeepSeek fallback — ${messageOf(error)}`)
    } catch {
      /* logging must never fail a search */
    }
  }

  ctx.web.registerSearchProvider(new FailoverSearchProvider(primary, fallback, onFallback))
}

/** Treat an empty or blank configured string as absent. */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}
