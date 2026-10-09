import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBrowserEndingLabels, runBrowserBattleInput, runBrowserEnd } from './browser-battle-input.mjs';

// These fixtures prove classification and refusal boundaries only. They never
// drive a browser, send guest input or provide a successful ending/game verdict.
const label = (text, properties = {}) => ({ text, visible: true, enabled: true, ...properties });

test('outcome labels keep defeat and victory separate in both languages', () => {
  for (const text of ['GUI:Defeat', 'You Lose!', 'MissionFailed', '战败', '任務失敗']) {
    const result = readBrowserEndingLabels({ controls: [label(text)] });
    assert.equal(result.labelledOutcome, 'defeat');
    assert.equal(result.victory.length, 0);
  }
  for (const text of ['GUI:Victory', 'You Win!', 'Mission Accomplished', '胜利', '任務完成']) {
    const result = readBrowserEndingLabels({ controls: [label(text)] });
    assert.equal(result.labelledOutcome, 'victory');
    assert.equal(result.defeat.length, 0);
  }
});

test('score/Continue, unrelated text, hidden labels and contradictory labels remain unidentified', () => {
  for (const controls of [
    [label('GUI:SkirmishScore'), label('GUI:Continue')],
    [label('Victory Road'), label('Defeat enemy units')],
    [label('Victory', { visible: false }), label('Defeat', { enabled: false })],
    [label('Victory'), label('Defeat')],
  ])
    assert.equal(readBrowserEndingLabels({ controls }).labelledOutcome, null);
});

function rejectingApi(ownerIdle, inputState) {
  const calls = { actions: [], observations: [], releases: [] };
  const unexpected = (name) => async () => {
    calls.actions.push(name);
    throw new Error('Unexpected fixture action: ' + name);
  };
  const observation = (name) => async () => {
    calls.observations.push(name);
    throw new Error('Unexpected fixture observation: ' + name);
  };
  const release = (name) => async () => calls.releases.push(name);
  return {
    calls,
    api: {
      ownerIdle,
      inputState:
        inputState ??
        (async () => {
          calls.observations.push('inputState');
          throw new Error('Unexpected fixture input-state read');
        }),
      commandState: observation('commandState'),
      readBytes: observation('readBytes'),
      point: observation('point'),
      shot: observation('shot'),
      click: unexpected('click'),
      page: {
        evaluate: observation('page.evaluate'),
        locator: () => {
          throw new Error('Unexpected fixture locator');
        },
        mouse: {
          move: unexpected('mouse.move'),
          down: unexpected('mouse.down'),
          dblclick: unexpected('mouse.dblclick'),
          up: release('mouse.up'),
        },
        keyboard: {
          down: unexpected('keyboard.down'),
          press: unexpected('keyboard.press'),
          up: release('keyboard.up'),
        },
      },
    },
  };
}

for (const run of [runBrowserBattleInput, runBrowserEnd]) {
  for (const reason of ['Owned acceptance cancelled', 'Bounded task deadline reached']) {
    test(`${run.name} refuses all observations and presses when ${reason}`, async () => {
      const fixture = rejectingApi(async () => {
        throw new Error(reason);
      });
      const result = await run(fixture.api);
      assert.equal(result.met, false);
      assert.match(result.error, new RegExp(reason));
      assert.deepEqual(fixture.calls.actions, []);
      assert.deepEqual(fixture.calls.observations, []);
      // Key/button releases intentionally bypass a closed guard.
      assert.equal(fixture.calls.releases.length > 0, run === runBrowserBattleInput);
    });
  }

  test(`${run.name} rejects cancellation arriving during an asynchronous observation`, async () => {
    let cancelled = false;
    let resolveRead;
    let notifyRead;
    const startedRead = new Promise((resolve) => (notifyRead = resolve));
    const pendingRead = new Promise((resolve) => (resolveRead = resolve));
    const fixture = rejectingApi(
      async () => {
        if (cancelled) throw new Error('Owned acceptance cancelled');
      },
      async () => {
        fixture.calls.observations.push('inputState');
        notifyRead();
        return pendingRead;
      },
    );
    const pendingRun = run(fixture.api);
    await startedRead;
    cancelled = true;
    resolveRead({ modal: false, controls: [] });
    const result = await pendingRun;
    assert.equal(result.met, false);
    assert.match(result.error, /Owned acceptance cancelled/);
    assert.deepEqual(fixture.calls.actions, []);
    assert.deepEqual(fixture.calls.observations, ['inputState']);
  });
}

test('battle polling refuses a hold arriving between polling iterations', async () => {
  let held = false;
  const fixture = rejectingApi(
    async () => {
      if (held) throw new Error('Owner hold observed');
    },
    async () => ({ modal: false, controls: [] }),
  );
  delete fixture.api.shot;
  fixture.api.readBytes = async () => {
    const value = Buffer.alloc(8);
    value.writeDoubleLE(0.5);
    return value;
  };
  fixture.api.commandState = async () => {
    fixture.calls.observations.push('commandState');
    setTimeout(() => (held = true), 10);
    return null;
  };
  const result = await runBrowserBattleInput(fixture.api);
  assert.equal(result.met, false);
  assert.match(result.error, /Owner hold observed/);
  assert.deepEqual(fixture.calls.actions, []);
  assert.deepEqual(fixture.calls.observations, ['commandState']);
});

test('score polling refuses a deadline arriving between polling iterations', async () => {
  let expired = false;
  let inputReads = 0;
  const fixture = rejectingApi(
    async () => {
      if (expired) throw new Error('Bounded task deadline reached');
    },
    async () => {
      inputReads++;
      if (inputReads === 2) setTimeout(() => (expired = true), 10);
      // An unrelated modal must never be continued as a known ending.
      return { modal: true, controls: [] };
    },
  );
  delete fixture.api.shot;
  fixture.api.commandState = async () => null;
  fixture.api.readBytes = async () => Buffer.alloc(4);
  fixture.api.page.evaluate = async () => ({ shown: false });
  const result = await runBrowserEnd(fixture.api);
  assert.equal(result.met, false);
  assert.match(result.error, /Bounded task deadline reached/);
  assert.deepEqual(fixture.calls.actions, []);
  assert.equal(inputReads, 2);
});
