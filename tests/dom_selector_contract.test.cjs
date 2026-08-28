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

test('ChatGPT reasoning slider is selectable before prompt submission', { skip: !chrome }, () => {
  const source = readFileSync(join(repoRoot, 'src', 'main.rs'), 'utf8');
  assert.match(source, /data-model-reasoning-effort-slider/);
  assert.match(source, /press_provider_key\(&config_path, "ArrowLeft"\)/);
  assert.match(source, /press_provider_key\(&config_path, "ArrowRight"\)/);
  assert.match(source, /model radio selection was not verified/);

  const fixture = `<!doctype html>
    <main>
      <button class="__composer-pill" type="button">GPT-5.6 Sol</button>
      <div id="menu" role="menu" hidden>
        <div role="menuitemradio" aria-checked="true">GPT-5.6 Sol</div>
        <div role="menuitem" aria-expanded="false" aria-label="推理強度">
          推理強度
          <div
            data-model-reasoning-effort-slider
            role="slider"
            aria-valuemin="0"
            aria-valuemax="2"
            aria-valuenow="0"
            aria-describedby="reasoning-announcement"
            tabindex="0"
          ></div>
          <div id="reasoning-announcement">即時，第 1 項，共 3 項</div>
        </div>
      </div>
      <pre id="result"></pre>
    </main>
    <script>
      const menu = document.querySelector('#menu');
      const slider = document.querySelector('[data-model-reasoning-effort-slider]');
      const labels = ['即時', '中', '高'];
      document.querySelector('.__composer-pill').addEventListener('click', () => {
        menu.hidden = false;
      });
      document.querySelector('.__composer-pill').click();
      slider.addEventListener('keydown', (event) => {
        const now = Number(slider.getAttribute('aria-valuenow'));
        const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        const next = Math.max(0, Math.min(2, now + delta));
        if (delta !== 0) {
          slider.setAttribute('aria-valuenow', String(next));
          document.querySelector('#reasoning-announcement').textContent =
            labels[next] + '，第 ' + (next + 1) + ' 項，共 3 項';
        }
      });
      const norm = (value) => (value || '').toLowerCase().replace(/[\\s.\\-_]/g, '');
      const target = norm('即時');
      const targetFoundByLegacySelector = Array.from(
          document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'),
        )
          .filter((item) => item.getAttribute('aria-haspopup') !== 'menu')
          .some((item) => norm(item.innerText) === target);
      const selectSlider = (targetLabel) => {
        slider.focus();
        while (Number(slider.getAttribute('aria-valuenow')) > 0) {
          slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        }
        for (;;) {
          const announcement = document.querySelector('#reasoning-announcement').textContent;
          if (norm(announcement.split('，')[0]) === norm(targetLabel)) return true;
          const now = Number(slider.getAttribute('aria-valuenow'));
          if (now >= 2) return false;
          slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        }
      };
      document.querySelector('#result').textContent = JSON.stringify({
        targetFoundByLegacySelector,
        selectedLabel: selectSlider('即時') ? '即時' : null,
        promptStarted: false,
        sliderPresent: Boolean(document.querySelector('[data-model-reasoning-effort-slider][role="slider"]')),
      });
    </script>`;
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(fixture)}`;
  const rendered = execFileSync(
    chrome,
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--dump-dom', url],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 },
  );
  const encoded = rendered.match(/<pre id="result">([^<]*)<\/pre>/)?.[1];
  assert.ok(encoded, 'headless reasoning-slider fixture did not return a result');
  const result = JSON.parse(encoded);
  assert.deepEqual(result, {
    targetFoundByLegacySelector: false,
    selectedLabel: '即時',
    promptStarted: false,
    sliderPresent: true,
  });
});
