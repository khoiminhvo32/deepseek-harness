/** Fact builders shared by the feature map specs. */

import type { HardCpgArg, HardCpgFact } from '@deepseek-ai/dsh-experimental-hard-cpg'
import { buildModel } from '@deepseek-ai/dsh-experimental-hard-featuremap'
import type { FactModel } from '@deepseek-ai/dsh-experimental-hard-featuremap'

export function type(id: string, inherits: string[] = [], file = 'types.php'): HardCpgFact {
  return { k: 'type', id, name: id, file, line: 1, inherits }
}

export function method(id: string, owner: string | null = null, file = 'code.php'): HardCpgFact {
  return { k: 'method', id, name: id.includes(':<global>') ? '<global>' : id.split('.').at(-1)!, file, owner, line: 1, end: 2 }
}

interface CallOptions {
  target?: string
  resolved?: string[]
  dynamic?: boolean
  args?: HardCpgArg[]
  file?: string
  line?: number
}

export function call(caller: string, name: string, options: CallOptions = {}): HardCpgFact {
  return {
    k: 'call',
    caller,
    name,
    target: options.target ?? name,
    resolved: options.resolved ?? [],
    file: options.file ?? 'code.php',
    line: options.line ?? 10,
    dispatch: options.dynamic === true ? 'dynamic' : 'static',
    args: options.args ?? [],
  }
}

export async function modelOf(facts: HardCpgFact[]): Promise<FactModel> {
  return buildModel((async function* () {
    yield* facts
  })())
}
