/**
 * Sign the Codex subscription route in: pnpm codex:login [--credentials-path <file>].
 *
 * Runs pi-ai's own Codex OAuth login (browser or device-code, chosen at the
 * prompt) against the harness credentials document the server reads, so the
 * grant is live for the next request with no restart. Attended by design: a
 * human must open the URL and approve.
 *
 * The document defaults exactly as the server's credentials-local does
 * (<harness home>/.credentials.yaml); pass --credentials-path only when the
 * server overrides it. Writes serialize against the running server through
 * the document's own cross-process lock.
 */

import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider, { resolveSpec } from '@deepseek-ai/dsh-credentials-local'
import { createModels } from '@earendil-works/pi-ai'
import { catalogCodex, codexAuth } from '../src/codex.ts'
import type { CodexCredentialService } from '../src/codex.ts'
import { readlineTerminal, runCodexLogin } from '../src/codex-login.ts'

/** Flag naming an explicit credentials document. */
const PATH_FLAG = '--credentials-path'

/** The explicit document override from argv, if the server overrides its own. */
function credentialsPath(argv: readonly string[]): string | undefined {
  const at = argv.indexOf(PATH_FLAG)
  const value = at === -1 ? undefined : argv[at + 1]
  if (at !== -1 && (value === undefined || value.startsWith('--'))) {
    throw new Error('dsh-provider-extra: ' + PATH_FLAG + ' needs a file path')
  }
  return value
}

async function main(argv: readonly string[]): Promise<void> {
  const path = credentialsPath(argv)
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalCredentialProvider, {
    ...(path === undefined ? {} : { path }),
    watch: false,
  })
  console.log('Credentials: ' + resolveSpec(path === undefined ? {} : { path }).filename)
  const controller = new AbortController()
  process.on('SIGINT', () => { controller.abort() })
  const rl = createInterface({ input, output })
  try {
    const models = createModels(codexAuth(() => ctx.get('credentials') as CodexCredentialService | undefined))
    await runCodexLogin(models, catalogCodex(), readlineTerminal(rl, controller.signal))
  } finally {
    rl.close()
    await fiber.dispose()
  }
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  if (error instanceof Error) console.error(error.message)
  else console.error(error)
  process.exitCode = 1
}
