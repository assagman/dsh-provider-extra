/**
 * Proving a key against fakes: the provider answers with the one field the
 * decision reads, so a refusal stays distinguishable from a timeout and a
 * provider with nothing to ask about is never refused on a guess.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Api, AssistantMessage, Credential, Model } from '@earendil-works/pi-ai'
import { PendingCredentialStore, proveApiKey } from '../src/login-verify.ts'
import type { KeyProbe } from '../src/login-verify.ts'

/** The province of an assistant message this decision reads; the rest is noise. */
function answer(stopReason: AssistantMessage['stopReason'], errorMessage?: string): AssistantMessage {
  return { stopReason, ...errorMessage === undefined ? {} : { errorMessage } } as AssistantMessage
}

/** A provider that ships the given models and answers every request the same way. */
function probeOf(models: readonly Model<Api>[], answered: AssistantMessage, asked?: { count: number }): KeyProbe {
  return {
    getModels: () => models,
    completeSimple: async () => {
      if (asked !== undefined) asked.count += 1
      return answered
    },
  } as unknown as KeyProbe
}

const MODEL = { id: 'some-model' } as Model<Api>

describe('proveApiKey', () => {
  it('accepts the answer a working key draws, whatever the model chose to do with the token', async () => {
    await proveApiKey(probeOf([MODEL], answer('length')), 'anthropic')
  })

  it('repeats the provider explanation instead of inventing one', async () => {
    await assert.rejects(
      proveApiKey(probeOf([MODEL], answer('error', '401 API key is invalid.')), 'anthropic'),
      /provider did not accept this API key: 401 API key is invalid\./u,
    )
  })

  it('blames a silent provider rather than the key', async () => {
    await assert.rejects(proveApiKey(probeOf([MODEL], answer('aborted')), 'anthropic'), /did not answer in time/u)
  })

  it('keeps a key no model can be asked about, since nothing disproved it', async () => {
    const asked = { count: 0 }
    await proveApiKey(probeOf([], answer('error', 'never sent'), asked), 'radius')
    assert.equal(asked.count, 0)
  })
})

describe('PendingCredentialStore', () => {
  it('holds a credential as metadata and forgets it on delete', async () => {
    const store = new PendingCredentialStore()
    await store.modify('anthropic', async () => ({ type: 'api_key', key: 'sk-test' } as Credential))
    assert.deepEqual(await store.list(), [{ providerId: 'anthropic', type: 'api_key' }])
    assert.deepEqual(await store.read('anthropic'), { type: 'api_key', key: 'sk-test' })
    await store.delete('anthropic')
    assert.equal(await store.read('anthropic'), undefined)
  })
})
