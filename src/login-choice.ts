/**
 * The catalog as the picker shows it, and the answers it accepts back.
 *
 * A sign-in starts from whatever the installed catalog ships, and a human
 * answers a choice three ways — a label, a provider id, or free text — so the
 * labels and the resolution that reads them back live together: every path has
 * to land on the same provider-method pair.
 *
 * @module dsh-provider-extra/login-choice
 */

import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { LoginAuthType, LoginChoice } from './login-contract.ts'

/** Input word selecting the API-key method when a provider offers both. */
export const KEY_WORD = 'key'

/** Input word selecting the subscription method when a provider offers both. */
export const OAUTH_WORD = 'oauth'

/** Question ids belong to the caller; the answer echoes them back. */
const PICKER_QUESTION_ID = 'provider'

/** Split raw command input into lowercase words. */
export function words(rawInput: string): string[] {
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
export function pickerQuestion(choices: readonly LoginChoice[]): AskUserQuestionItem {
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
export function answerText(answer: AskUserQuestionAnswer, questionId: string): string | undefined {
  const item = answer.answers.find(entry => entry.id === questionId)
  const custom = item?.custom?.trim()
  return custom === undefined || custom.length === 0 ? undefined : custom
}

/** The option labels a single-question answer carries. */
export function answerLabels(answer: AskUserQuestionAnswer, questionId: string): string[] {
  return answer.answers.find(entry => entry.id === questionId)?.selected ?? []
}

/**
 * Resolve what the picker's answer names: a label first, then free text as a
 * provider id or a method word, so a capable UI that offers "Other" lands on
 * the same choice as the menu.
 */
export function resolveChoice(
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
export function choiceByWords(choices: readonly LoginChoice[], input: readonly string[]): LoginChoice | undefined {
  const providerId = input[0]
  if (providerId === undefined) return undefined
  const named = choices.filter(choice => choice.providerId === providerId)
  if (named.length === 0) return undefined
  const method = input[1]
  if (method === undefined) return named[0]
  const authType: LoginAuthType = method === KEY_WORD ? 'api_key' : 'oauth'
  return named.find(choice => choice.authType === authType)
}
