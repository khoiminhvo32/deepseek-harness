// @vitest-environment jsdom

import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { MeebardBrandName } from '../src/client/Brand.tsx'
// The locale-namespace merge for `hard` lives beside the registrations.
import type {} from '../src/client/mount.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
})

it('names the product Meebard Harness in the sidebar brand slot', () => {
  render(<MeebardBrandName t={makeTranslate(zh, commonZh)} />)
  expect(screen.getByText('Meebard Harness')).toBeTruthy()
})
