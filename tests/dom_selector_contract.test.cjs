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
          <div id="reasoning-announcement">第 1 項，共 3 項</div>
        </div>
      </div>
      <pre id="result"></pre>
    </main>
    <script>
      const menu = document.querySelector('#menu');
      const slider = document.querySelector('[data-model-reasoning-effort-slider]');
      const labels = ['', '中', '高'];
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
            (labels[next] ? labels[next] + '，' : '') + '第 ' + (next + 1) + ' 項，共 3 項';
        }
      });
      const norm = (value) => (value || '').toLowerCase().replace(/[\\s.\\-_]/g, '');
      const target = norm('即時');
      const targetFoundByLegacySelector = Array.from(
          document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'),
        )
          .filter((item) => item.getAttribute('aria-haspopup') !== 'menu')
          .some((item) => norm(item.innerText) === target);
      const canonicalEffort = (value) => {
        const normalized = norm(value);
        if (['即時', 'instant', 'fast', 'light', 'low'].includes(normalized)) return 'instant';
        if (['中', '中等', 'medium', 'standard', 'thinking'].includes(normalized)) return 'medium';
        if (['高', '高推理', 'high', 'heavy', 'extended'].includes(normalized)) return 'high';
        return null;
      };
      const readState = () => {
        const announcement = document.querySelector('#reasoning-announcement').textContent || '';
        const ordinal = announcement.match(/第\\s*(\\d+)\\s*項\\s*[，,]?\\s*共\\s*(\\d+)\\s*項/);
        const semantic = announcement.replace(/第\\s*\\d+\\s*項\\s*[，,]?\\s*共\\s*\\d+\\s*項/, '')
          .replace(/[，,]/g, '').trim();
        const now = Number(slider.getAttribute('aria-valuenow'));
        const current = ordinal ? Number(ordinal[1]) : null;
        const total = ordinal ? Number(ordinal[2]) : null;
        const actualEffort = semantic ? canonicalEffort(semantic) : null;
        const expectedEffort = ['instant', 'medium', 'high'][now] || null;
        return {
          now,
          current,
          total,
          semanticEffort: actualEffort,
          semanticContradiction: Boolean(semantic) && actualEffort !== expectedEffort,
          strictProfile: slider.hasAttribute('data-model-reasoning-effort-slider') &&
            slider.getAttribute('role') === 'slider' &&
            slider.getAttribute('aria-valuemin') === '0' &&
            slider.getAttribute('aria-valuemax') === '2' &&
            Number.isInteger(now) && current === now + 1 && total === 3,
        };
      };
      const selectSlider = (targetLabel) => {
        slider.focus();
        let state = readState();
        if (!state.strictProfile || state.semanticContradiction) return false;
        while (state.now > 0) {
          const previous = state;
          slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
          state = readState();
          if (!state.strictProfile || state.semanticContradiction ||
              state.now !== previous.now - 1 || state.current !== previous.current - 1) {
            return false;
          }
        }
        const targetIndex = canonicalEffort(targetLabel) === 'instant' ? 0 :
          canonicalEffort(targetLabel) === 'medium' ? 1 :
          canonicalEffort(targetLabel) === 'high' ? 2 : null;
        if (targetIndex === null) return false;
        while (state.now < targetIndex) {
          const previous = state;
          slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
          state = readState();
          if (!state.strictProfile || state.semanticContradiction ||
              state.now !== previous.now + 1 || state.current !== previous.current + 1) {
            return false;
          }
        }
        const stable = readState();
        if (!stable.strictProfile || stable.semanticContradiction ||
            stable.now !== state.now || stable.current !== state.current ||
            stable.total !== state.total) return false;
        menu.hidden = true;
        document.querySelector('.__composer-pill').click();
        const reopened = readState();
        return reopened.strictProfile && !reopened.semanticContradiction &&
          reopened.now === targetIndex && reopened.current === targetIndex + 1;
      };
      const selected = selectSlider('即時');
      document.querySelector('#reasoning-announcement').textContent = '高，第 1 項，共 3 項';
      const contradictoryLabelRejected = !selectSlider('即時');
      document.querySelector('#result').textContent = JSON.stringify({
        targetFoundByLegacySelector,
        selectedLabel: selected ? '即時' : null,
        selectionEvidence: selected ? 'bounded_ordinal_v1' : null,
        contradictoryLabelRejected,
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
    selectionEvidence: 'bounded_ordinal_v1',
    contradictoryLabelRejected: true,
    promptStarted: false,
    sliderPresent: true,
  });
});
