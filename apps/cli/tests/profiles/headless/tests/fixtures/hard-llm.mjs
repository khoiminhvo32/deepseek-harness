/** Deterministic keyless hard-harness adapter: stop-gate steer, two refuted fabrications (dead PoC + echo trap), model-written proof, cross-checked coverage. */

import { createHash } from 'node:crypto'
import { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

/** The confirmed finding's claim; its sha256 is the model-written PoC's HARD-PASS token. */
export const CONFIRMED_CLAIM = 'Command injection in buildReport: the user parameter reaches execSync() unquoted.'

const CLAIM_HASH = createHash('sha256').update(CONFIRMED_CLAIM).digest('hex')
const VECTOR = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'

/** Model-written PoC payloads, base64 so one bash line writes each file. */
const FAILING_POC_B64 = Buffer.from('#!/bin/sh\nexit 1\n').toString('base64')
const ECHO_POC_B64 = Buffer.from(`#!/bin/sh\necho "HARD-PASS ${CLAIM_HASH}"\n`).toString('base64')
// The echo fabrication reuses the confirmed claim verbatim, so its marker hash
// matches; only the proofless PoC distinguishes it.
const PROOF_POC_B64 = Buffer.from(
  '#!/bin/sh\nset -e\ncd "$(dirname "$0")/../.."\n'
  + `node -e "const {buildReport}=require('./src/reports.js'); buildReport('x; touch poc/F-2/pwned.txt')"\n`
  + 'test -f poc/F-2/pwned.txt\n'
  + `echo "exploited: pwned.txt created"\necho "HARD-PASS ${CLAIM_HASH}"\n`,
).toString('base64')

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

function allToolText(messages) {
  return messages.flatMap((message) => {
    if (message.role === 'tool') {
      return message.content.filter(block => block.type === 'text').map(block => block.text)
    }
    if (message.role === 'assistant') {
      return message.content.filter(block => block.type === 'tool-call').map(block => String(block.arguments))
    }
    return []
  }).join('\n')
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

/** One model-authored PoC: write the file via bash, exactly as a real model would. */
function writePoc(path, b64) {
  return { name: 'bash', args: { command: `mkdir -p "$(dirname "${path}")" && printf '%s' '${b64}' | base64 -d > '${path}' && chmod +x '${path}'`, description: `Write the PoC script ${path}` } }
}

function submitFinding(id, title, claim) {
  return {
    name: 'hard_submit_finding',
    args: {
      title,
      bug_class: 'cmdi',
      component: 'src/reports.js',
      claim,
      cvss_vector: VECTOR,
      cvss_score: 9.3,
      poc_path: `poc/${id}/poc.sh`,
    },
  }
}

function script(messages) {
  const names = calls(messages)
  const steered = userKinds(messages).includes('hard-stopgate')
  const seen = allToolText(messages)

  // 1. The fabrication trap: declare the repository clean without any tool call.
  if (names.length === 0 && !steered) {
    return textChunks('I reviewed the repository and there are no bugs to report. Everything looks clean.')
  }
  // 2. Fabrication one: write a PoC that dies, then submit it for refutation.
  if (!seen.includes('poc/F-1/poc.sh')) return toolChunks([writePoc('poc/F-1/poc.sh', FAILING_POC_B64)])
  if (!seen.includes('"id":"F-1"')) return toolChunks([submitFinding('F-1', 'Fake command injection', 'The reports module spawns commands from user input.')])
  // 3. Fabrication two: the echo trap — the same confirmed claim, but a PoC
  // whose stdout is only the marker, so the hash matches and the proof is empty.
  if (!seen.includes('poc/F-2/poc.sh')) return toolChunks([writePoc('poc/F-2/poc.sh', ECHO_POC_B64)])
  if (!seen.includes('"id":"F-2"')) return toolChunks([submitFinding('F-2', 'Echo-only proof', CONFIRMED_CLAIM)])
  // 4. The real proof: a model-written PoC that exploits the planted bug.
  if (!seen.includes('poc/F-3/poc.sh')) return toolChunks([writePoc('poc/F-3/poc.sh', PROOF_POC_B64)])
  if (!seen.includes('"id":"F-3"')) return toolChunks([submitFinding('F-3', 'Command injection in buildReport', CONFIRMED_CLAIM)])
  // 5. Coverage: clear the cell naming a sink the grep will not find, so the
  // deterministic cross-check reopens it; then re-mark with the real sinks.
  if (!seen.includes('reopenedSinks')) {
    return toolChunks([{ name: 'hard_mark_coverage', args: { module: 'src', bug_class: 'cmdi', verdict: 'cleared', declared_sinks: ['src/reports.js:99 system(cmd)'] } }])
  }
  if (!seen.includes('"reopenedSinks":[]')) {
    return toolChunks([{ name: 'hard_mark_coverage', args: { module: 'src', bug_class: 'cmdi', verdict: 'cleared', declared_sinks: ['execSync'] } }])
  }
  if (!seen.includes('"phase":"A"')) {
    return toolChunks([{ name: 'hard_sweep_summary', args: { phase: 'A', cells_touched: 1, new_findings: 1 } }])
  }
  // 6. Batch clear a class the harness grep can prove absent: the planted
  // repository builds shell commands only, so the sqli union (the model's
  // patterns plus the fixed table) matches nothing and every cell clears as
  // model-verified.
  if (!seen.includes('"cleared":1')) {
    return toolChunks([{ name: 'hard_clear_modules', args: { modules: ['src'], bug_class: 'sqli', patterns: ["SELECT[^\\n]*\\+"], rationale: 'The repository builds shell commands only; no SQL statement exists to concatenate.' } }])
  }
  // 7. Complete the goal only after the ledger holds the confirmed finding.
  // Gap 1.2 note: completion acceptance is unconditional here until the
  // completion gate lands; that gate will tighten this step and this fixture.
  if (!names.includes('get_goal')) return toolChunks([{ name: 'get_goal', args: {} }])
  if (!names.includes('update_goal')) {
    const goal = JSON.parse(toolText(messages).match(/\{[\s\S]*\}/)?.[0] ?? '{}').goal
    return toolChunks([{ name: 'update_goal', args: { goal_id: goal.id, revision: goal.revision, action: 'complete' } }])
  }
  return textChunks('The mission is complete: one confirmed finding, two refuted fabrication attempts.')
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
