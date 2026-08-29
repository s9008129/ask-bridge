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
  const resolverSource = readFileSync(
    join(repoRoot, 'src', 'chatgpt_control_bundle_resolver.js'),
    'utf8',
  );
  assert.match(source, /data-model-reasoning-effort-slider/);
  assert.match(source, /press_provider_key\(&config_path, "ArrowLeft"\)/);
  assert.match(source, /press_provider_key\(&config_path, "ArrowRight"\)/);
  assert.match(source, /include_str!\("chatgpt_control_bundle_resolver\.js"\)/);
  assert.match(source, /model radio selection was not verified/);
  assert.match(resolverSource, /semantic_effort/);
  assert.match(resolverSource, /ordinal_conflict/);

  const fixture = `<!doctype html>
    <main>
      <button class="__composer-pill" type="button">GPT-5.6 Sol</button>
      <div id="menu" role="menu" hidden>
        <div role="menuitemradio" aria-checked="true">GPT-5.6 Sol</div>
        <div role="menuitem" aria-expanded="false" aria-label="推理強度">
          推理強度
          <div
            data-model-reasoning-effort-slider
            aria-valuemin="0"
            aria-valuemax="2"
            aria-valuenow="0"
            aria-describedby="reasoning-announcement"
            tabindex="0"
          ></div>
          <div id="reasoning-announcement"></div>
        </div>
      </div>
      <div id="global-live" role="status">高</div>
      <pre id="result"></pre>
    </main>
    <script>
      const resolveReasoningControlBundle = ${resolverSource};
      const menu = document.querySelector('#menu');
      const slider = document.querySelector('[data-model-reasoning-effort-slider]');
      const labels = ['', '', ''];
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
          document.querySelector('#reasoning-announcement').textContent = labels[next];
        }
      });
      const readState = () => resolveReasoningControlBundle('即時');
      const press = (key) => {
        slider.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      };
      const efforts = ['instant', 'medium', 'high'];
      const ranks = { instant: 0, medium: 1, high: 2 };
      const calibrate = (initialAnnouncement) => {
        slider.setAttribute('aria-valuenow', '0');
        document.querySelector('#reasoning-announcement').textContent = initialAnnouncement;
        slider.focus();
        const observations = [readState()];
        while (observations.at(-1).now < 2) {
          const previous = observations.at(-1);
          press('ArrowRight');
          const next = readState();
          if (next.now !== previous.now + 1) return { accepted: false, observations };
          observations.push(next);
        }
        const direct = observations.filter((state) => state.semantic_effort !== null);
        for (const state of direct) {
          if (ranks[state.semantic_effort] !== state.now) {
            return { accepted: false, observations, rankConflict: true };
          }
        }
        const directCount = direct.length;
        return { accepted: true, observations, directCount };
      };
      const calibration = calibrate('');
      let targetIndex = null;
      let selected = false;
      let stable = null;
      let reopened = null;
      let directCount = null;
      if (calibration.accepted) {
        targetIndex = ranks['instant'];
        directCount = calibration.directCount;
        let state = readState();
        while (state.now > targetIndex) {
          const previous = state;
          press('ArrowLeft');
          state = readState();
          if (state.now !== previous.now - 1) break;
        }
        stable = readState();
        menu.hidden = true;
        document.querySelector('.__composer-pill').click();
        reopened = readState();
        selected = stable.now === targetIndex && reopened.now === targetIndex &&
          stable.ordinal_conflict === false && reopened.ordinal_conflict === false;
      }
      const contradictoryCalibration = calibrate('高，第 1 項，共 3 項');
      slider.setAttribute('aria-valuenow', '0');
      document.querySelector('#reasoning-announcement').textContent = '第 2 項，共 3 項';
      const ordinalConflictState = readState();
      const initialState = calibration.observations[0];
      document.querySelector('#result').textContent = JSON.stringify({
        selectedLabel: selected ? '即時' : null,
        selectionEvidence: selected ? 'ordered_bounded_effort_v1' : null,
        directSemanticCount: selected ? directCount : null,
        targetIndex: selected ? targetIndex : null,
        roleEvidence: initialState.role_evidence,
        semanticMissingAtTarget: initialState.semantic_effort === null,
        globalLiveIgnored: initialState.announcement_present === false,
        contradictoryLabelRejected: contradictoryCalibration.accepted === false,
        rankConflictRejected: contradictoryCalibration.rankConflict === true,
        ordinalConflictRejected: ordinalConflictState.ordinal_conflict === true,
        promptStarted: false,
        sliderPresent: Boolean(document.querySelector('[data-model-reasoning-effort-slider]')),
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
    selectedLabel: '即時',
    selectionEvidence: 'ordered_bounded_effort_v1',
    directSemanticCount: 0,
    targetIndex: 0,
    roleEvidence: 'missing',
    semanticMissingAtTarget: true,
    globalLiveIgnored: true,
    contradictoryLabelRejected: true,
    rankConflictRejected: true,
    ordinalConflictRejected: true,
    promptStarted: false,
    sliderPresent: true,
  });
});

test('ChatGPT reasoning control bundle resolves a roleless marker with a nested native range', { skip: !chrome }, () => {
  const source = readFileSync(join(repoRoot, 'src', 'main.rs'), 'utf8');
  const resolverSource = readFileSync(
    join(repoRoot, 'src', 'chatgpt_control_bundle_resolver.js'),
    'utf8',
  );
  assert.match(source, /state_owner_relation/);
  assert.match(source, /focus_owner_relation/);
  assert.match(source, /role_evidence/);

  const fixture = `<!doctype html>
    <main>
      <div role="group" aria-label="推理強度">
        <div
          data-model-reasoning-effort-slider
          aria-describedby="reasoning-announcement"
        >
          <input
            type="range"
            min="0"
            max="2"
            value="0"
            aria-valuemin="0"
            aria-valuemax="2"
            aria-valuenow="0"
            tabindex="0"
          >
        </div>
        <div id="reasoning-announcement" role="status">第 1 項，共 3 項</div>
      </div>
      <pre id="result"></pre>
    </main>
    <script>
      const resolveReasoningControlBundle = ${resolverSource};
      document.querySelector('#result').textContent = JSON.stringify(
        resolveReasoningControlBundle('即時'),
      );
    </script>`;
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(fixture)}`;
  const rendered = execFileSync(
    chrome,
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--dump-dom', url],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 },
  );
  const encoded = rendered.match(/<pre id="result">([^<]*)<\/pre>/)?.[1];
  assert.ok(encoded, 'headless nested reasoning fixture did not return a result');
  assert.deepEqual(JSON.parse(encoded), {
    found: true,
    marker_present: true,
    marker_count: 1,
    state_owner_relation: 'descendant',
    focus_owner_relation: 'state_owner',
    role_evidence: 'native_range',
    role_slider: false,
    min: 0,
    max: 2,
    now: 0,
    matched: false,
    announcement_present: true,
    ordinal_present: true,
    ordinal_current: 1,
    ordinal_total: 3,
    ordinal_consistent: true,
    ordinal_conflict: false,
    semantic_effort: null,
    semantic_conflict: false,
    focused: true,
  });
});
