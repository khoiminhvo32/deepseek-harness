/** Deterministic keyless hard-harness adapter: stop-gate steer, three refuted fabrications (dead PoC + two payload-agnostic proofs), model-written proof over $1, cross-checked coverage. */

import { createHash } from 'node:crypto'
import { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

/** The confirmed finding's claim; its sha256 is the model-written PoC's HARD-PASS token. */
export const CONFIRMED_CLAIM = 'Command injection in buildReport: the user parameter reaches execSync() unquoted.'

const CLAIM_HASH = createHash('sha256').update(CONFIRMED_CLAIM).digest('hex')
const VECTOR = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'

/** Model-written PoC payloads, base64 so one bash line writes each file. */
const FAILING_POC_B64 = Buffer.from('#!/bin/sh\nexit 1\n').toString('base64')
const ECHO_POC_B64 = Buffer.from(`#!/bin/sh\necho "HARD-PASS ${CLAIM_HASH}"\n`).toString('base64')
// The marker-only fabrication reuses the confirmed claim verbatim, so its
// marker hash matches; ignoring $1 is what the benign arm catches.
const PROOF_POC_B64 = Buffer.from(
  '#!/bin/sh\nset -e\ncd "$(dirname "$0")/../.."\n'
  + 'node -e "const {buildReport}=require(\'./src/reports.js\'); buildReport(process.argv[1])" "$1"\n'
  + 'test -f poc/F-2/pwned.txt\n'
  + `echo "exploited: pwned.txt created"\necho "HARD-PASS ${CLAIM_HASH}"\n`,
).toString('base64')
// The payload-agnostic PoC prints filler output plus the marker regardless of
// $1 — the benign arm refutes it.
const GENERIC_POC_B64 = Buffer.from(
  `#!/bin/sh\necho "exploit succeeded"\necho "HARD-PASS ${CLAIM_HASH}"\n`,
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

/** The goal object from the most recent get_goal result, so revisions stay exact. */
function lastGoal(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'tool') continue
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const match = text.match(/\{[\s\S]*"goal"[\s\S]*\}/)
    if (match) return JSON.parse(match[0]).goal
  }
  return undefined
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

function submitFinding(id, title, claim, payload, component = 'src/reports.js') {
  return {
    name: 'hard_submit_finding',
    args: {
      title,
      bug_class: 'cmdi',
      component,
      claim,
      cvss_vector: VECTOR,
      cvss_score: 9.3,
      poc_path: `poc/${id}/poc.sh`,
      payload,
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
  if (!seen.includes('"id":"F-1"')) return toolChunks([submitFinding('F-1', 'Fake command injection', 'The reports module spawns commands from user input.', 'x')])
  // 3. Fabrication two: a marker-only PoC for the same confirmed claim — it
  // ignores $1, so the benign arm refutes it.
  if (!seen.includes('poc/F-2/poc.sh')) return toolChunks([writePoc('poc/F-2/poc.sh', ECHO_POC_B64)])
  if (!seen.includes('"id":"F-2"')) return toolChunks([submitFinding('F-2', 'Echo-only proof', CONFIRMED_CLAIM, 'x')])
  // 4. The real proof: a model-written PoC that exploits the planted bug
  // through the $1 payload the harness passes.
  if (!seen.includes('poc/F-3/poc.sh')) return toolChunks([writePoc('poc/F-3/poc.sh', PROOF_POC_B64)])
  if (!seen.includes('"id":"F-3"')) return toolChunks([submitFinding('F-3', 'Command injection in buildReport', CONFIRMED_CLAIM, 'x; touch poc/F-2/pwned.txt')])
  // 4b. The payload-agnostic trap: filler output plus the marker for ANY $1 —
  // the specificity check refutes it.
  if (!seen.includes('poc/F-4/poc.sh')) return toolChunks([writePoc('poc/F-4/poc.sh', GENERIC_POC_B64)])
  if (!seen.includes('"id":"F-4"')) return toolChunks([submitFinding('F-4', 'Payload-agnostic proof', CONFIRMED_CLAIM, 'x', 'src/session.js')])
  // 5. Coverage: clear the cell naming a sink the grep will not find, so the
  // deterministic cross-check reopens it; then re-mark with the real sinks.
  if (!seen.includes('reopenedSinks')) {
    return toolChunks([{ name: 'hard_mark_coverage', args: { module: 'src', bug_class: 'cmdi', verdict: 'cleared', declared_sinks: ['src/reports.js:99 system(cmd)'] } }])
  }
  if (!seen.includes('"reopenedSinks":[]')) {
    return toolChunks([{ name: 'hard_mark_coverage', args: { module: 'src', bug_class: 'cmdi', verdict: 'cleared', declared_sinks: ['execSync'] } }])
  }
  // 6. Propose completion while the sqli cell is still open: the completion
  // gate denies the attempt and names the remaining work.
  if (!names.includes('get_goal')) return toolChunks([{ name: 'get_goal', args: {} }])
  if (!seen.includes('The mission is not complete.')) {
    const goal = lastGoal(messages)
    return toolChunks([{ name: 'update_goal', args: { goal_id: goal.id, revision: goal.revision, action: 'complete' } }])
  }
  // 7. Batch clear the remaining class the harness grep can prove absent: the
  // planted repository builds shell commands only, so the sqli union (the
  // model's patterns plus the fixed table) matches nothing and the cell
  // clears as model-verified.
  if (!seen.includes('"cleared":1')) {
    return toolChunks([{ name: 'hard_clear_modules', args: { modules: ['src'], bug_class: 'sqli', patterns: ["SELECT[^\\n]*\\+"], rationale: 'The repository builds shell commands only; no SQL statement exists to concatenate.' } }])
  }
  // 7b. Phase B proof trap: cite a line the pinned tree never had. The harness
  // resolves citations at the pinned commit and rejects the whole record
  // naming the failed cite.
  if (!seen.includes('src/reports.js:999')) {
    return toolChunks([{ name: 'hard_record_flow', args: { module: 'src', entry_points: [{ cite: 'src/reports.js:999', snippet: 'never there', note: 'fabricated reading' }], dataflows: [], trust_boundaries: [], state_machines: [], assumptions: [], quirks: [] } }])
  }
  // 7c. The honest Phase B record: a citation that resolves at the pinned
  // commit lands as hard/flow/doc.
  if (!seen.includes('"flow"')) {
    return toolChunks([{ name: 'hard_record_flow', args: { module: 'src', entry_points: [{ cite: 'src/reports.js:8', snippet: 'execSync', note: 'the user parameter reaches execSync through interpolation' }], dataflows: [], trust_boundaries: [], state_machines: [], assumptions: [], quirks: [] } }])
  }
  // 8. Empty-verified sweep the completion gate requires, citing the
  // model-cleared cell as the verifiable proof.
  if (!seen.includes('"emptyProofRef"')) {
    return toolChunks([{ name: 'hard_sweep_summary', args: { phase: 'A', cells_touched: 2, new_findings: 0, empty_proof_kind: 'cell', empty_proof_module: 'src', empty_proof_bug_class: 'cmdi' } }])
  }
  // 9. Re-read the goal, then complete again: the ledger now certifies and
  // the gate allows it.
  if (names.filter(name => name === 'get_goal').length < 2) {
    return toolChunks([{ name: 'get_goal', args: {} }])
  }
  if (!seen.includes('"phase":"complete"')) {
    const goal = lastGoal(messages)
    return toolChunks([{ name: 'update_goal', args: { goal_id: goal.id, revision: goal.revision, action: 'complete' } }])
  }
  return textChunks('The mission is complete: one confirmed finding, two refuted fabrication attempts, and the gate-certified sweep record.')
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
