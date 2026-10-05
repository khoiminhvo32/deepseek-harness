/** Deterministic keyless hard-harness adapter: fabrication trap, stop-gate steer, verified finding. */

import { createHash } from 'node:crypto'
import { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

/** The confirmed finding's claim; its sha256 is the pre-staged PoC's HARD-PASS token. */
export const CONFIRMED_CLAIM = 'Command injection in buildReport: the user parameter reaches execSync() unquoted.'

const CLAIM_HASH = createHash('sha256').update(CONFIRMED_CLAIM).digest('hex')
const VECTOR = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'

let nextCall = 0

function calls(messages) {
  return messages.flatMap(message => message.role === 'assistant'
    ? message.content.filter(block => block.type === 'tool-call').map(block => block.name)
    : [])
}

function userKinds(messages) {
  return messages.filter(message => message.role === 'user')
    .map(message => String(message.source?.kind ?? 'user'))
}

function toolText(messages) {
  return messages.findLast(message => message.role === 'tool')
    ?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
}

function toolChunks(specs) {
  const chunks = []
  for (const [index, spec] of specs.entries()) {
    const id = ToolCallId(`hard-fixture-${++nextCall}`)
    const args = JSON.stringify(spec.args)
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name: spec.name, argumentsDelta: args },
      { type: 'block-end', index, block: { type: 'tool-call', id, name: spec.name, arguments: args } },
    )
  }
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
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

function script(messages) {
  const names = calls(messages)
  const steered = userKinds(messages).includes('hard-stopgate')

  // 1. The fabrication trap: declare the repository clean without any tool call.
  if (names.length === 0 && !steered) {
    return textChunks('I reviewed the repository and there are no bugs to report. Everything looks clean.')
  }

  // 2. After the stop gate steers, submit a fabricated finding whose PoC fails.
  if (!names.includes('hard_submit_finding')) {
    return toolChunks([{
      name: 'hard_submit_finding',
      args: {
        title: 'Fake SQL injection',
        bug_class: 'sqli',
        component: 'src/reports.js',
        claim: 'The reports module concatenates SQL from user input.',
        cvss_vector: VECTOR,
        cvss_score: 9.3,
        poc_path: 'poc/F-1/poc.sh',
      },
    }])
  }

  // 3. Fabrication refuted: submit the real finding, whose pre-staged PoC proves the effect.
  const refuted = toolText(messages).includes('refuted')
  if (refuted && !names.includes('hard_mark_coverage')) {
    return toolChunks([
      {
        name: 'hard_submit_finding',
        args: {
          title: 'Command injection in buildReport',
          bug_class: 'cmdi',
          component: 'src/reports.js',
          claim: CONFIRMED_CLAIM,
          cvss_vector: VECTOR,
          cvss_score: 9.3,
          poc_path: 'poc/F-2/poc.sh',
        },
      },
      {
        name: 'hard_mark_coverage',
        args: {
          module: 'src',
          bug_class: 'cmdi',
          verdict: 'cleared',
          declared_sinks: ['src/reports.js:7 execSync(command)'],
        },
      },
      { name: 'hard_sweep_summary', args: { phase: 'A', cells_touched: 1, new_findings: 1 } },
    ])
  }

  // 4. The ledger holds a confirmed finding: complete the goal honestly.
  if (!names.includes('get_goal')) {
    return toolChunks([{ name: 'get_goal', args: {} }])
  }
  if (!names.includes('update_goal')) {
    const goal = JSON.parse(toolText(messages).match(/\{[\s\S]*\}/)?.[0] ?? '{}').goal
    return toolChunks([{ name: 'update_goal', args: {
      goal_id: goal.id, revision: goal.revision, action: 'complete',
    } }])
  }
  return textChunks('The mission is complete: one confirmed finding, one refuted fabrication attempt.')
}

class HardFixtureAdapter extends LlmAdapter {
  async *stream(request) {
    yield* script(request.messages)
  }
}

export const name = 'hard-fixture-llm'

export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new HardFixtureAdapter())
}

export { CLAIM_HASH }
