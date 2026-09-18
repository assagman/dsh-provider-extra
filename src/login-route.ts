/**
 * Making a signed-in provider reachable.
 *
 * A sign-in stores a credential, but the harness serves a provider only through
 * a route its own pi-ai service has been configured with: signing into a
 * catalog provider the profile never declared stores a key that no request can
 * use, and the first turn then fails with "no adapter registered for provider",
 * which reads as a broken sign-in rather than the missing declaration it is.
 * The write below adds that declaration, because a human who just signed in
 * asked for a provider to work, not for a file to edit.
 *
 * @module dsh-provider-extra/login-route
 */

/** The namespace the harness pi-ai service owns; its providers dict is the route set. */
const PI_AI_SETTINGS_NAMESPACE = 'llm-pi-ai'

/** The dict whose keys are routes, matching that service's configuration shape. */
const PROVIDERS_FIELD = 'providers'

/**
 * A catalog route needs no fields of its own: the installed catalog supplies
 * the endpoint, protocol, and models, and the credential is read from the store
 * this command already wrote, so an empty profile is the whole declaration.
 */
const CATALOG_ROUTE_OVERRIDES: Record<string, never> = {}

/** What one declaration found or did, so the caller can say it instead of assuming it. */
export type RouteDeclaration = 'declared' | 'present' | 'unavailable'

/** The slice of the settings service this needs, kept structural so its absence is a value, not a crash. */
export interface SettingsLike {
  get(namespace: typeof PI_AI_SETTINGS_NAMESPACE): unknown
  update(namespace: typeof PI_AI_SETTINGS_NAMESPACE, patch: object): Promise<void>
}

/** The configured routes, or nothing when no pi-ai service registered the namespace. */
function configuredProviders(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const providers = (value as Record<string, unknown>)[PROVIDERS_FIELD]
  return typeof providers === 'object' && providers !== null ? providers as Record<string, unknown> : undefined
}

/**
 * Give a freshly stored credential a route to be read through.
 *
 * The patch names one provider, so the settings service merges it over the
 * routes a profile already configured and no existing key or override is
 * restated, let alone lost.
 *
 * @param settings - the settings service, absent in a composition that mounts none.
 * @param providerId - the pi-ai catalog provider that was just signed in.
 * @returns whether the route was added, already configured, or cannot exist here.
 */
export async function declareProviderRoute(settings: SettingsLike | undefined, providerId: string): Promise<RouteDeclaration> {
  if (settings === undefined) return 'unavailable'
  const providers = configuredProviders(settings.get(PI_AI_SETTINGS_NAMESPACE))
  if (providers === undefined) return 'unavailable'
  if (providers[providerId] !== undefined) return 'present'
  await settings.update(PI_AI_SETTINGS_NAMESPACE, { [PROVIDERS_FIELD]: { [providerId]: CATALOG_ROUTE_OVERRIDES } })
  return 'declared'
}
