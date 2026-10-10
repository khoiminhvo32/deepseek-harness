/** Call edges keep Joern's resolution and add repaired edges only where the facts name exactly one target. */

import { describe, expect, it } from 'vitest'
import { callEdges } from '@deepseek-ai/dsh-experimental-hard-featuremap'
import type { HardCallEdge } from '@deepseek-ai/dsh-experimental-hard-featuremap'
import { call, method, modelOf, type } from './facts.ts'

const BASE = [
  type('Child', ['Parent']),
  type('Parent'),
  method('wp_insert_post'),
  method('Parent.save', 'Parent'),
  method('Parent.render', 'Parent'),
  method('Child.render', 'Child'),
  method('Child.run', 'Child'),
  method('WP_Error.get_error_code', 'WP_Error'),
  method('A.shared', 'A'),
  method('B.shared', 'B'),
  method('Ghost.run', 'Ghost'),
]

async function edgesFor(...calls: ReturnType<typeof call>[]): Promise<Pick<HardCallEdge, 'callee' | 'source'>[]> {
  const model = await modelOf([...BASE, ...calls])
  return callEdges(model).map(({ callee, source }) => ({ callee, source }))
}

describe('callEdges', () => {
  it('keeps every target Joern resolved', async () => {
    const model = await modelOf([...BASE, call('Child.run', 'render', { resolved: ['Child.render', 'Parent.render'], dynamic: true, file: 'a.php', line: 7 })])
    expect(callEdges(model)).toEqual([
      { site: 0, caller: 'Child.run', callee: 'Child.render', file: 'a.php', line: 7, source: 'joern' },
      { site: 0, caller: 'Child.run', callee: 'Parent.render', file: 'a.php', line: 7, source: 'joern' },
    ])
  })

  it('resolves a class-qualified call to the free function the class does not declare (Joern issue 3050)', async () => {
    expect(await edgesFor(call('Child.run', 'wp_insert_post', { target: 'Child.wp_insert_post' }))).toEqual([{ callee: 'wp_insert_post', source: 'repair' }])
  })

  it('resolves a type-qualified call through the lineage before falling back to a free function', async () => {
    expect(await edgesFor(call('Child.run', 'save', { target: 'Child.save', dynamic: true }))).toEqual([{ callee: 'Parent.save', source: 'repair' }])
  })

  it('resolves parent, self, and static calls relative to the caller type', async () => {
    expect(await edgesFor(
      call('Child.render', 'render', { target: 'parent.render' }),
      call('Child.run', 'render', { target: 'self.render' }),
      call('Child.run', 'save', { target: 'static.save' }),
    )).toEqual([
      { callee: 'Parent.render', source: 'repair' },
      { callee: 'Child.render', source: 'repair' },
      { callee: 'Parent.save', source: 'repair' },
    ])
  })

  it('leaves relative calls unresolved outside a type or without a match', async () => {
    expect(await edgesFor(
      call('wp_insert_post', 'render', { target: 'parent.render' }),
      call('wp_insert_post', 'render', { target: 'self.render' }),
      call('Child.run', 'missing', { target: 'parent.missing' }),
      call('Parent.save', 'render', { target: 'parent.render' }),
      call('Ghost.run', 'render', { target: 'parent.render' }),
    )).toEqual([])
  })

  it('resolves an unqualified call only to a known free function', async () => {
    expect(await edgesFor(call('Child.run', 'wp_insert_post'), call('Child.run', 'strlen'))).toEqual([{ callee: 'wp_insert_post', source: 'repair' }])
  })

  it('leaves a known-type call that names nothing unresolved', async () => {
    expect(await edgesFor(call('Child.run', 'missing', { target: 'Child.missing' }))).toEqual([])
  })

  it('resolves a call Joern could not name through the caller type, as Ruby receiverless calls', async () => {
    expect(await edgesFor(
      call('Child.run', 'save', { target: '<unknownFullName>', dynamic: true }),
      call('wp_insert_post', 'save', { target: '<unknownFullName>', dynamic: true }),
    )).toEqual([{ callee: 'Parent.save', source: 'repair' }, { callee: 'Parent.save', source: 'unique-name' }])
  })

  it('links a dynamic call on an unknown receiver only when one method carries the name', async () => {
    expect(await edgesFor(
      call('Child.run', 'get_error_code', { target: 'null.get_error_code', dynamic: true }),
      call('Child.run', 'shared', { target: 'null.shared', dynamic: true }),
      call('Child.run', 'get_error_code', { target: 'null.get_error_code' }),
    )).toEqual([{ callee: 'WP_Error.get_error_code', source: 'unique-name' }])
  })
})
