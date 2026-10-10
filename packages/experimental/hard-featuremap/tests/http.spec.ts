/** HTTP route profiles read each framework's route declarations, the handler each reaches, and the routing guards. */

import { describe, expect, it } from 'vitest'
import { httpEntryPoints } from '@deepseek-ai/dsh-experimental-hard-featuremap'
import type { HardEntryPoint } from '@deepseek-ai/dsh-experimental-hard-featuremap'
import { annotation, call, method, modelOf, type } from './facts.ts'

function summary(entries: HardEntryPoint[]): [string, string | null, string, readonly string[]][] {
  return entries.map(entry => [entry.key, entry.handler, entry.auth, entry.guards])
}

describe('spring', () => {
  it('joins the controller prefix and reads method and class guards', async () => {
    const model = await modelOf([
      type('demo.PostController', [], 'PostController.java', [annotation('RestController'), annotation('RequestMapping', ['/api/posts'])]),
      type('demo.AdminController', [], 'AdminController.java', [annotation('PreAuthorize', ["hasRole('ADMIN')"])]),
      method('demo.PostController.get', 'demo.PostController', 'PostController.java', [annotation('GetMapping', ['/{id}'])]),
      method('demo.PostController.create', 'demo.PostController', 'PostController.java', [annotation('PostMapping'), annotation('Secured', ['ROLE_EDITOR', 'ROLE_ADMIN'])]),
      method('demo.PostController.open', 'demo.PostController', 'PostController.java', [annotation('RequestMapping', ['"/open"']), annotation('PermitAll')]),
      method('demo.AdminController.purge', 'demo.AdminController', 'AdminController.java', [annotation('DeleteMapping', ['/purge'])]),
      method('demo.Free.helper', null, 'Free.java', [annotation('PatchMapping', ['x'])]),
      method('demo.PostController.load', 'demo.PostController', 'PostController.java', [annotation('Override')]),
      method('demo.Ghost.find', 'demo.Ghost', 'Ghost.java', [annotation('GetMapping', ['/ghost']), annotation('RolesAllowed')]),
    ])
    expect(summary(httpEntryPoints(model, ['spring']))).toEqual([
      ['GET /api/posts/{id}', 'demo.PostController.get', 'unknown', []],
      ['POST /api/posts', 'demo.PostController.create', 'authenticated', ['Secured(ROLE_EDITOR, ROLE_ADMIN)']],
      ['ANY /api/posts/open', 'demo.PostController.open', 'public', []],
      ['DELETE /purge', 'demo.AdminController.purge', 'authenticated', ["PreAuthorize(hasRole('ADMIN'))"]],
      ['PATCH /x', 'demo.Free.helper', 'unknown', []],
      ['GET /ghost', 'demo.Ghost.find', 'authenticated', ['RolesAllowed']],
    ])
  })
})

describe('aspnet', () => {
  it('expands controller and action tokens and honors absolute routes and anonymous access', async () => {
    const model = await modelOf([
      type('PostsController', ['ControllerBase'], 'PostsController.cs', [annotation('ApiController'), annotation('Route', [], 'Route("api/[controller]")'), annotation('Authorize', [], 'Authorize')]),
      method('PostsController.Get', 'PostsController', 'PostsController.cs', [annotation('HttpGet', [], 'HttpGet("{id}")')]),
      method('PostsController.Create', 'PostsController', 'PostsController.cs', [annotation('HttpPost', [], 'HttpPost'), annotation('Authorize', [], 'Authorize(Roles = "Admin")')]),
      method('PostsController.Health', 'PostsController', 'PostsController.cs', [annotation('HttpGet', [], 'HttpGet("/health")'), annotation('AllowAnonymous', [], 'AllowAnonymous')]),
      method('PostsController.Export', 'PostsController', 'PostsController.cs', [annotation('Route', [], 'Route("~/export/[action]")')]),
      method('Handlers.Ping', null, 'Handlers.cs', [annotation('HttpPut', [], 'HttpPut("ping")')]),
      method('Orphan.Run', 'Orphan', 'Orphan.cs', [annotation('HttpDelete', [], 'HttpDelete("[controller]/run")')]),
      method('PostsController.Load', 'PostsController', 'PostsController.cs', [annotation('NonAction', [], 'NonAction')]),
    ])
    expect(summary(httpEntryPoints(model, ['aspnet']))).toEqual([
      ['GET /api/Posts/{id}', 'PostsController.Get', 'authenticated', ['Authorize']],
      ['POST /api/Posts', 'PostsController.Create', 'authenticated', ['Authorize', 'Authorize(Roles = "Admin")']],
      ['GET /health', 'PostsController.Health', 'public', ['Authorize']],
      ['ANY /export/Export', 'PostsController.Export', 'authenticated', ['Authorize']],
      ['PUT /ping', 'Handlers.Ping', 'unknown', []],
      ['DELETE /run', 'Orphan.Run', 'unknown', []],
    ])
  })
})

describe('flask and fastapi', () => {
  it('reads route decorators with a path and treats access-named decorators as guards', async () => {
    const model = await modelOf([
      method('app.py:<module>.delete', null, 'app.py', [annotation('route', ['"/posts/<pid>/delete"']), annotation('login_required'), annotation('cache')]),
      method('app.py:<module>.read_item', null, 'app.py', [annotation('get', ["'/items/{item_id}'"])]),
      method('app.py:<module>.admin', null, 'app.py', [annotation('post', ['"/admin"']), annotation('requires_roles', ['"admin"'])]),
      method('app.py:<module>.helper', null, 'app.py', [annotation('get', ['"cache-key"'])]),
      method('app.py:<module>.plain', null, 'app.py', [annotation('lru_cache')]),
    ])
    const entries = httpEntryPoints(model, ['flask', 'fastapi'])
    expect(summary(entries)).toEqual([
      ['ANY /posts/<pid>/delete', 'app.py:<module>.delete', 'authenticated', ['login_required']],
      ['GET /items/{item_id}', 'app.py:<module>.read_item', 'unknown', []],
      ['POST /admin', 'app.py:<module>.admin', 'authenticated', ['requires_roles']],
    ])
    expect(httpEntryPoints(model, ['fastapi'])).toEqual(entries)
  })
})

describe('express', () => {
  it('resolves handlers by reference or same-file name and reads middleware as guards', async () => {
    const model = await modelOf([
      method('app.js::program', null, 'app.js'),
      method('app.js::program:remove', 'app.js::program', 'app.js'),
      method('app.js::program:<lambda>0', 'app.js::program', 'app.js'),
      method('other.js::program:remove', 'other.js::program', 'other.js'),
      call('app.js::program', 'get', { dynamic: true, file: 'app.js', line: 7, args: [{ lit: "'/health'" }, { ref: 'app.js::program:<lambda>0' }] }),
      call('app.js::program', 'post', { dynamic: true, file: 'app.js', line: 8, args: [{ lit: '"/posts/:id/delete"' }, { code: 'requireAuth' }, { lit: '"csrf"' }, { ref: 'x' }, { arr: ['a'] }, { code: 'remove' }] }),
      call('app.js::program', 'put', { dynamic: true, file: 'app.js', line: 9, args: [{ lit: '`/items/:id`' }, { code: 'missing' }] }),
      call('app.js::program', 'delete', { dynamic: true, file: 'app.js', args: [{ lit: '"/gone"' }, { ref: 'unknown.ref' }] }),
      call('app.js::program', 'all', { dynamic: true, file: 'app.js', args: [{ lit: '"/any"' }, { arr: ['x'] }] }),
      call('app.js::program', 'get', { dynamic: true, file: 'app.js', args: [{ lit: '"setting"' }, { code: 'remove' }] }),
      call('app.js::program', 'get', { dynamic: true, file: 'app.js', args: [{ code: 'path' }, { code: 'remove' }] }),
      call('app.js::program', 'get', { dynamic: true, file: 'app.js', args: [{ lit: '"/only"' }] }),
      call('app.js::program', 'get', { file: 'app.js', args: [{ lit: '"/static"' }, { code: 'remove' }] }),
      call('app.js::program', 'listen', { dynamic: true, file: 'app.js', args: [{ lit: '"/x"' }, { code: 'remove' }] }),
    ])
    expect(summary(httpEntryPoints(model, ['express']))).toEqual([
      ['GET /health', 'app.js::program:<lambda>0', 'unknown', []],
      ['POST /posts/:id/delete', 'app.js::program:remove', 'authenticated', ['requireAuth', 'csrf', 'x', '[a]']],
      ['PUT /items/:id', null, 'unknown', []],
      ['DELETE /gone', null, 'unknown', []],
      ['ANY /any', null, 'unknown', []],
    ])
  })
})

describe('laravel', () => {
  it('resolves controller arrays, legacy strings, and closures and reads chained middleware', async () => {
    const model = await modelOf([
      type('App\\Http\\Controllers\\PostController', ['App\\Http\\Controllers\\Controller']),
      type('App\\Http\\Controllers\\Controller'),
      method('App\\Http\\Controllers\\PostController.show', 'App\\Http\\Controllers\\PostController'),
      method('App\\Http\\Controllers\\Controller.store', 'App\\Http\\Controllers\\Controller'),
      method('routes/web.php:<global>', null, 'routes/web.php'),
      method('routes/web.php:<global>.<lambda>0', 'routes/web.php:<global>', 'routes/web.php'),
      ...['get', 'post', 'put', 'patch', 'delete', 'any'].map(() => method('unused')),
      call('routes/web.php:<global>', 'get', { target: 'Illuminate\\Support\\Facades\\Route.get', file: 'routes/web.php', line: 4, args: [{ lit: '"/posts/{id}"' }, { arr: ['App\\Http\\Controllers\\PostController.class', '"show"'] }] }),
      call('routes/web.php:<global>', 'post', { target: 'Illuminate\\Support\\Facades\\Route.post', file: 'routes/web.php', line: 5, args: [{ lit: '"posts"' }, { arr: ['App\\Http\\Controllers\\PostController::class', '"store"'] }] }),
      call('routes/web.php:<global>', 'middleware', { target: 'Illuminate\\Support\\Facades\\Route.post.middleware', file: 'routes/web.php', line: 5, args: [{ code: 'Route::post(...)' }, { lit: '"auth"' }, { lit: '"verified"' }] }),
      call('routes/web.php:<global>', 'put', { target: 'Illuminate\\Support\\Facades\\Route.put', file: 'routes/web.php', line: 6, args: [{ lit: '"/legacy"' }, { lit: '"PostController@show"' }] }),
      call('routes/web.php:<global>', 'patch', { target: 'Illuminate\\Support\\Facades\\Route.patch', file: 'routes/web.php', line: 7, args: [{ lit: '"/health"' }, { ref: 'routes/web.php:<global>.<lambda>0' }] }),
      call('routes/web.php:<global>', 'delete', { target: 'Illuminate\\Support\\Facades\\Route.delete', file: 'routes/web.php', line: 8, args: [{ lit: '"/gone"' }, { ref: 'missing' }] }),
      call('routes/web.php:<global>', 'any', { target: 'Illuminate\\Support\\Facades\\Route.any', file: 'routes/web.php', line: 9, args: [{ lit: '"/bad"' }, { arr: ['Unknown.class', '$method'] }] }),
      call('routes/web.php:<global>', 'get', { target: 'Illuminate\\Support\\Facades\\Route.get', file: 'routes/web.php', line: 10, args: [{ lit: '"/old"' }, { lit: '"Missing@show"' }] }),
      call('routes/web.php:<global>', 'get', { target: 'Illuminate\\Support\\Facades\\Route.get', file: 'routes/web.php', line: 11, args: [{ lit: '"/view"' }, { lit: '"welcome"' }] }),
      call('routes/web.php:<global>', 'get', { target: 'Illuminate\\Support\\Facades\\Route.get', file: 'routes/web.php', line: 12, args: [{ lit: '"/none"' }] }),
      call('routes/web.php:<global>', 'get', { target: 'Illuminate\\Support\\Facades\\Route.get', file: 'routes/web.php', line: 13, args: [{ lit: '"/code"' }, { code: '$handler' }] }),
      call('routes/web.php:<global>', 'get', { target: 'Illuminate\\Support\\Facades\\Route.get', file: 'routes/web.php', line: 14, args: [{ code: '$path' }] }),
      call('routes/web.php:<global>', 'get', { target: 'Illuminate\\Support\\Facades\\Route.get', file: 'routes/web.php', line: 15, args: [] }),
      call('routes/web.php:<global>', 'get', { target: 'Illuminate\\Support\\Facades\\Route.get', file: 'routes/web.php', line: 16, args: [{ lit: '"/m1"' }, { arr: ['App\\Http\\Controllers\\PostController.class', '"missing"'] }] }),
      call('routes/web.php:<global>', 'get', { target: 'Illuminate\\Support\\Facades\\Route.get', file: 'routes/web.php', line: 17, args: [{ lit: '"/m2"' }, { lit: '"PostController@missing"' }] }),
      call('routes/web.php:<global>', 'get', { target: 'Illuminate\\Support\\Facades\\Route.get', file: 'routes/web.php', line: 18, args: [{ lit: '"/m3"' }, { lit: '"Post$x@show"' }] }),
      call('routes/web.php:<global>', 'get', { target: 'Other.get', file: 'routes/web.php', args: [{ lit: '"/other"' }] }),
      call('routes/web.php:<global>', 'middleware', { target: 'Other.middleware', file: 'routes/web.php', line: 4, args: [{ lit: '"ignored"' }] }),
      call('routes/web.php:<global>', 'resource', { target: 'Illuminate\\Support\\Facades\\Route.resource', file: 'routes/web.php', args: [{ lit: '"/photos"' }] }),
    ])
    expect(summary(httpEntryPoints(model, ['laravel']))).toEqual([
      ['GET /posts/{id}', 'App\\Http\\Controllers\\PostController.show', 'unknown', []],
      ['POST /posts', 'App\\Http\\Controllers\\Controller.store', 'authenticated', ['auth', 'verified']],
      ['PUT /legacy', 'App\\Http\\Controllers\\PostController.show', 'unknown', []],
      ['PATCH /health', 'routes/web.php:<global>.<lambda>0', 'unknown', []],
      ['DELETE /gone', null, 'unknown', []],
      ['ANY /bad', null, 'unknown', []],
      ['GET /old', null, 'unknown', []],
      ['GET /view', null, 'unknown', []],
      ['GET /none', null, 'unknown', []],
      ['GET /code', null, 'unknown', []],
      ['GET /m1', null, 'unknown', []],
      ['GET /m2', null, 'unknown', []],
      ['GET /m3', null, 'unknown', []],
    ])
  })
})

describe('httpEntryPoints', () => {
  it('reads nothing without frameworks', async () => {
    const model = await modelOf([method('x', null, 'x.py', [annotation('get', ['"/x"'])])])
    expect(httpEntryPoints(model, [])).toEqual([])
  })
})
