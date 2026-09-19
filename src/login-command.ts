/**
 * Provider sign-in from the command palette.
 *
 * The command palette is the only surface a registry install reliably has — a
 * package bin is not on PATH and the tree it resolves through only exists
 * after a boot — so the attended sign-in lives where the human already is. It
 * is deliberately provider-agnostic: the host hands it every installed
 * provider that ships an interactive login, and the command runs whichever
 * one the human picks through pi-ai's own flow, so a new provider in the
 * catalog needs no change here.
 *
 * A sign-in is a conversation, and a command result renders only once the
 * handler settles. The conversation therefore runs through the session UI's
 * question channel: the provider picker, every flow prompt, and the page or
 * device code are asked as questions, and the handler answers with the final
 * verdict only after the credential is stored and observed.
 *
 * @module dsh-provider-extra/login-command
 */

import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { renderEvent } from './codex-login.ts'
import type { RouteDeclaration } from './login-route.ts'

/** Command name a profile gets unless it renames the command. */
export const DEFAULT_LOGIN_COMMAND_NAME = 'dsh-provider-extra-login'

/** Input word showing what is already stored instead of starting a sign-in. */
const STATUS_WORD = 'status'

/** Input word selecting the API-key method when a provider offers both. */
const KEY_WORD = 'key'

/** Input word selecting the subscription method when a provider offers both. */
const OAUTH_WORD = 'oauth'

/** Question ids belong to the caller; the answer echoes them back. */
const PICKER_QUESTION_ID = 'provider'
const NOTICE_QUESTION_ID = 'notice'
const PROMPT_QUESTION_ID = 'prompt'

/** Answer labels this command owns, so a decision is never read as typed text. */
const DONE_LABEL = 'Done'
const CANCEL_LABEL = 'Cancel'

/**
 * Caveat rendered with a secret prompt. The answer reaches the provider that
 * issued the key and the credential store, never the model's context, but a
 * session UI can only show what the human types: saying so is the difference
 * between a choice and a trap.
 */
const SECRET_DETAIL = 'The value is stored in your credential store and sent only to this provider to be checked.'

/** Guidance added to a page or device-code question, where waiting is the task. */
const WAIT_DETAIL = 'Finish on that page, then choose Done. The sign-in completes by itself.'

/**
 * Said when the sign-in had to declare the route. The settings file grew an
 * entry on the human's behalf, and a configuration change they did not make is
 * one they must hear about.
 */
const DECLARED_ROUTE_NOTICE = ' The provider was added to the llm-pi-ai settings, so its models work now.'

/** Said when a configured route already carried the sign-in. */
const PRESENT_ROUTE_NOTICE = ' The credential is stored and the route reads it on its next request.'

/**
 * Said when nothing here can serve the provider. A stored credential with no
 * route is the state that later fails a turn, so the failure belongs to the
 * sign-in that caused it rather than to a model request the human cannot explain.
 */
const UNAVAILABLE_ROUTE_NOTICE = ' Nothing in this composition serves its models: mount an llm-pi-ai service to use them.'

/** Upper bound on one attended attempt, longer than any device code lives. */
const ATTEMPT_DEADLINE_MS = 15 * 60_000

/** pi-ai's auth type ids: a subscription login, or a stored API key. */
export type LoginAuthType = 'oauth' | 'api_key'

/** One provider-and-method pair as the picker shows it. */
export interface LoginChoice {
  /** pi-ai catalog id, echoed back when the flow runs. */
  providerId: string
  /** Provider name a human recognizes. */
  providerName: string
  /** Which method this choice runs. */
  authType: LoginAuthType
  /** Method label, e.g. "Sign in with ChatGPT" or "Anthropic API key". */
  methodLabel: string
}

/**
 * One declared route's credential reference and whether anything supplies it.
 * The reference decides its route on its own: llm-pi-ai resolves the named
 * value before it ever reaches the credential store, so an unset reference
 * beside a signed-in record is not what that route uses.
 */
export interface DeclaredReference {
  /** Environment-reference name the route resolves, e.g. `KIMI_CODING_API_KEY`. */
  ref: string
  /** Credential layer currently supplying the value, absent while nothing does. */
  source?: string
}

/** What the command needs from its plugin. */
export interface LoginCommandHost {
  /** Every provider in this composition that offers an interactive sign-in. */
  choices(): readonly LoginChoice[]
  /** Run one sign-in to completion; the credential commit and its route declaration happen inside. */
  login(choice: LoginChoice, interaction: AuthInteraction): Promise<RouteDeclaration>
  /** The stored credential kind for one provider, absent when nothing is stored. */
  stored(providerId: string): Promise<LoginAuthType | undefined>
  /**
   * The credential reference one provider's declared route resolves, when it
   * names one — configured or not, because a route whose reference is unset is
   * the state that fails its next turn.
   */
  reference(providerId: string): Promise<DeclaredReference | undefined>
  /** Ask the session UI, a surface that may be missing in headless compositions. */
  ask(request: {
    agent: CommandInvocation['agent']
    questions: AskUserQuestionItem[]
    signal?: AbortSignal
  }): Promise<AskUserQuestionAnswer>
}

/** Split raw command input into lowercase words. */
function words(rawInput: string): string[] {
  return rawInput.trim().toLowerCase().split(/\s+/u).filter(word => word.length > 0)
}

/** The label one choice shows: its provider alone when that provider has a single method. */
function choiceLabel(choice: LoginChoice, shared: boolean): string {
  if (!shared) return choice.providerName
  // A method label that already names its provider is the whole label: stitching
  // the name onto it again reads as a stutter to the human choosing from it.
  return choice.methodLabel.toLowerCase().includes(choice.providerName.toLowerCase())
    ? choice.methodLabel
    : choice.providerName + ' (' + choice.methodLabel + ')'
}

/** The option label for one choice; method labels disambiguate multi-auth providers. */
function optionLabels(choices: readonly LoginChoice[]): string[] {
  const perProvider = new Map<string, number>()
  for (const choice of choices) {
    perProvider.set(choice.providerId, (perProvider.get(choice.providerId) ?? 0) + 1)
  }
  return choices.map(choice => choiceLabel(choice, (perProvider.get(choice.providerId) ?? 0) > 1))
}

/** The question the picker asks, one option per provider-method pair. */
function pickerQuestion(choices: readonly LoginChoice[]): AskUserQuestionItem {
  const labels = optionLabels(choices)
  return {
    id: PICKER_QUESTION_ID,
    header: 'Sign in',
    question: 'Which provider do you want to sign in to?',
    options: choices.map((choice, index) => ({
      label: labels[index] ?? choice.providerName,
      description: choice.methodLabel + ' · ' + choice.providerId,
    })),
  }
}

/** The free text a single-question answer carries, if any. */
function answerText(answer: AskUserQuestionAnswer, questionId: string): string | undefined {
  const item = answer.answers.find(entry => entry.id === questionId)
  const custom = item?.custom?.trim()
  return custom === undefined || custom.length === 0 ? undefined : custom
}

/** The option labels a single-question answer carries. */
function answerLabels(answer: AskUserQuestionAnswer, questionId: string): string[] {
  return answer.answers.find(entry => entry.id === questionId)?.selected ?? []
}

/**
 * Resolve what the picker's answer names: a label first, then free text as a
 * provider id or a method word, so a capable UI that offers "Other" lands on
 * the same choice as the menu.
 */
function resolveChoice(
  choices: readonly LoginChoice[],
  answer: AskUserQuestionAnswer,
): LoginChoice | undefined {
  const labels = optionLabels(choices)
  for (const label of answerLabels(answer, PICKER_QUESTION_ID)) {
    const index = labels.indexOf(label)
    if (index >= 0) return choices[index]
  }
  const text = answerText(answer, PICKER_QUESTION_ID)
  if (text === undefined) return undefined
  const named = choices.filter(choice => choice.providerId === text.toLowerCase())
  if (named.length === 1) return named[0]
  const method = text.toLowerCase().split(/\s+/u)[1] ?? text.toLowerCase()
  return named.find(choice => choice.authType === (method === KEY_WORD ? 'api_key' : 'oauth'))
    ?? choices.find(choice => choice.authType === (method === KEY_WORD ? 'api_key' : 'oauth'))
}

/** The choice a provider id (and optional method word) names. */
function choiceByWords(choices: readonly LoginChoice[], input: readonly string[]): LoginChoice | undefined {
  const providerId = input[0]
  if (providerId === undefined) return undefined
  const named = choices.filter(choice => choice.providerId === providerId)
  if (named.length === 0) return undefined
  const method = input[1]
  if (method === undefined) return named[0]
  const authType: LoginAuthType = method === KEY_WORD ? 'api_key' : 'oauth'
  return named.find(choice => choice.authType === authType)
}

/** What one question turn needs from the running attempt. */
interface Attempt {
  /** Aborts the whole sign-in, whether the human declined or the clock ran out. */
  readonly abort: AbortController
  /** Rendered notices so far, newest last. */
  readonly notices: string[]
  /** The question holding the page or device code open, while it is open. */
  wait: { abort: AbortController; settled: Promise<void> } | undefined
  /** Set when the human chose Cancel, so the failure reads as their decision. */
  declined: boolean
  /** Set when the deadline, not the human, ended the attempt. */
  expired: boolean
}

/** Close the waiting question, if one is open, and let its ask settle. */
async function closeWait(attempt: Attempt): Promise<void> {
  const open = attempt.wait
  attempt.wait = undefined
  if (open === undefined) return
  open.abort.abort()
  await open.settled
}

/**
 * Hold the page or device code open as a question while the flow waits for the
 * human. Answering Done needs no handling — the flow finishes on its own — so
 * only Cancel is read, and the question is withdrawn the moment the flow ends.
 */
function openWait(host: LoginCommandHost, invocation: CommandInvocation, choice: LoginChoice, attempt: Attempt): void {
  const abort = new AbortController()
  const asked = host.ask({
    agent: invocation.agent,
    questions: [{
      id: NOTICE_QUESTION_ID,
      header: choice.providerName,
      question: 'Finish signing in',
      detail: [...attempt.notices, WAIT_DETAIL].join('\n'),
      options: [{ label: DONE_LABEL }, { label: CANCEL_LABEL }],
    }],
    signal: abort.signal,
  })
  const settled = asked.then((answer) => {
    if (answerLabels(answer, NOTICE_QUESTION_ID).includes(CANCEL_LABEL)) {
      attempt.declined = true
      attempt.abort.abort()
    }
  }, () => {
    // A withdrawn question is the normal end of an attempt: the flow settled
    // first, or the surface cannot ask. Either way the flow's own outcome rules.
  })
  attempt.wait = { abort, settled }
}

/** The question one pi-ai prompt becomes, so the human can answer it. */
function promptQuestion(prompt: AuthPrompt, choice: LoginChoice): AskUserQuestionItem {
  const header = choice.providerName
  switch (prompt.type) {
    case 'select':
      return {
        id: PROMPT_QUESTION_ID,
        header,
        question: prompt.message,
        options: prompt.options.map(option => ({
          label: option.label,
          ...option.description === undefined ? {} : { description: option.description },
        })),
      }
    case 'secret':
      return {
        id: PROMPT_QUESTION_ID,
        header,
        question: prompt.message,
        detail: SECRET_DETAIL + (prompt.placeholder === undefined ? '' : ' ' + prompt.placeholder),
      }
    case 'manual_code':
      return {
        id: PROMPT_QUESTION_ID,
        header,
        question: prompt.message,
        detail: 'Answer here only if the browser did not finish the sign-in.'
          + (prompt.placeholder === undefined ? '' : ' ' + prompt.placeholder),
      }
    case 'text':
      return {
        id: PROMPT_QUESTION_ID,
        header,
        question: prompt.message,
        ...prompt.placeholder === undefined ? {} : { detail: prompt.placeholder },
      }
  }
}

/** Answer one pi-ai prompt through the session UI. */
async function askPrompt(
  host: LoginCommandHost,
  invocation: CommandInvocation,
  prompt: AuthPrompt,
  choice: LoginChoice,
  attempt: Attempt,
): Promise<string> {
  const ask = host.ask({
    agent: invocation.agent,
    questions: [promptQuestion(prompt, choice)],
    signal: attempt.abort.signal,
  })
  if (prompt.type === 'select') {
    const options = prompt.options
    const answer = await ask
    for (const label of answerLabels(answer, PROMPT_QUESTION_ID)) {
      const hit = options.find(option => option.label === label)
      if (hit !== undefined) return hit.id
    }
    // A select answers with an option id, never a position: an answer that
    // names neither is echoed back only when it is an id pi-ai offered.
    const typed = answerText(answer, PROMPT_QUESTION_ID)
    const byId = options.find(option => option.id === typed)
    if (byId !== undefined) return byId.id
    throw new Error('dsh-provider-extra: answer the sign-in question by choosing one of its options')
  }
  if (prompt.type === 'manual_code' && prompt.signal !== undefined) {
    // The code is optional by design: pi-ai races this prompt against the
    // browser callback and withdraws it when the callback wins. Waiting on
    // the withdrawal instead of demanding a code keeps the callback able to
    // finish the sign-in on its own.
    const withdrawn = new Promise<never>((_, reject) => {
      const lose = (): void => { reject(new Error('dsh-provider-extra: the browser completed the sign-in')) }
      if (prompt.signal?.aborted === true) {
        lose()
        return
      }
      prompt.signal?.addEventListener('abort', lose, { once: true })
    })
    const answer = await Promise.race([ask, withdrawn])
    const typed = answerText(answer, PROMPT_QUESTION_ID)
    if (typed === undefined) throw new Error('dsh-provider-extra: no code was given')
    return typed
  }
  const answer = await ask
  const typed = answerText(answer, PROMPT_QUESTION_ID)
  if (typed === undefined) throw new Error('dsh-provider-extra: the sign-in question was left unanswered')
  return typed
}

/** The interaction one attempt hands to pi-ai's login. */
function attemptInteraction(
  host: LoginCommandHost,
  invocation: CommandInvocation,
  choice: LoginChoice,
  attempt: Attempt,
): AuthInteraction {
  return {
    signal: attempt.abort.signal,
    notify: (event: AuthEvent) => {
      attempt.notices.push(...renderEvent(event))
      if (attempt.wait === undefined) openWait(host, invocation, choice, attempt)
    },
    prompt: async (prompt: AuthPrompt) => {
      await closeWait(attempt)
      return await askPrompt(host, invocation, prompt, choice, attempt)
    },
  }
}

/** What one finished sign-in means, said in terms of whether its models can be reached. */
function successText(choice: LoginChoice, route: RouteDeclaration): string {
  const signedIn = 'Signed in to ' + choice.providerName + ' (' + choice.methodLabel + ').'
  if (route === 'declared') return signedIn + DECLARED_ROUTE_NOTICE
  if (route === 'unavailable') return signedIn + UNAVAILABLE_ROUTE_NOTICE
  return signedIn + PRESENT_ROUTE_NOTICE
}

/** Why one attempt ended without a credential, as the human should read it. */
function describeFailure(error: unknown, attempt: Attempt, choice: LoginChoice): string {
  if (attempt.declined) return 'The ' + choice.providerName + ' sign-in was cancelled.'
  if (attempt.expired) return 'The ' + choice.providerName + ' sign-in timed out; start it again to get a fresh code.'
  const message = error instanceof Error ? error.message : String(error)
  return 'The ' + choice.providerName + ' sign-in failed: ' + message
}

/** Run one sign-in end to end: the conversation plus the stored-credential check. */
async function runChoice(
  host: LoginCommandHost,
  invocation: CommandInvocation,
  choice: LoginChoice,
): Promise<CommandResult> {
  const attempt: Attempt = { abort: new AbortController(), notices: [], wait: undefined, declined: false, expired: false }
  const deadline = setTimeout(() => {
    attempt.expired = true
    attempt.abort.abort()
  }, ATTEMPT_DEADLINE_MS)
  if (typeof deadline === 'object') deadline.unref()
  try {
    const route = await host.login(choice, attemptInteraction(host, invocation, choice, attempt))
    await closeWait(attempt)
    // pi-ai persists during login, so resolving is not yet proof: only a
    // record read back is. A flow that resolves without one is a catalog bug
    // the human must hear about rather than a silent no-op sign-in.
    const stored = await host.stored(choice.providerId)
    if (stored === undefined) {
      return {
        kind: 'error',
        text: 'The ' + choice.providerName + ' sign-in reported success but stored no credential; nothing changed.',
      }
    }
    return { kind: 'success', text: successText(choice, route) }
  } catch (error) {
    return { kind: 'error', text: describeFailure(error, attempt, choice) }
  } finally {
    clearTimeout(deadline)
    await closeWait(attempt)
  }
}

/** How one provider authenticates right now, as the human should read it. */
async function statusLine(host: LoginCommandHost, choice: LoginChoice): Promise<string> {
  const reference = await host.reference(choice.providerId)
  if (reference !== undefined) {
    const where = reference.source === undefined ? 'not set' : 'set from ' + reference.source
    return '  ' + choice.providerName + ' — API key ' + reference.ref + ' (' + where + ')'
  }
  const stored = await host.stored(choice.providerId)
  return '  ' + choice.providerName + ' — ' + (stored === undefined ? 'not signed in' : 'signed in (' + stored + ')')
}

/** Answer how each provider authenticates today. */
async function statusOf(host: LoginCommandHost): Promise<CommandResult> {
  const choices = host.choices()
  if (choices.length === 0) {
    return { kind: 'error', text: 'dsh-provider-extra: this composition mounts no provider with an interactive sign-in' }
  }
  const seen = new Set<string>()
  const lines: string[] = []
  for (const choice of choices) {
    if (seen.has(choice.providerId)) continue
    seen.add(choice.providerId)
    lines.push(await statusLine(host, choice))
  }
  return { kind: 'success', text: ['Provider sign-in status:', ...lines].join('\n') }
}

/**
 * Build the provider sign-in command.
 *
 * @param host - the composition's providers, its login runner, and the session UI.
 * @param commandName - registered name, without the leading slash.
 * @returns the registry definition, valid until the profile unloads it.
 */
export function createLoginCommand(host: LoginCommandHost, commandName: string): CommandDefinition {
  const usage = 'Usage: /' + commandName + ' [<provider-id> [' + OAUTH_WORD + '|' + KEY_WORD + '] | ' + STATUS_WORD + ']'

  return {
    name: commandName,
    description: 'Sign in to a model provider (subscription or API key)',
    input: { hint: 'no input picks a provider, ' + STATUS_WORD + ' lists what is signed in' },
    // The input is a provider id in normal use, but this command is also the
    // one place a human might paste a key: keep the session log out of it.
    recordInput: false,
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const input = words(invocation.rawInput)
      if (input.length === 1 && input[0] === STATUS_WORD) return await statusOf(host)
      if (input.length > 2) return { kind: 'error', text: 'dsh-provider-extra: too many arguments. ' + usage }
      const choices = host.choices()
      if (choices.length === 0) {
        return { kind: 'error', text: 'dsh-provider-extra: this composition mounts no provider with an interactive sign-in' }
      }
      let choice: LoginChoice | undefined
      if (input.length === 0) {
        try {
          choice = resolveChoice(choices, await host.ask({
            agent: invocation.agent,
            questions: [pickerQuestion(choices)],
            signal: invocation.signal,
          }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { kind: 'error', text: 'dsh-provider-extra: no provider was picked (' + message + '). ' + usage }
        }
        if (choice === undefined) return { kind: 'error', text: 'dsh-provider-extra: no provider was picked. ' + usage }
      } else {
        choice = choiceByWords(choices, input)
        if (choice === undefined) {
          const known = [...new Set(choices.map(entry => entry.providerId))].join(', ')
          return { kind: 'error', text: 'dsh-provider-extra: no sign-in named "' + input.join(' ') + '". Known providers: ' + known + '. ' + usage }
        }
      }
      return await runChoice(host, invocation, choice)
    },
  }
}
