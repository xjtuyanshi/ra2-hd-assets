import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const AI_CONTROL_IDS = Object.freeze([1291, 1294, 1302, 1306, 1307]);
const PRESETS = Object.freeze({ easy: 1, medium: 2, hard: 3 });
const LIMIT_MS = 60000;
const REVIEW_LIMIT_MS = 180000;
const REVIEW_REQUEST_MS = 45000;
const REVIEW_ACTIONS = 3;

const usable = (control) =>
  control?.visible &&
  control.enabled &&
  Array.isArray(control.rect) &&
  control.rect.length === 4 &&
  control.rect.every(Number.isFinite) &&
  control.rect[2] > control.rect[0] &&
  control.rect[3] > control.rect[1];

function observe(state) {
  assert(Array.isArray(state?.controls) && !state.controlsTruncated, 'A complete native control list is required');
  const start = state.controls.find((control) => control.id === 1559 && usable(control));
  assert(start, 'The actual enabled Skirmish Setup must be available');
  assert.equal(state.dialogHwnd, start.parentHwnd, 'Skirmish Setup owns the input dialog');
  return AI_CONTROL_IDS.map((id) => {
    const matches = state.controls.filter((control) => control.id === id && usable(control));
    assert.equal(matches.length, 1, `AI control ${id} must be unique and enabled`);
    const control = matches[0];
    assert.equal(control.class, 'ComboBox', 'AI choices must be real native Combos');
    assert.equal(control.parentHwnd, start.parentHwnd, 'AI control must belong to the active setup');
    assert.equal(control.combo?.count, 4, 'The pinned AI Combo must contain four original choices');
    assert(
      Number.isInteger(control.combo.selection) && control.combo.selection >= 1 && control.combo.selection <= 3,
      'Each of the five slots must contain an actual AI; the closed selection is never selected',
    );
    return control;
  });
}

const summary = (controls) =>
  controls.map((control) => ({
    id: control.id,
    hwnd: control.hwnd,
    parentHwnd: control.parentHwnd,
    count: control.combo.count,
    selection: control.combo.selection,
    rect: [...control.rect],
  }));

function validateOriginal(original) {
  assert(Array.isArray(original) && original.length === AI_CONTROL_IDS.length, 'Five original AI choices are required');
  return original.map((player, index) => {
    assert.equal(player.id, AI_CONTROL_IDS[index], 'AI preferences must match the five original AI IDs');
    assert(
      Number.isInteger(player.selection) && player.selection >= 1 && player.selection <= 3,
      'Original AI preferences must retain active AI slots',
    );
    return { id: player.id, selection: player.selection };
  });
}

async function baseline(out, controls, source) {
  assert(typeof out === 'string' && isAbsolute(out), 'Supply the absolute private browser output directory');
  await mkdir(out, { recursive: true });
  const path = join(out, 'ai-preferences.json');
  try {
    await writeFile(
      path,
      JSON.stringify({ source, recordedAt: new Date().toISOString(), players: summary(controls) }, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  // Never follow a swapped baseline symlink or accept an unbounded/private-file mismatch.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    assert(
      stat.isFile() && stat.size <= 16384 && !(stat.mode & 0o077),
      'AI preferences must be a bounded private file',
    );
    const saved = JSON.parse(await file.readFile('utf8'));
    return { path, source: saved.source, original: validateOriginal(saved.players) };
  } finally {
    await file.close();
  }
}

function ownedPopup(state, control) {
  const matches = state.controls?.filter(
    (popup) =>
      usable(popup) &&
      popup.class === 'ComboDropWin' &&
      popup.hwnd === state.gameCaptureHwnd &&
      popup.parentHwnd === control.parentHwnd &&
      popup.rect[0] === control.rect[0] &&
      popup.rect[1] >= control.rect[3] &&
      popup.rect[1] <= control.rect[3] + 4,
  );
  return matches?.length === 1 ? matches[0] : null;
}

function reviewedBounds(control, popup) {
  // The inspected native menu paints a separate scrollbar immediately to the
  // right of the content HWND, bounded by the owning closed Combo's right edge.
  // This fence admits reviewed visible scrollbar points, never a hidden row.
  const right = Math.max(popup.rect[2], control.rect[2]);
  const width = right - popup.rect[2];
  assert(width <= 24, 'UNVERIFIED: the observed popup sidebar exceeds the inspected scrollbar width');
  return {
    compoundPopupBounds: [popup.rect[0], popup.rect[1], right, popup.rect[3]],
    scrollbarBounds: width > 0 ? [popup.rect[2], popup.rect[1], right, popup.rect[3]] : null,
  };
}

async function reviewedPoint(api, request, deadline) {
  const timeoutMs = Math.min(REVIEW_REQUEST_MS, deadline - Date.now());
  assert(timeoutMs > 0, 'UNVERIFIED: the bounded AI popup review expired; no click sent');
  let timer;
  try {
    const point = await Promise.race([
      Promise.resolve().then(() => api.reviewNativePopupRequest({ ...request, timeoutMs })),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('UNVERIFIED: no bounded screenshot-review response; no click sent')),
          timeoutMs,
        );
      }),
    ]);
    assert(
      point && Number.isFinite(point.x) && Number.isFinite(point.y),
      'UNVERIFIED: a reviewed native mouse point is required; no click sent',
    );
    return { x: point.x, y: point.y };
  } finally {
    clearTimeout(timer);
  }
}

async function select(api, wanted, label, deadline) {
  const wait = (name, read) => {
    const remaining = deadline - Date.now();
    assert(remaining > 0, 'The bounded AI settings operation expired');
    return api.wait(name, read, Math.min(8000, remaining));
  };
  const before = observe(await api.inputState()).find((control) => control.id === wanted.id);
  if (before.combo.selection === wanted.selection)
    return { id: wanted.id, changed: false, selection: wanted.selection };
  const reviewed = before.combo.selection === 3 || wanted.selection === 3;
  assert(
    !reviewed || typeof api.reviewNativePopupRequest === 'function',
    'UNVERIFIED: Hard or initially Hard AI navigation requires screenshot-reviewed mouse input; no input sent',
  );
  let changed = false;
  try {
    await api.click(
      before.rect[2] - Math.min(11, (before.rect[2] - before.rect[0]) / 2),
      (before.rect[1] + before.rect[3]) / 2,
      'quick',
      'left',
      80,
    );
    const popup = await wait(`owned AI ${wanted.id} popup`, async () => {
      const state = await api.inputState();
      const current = observe(state).find((control) => control.id === wanted.id);
      assert.equal(current.hwnd, before.hwnd, 'The original AI control must remain alive');
      return ownedPopup(state, current);
    });
    const screenshot = await api.shot(`${label}-${wanted.id}-popup`);
    const popupState = await api.inputState();
    await api.record('ai-popup-observed', {
      id: wanted.id,
      before: summary([before])[0],
      popup,
      screenshot,
      input: {
        dialogHwnd: popupState.dialogHwnd,
        gameCaptureHwnd: popupState.gameCaptureHwnd,
        lastTargetHwnd: popupState.lastTargetHwnd,
        lastTargetId: popupState.lastTargetId,
      },
      actualTeams: popupState.controls
        .filter((control) => control.id >= 1901 && control.id <= 1906)
        .map((control) => ({ id: control.id, selection: control.combo?.selection ?? null })),
    });
    assert.equal(ownedPopup(popupState, before)?.hwnd, popup.hwnd, 'The observed AI popup must retain capture');
    let after;
    const reviewSteps = [];
    if (reviewed) {
      // The custom popup exposes no readable topIndex, and actual closed-Combo
      // arrow input did not change its selection. A reviewer must inspect each
      // current native picture; no scrollbar or hidden row coordinate is inferred.
      for (let action = 1; action <= REVIEW_ACTIONS; action++) {
        const ready = await api.inputState();
        const current = observe(ready).find((control) => control.id === wanted.id);
        assert.equal(current.hwnd, before.hwnd, 'The original AI Combo must remain alive');
        assert.equal(current.parentHwnd, before.parentHwnd, 'The original setup must retain the reviewed AI Combo');
        assert.deepEqual(current.rect, before.rect, 'The reviewed AI Combo bounds must remain unchanged');
        const currentPopup = ownedPopup(ready, current);
        assert.equal(currentPopup?.hwnd, popup.hwnd, 'The original reviewed popup must retain capture');
        const bounds = reviewedBounds(current, currentPopup);
        const request = {
          phase: 'scroll-or-select',
          label,
          action,
          maximumActions: REVIEW_ACTIONS,
          id: wanted.id,
          targetChoice: wanted.selection,
          before: summary([before])[0],
          control: summary([current])[0],
          popup: { ...currentPopup, rect: [...currentPopup.rect] },
          ...bounds,
          screenshot: await api.shot(`${label}-${wanted.id}-review-${action}-before`),
          canvas: await api.page.evaluate(() => {
            const canvas = document.querySelector('#screen');
            if (!canvas) return null;
            const rect = canvas.getBoundingClientRect();
            return {
              width: canvas.width,
              height: canvas.height,
              boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            };
          }),
          input: {
            dialogHwnd: ready.dialogHwnd,
            focusHwnd: ready.focusHwnd,
            gameCaptureHwnd: ready.gameCaptureHwnd,
            acceptedInputs: ready.acceptedInputs,
          },
        };
        await api.record('ai-popup-review-request', request);
        const point = await reviewedPoint(api, request, deadline);
        const revalidated = await api.inputState();
        const owner = observe(revalidated).find((control) => control.id === wanted.id);
        assert.equal(owner.hwnd, before.hwnd, 'The reviewed original AI Combo must remain alive');
        assert.equal(owner.parentHwnd, before.parentHwnd, 'The reviewed original setup must remain alive');
        assert.deepEqual(owner.rect, current.rect, 'The reviewed AI Combo bounds must stay unchanged');
        assert.equal(owner.combo.selection, current.combo.selection, 'The AI choice must not change during review');
        const revalidatedPopup = ownedPopup(revalidated, owner);
        assert.equal(revalidatedPopup?.hwnd, currentPopup.hwnd, 'The reviewed popup must still own capture');
        assert.deepEqual(revalidatedPopup.rect, currentPopup.rect, 'The reviewed popup bounds must stay unchanged');
        assert.deepEqual(
          reviewedBounds(owner, revalidatedPopup),
          bounds,
          'The reviewed compound bounds must stay unchanged',
        );
        const [left, top, right, bottom] = bounds.compoundPopupBounds;
        assert(
          point.x > left && point.x < right && point.y > top && point.y < bottom,
          'UNVERIFIED: reviewed native mouse point is outside the owned popup and inspected scrollbar fence; no click sent',
        );
        await api.click(point.x, point.y, 'no-move', 'left', 80);
        const actual = await wait(`AI ${wanted.id} actual reviewed mouse result`, async () => {
          const state = await api.inputState();
          const control = observe(state).find((control) => control.id === wanted.id);
          assert.equal(control.hwnd, before.hwnd, 'The original AI Combo must remain alive after reviewed input');
          const nextPopup = ownedPopup(state, control);
          if (nextPopup) assert.equal(nextPopup.hwnd, popup.hwnd, 'The same reviewed popup must retain capture');
          return { state, control, popup: nextPopup };
        });
        const step = {
          action,
          point,
          holdMs: 80,
          beforeSelection: current.combo.selection,
          after: summary([actual.control])[0],
          popup: actual.popup,
          focusHwnd: actual.state.focusHwnd,
          gameCaptureHwnd: actual.state.gameCaptureHwnd,
          lastTargetHwnd: actual.state.lastTargetHwnd,
          lastTargetId: actual.state.lastTargetId,
          acceptedInputsBefore: revalidated.acceptedInputs,
          acceptedInputsAfter: actual.state.acceptedInputs,
          screenshot: await api.shot(`${label}-${wanted.id}-review-${action}-after`),
        };
        reviewSteps.push(step);
        await api.record('ai-real-reviewed-mouse', { id: wanted.id, ...step });
        if (!actual.popup) {
          assert.equal(actual.control.combo.selection, wanted.selection, 'UNVERIFIED: the actual AI choice is wrong');
          after = actual.control;
          break;
        }
      }
      assert(after, 'UNVERIFIED: three reviewed mouse actions did not establish the requested closed AI choice');
    } else {
      // Actual native pictures show three visible 23-pixel rows and a scrollbar,
      // despite the Combo containing four choices. Item count is not viewport height.
      // A change from Easy/Medium opens at the inspected unscrolled position.
      const y = popup.rect[1] + 11 + wanted.selection * 23;
      const x = popup.rect[0] + (popup.rect[2] - popup.rect[0] - 20) / 2;
      assert(
        y - 10 > popup.rect[1] && y + 10 < popup.rect[3] && x > popup.rect[0] + 2 && x < popup.rect[2] - 20,
        'UNVERIFIED: requested AI row is outside the actual visible content; no hidden-row click sent',
      );
      await api.click(x, y, 'no-move', 'left', 80);
      after = await wait(`AI ${wanted.id} actual selection`, async () => {
        const state = await api.inputState();
        const current = observe(state).find((control) => control.id === wanted.id);
        return current.combo.selection === wanted.selection && !ownedPopup(state, current) ? current : null;
      });
    }
    changed = true;
    const proof = {
      id: wanted.id,
      desired: wanted.selection,
      before: summary([before])[0],
      after: summary([after])[0],
      input: reviewed
        ? 'trusted screenshot-reviewed popup mouse points with actual native selection'
        : 'trusted visible popup-row mouse click',
      reviewSteps,
    };
    await api.record(label, proof);
    return { ...proof, changed };
  } catch (error) {
    let popupDismissed = null;
    try {
      const state = await api.inputState();
      const current = observe(state).find((control) => control.id === wanted.id);
      const popup = ownedPopup(state, current);
      if (popup) {
        // The native popup capture consumes an outside click; it cannot activate an exposed sibling.
        await api.click(popup.rect[0] - 4, popup.rect[1] + 11, 'no-move', 'left', 80);
        popupDismissed = !!(await wait(`AI ${wanted.id} popup dismissed`, async () => {
          const next = await api.inputState();
          const owner = observe(next).find((control) => control.id === wanted.id);
          return !ownedPopup(next, owner);
        }));
      }
    } catch {
      popupDismissed = false;
    }
    // Reporting a cleanup problem must not replace the original input failure.
    await api
      .record('ai-selection-error', {
        id: wanted.id,
        desired: wanted.selection,
        popupDismissed,
        error: String(error),
      })
      .catch(() => {});
    throw error;
  }
}

async function apply(api, wanted, label) {
  const choices = validateOriginal(wanted);
  assert(
    api.reviewNativePopupRequest === undefined || typeof api.reviewNativePopupRequest === 'function',
    'The optional native popup review callback must be callable',
  );
  const current = observe(await api.inputState());
  const needsReview = choices.some(
    (choice) =>
      current.find((control) => control.id === choice.id)?.combo.selection !== choice.selection &&
      (choice.selection === 3 || current.find((control) => control.id === choice.id)?.combo.selection === 3),
  );
  const deadline = Date.now() + (needsReview && api.reviewNativePopupRequest ? REVIEW_LIMIT_MS : LIMIT_MS);
  const steps = [];
  for (const choice of choices) steps.push(await select(api, choice, label, deadline));
  const actual = summary(observe(await api.inputState()));
  assert(choices.every((choice) => actual.find((control) => control.id === choice.id)?.selection === choice.selection));
  const proof = { met: true, desired: choices, actual, steps, screenshot: await api.shot(label) };
  await api.record(label, proof);
  return proof;
}

/** Configure only the five existing AI menu slots; the caller owns final restoration before leaving setup. */
export async function applyBrowserAiSettings(
  api,
  { out, preset = 'original', source = 'browser-acceptance', onBaseline },
) {
  assert(preset === 'original' || Object.hasOwn(PRESETS, preset), 'Unknown original/easy/medium/hard AI preset');
  assert(
    onBaseline === undefined || typeof onBaseline === 'function',
    'The optional baseline callback must be callable',
  );
  const controls = observe(await api.inputState());
  const saved = await baseline(out, controls, source);
  await api.record('ai-preferences-baseline', { ...saved, observed: summary(controls) });
  // The caller captures this before the first mutation so its finally path also owns partial failures.
  await onBaseline?.(saved.original.map((player) => ({ ...player })));
  const wanted = saved.original.map((player) => ({
    id: player.id,
    selection: preset === 'original' ? player.selection : PRESETS[preset],
  }));
  const result = await apply(api, wanted, 'ai-match-settings');
  return { ...result, preset, original: saved.original };
}

/** Call from the caller's setup-menu finally path, before its real Back/Main Menu input. */
export async function restoreBrowserAiSettings(api, original) {
  return apply(api, validateOriginal(original), 'ai-original-settings-restored');
}
