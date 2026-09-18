/**
 * Slash-command sign-in for the Codex subscription route.
 *
 * A registry install cannot name the package bin's path, and the tree that bin
 * resolves the harness packages through only exists after a profile boot, so
 * the attended login also belongs where the human already is: the command
 * palette. This handler runs inside the server, so the grant lands in the very
 * credential service the route reads and no module resolution crosses a
 * process boundary.
 *
 * pi-ai's OAuth announces its URL or device code before it waits for the
 * human, while a command result renders only once the handler settles. The
 * handler therefore answers with the first credential-bearing event and lets
 * the attempt continue in the background; invoking the command again reports
 * that same attempt instead of starting a second one.
 *
 * @module dsh-provider-extra/login-command
 */

import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { renderEvent } from './codex-login.ts'

/** Command name a profile gets unless it renames the command. */
export const DEFAULT_LOGIN_COMMAND_NAME = 'dsh-provider-extra-login'

/** Input word selecting the headless device-code flow. */
const DEVICE_WORD = 'device'

/** Input word selecting the browser flow. */
const BROWSER_WORD = 'browser'

/** Input word asking about the current attempt instead of starting one. */
const STATUS_WORD = 'status'

/** Input word starting a replacement attempt even when a grant is stored. */
const RENEW_WORD = 'renew'

/** pi-ai's login-method ids; a select answers with the id, never a position. */
const PI_DEVICE_METHOD = 'device_code'
const PI_BROWSER_METHOD = 'browser'

/** How long a handler waits for the flow's first user-facing event. */
const FIRST_EVENT_TIMEOUT_MS = 20_000

/** Upper bound on one attended attempt, longer than any device code lives. */
const ATTEMPT_DEADLINE_MS = 15 * 60_000

/** What the handler needs from its plugin: an attempt runner and its lifetime. */
export interface LoginCommandHost {
  /** Conduct one OAuth attempt against the credential store the route reads. */
  login(interaction: AuthInteraction): Promise<void>
  /** Whether a grant is already stored, for a status answer outside an attempt. */
  hasGrant(): Promise<boolean>
  /** Tie one attempt's abort to the host lifetime, so unload cancels it. */
  track(abort: () => void): void
}

/** How one attempt ended, absent while it is still waiting for the human. */
type AttemptOutcome =
  | { readonly kind: 'signed-in' }
  | { readonly kind: 'failed'; readonly message: string }

/** One in-flight or settled sign-in attempt. */
interface Attempt {
  /** pi-ai login method this attempt answers the flow select with. */
  readonly method: string
  /** Rendered events so far, kept so a repeat invocation can show them again. */
  readonly lines: string[]
  /** Aborts this attempt alone; never the dispatching command request. */
  readonly abort: AbortController
  /** Settles with the first credential-bearing announcement, or without one. */
  readonly announced: Promise<string | undefined>
  /** Set once the attempt settles; absent while the human still can finish. */
  outcome: AttemptOutcome | undefined
}

/** A promise plus the only resolver that can settle it. */
interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Render the events captured so far, or a starting line when none arrived. */
function describeAttempt(attempt: Attempt, commandName: string): string {
  const method = attempt.method === PI_DEVICE_METHOD ? DEVICE_WORD : BROWSER_WORD
  const lines = attempt.lines.length > 0 ? attempt.lines : ['Waiting for the sign-in page…']
  return [
    'OpenAI Codex sign-in (' + method + '):',
    ...lines,
    'Run /' + commandName + ' ' + STATUS_WORD + ' to check it.',
  ].join('\n')
}

/** The credential-bearing announcement as it is shown to the human. */
function announceAttempt(attempt: Attempt): string {
  return attempt.lines.join('\n')
}

/**
 * Answer one pi-ai prompt without a terminal.
 *
 * The flow select resolves to the requested method by id. The browser flow's
 * manual-code prompt exists only to race the local callback server: pi-ai
 * aborts it when the callback wins, so rejecting on that abort continues the
 * sign-in, and a code typed elsewhere is never required. Any other prompt is a
 * grammar this command cannot serve, and saying so beats hanging.
 */
function answerPrompt(prompt: AuthPrompt, method: string, signal: AbortSignal): Promise<string> {
  switch (prompt.type) {
    case 'select': {
      const option = prompt.options.find(candidate => candidate.id === method)
      if (option === undefined) {
        return Promise.reject(new Error('dsh-provider-extra: the installed pi-ai catalog no longer offers the "' + method + '" login method'))
      }
      return Promise.resolve(option.id)
    }
    case 'manual_code': {
      return new Promise<string>((_, reject) => {
        const lost = (): void => {
          reject(new Error('dsh-provider-extra: the browser callback did not finish the sign-in;'
            + ' retry with "' + DEVICE_WORD + '" on a headless host'))
        }
        if (prompt.signal?.aborted === true || signal.aborted) {
          lost()
          return
        }
        prompt.signal?.addEventListener('abort', lost, { once: true })
        signal.addEventListener('abort', lost, { once: true })
      })
    }
    default: {
      return Promise.reject(new Error('dsh-provider-extra: the codex sign-in asked for "' + prompt.type
        + '" input, which a command cannot supply; retry with "' + DEVICE_WORD + '"'))
    }
  }
}

/** Start one attempt and keep its settlement on the attempt object. */
function startAttempt(host: LoginCommandHost, method: string): Attempt {
  const abort = new AbortController()
  const announced = deferred<string | undefined>()
  const attempt: Attempt = { method, lines: [], abort, announced: announced.promise, outcome: undefined }
  const settle = (outcome: AttemptOutcome): void => {
    attempt.outcome = outcome
    announced.resolve(undefined)
  }
  const deadline = setTimeout(() => { abort.abort() }, ATTEMPT_DEADLINE_MS)
  // The dispatching request's own signal is deliberately not used: it settles
  // when the handler returns, which is exactly when the attempt must keep
  // going. The plugin lifetime owns cancellation instead.
  host.track(() => {
    clearTimeout(deadline)
    abort.abort()
  })
  const interaction: AuthInteraction = {
    signal: abort.signal,
    notify: (event: AuthEvent) => {
      attempt.lines.push(...renderEvent(event))
      if (event.type === 'device_code' || event.type === 'auth_url') {
        announced.resolve(announceAttempt(attempt))
      }
    },
    prompt: (prompt: AuthPrompt) => answerPrompt(prompt, method, abort.signal),
  }
  void host.login(interaction).then(
    () => {
      clearTimeout(deadline)
      settle({ kind: 'signed-in' })
    },
    (error: unknown) => {
      clearTimeout(deadline)
      const message = error instanceof Error ? error.message : String(error)
      // The deadline abort is ours; naming it keeps a forgotten attempt from
      // reading like a server refusal.
      settle({
        kind: 'failed',
        message: abort.signal.aborted && !abort.signal.reason ? 'the attempt timed out' : message,
      })
    },
  )
  return attempt
}

/** Wait for the first announcement, or report that none arrived in time. */
async function announcedWithin(attempt: Attempt): Promise<string | undefined | 'timeout'> {
  return await Promise.race([
    attempt.announced,
    new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => { resolve('timeout') }, FIRST_EVENT_TIMEOUT_MS)
      timer.unref()
    }),
  ])
}

/**
 * Build the command that signs the Codex route in.
 *
 * @param host - attempt runner, grant probe, and lifetime hook of the plugin.
 * @param commandName - registered name, without the leading slash.
 * @returns the registry definition, valid until the profile unloads it.
 */
export function createLoginCommand(host: LoginCommandHost, commandName: string): CommandDefinition {
  let attempt: Attempt | undefined

  const usage = 'Usage: /' + commandName + ' [' + BROWSER_WORD + '|' + DEVICE_WORD + '|' + STATUS_WORD + '|' + RENEW_WORD + ']'

  const statusOf = async (): Promise<CommandResult> => {
    if (attempt !== undefined && attempt.outcome === undefined) {
      return { kind: 'success', text: describeAttempt(attempt, commandName) }
    }
    if (attempt?.outcome?.kind === 'signed-in') {
      return { kind: 'success', text: 'OpenAI Codex is signed in; the route reads the stored grant on its next request.' }
    }
    if (attempt?.outcome?.kind === 'failed') {
      return { kind: 'error', text: 'The last OpenAI Codex sign-in failed: ' + attempt.outcome.message }
    }
    const stored = await host.hasGrant()
    return {
      kind: 'success',
      text: stored
        ? 'A Codex grant is stored. Run /' + commandName + ' ' + RENEW_WORD + ' to replace it.'
        : 'No Codex sign-in is in progress and none is stored. Run /' + commandName + ' to start one.',
    }
  }

  return {
    name: commandName,
    description: 'Sign in to the OpenAI Codex subscription route (browser or device code)',
    input: { hint: BROWSER_WORD + ' or ' + DEVICE_WORD + ', ' + STATUS_WORD + ' to check, ' + RENEW_WORD + ' to replace' },
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const words = invocation.rawInput.trim().toLowerCase().split(/\s+/u).filter(word => word.length > 0)
      if (words.length === 1 && words[0] === STATUS_WORD) return await statusOf()
      // A bare repeat after success must not silently start a second sign-in:
      // replacing a stored grant is the explicit "renew" request.
      const renew = words[0] === RENEW_WORD
      const methodWord = (renew ? words[1] : words[0]) ?? ''
      if ((renew ? words.length > 2 : words.length > 1)
        || (methodWord !== '' && methodWord !== BROWSER_WORD && methodWord !== DEVICE_WORD)) {
        return { kind: 'error', text: 'dsh-provider-extra: unknown sign-in request "' + invocation.rawInput.trim() + '". ' + usage }
      }
      if (attempt !== undefined && attempt.outcome === undefined) {
        return { kind: 'success', text: describeAttempt(attempt, commandName) }
      }
      if (attempt?.outcome?.kind === 'signed-in' && !renew) {
        return {
          kind: 'success',
          text: 'OpenAI Codex is signed in; the route reads the stored grant on its next request.'
            + ' Run /' + commandName + ' ' + RENEW_WORD + ' to replace the grant.',
        }
      }
      const method = methodWord === DEVICE_WORD ? PI_DEVICE_METHOD : PI_BROWSER_METHOD
      attempt = startAttempt(host, method)
      const announcement = await announcedWithin(attempt)
      if (attempt.outcome?.kind === 'failed') {
        return { kind: 'error', text: 'The OpenAI Codex sign-in failed: ' + attempt.outcome.message }
      }
      if (announcement === 'timeout') {
        attempt.abort.abort()
        return { kind: 'error', text: 'The OpenAI Codex sign-in announced no page within ' + String(FIRST_EVENT_TIMEOUT_MS / 1000) + 's. ' + usage }
      }
      if (announcement === undefined) {
        return { kind: 'success', text: 'OpenAI Codex is signed in; the route reads the stored grant on its next request.' }
      }
      return { kind: 'success', text: announcement + '\nFinish in your browser; run /' + commandName + ' ' + STATUS_WORD + ' to check it.' }
    },
  }
}
