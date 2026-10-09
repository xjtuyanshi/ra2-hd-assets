import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Read-only ending checkpoints for the pinned YR 1.001 image. Inputs remain
// owned by the normal browser harness; no outcome, resource or clock is changed.
export async function capturePhase11EndingCheckpoint({
  page,
  worker,
  inputState,
  shot,
  record = async () => {},
  ownerIdle = async () => {},
  out,
  label,
  expectedScreen,
  compareWith,
}) {
  assert(/^[a-zA-Z0-9_-]+$/.test(label));
  assert(['battle', 'main', 'setup', 'score', 'defeat', 'victory'].includes(expectedScreen));
  if (compareWith !== undefined) assert(/^[a-zA-Z0-9_-]+$/.test(compareWith));
  await mkdir(out, { recursive: true });
  const activeWorker = () => (typeof worker === 'function' ? worker() : worker);
  const observed = async () => {
    await ownerIdle();
    return activeWorker().evaluate(async () => {
      const core = globalThis.__auditCore;
      if (!core?.connection || !core.hello) throw new Error('Actual NativeCore observer is required');
      const errors = [];
      const bytes = async (address, length) => (await core.connection.read(address, length)).bytes;
      const view = (value) => new DataView(value.buffer, value.byteOffset, value.byteLength);
      let logicFrame = null;
      let localOutcome = null;
      let command = null;
      try {
        logicFrame = view(await bytes(0xa8ed84, 4)).getUint32(0, true);
      } catch (error) {
        errors.push({ observation: 'original logic counter', error: String(error) });
      }
      try {
        const pointer = view(await bytes(0xa83d4c, 4)).getUint32(0, true);
        if (pointer < 0x10000 || pointer % 4 || pointer > 0xfffffe00)
          localOutcome = { known: false, reason: 'Original local HouseClass pointer is unavailable', pointer };
        else {
          const index = view(await bytes(pointer + 0x30, 4)).getInt32(0, true);
          const flag = (await bytes(pointer + 0x1f5, 1))[0];
          localOutcome = {
            known: index >= 0 && index < 32 && (flag === 0 || flag === 1),
            housePointer: pointer,
            index,
            originalDefeatedByte: flag,
            defeated: flag === 1,
          };
        }
      } catch (error) {
        errors.push({ observation: 'original local HouseClass::Defeated', error: String(error) });
      }
      try {
        const value = await core.getCommandState();
        command = value
          ? {
              frame: value.frame,
              localHouse: value.localHouse,
              view: value.view,
              ownedLivingObjects: value.objects
                .filter((object) => object.owner === value.localHouse && object.health > 0)
                .map((object) => ({ uid: object.uid, type: object.type, kind: object.kind, health: object.health })),
            }
          : null;
      } catch (error) {
        errors.push({ observation: 'genuine command state', error: String(error) });
      }
      return {
        at: performance.timeOrigin + performance.now(),
        workerTimeOrigin: performance.timeOrigin,
        pid: core.hello.pid,
        exe: core.hello.exe,
        picture: core.connection.pictureDecoder.previous
          ? {
              width: core.connection.pictureDecoder.previous.width,
              height: core.connection.pictureDecoder.previous.height,
              frame: core.connection.pictureDecoder.previous.frame,
            }
          : null,
        logicFrame,
        localOutcome,
        command,
        errors,
      };
    });
  };
  const first = await observed();
  // Two real observations distinguish advancing game logic from a stale battle
  // cache. This interval is sampling cadence, not a new acceptance threshold.
  await delay(250);
  await ownerIdle();
  const screenshot = await shot(`ending-${label}`);
  const nativeInput = await inputState();
  const last = await observed();
  const browser = await page.evaluate(() => ({
    timeOrigin: performance.timeOrigin,
    visibility: document.visibilityState,
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
  }));
  const usable = (control) => control.visible && control.enabled;
  const controls = nativeInput.controls?.filter(usable) ?? [];
  const hasId = (id) => controls.some((control) => control.id === id);
  const scoreLabels = controls.filter((control) =>
    /(?:skirmish|multiplayer)?score|statistic|results?|成绩|統計|统计|战绩|戰績|计分|計分/i.test(control.text),
  );
  const continueLabels = controls.filter((control) =>
    /^(?:GUI:)?Continue$|继续|繼續|返回主菜单|return.*menu/i.test(control.text),
  );
  const defeatLabels = controls.filter((control) =>
    /^(?:GUI:)?(?:Defeat|You Lose|Mission Failed|战败|戰敗|败北|敗北|任务失败|任務失敗)[.!]?$/i.test(control.text),
  );
  const victoryLabels = controls.filter((control) =>
    /^(?:GUI:)?(?:Victory|You Win|Mission Accomplished|胜利|勝利|任务完成|任務完成)[.!]?$/i.test(control.text),
  );
  const logicAdvancing =
    Number.isInteger(first.logicFrame) && Number.isInteger(last.logicFrame) && last.logicFrame > first.logicFrame;
  const battleKnown =
    nativeInput.modal === false &&
    !!last.command?.view &&
    last.command.localHouse >= 0 &&
    last.command.ownedLivingObjects.length > 0 &&
    logicAdvancing;
  const localOutcomeMatches = last.localOutcome?.known === true && last.localOutcome.index === last.command?.localHouse;
  const observations = {
    battle: battleKnown,
    main: hasId(1667),
    setup: hasId(1559),
    score: scoreLabels.length > 0 && continueLabels.length > 0,
    defeat:
      nativeInput.modal === true &&
      (defeatLabels.length > 0 ||
        (scoreLabels.length > 0 &&
          continueLabels.length > 0 &&
          localOutcomeMatches &&
          last.localOutcome.defeated === true)),
    victory:
      nativeInput.modal === true &&
      victoryLabels.length > 0 &&
      localOutcomeMatches &&
      last.localOutcome.defeated === false,
  };
  let comparison = null;
  if (compareWith !== undefined) {
    const baselinePath = join(out, `ending-${compareWith}.json`);
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    comparison = {
      baselineFile: `ending-${compareWith}.json`,
      sameNativePid: baseline.last.pid === last.pid,
      sameExecutableHash: baseline.last.exe.sha256 === last.exe.sha256,
      sameBrowserDocument: baseline.browser.timeOrigin === browser.timeOrigin,
      sameWorker: baseline.last.workerTimeOrigin === last.workerTimeOrigin,
      baselineLogicFrame: baseline.last.logicFrame,
      currentLogicFrame: last.logicFrame,
      baselineExpectedScreen: baseline.expectedScreen,
      baselineScreenObserved: baseline.expectedScreenObserved,
    };
    comparison.sameLauncherAndPage =
      comparison.sameNativePid &&
      comparison.sameExecutableHash &&
      comparison.sameBrowserDocument &&
      comparison.sameWorker;
  }
  const proof = {
    label,
    expectedScreen,
    expectedScreenObserved: observations[expectedScreen],
    source:
      'Genuine native read-only counters/HouseClass fields, ordinary input controls and actual browser screenshot',
    first,
    last,
    browser,
    nativeModal: nativeInput.modal,
    controls,
    logicAdvancing,
    localOutcomeMatches,
    outcomeMetadata: {
      authenticLocalDefeated: localOutcomeMatches ? last.localOutcome.defeated : null,
      establishesCorrectEndingScreen: false,
      interpretation:
        'The original house flag is outcome metadata only; the actual ending screen needs controls and screenshot review.',
    },
    observations,
    scoreLabels,
    continueLabels,
    defeatLabels,
    victoryLabels,
    comparison,
    screenshot,
    visualReviewRequired: true,
    interpretation:
      'This is evidence, not an automatic A6 pass. Review the screenshot for the actual ending and painted names/heads. A score table or surviving local house alone never proves victory. The second match additionally requires the recorded first-ending/menu/start input sequence; a changed frame number alone is insufficient.',
  };
  const file = `ending-${label}.json`;
  await writeFile(join(out, file), JSON.stringify(proof, null, 2));
  await record('ending-checkpoint', {
    label,
    file,
    expectedScreen,
    expectedScreenObserved: proof.expectedScreenObserved,
    logicAdvancing,
    nativePid: last.pid,
    comparison,
    screenshot,
    visualReviewRequired: true,
  });
  return proof;
}
