/** Guard pairs are found the same way for every framework: routing guards, reached guards, and declared guards, by category. */

import { describe, expect, it } from 'vitest'
import type { HardFeatureId } from '@deepseek-ai/dsh-experimental-hard-ledger'
import { DEFAULT_AUTHENTICATION_GUARD_PATTERN, DEFAULT_CSRF_GUARD_PATTERN, guardCategories, guardPairs } from '@deepseek-ai/dsh-experimental-hard-featuremap'
import type { HardGuardProfile } from '@deepseek-ai/dsh-experimental-hard-featuremap'

const FE = (id: string) => id as HardFeatureId
const patterns = { csrf: new RegExp(DEFAULT_CSRF_GUARD_PATTERN, 'i'), authentication: new RegExp(DEFAULT_AUTHENTICATION_GUARD_PATTERN, 'i') }
const categoryOf = guardCategories(new Map(), patterns)
const profile = (key: string, guards: string[], writes: string[], extra: Partial<HardGuardProfile> = {}): HardGuardProfile =>
  ({ key, auth: 'unknown', feature: FE('FE-1'), guards, writes, ...extra })

describe('guardCategories', () => {
  it('classifies declared guards first, then CSRF and authentication names, and everything else as authorization', () => {
    const classify = guardCategories(new Map([['App.Policy.canEdit', 'csrf' as const]]), patterns)
    expect(classify('App.Policy.canEdit')).toBe('csrf')
    expect(['check_ajax_referer', 'wp_verify_nonce', 'VerifyCsrfToken', 'ValidateAntiForgeryToken'].map(classify)).toEqual(['csrf', 'csrf', 'csrf', 'csrf'])
    expect(['is_user_logged_in', 'login_required', 'requireAuth', 'auth', 'auth:sanctum', '[Authorize]', '@PreAuthorize("isAuthenticated()")'].map(classify))
      .toEqual(['authentication', 'authentication', 'authentication', 'authentication', 'authentication', 'authentication', 'authentication'])
    expect(['current_user_can', '[Authorize(Roles = "Admin")]', '@PreAuthorize("hasRole(\'ADMIN\')")', 'can:update,post', 'isAdmin'].map(classify))
      .toEqual(['authorization', 'authorization', 'authorization', 'authorization', 'authorization'])
  })
})

describe('guardPairs', () => {
  it('pairs a Spring route without the role check its siblings make on the same state', () => {
    const pairs = guardPairs([
      profile('http:PUT /api/posts/{id}', ['@PreAuthorize("hasRole(\'EDITOR\')")'], ['PostRepository.save']),
      profile('http:POST /api/posts', ['@Secured("ROLE_EDITOR")'], ['PostRepository.save'], { feature: FE('FE-2') }),
      profile('http:POST /api/posts/{id}/publish', [], ['PostRepository.save', 'table:posts'], { feature: FE('FE-3') }),
    ], categoryOf)
    expect(pairs).toEqual([{
      category: 'authorization',
      states: ['PostRepository.save'],
      weaker: { entry: 'http:POST /api/posts/{id}/publish', feature: 'FE-3' },
      stronger: { entry: 'http:PUT /api/posts/{id}', feature: 'FE-1' },
      missing: ['@PreAuthorize("hasRole(\'EDITOR\')")'],
    }])
  })

  it('counts an authenticated route as authentication, compares CSRF only within a kind, and merges states per weaker entry', () => {
    const pairs = guardPairs([
      profile('ajax:save', ['check_ajax_referer'], ['update_post_meta', 'wp_update_post'], { auth: 'authenticated' }),
      profile('ajax:public_save', [], ['update_post_meta', 'wp_update_post'], { auth: 'public' }),
      profile('ajax:other', ['check_ajax_referer'], ['update_post_meta'], { auth: 'authenticated' }),
      profile('rest:Posts.update_item', ['current_user_can'], ['wp_update_post']),
    ], categoryOf)
    // wp_update_post: the lone REST writer forms no CSRF peer group, and one authenticated writer of three is not half.
    expect(pairs.map(pair => [pair.weaker.entry, pair.category, pair.states, pair.missing])).toEqual([
      ['ajax:public_save', 'csrf', ['update_post_meta', 'wp_update_post'], ['check_ajax_referer']],
      ['ajax:public_save', 'authentication', ['update_post_meta'], ['an authenticated route']],
    ])
  })

  it('stays silent when fewer than half the writers carry the category or a state has one writer', () => {
    expect(guardPairs([
      profile('a:1', ['current_user_can'], ['s']), profile('a:2', [], ['s']), profile('a:3', [], ['s']), profile('a:4', [], ['solo']),
    ], categoryOf)).toEqual([])
    expect(guardPairs([], categoryOf)).toEqual([])
  })
})
