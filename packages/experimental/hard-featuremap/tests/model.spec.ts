/** The fact model indexes types, methods, free functions, and calls, and walks type lineages safely. */

import { describe, expect, it } from 'vitest'
import { findMethod, lineage } from '@deepseek-ai/dsh-experimental-hard-featuremap'
import { call, method, modelOf, type } from './facts.ts'

describe('fact model', () => {
  it('indexes free functions apart from methods and file-level code', async () => {
    const model = await modelOf([
      { k: 'file', path: 'code.php' },
      type('Base'),
      method('helper'),
      method('Base.helper', 'Base'),
      method('code.php:<global>'),
      call('helper', 'strlen'),
    ])
    expect(model.files).toEqual(['code.php'])
    expect([...model.functions]).toEqual(['helper'])
    expect(model.methodsByName.get('helper')).toEqual(['helper', 'Base.helper'])
    expect(model.calls).toHaveLength(1)
  })

  it('walks the lineage nearest first and stops at cycles and unknown parents', async () => {
    const model = await modelOf([type('C', ['B']), type('B', ['A', 'External']), type('A', ['C'])])
    expect(lineage(model, 'C')).toEqual(['C', 'B', 'A'])
    expect(lineage(model, 'Unknown')).toEqual([])
  })

  it('finds a method on the type or its nearest ancestor', async () => {
    const model = await modelOf([type('Child', ['Parent']), type('Parent'), method('Parent.save', 'Parent'), method('Child.load', 'Child')])
    expect(findMethod(model, 'Child', 'load')).toBe('Child.load')
    expect(findMethod(model, 'Child', 'save')).toBe('Parent.save')
    expect(findMethod(model, 'Child', 'missing')).toBeUndefined()
  })
})
