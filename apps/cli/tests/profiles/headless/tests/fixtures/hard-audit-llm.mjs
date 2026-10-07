/** Deterministic keyless hard-audit adapter: the mission agent clears a cell wrongly and stops at once; the blind reader reads the module and flags it. */

import { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

/** The mission agent's declared site; the reader's prompt must never carry it. */
export const CLAIMED_SINK = 'src/reports.js:buildReport - the user parameter is quoted before it reaches execSync'

let nextCall = 0

function toolChunks(name, args) {
  const id = ToolCallId(`hard-audit-fixture-${++nextCall}`)
  const text = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: text },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function calledTools(messages) {
  return messages.flatMap(message => message.role === 'assistant'
    ? message.content.filter(block => block.type === 'tool-call').map(block => block.name)
    : [])
}

function allText(messages) {
  return messages.flatMap(message => (Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === 'text').map(block => block.text)).join('\n')
}

/** The reader: read the module, then report the planted bug with the facts the e2e asserts in its reason. */
function reader(request) {
  const called = calledTools(request.messages)
  if (!called.includes('read')) return toolChunks('read', { file_path: 'src/reports.js' })
  const tools = (request.tools ?? []).map(tool => tool.name).sort().join(',')
  const blind = !allText(request.messages).includes('quoted before it reaches execSync')
  return toolChunks('structured_output', {
    outcome: 'flagged',
    locations: [{ path: 'src/reports.js', line: 8, symbol: 'buildReport' }],
    examined: [],
    reason: `blind=${blind} tools=${tools}`,
  })
}

/** The mission agent: clear the vulnerable cell, then stop without waiting for anything. */
function mission(request) {
  const called = calledTools(request.messages)
  if (!called.includes('hard_mark_coverage')) {
    return toolChunks('hard_mark_coverage', { module: 'src', bug_class: 'cmdi', verdict: 'cleared', declared_sinks: [CLAIMED_SINK] })
  }
  return textChunks('The cell is cleared.')
}

/** How long each reader response takes, so the mission agent stops while the reader still runs. */
const READER_LATENCY_MS = 1500

class HardAuditFixtureAdapter extends LlmAdapter {
  async *stream(request) {
    const isReader = (request.tools ?? []).some(tool => tool.name === 'structured_output')
    if (isReader) await new Promise(resolve => setTimeout(resolve, READER_LATENCY_MS))
    yield* isReader ? reader(request) : mission(request)
  }
}

export const name = 'hard-audit-fixture-llm'

export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new HardAuditFixtureAdapter())
}
