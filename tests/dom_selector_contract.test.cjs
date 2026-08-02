const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { test } = require('node:test');
const { join } = require('node:path');

const repoRoot = join(__dirname, '..');
const chromeCandidates = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const chrome = chromeCandidates.find((candidate) => existsSync(candidate));

test('ChatGPT assistant selector counts semantic turns once', { skip: !chrome }, () => {
  const source = readFileSync(join(repoRoot, 'src', 'main.rs'), 'utf8');
  assert.match(
    source,
    /\.agent-turn, \[data-message-author-role=\\"assistant\\"\]:not\(\.agent-turn \*\)/,
    'the provider boundary must use the canonical containment selector',
  );

  const fixture = `<!doctype html>
    <main id="fixture"></main>
    <pre id="result"></pre>
    <script>
      const oldSelector = '[data-message-author-role="assistant"], .agent-turn';
      const canonicalSelector = '.agent-turn, [data-message-author-role="assistant"]:not(.agent-turn *)';
      const cases = [
        ['nested', '<div class="agent-turn"><div data-message-author-role="assistant">nested</div></div>'],
        ['agent-only', '<div class="agent-turn">agent</div>'],
        ['role-only', '<div data-message-author-role="assistant">role</div>'],
        ['siblings', '<div class="agent-turn">one</div><div class="agent-turn">two</div>'],
        ['mixed', '<div data-message-author-role="assistant">old</div><div class="agent-turn"><div data-message-author-role="assistant">new</div></div>'],
      ];
      const result = {};
      for (const [name, html] of cases) {
        const host = document.createElement('section');
        host.innerHTML = html;
        result[name] = {
          old: host.querySelectorAll(oldSelector).length,
          canonical: host.querySelectorAll(canonicalSelector).length,
        };
      }
      document.querySelector('#result').textContent = JSON.stringify(result);
    </script>`;
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(fixture)}`;
  const rendered = execFileSync(
    chrome,
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--dump-dom', url],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 },
  );
  const encoded = rendered.match(/<pre id="result">([^<]*)<\/pre>/)?.[1];
  assert.ok(encoded, 'headless DOM fixture did not return a result');
  const counts = JSON.parse(encoded);
  assert.deepEqual(counts, {
    nested: { old: 2, canonical: 1 },
    'agent-only': { old: 1, canonical: 1 },
    'role-only': { old: 1, canonical: 1 },
    siblings: { old: 2, canonical: 2 },
    mixed: { old: 3, canonical: 2 },
  });
});
