import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptEditInput, PromptEditResult } from 'claude-code'

const ORIGIN = { kind: 'composer' } as const
const PRESENTATION = { isFullscreen: false, columns: 120 }
const CLASSIFY_MAX_TOKENS = 256
const FILL_DELAY_MS = 50
const REWRITTEN = 'Fix the failing login test in `auth.spec.ts`.'
const CLASSIFICATION = '{"role": "backend", "task": "none", "search": ""}'
const USAGE = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/**
 * Summary: the engine beneath the mod, answered from memory: persona and prompt files, Haiku,
 * the prompt box and a clock the test moves.
 * Parameters: `on` — the test's registrar.
 * Returns: the clock, and the user messages each rewrite call sent to Haiku.
 * Usage: `const w = world(on)` before the test's first call on `$`.
 */
function world(on: On) {
  const clock = mock.clock(on)
  const rewriteInputs: string[] = []
  // fs, model and ui.status answer as { value }; the prompt events return their own result objects.
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [{ name: 'backend.md', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }] }))
  on('fs.read', ($, e) => ({ value: e.path.includes('/prompts/') ? 'system prompt' : '# Backend — servers\n\n- guidance' }))
  on('model.complete', ($, e) => {
    if (e.maxTokens !== CLASSIFY_MAX_TOKENS) rewriteInputs.push(e.prompt)
    const text = e.maxTokens === CLASSIFY_MAX_TOKENS ? CLASSIFICATION : REWRITTEN
    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('prompt.edit', ($, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length }
  })
  return { clock, rewriteInputs }
}

/** Summary: runs one of the mod's commands as the composer does. Returns: the command's result. */
function run(engine: Engine, command: string, args = '') {
  return engine.command.run({ command, args, origin: ORIGIN, presentation: PRESENTATION })
}

/** Summary: one keystroke typed at the end of the box. Returns: the box after it. */
function typeAtEnd(engine: Engine, text: string, key: string) {
  // The kit dispatches prompt.edit at runtime but leaves it out of the engine's typed calls (2.1.296).
  const prompt = engine.prompt as unknown as { edit: (e: PromptEditInput) => Promise<PromptEditResult> }
  return prompt.edit({ origin: ORIGIN, text, cursor: text.length, start: text.length, end: text.length, inputText: key })
}

test('a first-key "/" replaces an untouched rewrite', async ($, on) => {
  const w = world(on)
  await run($, 'rewrite', 'fix login test')
  await w.clock.advance(FILL_DELAY_MS)
  const box = await typeAtEnd($, REWRITTEN, '/')
  expect(box.text).toBe('/')
})

test('"/" is plain text once the rewrite has been edited', async ($, on) => {
  const w = world(on)
  await run($, 'rewrite', 'fix login test')
  await w.clock.advance(FILL_DELAY_MS)
  const edited = `${REWRITTEN} Use src/`
  const box = await typeAtEnd($, edited, '/')
  expect(box.text).toBe(`${edited}/`)
})

test('"/" is plain text when no rewrite is pending', async ($, on) => {
  world(on)
  const box = await typeAtEnd($, 'open src', '/')
  expect(box.text).toBe('open src/')
})

test('/rewrite-again with more context rewrites the original plus it, and later retries keep it', async ($, on) => {
  const w = world(on)
  await run($, 'rewrite', 'fix login test')
  await run($, 'rewrite-again', 'it only fails on CI')
  await run($, 'rewrite-again')
  const [first, withContext, retry] = w.rewriteInputs
  expect(first).toContain('fix login test')
  expect(first).not.toContain('it only fails on CI')
  expect(withContext).toContain('fix login test\n\nit only fails on CI')
  expect(retry).toBe(withContext)
})

test('/rewrite-again with no context rewrites the same original', async ($, on) => {
  const w = world(on)
  await run($, 'rewrite', 'fix login test')
  await run($, 'rewrite-again')
  expect(w.rewriteInputs[1]).toBe(w.rewriteInputs[0])
})
