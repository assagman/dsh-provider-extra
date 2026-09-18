import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'

const PACKAGE_NAME = '@sagmans/dsh-provider-extra'
const GO_ROUTE = 'opencode-go'
const CODEX_ROUTE = 'openai-codex'
const EXTRA_MODEL = 'deepseek-flash'

test('built package mounts both routes without credentials or a TypeScript loader', async () => {
  const plugin = await import(PACKAGE_NAME)
  const ctx = new Context()
  const runtime = await ctx.plugin(LlmRuntime)
  let mounted
  try {
    mounted = await ctx.plugin(plugin, {})
    const go = await ctx.llm.listModels(GO_ROUTE)
    const codex = await ctx.llm.listModels(CODEX_ROUTE)
    assert.ok(go.some((model) => model.id === EXTRA_MODEL))
    assert.ok(codex.length > 0)
  } finally {
    await mounted?.dispose()
    await runtime.dispose()
  }
})
