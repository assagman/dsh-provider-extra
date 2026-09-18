/**
 * Behavior of the server-side sign-in command: the flow select is answered by
 * id from the requested method, the first credential-bearing event reaches the
 * human while the attempt keeps running, and a repeat invocation reports that
 * attempt instead of starting a second one.
 *
 * A scripted host stands in for pi-ai, so every assertion runs keyless and no
 * network call leaves the process.
 *
 * @module dsh-provider-extra/tests
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

/** The registry knows the agent contract; deriving it keeps this suite free of a host dependency. */
type AgentHandle = Parameters<CommandRuntime['list']>[0]
import { DEFAULT_LOGIN_COMMAND_NAME, createLoginCommand } from '../src/login-command.ts'
import type { LoginCommandHost } from '../src/login-command.ts'

/** The handler reads only `rawInput`; the rest of the invocation is the UI's. */
function invocation(rawInput: string): CommandInvocation {
  return { rawInput } as unknown as CommandInvocation
}

async function run(definition: CommandDefinition, rawInput = ''): Promise<CommandResult> {
  return await definition.handler(invocation(rawInput))
}

function text(result: CommandResult): string {
  return result.text ?? ''
}

/** Let the host's login promise settle through its then-handlers. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setImmediate(resolve) })
}

describe('login command registration', () => {
  it('registers the requested name with discovery metadata', () => {
    const host: LoginCommandHost = {
      login: async () => {},
      hasGrant: async () => false,
      track: () => {},
    }
    const definition = createLoginCommand(host, 'renamed-login')
    assert.equal(definition.name, 'renamed-login')
    assert.ok(definition.description.length > 0)
    assert.ok((definition.input?.hint ?? '').includes('device'))
  })

  it('defaults to the documented name', () => {
    assert.equal(DEFAULT_LOGIN_COMMAND_NAME, 'dsh-provider-extra-login')
  })
})

describe('login command', () => {
  it('announces the device code, keeps the attempt, and reports the stored grant', async () => {
    let finish: () => void = () => {}
    const completion = new Promise<void>((resolve) => { finish = resolve })
    const signals: AbortSignal[] = []
    const host: LoginCommandHost = {
      login: async (interaction) => {
        if (interaction.signal !== undefined) signals.push(interaction.signal)
        interaction.notify({ type: 'device_code', userCode: 'WXYZ-1234', verificationUri: 'https://example.test/device' })
        await completion
      },
      hasGrant: async () => false,
      track: () => {},
    }
    const definition = createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME)

    const first = await run(definition, ' device ')
    assert.equal(first.kind, 'success')
    assert.match(text(first), /WXYZ-1234/)
    assert.match(text(first), /https:\/\/example\.test\/device/)
    assert.match(text(first), /status/)

    const repeat = await run(definition)
    assert.equal(repeat.kind, 'success')
    assert.match(text(repeat), /WXYZ-1234/)

    finish()
    await settle()
    const status = await run(definition, 'status')
    assert.equal(status.kind, 'success')
    assert.match(text(status), /signed in/i)
    assert.equal(signals.length, 1)
  })

  it('answers the flow select by id, never by position', async () => {
    const answers: string[] = []
    const options = [
      { id: 'browser', label: 'Browser login (default)' },
      { id: 'device_code', label: 'Device code login (headless)' },
    ]
    const host: LoginCommandHost = {
      login: async (interaction) => {
        answers.push(await interaction.prompt({ type: 'select', message: 'Select OpenAI Codex login method:', options }))
        interaction.notify({ type: 'auth_url', url: 'https://example.test/auth' })
      },
      hasGrant: async () => false,
      track: () => {},
    }
    const definition = createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME)

    await run(definition, 'device')
    await settle()
    const repeat = await run(definition, 'browser')
    assert.match(text(repeat), /already|signed in/i)
    assert.equal(answers.length, 1)
    await run(definition, 'renew browser')
    await settle()

    assert.deepEqual(answers, ['device_code', 'browser'])
  })

  it('defaults to the browser flow and continues when the callback wins the prompt race', async () => {
    const promptAbort = new AbortController()
    let outcome: 'resolved' | 'rejected' | undefined
    const host: LoginCommandHost = {
      login: async (interaction) => {
        interaction.notify({ type: 'auth_url', url: 'https://example.test/auth', instructions: 'Open this page.' })
        const raced = interaction.prompt({ type: 'manual_code', message: 'paste', signal: promptAbort.signal })
        raced.then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
        promptAbort.abort()
        await settle()
      },
      hasGrant: async () => false,
      track: () => {},
    }
    const definition = createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME)

    const started = await run(definition)
    assert.equal(started.kind, 'success')
    assert.match(text(started), /https:\/\/example\.test\/auth/)
    await settle()
    assert.equal(outcome, 'rejected')

    const status = await run(definition, 'status')
    assert.match(text(status), /signed in/i)
  })

  it('reports a failure that arrives before any page is announced', async () => {
    const host: LoginCommandHost = {
      login: async () => { throw new Error('device code login is not enabled for this server') },
      hasGrant: async () => false,
      track: () => {},
    }
    const definition = createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME)
    const result = await run(definition, 'device')
    assert.equal(result.kind, 'error')
    assert.match(text(result), /not enabled/)
  })

  it('refuses an unknown method with the usage line', async () => {
    const host: LoginCommandHost = {
      login: async () => {},
      hasGrant: async () => false,
      track: () => {},
    }
    const definition = createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME)
    const result = await run(definition, 'sms')
    assert.equal(result.kind, 'error')
    assert.match(text(result), /unknown sign-in request "sms"/)
    assert.match(text(result), /Usage: \/dsh-provider-extra-login \[browser\|device\|status\|renew\]/)
  })

  it('reports the stored grant outside any attempt', async () => {
    const stored: LoginCommandHost = {
      login: async () => {},
      hasGrant: async () => true,
      track: () => {},
    }
    const storedResult = await run(createLoginCommand(stored, DEFAULT_LOGIN_COMMAND_NAME), 'status')
    assert.equal(storedResult.kind, 'success')
    assert.match(text(storedResult), /grant is stored/)

    const empty: LoginCommandHost = {
      login: async () => {},
      hasGrant: async () => false,
      track: () => {},
    }
    const emptyResult = await run(createLoginCommand(empty, DEFAULT_LOGIN_COMMAND_NAME), 'status')
    assert.equal(emptyResult.kind, 'success')
    assert.match(text(emptyResult), /none is stored/)
  })

  it('hands the attempt to the plugin lifetime for cancellation', async () => {
    const disposers: (() => void)[] = []
    let signal: AbortSignal | undefined
    const host: LoginCommandHost = {
      login: async (interaction) => {
        signal = interaction.signal
        interaction.notify({ type: 'auth_url', url: 'https://example.test/auth' })
        await new Promise(() => { /* holds the attempt open like a waiting browser */ })
      },
      hasGrant: async () => false,
      track: (abort) => { disposers.push(abort) },
    }
    const definition = createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME)
    await run(definition, 'browser')
    assert.equal(disposers.length, 1)
    assert.equal(signal?.aborted, false)
    disposers[0]!()
    assert.equal(signal?.aborted, true)
  })
})
/**
 * The same command against the real registry: the definition must satisfy the
 * harness's own validation, appear in discovery, and look up by name — the
 * fake-driven suite above covers behavior, this one covers the contract.
 */

describe('login command in the harness registry', () => {
  it('registers, lists, and resolves through CommandRuntime', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(CommandRuntime)
    try {
      const host: LoginCommandHost = {
        login: async (interaction) => {
          interaction.notify({ type: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://example.test/device' })
        },
        hasGrant: async () => false,
        track: () => {},
      }
      const definition = createLoginCommand(host, DEFAULT_LOGIN_COMMAND_NAME)
      const dispose = ctx.commands.register(definition)
      const agent = { id: 'agent-test' } as unknown as AgentHandle

      const descriptors = ctx.commands.list(agent)
      const listed = descriptors.find(descriptor => descriptor.name === DEFAULT_LOGIN_COMMAND_NAME)
      assert.notEqual(listed, undefined)
      assert.ok(listed!.description.length > 0)
      assert.ok((listed!.input?.hint ?? '').length > 0)

      const found = ctx.commands.find(agent, DEFAULT_LOGIN_COMMAND_NAME)
      assert.notEqual(found, undefined)
      const result = await found!.handler({ rawInput: 'device' } as unknown as CommandInvocation)
      assert.equal(result.kind, 'success')
      assert.match(result.text ?? '', /ABCD-EFGH/)

      dispose()
      assert.equal(ctx.commands.find(agent, DEFAULT_LOGIN_COMMAND_NAME), undefined)
    } finally {
      await fiber.dispose()
    }
  })
})

