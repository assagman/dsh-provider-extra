/**
 * dsh-provider-extra: extra LLM provider routes for DeepSeek Harness.
 *
 * Mounts two routes today. OpenCode Go stamps the x-opencode-session header
 * from the live dsh session id, which the gateway requires for routing and
 * prompt-cache affinity and which the shipped adapters do not send. OpenAI
 * Codex serves a ChatGPT subscription through pi-ai's OAuth: the grant lives
 * in the harness credential store (see src/codex-login.ts for the sign-in),
 * because no shipped surface consumes DSH core's own Codex authorization flow.
 *
 * Registration is the profile's job: `dsh plugin add` installs the package and
 * its bundle patch mounts this module, so no path is ever written down.
 *
 *     dsh plugin --profile web add @sagmans/dsh-provider-extra
 *
 * An ID-targeted override changes the config after that:
 *
 *     - id: dsh-provider-extra
 *       config:
 *         apiKeyEnv: OPENCODE_API_KEY
 *         # routeId: opencode-go        # default; keep it out of llm-pi-ai providers
 *         # baseURL: https://opencode.ai/zen/go/v1
 *         # fallbackSessionId: dsh-provider-extra
 *         # codexEnabled: true          # sign in with: dsh-provider-extra-login
 *         # codexRouteId: openai-codex  # default; keep it out of llm-pi-ai providers
 *
 * @module dsh-provider-extra
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { LlmError, assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-commands'
import { createModels } from '@earendil-works/pi-ai'
import {
  DEFAULT_EXTRA_MODEL_TEMPLATE,
  DEFAULT_OPENCODE_API_KEY_ENV,
  OPENCODE_GO_PROVIDER_ID,
  buildOpenCodeGoProfile,
} from './opencode-go.ts'
import type { ExtraModelSpec, OpenCodeGoRouteConfig } from './opencode-go.ts'
import {
  DEFAULT_CODEX_DISPLAY_NAME,
  DEFAULT_CODEX_ROUTE_ID,
  buildCodexProfile,
  catalogCodex,
  codexApiKey,
  codexAuth,
  recordKeyFor,
} from './codex.ts'
import type { CodexCredentialService, CodexRouteConfig } from './codex.ts'
import { startCodexLogin } from './codex-login.ts'
import { DEFAULT_LOGIN_COMMAND_NAME, createLoginCommand } from './login-command.ts'
import type { LoginCommandHost } from './login-command.ts'

/** Settings namespace configuration surfaces address this plugin's section by. */
const SETTINGS_NS = 'dsh-provider-extra'

export interface Config {
  apiKeyEnv: string
  routeId: string
  displayName: string
  baseURL?: string
  fallbackSessionId?: string
  headers?: Record<string, string>
  codexEnabled: boolean
  codexRouteId: string
  codexDisplayName: string
  loginCommandEnabled: boolean
  loginCommandName: string
}

export const Config: Schema<Config> = Schema.object({
  apiKeyEnv: Schema.string().role('credential-ref').default(DEFAULT_OPENCODE_API_KEY_ENV),
  routeId: Schema.string().default(OPENCODE_GO_PROVIDER_ID),
  displayName: Schema.string().default('OpenCode Go'),
  baseURL: Schema.string(),
  fallbackSessionId: Schema.string(),
  headers: Schema.dict(Schema.string()),
  codexEnabled: Schema.boolean().default(true),
  codexRouteId: Schema.string().default(DEFAULT_CODEX_ROUTE_ID),
  codexDisplayName: Schema.string().default(DEFAULT_CODEX_DISPLAY_NAME),
  loginCommandEnabled: Schema.boolean().default(true),
  loginCommandName: Schema.string().default(DEFAULT_LOGIN_COMMAND_NAME),
})

export const name = 'dsh-provider-extra'
export const inject = ['llm']

/** Restart-free model additions for the route, read from the settings section per request. */
export interface ProviderExtraSection {
  /** Extra models served beside the installed catalog; later entries win by id. */
  extraModels: ExtraModelSpec[]
}

const extraModelSchema: Schema<ExtraModelSpec> = Schema.object({
  id: Schema.string().required(),
  name: Schema.string(),
  template: Schema.string().default(DEFAULT_EXTRA_MODEL_TEMPLATE),
})

const SectionSchema: Schema<ProviderExtraSection> = Schema.object({
  extraModels: Schema.array(extraModelSchema).default([]),
})

/** The credential seam when present; resolved per request, never at mount. */
interface CredentialService {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

export function apply(ctx: Context, config: Config): void {
  const route: OpenCodeGoRouteConfig = {
    provider: config.routeId,
    displayName: config.displayName,
    apiKeyEnv: config.apiKeyEnv,
    ...config.baseURL === undefined ? {} : { baseURL: config.baseURL },
    ...config.fallbackSessionId === undefined ? {} : { fallbackSessionId: config.fallbackSessionId },
    ...config.headers === undefined ? {} : { headers: { ...config.headers } },
  }

  const codex: CodexRouteConfig = {
    provider: config.codexRouteId,
    displayName: config.codexDisplayName,
  }

  // The Codex profile is boot-time, not per-request: it takes no settings
  // inputs, and building it per operation would let a catalog drift (pi-ai no
  // longer shipping Codex) fail every request on both routes instead of just
  // standing this route down once, loudly, here.
  let codexProfile: ResolvedPiAiProviderProfile | undefined
  if (config.codexEnabled) {
    try {
      codexProfile = buildCodexProfile(codex)
    } catch (error) {
      ctx.logger.error('dsh-provider-extra: codex route "' + codex.provider + '" disabled; the installed pi-ai catalog cannot serve it')
      ctx.logger.error(error)
    }
  }

  // Route wiring is boot-time, but the model list is per-request: the section
  // thunk below tracks the settings overlay, so a committed extras change
  // reaches the next operation with no rebuild and no restart.
  let currentSection: () => ProviderExtraSection = () => ({ extraModels: [] })
  const profiles = (): Map<string, ResolvedPiAiProviderProfile> => {
    const entries: [string, ResolvedPiAiProviderProfile][] = [
      [route.provider, buildOpenCodeGoProfile({ ...route, extraModels: currentSection().extraModels })],
    ]
    if (codexProfile !== undefined) entries.push([codex.provider, codexProfile])
    return new Map(entries)
  }
  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey: async (provider) => {
      // The Codex route authenticates from the stored OAuth grant, never
      // from a key: absent here is what lets the collection store serve it.
      if (provider === codex.provider) return codexApiKey()
      const credentials = ctx.get('credentials') as CredentialService | undefined
      const hit = credentials !== undefined
        ? (await credentials.resolve(route.apiKeyEnv))?.value
        : process.env[route.apiKeyEnv]
      if (hit !== undefined && hit.length > 0) {
        return assertUsableApiKey(hit, name, route.apiKeyEnv)
      }
      throw new LlmError(
        'dsh-provider-extra: no credential for route "' + route.provider + '"; its profile resolves ' + route.apiKeyEnv
        + ', which is not set — store it through the credentials service or export it',
        'MISSING_CREDENTIAL',
      )
    },
    // One shared injection for both routes: the OpenCode Go key arrives as
    // the request-level override (preferred over every store read), so the
    // harness-backed grant store serves Codex while changing nothing for it.
    auth: codexAuth(() => ctx.get('credentials') as CodexCredentialService | undefined),
  })

  // A route another adapter already owns (opencode-go configured under
  // llm-pi-ai) must not brick the whole composition: the refusal names the
  // remediation and every other plugin keeps working.
  try {
    ctx.llm.registerAdapter([route.provider], adapter)
  } catch (error) {
    ctx.logger.error('dsh-provider-extra: route "' + route.provider + '" was refused;'
      + " remove it from llm-pi-ai's providers section to serve it here")
    ctx.logger.error(error)
    return
  }
  // Separately from the OpenCode Go route, because registration is
  // all-or-nothing: one call for both would drop a working route when the
  // other collides. llm-pi-ai's directory already lists the catalog id, so
  // no directory entry is registered here — core's serves the Models page.
  if (codexProfile !== undefined) {
    try {
      ctx.llm.registerAdapter([codex.provider], adapter)
    } catch (error) {
      ctx.logger.warn('dsh-provider-extra: codex route "' + codex.provider + '" stays with its existing owner;'
        + " remove it from llm-pi-ai's providers section to serve it here")
      ctx.logger.warn(error)
    }
  }
  try {
    ctx.llm.registerConfigurableProviders([{
      provider: route.provider,
      displayName: route.displayName,
      settingsNs: SETTINGS_NS,
      settingsPath: [route.provider],
    }])
  } catch (error) {
    // llm-pi-ai already lists every catalog id in the directory, including
    // opencode-go; its entry keeps serving the Models page here.
    ctx.logger.warn('dsh-provider-extra: directory entry for "' + route.provider + '" stays with its existing owner')
    ctx.logger.warn(error)
  }
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, SETTINGS_NS, SectionSchema, { extraModels: [] }, {
      setSource: (source) => { currentSection = source },
      // No registration facts derive from the section: the route set is fixed
      // at composition and the adapter rebuilds its snapshot on every
      // operation, so a committed extras change applies alone.
      onChange: () => { /* per-operation snapshot; no swap needed */ },
    })
  })
  // The command is the registry-install-friendly half of the attended sign-in:
  // it runs in this process, so the grant lands in the credential service the
  // route already reads and no bin path or peer tree is involved. Profiles
  // without a command registry (headless compositions) keep the package bin.
  if (config.loginCommandEnabled) {
    ctx.inject(['commands'], (commandCtx) => {
      const host: LoginCommandHost = {
        login: async (interaction) => {
          const credentials = () => ctx.get('credentials') as CodexCredentialService | undefined
          const models = createModels(codexAuth(credentials))
          await startCodexLogin(models, catalogCodex(), interaction)
        },
        hasGrant: async () => {
          const credentials = ctx.get('credentials') as CodexCredentialService | undefined
          if (credentials === undefined) return false
          return await credentials.readRecord(recordKeyFor(codex.provider)) !== undefined
        },
        // An attempt outlives the command request that started it, so the
        // plugin lifetime owns its cancellation, not the request signal.
        track: (abort) => { ctx.effect(() => abort) },
      }
      commandCtx.commands.register(createLoginCommand(host, config.loginCommandName))
      // Registration is silent otherwise, and the command is the one surface a
      // user cannot see in a config dump: saying it exists is the diagnosis.
      ctx.logger.info('dsh-provider-extra: /' + config.loginCommandName + ' signs in the codex route')
    })
  }
}
