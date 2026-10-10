/** The WordPress profile reads hooks from call sites, links fired hooks to registered callbacks, and lists entry points. */

import { describe, expect, it } from 'vitest'
import { hookEdges, phpString, resolveCallback, WORDPRESS_SCRIPT_DIRS, wordpressEntryPoints, wordpressHooks } from '@deepseek-ai/dsh-experimental-hard-featuremap'
import type { HardCpgArg } from '@deepseek-ai/dsh-experimental-hard-cpg'
import { call, method, modelOf, type } from './facts.ts'

describe('phpString', () => {
  it.each([
    ['"wp_ajax_save"', 'wp_ajax_save'],
    ["'it\\'s'", "it's"],
    ["'a\\\\b'", 'a\\b'],
    ['"interpolated $x"', undefined],
    ['"escaped \\n"', undefined],
    ['$hook', undefined],
    ['"unterminated', undefined],
  ])('reads %s', (code, value) => {
    expect(phpString(code)).toBe(value)
  })
})

describe('resolveCallback', async () => {
  const model = await modelOf([
    type('Controller', ['Base']),
    type('Base'),
    method('save_widget'),
    method('Base.handle', 'Base'),
    method('Controller.register', 'Controller'),
  ])
  it.each([
    ['a function name', { lit: '"save_widget"' }, 'save_widget'],
    ['an unknown function name', { lit: '"missing"' }, undefined],
    ['a Class::method string', { lit: '"Controller::handle"' }, 'Base.handle'],
    ['a computed string', { lit: '"save_$x"' }, undefined],
    ['a class and method array', { arr: ['"Controller"', '"handle"'] }, 'Base.handle'],
    ['a $this and method array', { arr: ['$this', '"handle"'] }, 'Base.handle'],
    ['an array with a computed method', { arr: ['$this', '$method'] }, undefined],
    ['an array with a computed class', { arr: ['$class', '"handle"'] }, undefined],
    ['an array of the wrong length', { arr: ['"Controller"'] }, undefined],
    ['a closure or expression', { code: 'function () {}' }, undefined],
    ['a missing argument', undefined, undefined],
  ] satisfies [string, HardCpgArg | undefined, string | undefined][])('resolves %s', (_name, arg, expected) => {
    expect(resolveCallback(model, arg, 'Controller.register')).toBe(expected)
  })

  it('reads $this as nothing outside a type', () => {
    expect(resolveCallback(model, { arr: ['$this', '"handle"'] }, 'save_widget')).toBeUndefined()
  })
})

describe('hooks', () => {
  it('records registrations and firings and links each literal firing to its resolved callbacks', async () => {
    const model = await modelOf([
      method('save_widget'),
      method('on_save'),
      method('wp-admin/widgets.php:<global>', null, 'wp-admin/widgets.php'),
      call('wp-admin/widgets.php:<global>', 'add_action', { args: [{ lit: '"save"' }, { lit: '"on_save"' }], file: 'wp-admin/widgets.php', line: 3 }),
      call('wp-admin/widgets.php:<global>', 'add_action', { args: [{ lit: '"save"' }, { lit: '"on_save"' }], file: 'wp-admin/widgets.php', line: 4 }),
      call('wp-admin/widgets.php:<global>', 'add_filter', { args: [{ code: '$hook' }, { code: 'function () {}' }] }),
      call('wp-admin/widgets.php:<global>', 'add_filter', { args: [{ lit: '"save"' }] }),
      call('wp-admin/widgets.php:<global>', 'add_filter', { args: [{ lit: '"save_$type"' }, { lit: '"on_save"' }] }),
      call('save_widget', 'do_action', { args: [{ lit: '"save"' }], line: 20 }),
      call('save_widget', 'apply_filters', { args: [{ code: '$name' }] }),
      call('save_widget', 'do_action', { args: [{ lit: '"unregistered"' }] }),
      call('save_widget', 'strlen'),
    ])
    const hooks = wordpressHooks(model)
    expect(hooks.map(({ site, op, name, callback, callbackText }) => ({ site, op, name, callback, callbackText }))).toEqual([
      { site: 0, op: 'register', name: 'save', callback: 'on_save', callbackText: '"on_save"' },
      { site: 1, op: 'register', name: 'save', callback: 'on_save', callbackText: '"on_save"' },
      { site: 2, op: 'register', name: null, callback: null, callbackText: 'function () {}' },
      { site: 3, op: 'register', name: 'save', callback: null, callbackText: null },
      { site: 4, op: 'register', name: null, callback: 'on_save', callbackText: '"on_save"' },
      { site: 5, op: 'fire', name: 'save', callback: null, callbackText: null },
      { site: 6, op: 'fire', name: null, callback: null, callbackText: null },
      { site: 7, op: 'fire', name: 'unregistered', callback: null, callbackText: null },
    ])
    expect(hookEdges(hooks)).toEqual([{ site: 5, caller: 'save_widget', callee: 'on_save', file: 'code.php', line: 20, source: 'hook' }])
  })

  it('records the source text of an array callback', async () => {
    const model = await modelOf([call('x', 'add_action', { args: [{ lit: '"init"' }, { arr: ['$this', '"boot"'] }] })])
    expect(wordpressHooks(model)[0]?.callbackText).toBe('array($this, "boot")')
  })
})

describe('wordpressEntryPoints', () => {
  it('lists hook-routed actions, convention-named ajax handlers, shortcodes, REST handlers, and scripts', async () => {
    const model = await modelOf([
      { k: 'file', path: 'wp-login.php' },
      { k: 'file', path: 'wp-admin/admin-ajax.php' },
      { k: 'file', path: 'wp-admin/includes/ajax-actions.php' },
      { k: 'file', path: 'wp-admin/css/readme.txt' },
      { k: 'file', path: 'wp-admin/network/sites.php' },
      method('wp-login.php:<global>', null, 'wp-login.php'),
      method('wp-admin/admin-ajax.php:<global>', null, 'wp-admin/admin-ajax.php'),
      method('wp_ajax_nopriv_heartbeat', null, 'wp-admin/includes/ajax-actions.php'),
      method('wp_ajax_inline_save', null, 'wp-admin/includes/ajax-actions.php'),
      method('wp_ajax_nopriv_generate_password', null, 'wp-admin/includes/ajax-actions.php'),
      method('handle_export'),
      method('gallery_shortcode'),
      type('WP_REST_Controller'),
      type('WP_REST_Posts_Controller', ['WP_REST_Controller']),
      type('WP_REST_Pages_Controller', ['WP_REST_Posts_Controller']),
      type('Unrelated'),
      method('WP_REST_Controller.get_items', 'WP_REST_Controller'),
      method('WP_REST_Posts_Controller.update_item', 'WP_REST_Posts_Controller'),
      method('WP_REST_Posts_Controller.prepare_item_for_response', 'WP_REST_Posts_Controller'),
      method('WP_REST_Pages_Controller.get_items', 'WP_REST_Pages_Controller'),
      method('Unrelated.get_items', 'Unrelated'),
      call('wp-admin/admin-ajax.php:<global>', 'add_action', { args: [{ lit: '"wp_ajax_nopriv_heartbeat"' }, { lit: '"wp_ajax_nopriv_heartbeat"' }], file: 'wp-admin/admin-ajax.php', line: 171 }),
      call('x', 'add_action', { args: [{ lit: '"admin_post_export"' }, { lit: '"handle_export"' }], line: 5 }),
      call('x', 'add_action', { args: [{ lit: '"admin_post_nopriv_export"' }, { lit: '"missing"' }], line: 6 }),
      call('x', 'add_action', { args: [{ lit: '"init"' }, { lit: '"handle_export"' }] }),
      call('x', 'add_action', { args: [{ code: '"wp_ajax_" . $action' }, { code: '"wp_ajax_" . $action' }] }),
      call('x', 'do_action', { args: [{ lit: '"wp_ajax_fired"' }] }),
      call('x', 'add_shortcode', { args: [{ lit: '"gallery"' }, { lit: '"gallery_shortcode"' }], line: 9 }),
      call('x', 'add_shortcode', { args: [{ code: '$tag' }, { lit: '"gallery_shortcode"' }] }),
      call('x', 'add_shortcode', { args: [{ lit: '"caption"' }, { code: 'function () {}' }] }),
      call('x', 'add_shortcode', { args: [] }),
    ])
    const entries = wordpressEntryPoints(model, wordpressHooks(model), WORDPRESS_SCRIPT_DIRS)
    expect(entries.map(({ kind, key, handler, auth }) => ({ kind, key, handler, auth }))).toEqual([
      { kind: 'ajax', key: 'heartbeat', handler: 'wp_ajax_nopriv_heartbeat', auth: 'public' },
      { kind: 'admin-post', key: 'export', handler: 'handle_export', auth: 'authenticated' },
      { kind: 'admin-post', key: 'export', handler: null, auth: 'public' },
      { kind: 'ajax', key: 'inline_save', handler: 'wp_ajax_inline_save', auth: 'authenticated' },
      { kind: 'ajax', key: 'generate_password', handler: 'wp_ajax_nopriv_generate_password', auth: 'public' },
      { kind: 'shortcode', key: 'gallery', handler: 'gallery_shortcode', auth: 'public' },
      { kind: 'shortcode', key: 'caption', handler: null, auth: 'public' },
      { kind: 'rest', key: 'WP_REST_Posts_Controller.update_item', handler: 'WP_REST_Posts_Controller.update_item', auth: 'unknown' },
      { kind: 'rest', key: 'WP_REST_Pages_Controller.get_items', handler: 'WP_REST_Pages_Controller.get_items', auth: 'unknown' },
      { kind: 'script', key: 'wp-login.php', handler: 'wp-login.php:<global>', auth: 'unknown' },
      { kind: 'script', key: 'wp-admin/admin-ajax.php', handler: 'wp-admin/admin-ajax.php:<global>', auth: 'unknown' },
      { kind: 'script', key: 'wp-admin/network/sites.php', handler: null, auth: 'unknown' },
    ])
    expect(entries[0]).toMatchObject({ file: 'wp-admin/admin-ajax.php', line: 171 })
    expect(entries[3]).toMatchObject({ file: 'wp-admin/includes/ajax-actions.php', line: 1 })
  })

  it('lists no scripts without script directories', async () => {
    const model = await modelOf([{ k: 'file', path: 'index.php' }, method('index.php:<global>', null, 'index.php')])
    expect(wordpressEntryPoints(model, [], [])).toEqual([])
  })
})
