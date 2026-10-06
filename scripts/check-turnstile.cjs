const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function main() {
  const html = fs.readFileSync('contact.html', 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const button = { disabled: true };
  const status = {};
  let submit, options, requests = 0, resets = 0, fail = false;
  const form = {
    querySelector: () => button,
    addEventListener: (_, handler) => { submit = handler; },
    reset: () => {},
  };
  const context = {
    document: {
      querySelector: (selector) => ({ '#contact-form': form, '#form-status': status,
        '#contact-turnstile': { dataset: { sitekey: '0x4AAAAAAFPdPXUYkSka-xch' } } })[selector],
      createElement: () => ({}), head: { append: () => {} },
    },
    window: { turnstile: {
      render: (_, value) => { options = value; return 'contact-widget'; },
      reset: (id) => { assert.equal(id, 'contact-widget'); resets++; },
    } },
    FormData: class { *[Symbol.iterator]() { yield ['name', 'Visitor']; } },
    fetch: async (_, init) => {
      requests++;
      assert.equal(JSON.parse(init.body)['cf-turnstile-response'], 'fresh-token');
      return { ok: !fail, json: async () => fail ? { error: 'Rejected' } : { message: 'Received' } };
    },
    console: { error: () => {} },
  };
  vm.runInNewContext(script, context);
  context.window.onContactTurnstileLoad();
  assert.equal(options.action, 'contact');
  assert.equal(options.sitekey, '0x4AAAAAAFPdPXUYkSka-xch');
  const event = { preventDefault: () => {} };
  await submit(event);
  assert.equal(requests, 0);
  options.callback('fresh-token');
  assert.equal(button.disabled, false);
  options['expired-callback']();
  assert.equal(button.disabled, true);
  for (fail of [false, true]) {
    options.callback('fresh-token');
    await submit(event);
    assert.equal(button.disabled, true);
    await submit(event);
  }
  assert.equal(requests, 2);
  assert.equal(resets, 2);

  const backend = fs.readFileSync('supabase/functions/send-contact-email/index.ts', 'utf8');
  const verifier = backend.slice(backend.indexOf('const verifyTurnstileToken'), backend.indexOf('const saveContactMessage'))
    .replace('token: unknown', 'token').replace(' as TurnstileResult', '');
  let result, calls = 0;
  const server = { Deno: { env: { get: (name) => name === 'TURNSTILE_SECRET_KEY' ? 'mock-secret' : undefined } },
    AbortSignal, fetch: async () => { calls++; return { ok: true, json: async () => result }; } };
  vm.runInNewContext(verifier + '\nthis.verify = verifyTurnstileToken;', server);
  for (const token of [null, '', 'x'.repeat(2049)]) assert.equal(await server.verify(token), false);
  assert.equal(calls, 0);
  for (result of [
    { success: false, action: 'contact', hostname: '6thlevel.net' },
    { success: true, action: 'login', hostname: '6thlevel.net' },
    { success: true, action: 'contact', hostname: 'localhost' },
    { success: true, action: 'contact', hostname: 'attacker.example' },
  ]) assert.equal(await server.verify('token'), false);
  for (const hostname of ['6thlevel.net', 'www.6thlevel.net']) {
    result = { success: true, action: 'contact', hostname };
    assert.equal(await server.verify('token'), true);
  }
  assert.ok(backend.indexOf('if (!turnstileVerified)') < backend.indexOf('const messageId = await saveContactMessage'));
  console.log('Passed: frontend token gating/reset and backend token/action/hostname checks (mocked).');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
