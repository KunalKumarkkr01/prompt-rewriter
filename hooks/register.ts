import type { EngineInterface, Register } from 'claude-code'

const HAIKU_MODEL = 'haiku'
const HAIKU_TIMEOUT_MS = 15_000
const REWRITE_MAX_TOKENS = 2048
const CLASSIFY_MAX_TOKENS = 256
const MAX_WEB_CONTEXT_CHARS = 8_000
const WEB_SEARCH_MODE = 'standard'
const SLASH_COMMAND_PREFIX = '/'
const FILL_DELAY_MS = 50
const ROLES_DIR = 'personas/roles'
const TASKS_DIR = 'personas/tasks'
const PERSONA_EXTENSION = '.md'
// System prompts live in files so evals/run_eval.py scores exactly what ships.
const CLASSIFY_PROMPT_FILE = 'prompts/classify.md'
const REWRITE_PROMPT_FILE = 'prompts/rewrite.md'
const PROMPT_OPEN_TAG = '<prompt>'
const PROMPT_CLOSE_TAG = '</prompt>'
const META_REPLY_PATTERN = /^I\b[^.\n]*\b(rewrit|this prompt|the prompt)/i
const RECENT_CONTEXT_PATTERN = /^\s*recent context:/im
const SOURCE_URL_PATTERN = /https?:\/\//
const REWRITE_COMMAND = 'rewrite'
const CANCEL_COMMAND = 'rewrite-cancel'
const AGAIN_COMMAND = 'rewrite-again'
const REVIEW_STATUS = `Rewrite ready: Enter to send · or type /${AGAIN_COMMAND} [more context] or /${CANCEL_COMMAND} over it`

/** One persona file: `name` is the file name without extension, `summary` its first line. */
type Persona = { name: string; summary: string; body: string }

/** Every persona the mod ships, read from personas/roles and personas/tasks. */
type Catalog = { roles: Persona[]; tasks: Persona[] }

/** What the classifier decided: the matching personas (if any) and a web query ('' for none). */
type Classification = { role?: Persona; task?: Persona; searchQuery: string }

/** A finished rewrite: the new prompt, the personas to attach on send, and a one-line report. */
type Enhanced = { text: string; personas: string[]; report: string }

/** A rewrite sitting in the box awaiting Enter; `isAbandoned` once the person cleared the box. */
type Review = { original: string; rewritten: string; personas: string[]; isAbandoned: boolean }

/** A rewrite in flight; `stop` lets Esc or /rewrite-cancel cut it. */
type Rewriting = { original: string; stop: AbortController }

/** The mod's session state, shared by its hooks. */
type State = { review?: Review; rewriting?: Rewriting }

/**
 * Summary: reads every persona file in one folder of the mod.
 * Parameters: `$` — the hook's engine handle; `dir` — folder relative to the mod root.
 * Returns: the personas, named after their files; [] when the folder is missing.
 * Usage: drop a new `personas/roles/<name>.md` in and the classifier offers it next time.
 */
async function loadPersonas($: EngineInterface, dir: string): Promise<Persona[]> {
  const path = `${$.plugin.root}/${dir}`
  if (!(await $.fs.exists(path))) return []
  const files = (await $.fs.list(path)).filter(f => f.kind === 'file' && f.name.endsWith(PERSONA_EXTENSION))
  return Promise.all(files.map(async f => {
    const body = (await $.fs.read(`${path}/${f.name}`)) as string
    const summary = (body.split('\n')[0] ?? '').replace(/^#\s*/, '').trim()
    return { name: f.name.slice(0, -PERSONA_EXTENSION.length), summary, body: body.trim() }
  }))
}

/**
 * Summary: reads one of the mod's system prompt files.
 * Parameters: `$` — the hook's engine handle; `file` — path relative to the mod root.
 * Returns: the file's text, trimmed.
 * Usage: `loadPrompt($, REWRITE_PROMPT_FILE)` → the rewrite instructions Haiku gets.
 */
async function loadPrompt($: EngineInterface, file: string): Promise<string> {
  return ((await $.fs.read(`${$.plugin.root}/${file}`)) as string).trim()
}

/**
 * Summary: asks Haiku which role and task persona fit the prompt, and what to search the web for.
 * Parameters: `$` — engine handle; `text` — the prompt; `catalog` — the personas; `stop` — aborts the call.
 * Returns: the classification; no personas and no search when Haiku fails or answers off-list.
 * Usage: "fix the failing deploy pipeline" → role devops-cloud, task debug, query about the pipeline error.
 */
async function classify($: EngineInterface, text: string, catalog: Catalog, stop: AbortController): Promise<Classification> {
  const list = (personas: Persona[]) => personas.map(p => `- ${p.name}: ${p.summary}`).join('\n')
  const system = (await loadPrompt($, CLASSIFY_PROMPT_FILE))
    .replace('{{TODAY}}', new Date().toISOString().slice(0, 10))
    .replace('{{ROLES}}', list(catalog.roles))
    .replace('{{TASKS}}', list(catalog.tasks))
  const reply = await $.model.complete(
    { model: HAIKU_MODEL, system, prompt: `<prompt>\n${text}\n</prompt>`, maxTokens: CLASSIFY_MAX_TOKENS, effort: 'low', timeoutMs: HAIKU_TIMEOUT_MS },
    { signal: stop.signal },
  )
  const json = reply.isAnswered ? reply.text.match(/\{[\s\S]*\}/)?.[0] : undefined
  if (!json) return { searchQuery: '' }
  try {
    const parsed = JSON.parse(json)
    return {
      role: catalog.roles.find(p => p.name === parsed.role),
      task: catalog.tasks.find(p => p.name === parsed.task),
      searchQuery: typeof parsed.search === 'string' ? parsed.search.trim() : '',
    }
  } catch {
    return { searchQuery: '' }
  }
}

/**
 * Summary: runs the WebSearch tool for `query`.
 * Parameters: `$` — the hook's engine handle; `query` — what to search for.
 * Returns: the results as the model would read them (capped), or `{ failure }`.
 * Usage: feeds the "Recent context" section of the rewrite.
 */
async function searchWeb($: EngineInterface, query: string): Promise<{ text: string } | { failure: string }> {
  try {
    const result = await $.tool.call({ tool: 'WebSearch', query, mode: WEB_SEARCH_MODE })
    if (result.deny) return { failure: result.deny }
    if (result.isError || !result.text) return { failure: result.text ?? 'no results' }
    return { text: result.text.slice(0, MAX_WEB_CONTEXT_CHARS) }
  } catch (error) {
    return { failure: String(error) }
  }
}

/**
 * Summary: asks Haiku for a clearer version of `text`, with a "Recent context" section from `webResults`.
 * Parameters: `$` — engine handle; `text` — the prompt; `webResults` — search text or undefined; `stop` — aborts.
 * Returns: the rewritten text, or `{ failure }` ('cancelled', 'empty', or the engine's reason).
 * Usage: the last step of `enhance`.
 */
async function rewrite($: EngineInterface, text: string, webResults: string | undefined, stop: AbortController): Promise<{ text: string } | { failure: string }> {
  const prompt = webResults
    ? `<prompt>\n${text}\n</prompt>\n<web_results>\n${webResults}\n</web_results>`
    : `<prompt>\n${text}\n</prompt>`
  const system = await loadPrompt($, REWRITE_PROMPT_FILE)
  const reply = await $.model.complete(
    { model: HAIKU_MODEL, system, prompt, maxTokens: REWRITE_MAX_TOKENS, effort: 'low', timeoutMs: HAIKU_TIMEOUT_MS },
    { signal: stop.signal },
  )
  if (stop.signal.aborted) return { failure: 'cancelled' }
  if (!reply.isAnswered) return { failure: reply.reason }
  // No stop reason is exposed: a reply that used the whole budget was cut off mid-prompt.
  if (reply.usage.output_tokens >= REWRITE_MAX_TOKENS) return { failure: 'prompt too long to rewrite' }
  const rewritten = dropUnsourcedContext(unwrapPrompt(reply.text.trim()))
  if (rewritten === '') return { failure: 'empty' }
  if (isMetaReply(rewritten, text)) return { failure: 'Haiku declined' }
  return { text: rewritten }
}

/**
 * Summary: removes a "Recent context" section that cites no source, such as Haiku's
 * "- No web results are relevant to this prompt." (evals saw this in ~1 of 3 irrelevant-results trials).
 * Parameters: `text` — the rewrite.
 * Returns: the rewrite without that section; unchanged when there is no section or it has a URL.
 * Usage: "rename tmp\n\nRecent context:\n- Nothing relevant." → "rename tmp".
 */
function dropUnsourcedContext(text: string): string {
  const start = text.search(RECENT_CONTEXT_PATTERN)
  if (start === -1 || SOURCE_URL_PATTERN.test(text.slice(start))) return text
  return text.slice(0, start).trim()
}

/**
 * Summary: spots a reply that talks about the prompt instead of rewriting it, such as
 * "I can't rewrite this prompt…" (evals saw this in ~1–4% of trials).
 * Parameters: `reply` — Haiku's rewrite; `original` — the person's prompt.
 * Returns: true when the reply opens with a first-person sentence about rewriting or the prompt and
 * the original doesn't; a false positive only costs a rewrite, since the original goes back in the box.
 * Usage: `isMetaReply("I'm sorry, but I can't rewrite this prompt.", "fix it")` → true.
 */
function isMetaReply(reply: string, original: string): boolean {
  return META_REPLY_PATTERN.test(reply) && !META_REPLY_PATTERN.test(original)
}

/**
 * Summary: strips the <prompt> wrapper when Haiku echoes its whole input back (it does ~5% of the time
 * when a prompt is returned unchanged).
 * Parameters: `text` — Haiku's reply, trimmed.
 * Returns: the reply without the wrapper; unchanged when it doesn't start with one.
 * Usage: "<prompt>\nfix it\n</prompt>" → "fix it". The last closing tag is the wrapper's, so a
 * literal "</prompt>" inside the user's own text survives.
 */
function unwrapPrompt(text: string): string {
  if (!text.startsWith(PROMPT_OPEN_TAG)) return text
  const close = text.lastIndexOf(PROMPT_CLOSE_TAG)
  if (close === -1) return text
  return `${text.slice(PROMPT_OPEN_TAG.length, close).trim()}\n\n${text.slice(close + PROMPT_CLOSE_TAG.length).trim()}`.trim()
}

/**
 * Summary: the classifier pipeline — classify, load personas, search the web, rewrite.
 * Parameters: `$` — the hook's engine handle; `text` — the prompt; `stop` — cancels between and during steps.
 * Returns: the rewrite with its personas and a report line, or `{ failure }` ('cancelled' when stopped).
 * Usage: `/rewrite why does my Azure DevOps pipeline skip the deploy stage` → DevOps/Cloud + Debug
 * personas, a search on that pipeline behavior, and a rewrite ending in "Recent context:".
 */
async function enhance($: EngineInterface, text: string, stop: AbortController): Promise<Enhanced | { failure: string }> {
  $.ui.status(`Classifying… (/${CANCEL_COMMAND} to cancel)`)
  const catalog = { roles: await loadPersonas($, ROLES_DIR), tasks: await loadPersonas($, TASKS_DIR) }
  const { role, task, searchQuery } = await classify($, text, catalog, stop)
  if (stop.signal.aborted) return { failure: 'cancelled' }

  let webResults: string | undefined
  let webReport = 'no web search needed'
  if (searchQuery) {
    $.ui.status(`Searching the web: ${searchQuery}`)
    const search = await searchWeb($, searchQuery)
    if (stop.signal.aborted) return { failure: 'cancelled' }
    webResults = 'text' in search ? search.text : undefined
    webReport = 'text' in search ? `web context from "${searchQuery}"` : `web search failed (${search.failure})`
  }

  $.ui.status(`Rewriting… (/${CANCEL_COMMAND} to cancel)`)
  const result = await rewrite($, text, webResults, stop)
  if ('failure' in result) return result

  const matched = [role, task].filter((p): p is Persona => p !== undefined)
  const personaReport = matched.length ? matched.map(p => p.name).join(' + ') : 'no persona matched'
  return {
    text: result.text,
    personas: matched.map(p => `Persona for this prompt:\n${p.body}`),
    report: `${personaReport}; ${webReport}`,
  }
}

/**
 * Summary: writes `text` into the prompt box just after the current command settles.
 * Parameters: `$` — the hook's engine handle; `text` — the new draft.
 * Returns: nothing.
 * Usage: delayed so the engine's own box reset after a command can't wipe it.
 */
function fillBox($: EngineInterface, text: string) {
  $.clock.after(FILL_DELAY_MS, () => void $.prompt.fill({ text }))
}

/**
 * Summary: runs the pipeline on `original` and puts the result (or, on failure, the original) in the box.
 * Parameters: `$` — engine handle; `state` — the mod's state; `original` — the prompt; `signal` — the command's abort.
 * Returns: the command's transcript line.
 * Usage: shared by /rewrite and /rewrite-again.
 */
async function runRewrite($: EngineInterface, state: State, original: string, signal: AbortSignal): Promise<{ text: string }> {
  if (state.rewriting) return { text: 'A rewrite is already running.' }

  const stop = new AbortController()
  signal.addEventListener('abort', () => stop.abort())
  state.rewriting = { original, stop }
  const result = await enhance($, original, stop).finally(() => { state.rewriting = undefined })

  if ('failure' in result) {
    state.review = undefined
    $.ui.status(undefined)
    fillBox($, original)
    const reason = result.failure === 'cancelled' ? 'Rewrite cancelled' : `Rewrite failed (${result.failure})`
    return { text: `${reason}. Your original prompt is back in the box; Enter sends it as-is.` }
  }

  state.review = { original, rewritten: result.text, personas: result.personas, isAbandoned: false }
  $.ui.status(REVIEW_STATUS)
  fillBox($, result.text)
  return { text: `Rewrite is in the box (${result.report}). Review or edit it, then Enter to send.` }
}

/**
 * Summary: on-demand prompt rewriter and classifier. Plain Enter sends as usual, with no Haiku call.
 * `/rewrite <prompt>` classifies the prompt into a role + task persona, searches the web when recent
 * info would help, and puts a rewritten prompt (with a "Recent context" section) in the box; the next
 * Enter sends it with the matched personas attached as hidden context.
 * Parameters: `on` — the engine's hook registrar.
 * Returns: nothing; registers the commands, submit and edit hooks.
 * Usage:
 *   - /rewrite fix the flaky login test → review the rewrite in the box, Enter to send.
 *   - /rewrite-again [more context] → a fresh rewrite of the original prompt, plus that context if given.
 *   - type / as the first key on an untouched rewrite → it is replaced, ready for /rewrite-again or /rewrite-cancel.
 *   - /rewrite-cancel (or Esc while it runs) → your original prompt goes back in the box.
 *   - clear the box and type something else → sent as typed, no personas attached.
 */
export const register: Register = on => {
  const state: State = {}

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: REWRITE_COMMAND,
      description: 'Prompt rewriter: classify, add personas and web context, and rewrite a prompt with Haiku.',
      argumentHint: '<prompt>',
    })
    await $.command.register({
      name: AGAIN_COMMAND,
      description: 'Prompt rewriter: rewrite your original prompt again, optionally with more context.',
      argumentHint: '[more context]',
    })
    await $.command.register({
      name: CANCEL_COMMAND,
      description: 'Prompt rewriter: stop or discard the rewrite and put your original prompt back.',
      immediate: true,
    })
    return next(e)
  })

  // Sends whatever is in the box; a pending rewrite gets its personas attached.
  on('prompt.submit', ($, e, next) => {
    if (e.origin.kind !== 'composer' || e.text.startsWith(SLASH_COMMAND_PREFIX)) return next(e)

    const review = state.review
    if (!review) return next(e)
    state.review = undefined
    $.ui.status(undefined)
    if (review.isAbandoned) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...review.personas] })
  }).catch(($, e, next) => {
    state.review = undefined
    $.ui.status(undefined)
    return next(e)
  })

  // A "/" typed as the first keystroke on an untouched rewrite replaces it, so /rewrite-again or
  // /rewrite-cancel can be typed straight over it. After any other edit, "/" is plain text.
  // Emptying the box during review means "not this one": what's typed next is sent as typed.
  on('prompt.edit', async ($, e, next) => {
    const review = state.review
    const isSlashOverRewrite = review !== undefined && !review.isAbandoned && e.text === review.rewritten
      && e.start === e.end && e.inputText === SLASH_COMMAND_PREFIX
    const box = await next(isSlashOverRewrite ? { ...e, text: '', cursor: 0, start: 0, end: 0 } : e)
    if (state.review && box.text.trim() === '') state.review.isAbandoned = true
    return box
  })

  on('command.run', { command: REWRITE_COMMAND }, ($, e, next) => {
    const original = e.args.trim()
    if (original === '') return { text: `Usage: /${REWRITE_COMMAND} <your prompt>` }
    return runRewrite($, state, original, next.signal)
  })

  // `/rewrite-again <more context>` adds the context to the original, so later retries keep it too.
  on('command.run', { command: AGAIN_COMMAND }, ($, e, next) => {
    if (!state.review) return { text: `Nothing to rewrite again: run /${REWRITE_COMMAND} <prompt> first.` }
    const moreContext = e.args.trim()
    const original = moreContext ? `${state.review.original}\n\n${moreContext}` : state.review.original
    return runRewrite($, state, original, next.signal)
  })

  on('command.run', { command: CANCEL_COMMAND }, $ => {
    if (state.rewriting) {
      state.rewriting.stop.abort()
      return { text: 'Cancelling the rewrite…' }
    }
    if (!state.review) return { text: 'Nothing to cancel: no rewrite is pending.' }
    const { original } = state.review
    state.review = undefined
    $.ui.status(undefined)
    fillBox($, original)
    return { text: 'Rewrite discarded. Your original prompt is back in the box; Enter sends it as-is.' }
  })
}
