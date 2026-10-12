import type { MenuSnapshot } from '../../../vm86/menuSnapshot';
import type { VmShell } from '../../../adapter/vmShell';
import { identifyYrHdMenu, yrMenuText, YR_HD_DIALOG_ART_SIZE } from '../../../games/yr/hdMenus';
import { devicePixelBox } from './devicePixelBox';

interface ButtonArt {
  normal: string;
  hover: string;
  pressed: string;
  disabled: string;
}
interface MenuArt {
  version: number;
  strings: string;
  main: { shell: string; buttons: ButtonArt };
  themes: Record<string, { background: string; backgroundShade?: number; buttons: ButtonArt }>;
}
export interface HdMenus {
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

/** Picture-only overlay: all pointer/key input continues to the original canvas and controls. */
export async function startHdMenus(
  host: {
    screen: HTMLCanvasElement;
    vm: VmShell;
    side(): number | null;
    pageCursorAvailable(): boolean;
    battleActive?(): boolean;
    signal?: AbortSignal;
    pointerPosition?(): Readonly<{ x: number; y: number }> | null;
    frameSize(): { width: number; height: number } | null;
  },
  base = '/hd-cache/_ui/menus',
): Promise<HdMenus | null> {
  if (!host.vm.getMenuSnapshot || !host.pageCursorAvailable()) return null;
  const abort = new AbortController();
  const signal = host.signal ? AbortSignal.any([host.signal, abort.signal]) : abort.signal;
  const response = await fetch(`${base}/menus.json`, { signal });
  if (!response.ok) return null;
  const art = (await response.json()) as MenuArt;
  if (art.version !== 1 || !art.main || !art.themes) return null;
  const validFile = (file: string) => /^[a-zA-Z0-9_@.-]+\.(png|json)$/.test(file) && !file.includes('..');
  const names = [
    art.main.shell,
    ...Object.values(art.main.buttons),
    ...Object.values(art.themes).flatMap((theme) => [theme.background, ...Object.values(theme.buttons)]),
  ];
  if (!validFile(art.strings) || names.some((name) => !validFile(name))) return null;
  const images = new Map<string, ImageBitmap>();
  try {
    await Promise.all(
      [...new Set(names)].map(async (name) => {
        const imageResponse = await fetch(`${base}/${name}`, { signal });
        if (!imageResponse.ok) throw new Error(`Menu art unavailable: ${name}`);
        const bitmap = await createImageBitmap(await imageResponse.blob());
        if (signal.aborted) bitmap.close();
        else images.set(name, bitmap);
      }),
    );
    const stringsResponse = await fetch(`${base}/${art.strings}`, { signal });
    if (!stringsResponse.ok) throw new Error('Menu string table unavailable');
    const sourceStrings = (await stringsResponse.json()) as Record<string, string>;
    const strings = Object.fromEntries(Object.entries(sourceStrings).map(([key, value]) => [key.toLowerCase(), value]));
    const canvas = document.createElement('canvas');
    canvas.id = 'hd-menus';
    canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, { position: 'absolute', pointerEvents: 'none', zIndex: '4', display: 'none' });
    host.screen.parentElement!.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      canvas.remove();
      throw new Error('Menu canvas unavailable');
    }
    let snapshot: MenuSnapshot | null = null;
    let disposed = false;
    let enabled = true;
    let timer: number | undefined;
    let request: number | null = null;
    let inputRevision = 0;
    let localPointer: { x: number; y: number } | null = null;
    let down = false;
    let pressedControl: number | null = null;
    const hide = (reason: string) => {
      canvas.style.display = 'none';
      canvas.dataset.fallback = reason;
      delete canvas.dataset.screen;
    };
    const render = () => {
      request = null;
      if (disposed || !enabled || !snapshot) {
        hide('inactive');
        return;
      }
      if (!host.pageCursorAvailable()) {
        hide('cursor-unavailable');
        return;
      }
      const size = host.frameSize();
      if (!size || size.width !== snapshot.width || size.height !== snapshot.height) {
        hide('picture-size');
        return;
      }
      const screen = identifyYrHdMenu(snapshot);
      if (!screen) {
        hide('unknown-dialog');
        return;
      }
      const controls = snapshot.controls.filter((control) => control.visible && control.hwnd !== snapshot!.dialogHwnd);
      const texts = controls.map((control) => yrMenuText(control, strings));
      if (texts.some((text) => text === null)) {
        hide('unknown-text');
        return;
      }
      const theme = art.themes[String(host.side())];
      if (screen !== 'main' && !theme) {
        hide('unknown-theme');
        return;
      }
      const buttons = screen === 'main' ? art.main.buttons : theme.buttons;
      const box = devicePixelBox(host.screen, size, window.devicePixelRatio || 1);
      Object.assign(canvas.style, box.style);
      if (canvas.width !== box.width) canvas.width = box.width;
      if (canvas.height !== box.height) canvas.height = box.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      ctx.scale(canvas.width / size.width, canvas.height / size.height);
      if (screen === 'main') ctx.drawImage(images.get(art.main.shell)!, 0, 0, 800, 600);
      else {
        ctx.drawImage(images.get(theme.background)!, 0, 0, YR_HD_DIALOG_ART_SIZE.width, YR_HD_DIALOG_ART_SIZE.height);
        const shade = theme.backgroundShade;
        if (typeof shade === 'number' && Number.isFinite(shade) && shade >= 0 && shade <= 1) {
          ctx.fillStyle = `rgba(0,0,0,${shade})`;
          ctx.fillRect(8, 8, 840, 720);
        }
      }
      const pointer =
        (document.pointerLockElement === host.screen ? host.pointerPosition?.() : null) ??
        localPointer ??
        snapshot.pointer;
      controls.forEach((control, index) => {
        const text = texts[index]!;
        const r = control.rect;
        if (control.className === 'Button') {
          const hover = pointer.x >= r.x && pointer.y >= r.y && pointer.x < r.x + r.width && pointer.y < r.y + r.height;
          const state = !control.enabled
            ? 'disabled'
            : control.pressed || (hover && down && pressedControl === control.hwnd)
              ? 'pressed'
              : hover
                ? 'hover'
                : 'normal';
          ctx.save();
          // Optional art may share a plate between states. Preserve the real
          // control state visibly without inventing a new interaction target.
          if (state === 'disabled') ctx.filter = 'saturate(0.2) brightness(0.55)';
          else if (buttons[state] === buttons.normal && state === 'hover') ctx.filter = 'brightness(1.22)';
          ctx.drawImage(images.get(buttons[state])!, r.x, r.y, r.width, r.height);
          if (state === 'pressed' && buttons[state] === buttons.normal) {
            ctx.globalCompositeOperation = 'screen';
            ctx.fillStyle = 'rgba(255,175,0,0.65)';
            ctx.fillRect(r.x + 12, r.y + 10, r.width - 31, r.height - 21);
          }
          ctx.restore();
          if (control.focused) {
            ctx.strokeStyle = '#f1d970';
            ctx.lineWidth = 0.6;
            ctx.strokeRect(r.x + 4, r.y + 4, r.width - 8, r.height - 8);
          }
        } else if (text && screen !== 'main' && control.id !== 65535) {
          // The redrawn background already clears the prompt. Only labels over
          // retained chrome need a backing, inset so metal borders remain intact.
          ctx.fillStyle = '#030404';
          ctx.fillRect(r.x + 10, r.y + 2, r.width - 20, r.height - 4);
        }
        if (!text) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(r.x, r.y, r.width, r.height);
        ctx.clip();
        ctx.fillStyle = control.enabled ? '#ffff38' : '#88816a';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        let fontSize = 16;
        ctx.font = `${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        const measured = ctx.measureText(text).width;
        if (measured > r.width - 8) {
          fontSize *= (r.width - 8) / measured;
          ctx.font = `${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        }
        // The game's quit prompt starts at the top of its static rectangle;
        // button captions remain vertically centered in their original plates.
        const prompt = screen === 'quit' && control.id === 65535;
        if (prompt) ctx.textBaseline = 'alphabetic';
        const y = prompt ? r.y + ctx.measureText(text).actualBoundingBoxAscent : r.y + r.height / 2;
        ctx.fillText(text, r.x + r.width / 2, y + (control.pressed ? 1 : 0));
        ctx.restore();
      });
      canvas.style.display = 'block';
      canvas.dataset.screen = screen;
      delete canvas.dataset.fallback;
    };
    const schedule = () => {
      if (!disposed && request === null) request = requestAnimationFrame(render);
    };
    const poll = async () => {
      const revision = inputRevision;
      try {
        const next = enabled && !host.battleActive?.() ? await host.vm.getMenuSnapshot!() : null;
        if (!disposed && revision === inputRevision) {
          snapshot = next;
          schedule();
        }
      } catch {
        snapshot = null;
        hide('snapshot-unavailable');
      }
      if (!disposed) timer = window.setTimeout(poll, snapshot ? 80 : 250);
    };
    const pointer = (event: PointerEvent) => {
      if (!snapshot) return;
      if (document.pointerLockElement !== host.screen) {
        const box = host.screen.getBoundingClientRect();
        localPointer = {
          x: ((event.clientX - box.left) * snapshot.width) / box.width,
          y: ((event.clientY - box.top) * snapshot.height) / box.height,
        };
      }
      down = (event.buttons & 1) !== 0;
      if (event.type === 'pointerdown' && event.button === 0) {
        const position =
          (document.pointerLockElement === host.screen ? host.pointerPosition?.() : null) ?? localPointer;
        pressedControl = position
          ? (snapshot.controls.find(
              (control) =>
                control.className === 'Button' &&
                control.visible &&
                control.enabled &&
                position.x >= control.rect.x &&
                position.y >= control.rect.y &&
                position.x < control.rect.x + control.rect.width &&
                position.y < control.rect.y + control.rect.height,
            )?.hwnd ?? null)
          : null;
      }
      schedule();
    };
    const invalidate = (event: Event) => {
      let activates = false;
      if (event instanceof PointerEvent) {
        // A release outside the pressed control cancels the original click.
        // Read the release position too: there need not have been a move event.
        pointer(event);
        const position =
          (document.pointerLockElement === host.screen ? host.pointerPosition?.() : null) ?? localPointer;
        const control = snapshot?.controls.find((control) => control.hwnd === pressedControl);
        activates =
          event.button === 0 &&
          !!position &&
          !!control?.visible &&
          control.enabled &&
          position.x >= control.rect.x &&
          position.y >= control.rect.y &&
          position.x < control.rect.x + control.rect.width &&
          position.y < control.rect.y + control.rect.height;
        down = false;
        pressedControl = null;
      } else if (event instanceof KeyboardEvent) {
        // Games can implement Escape through a custom return button ID.
        activates =
          !!snapshot &&
          (event.key === 'Escape' ||
            (['Enter', ' '].includes(event.key) &&
              snapshot.controls.some(
                (control) => control.className === 'Button' && control.visible && control.enabled && control.focused,
              )));
      }
      if (!activates) {
        schedule();
        return;
      }
      inputRevision++;
      snapshot = null;
      hide('input-transition');
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(host.screen);
    host.screen.addEventListener('pointermove', pointer);
    host.screen.addEventListener('pointerdown', pointer);
    host.screen.addEventListener('pointerup', invalidate);
    window.addEventListener('keydown', invalidate);
    void poll();
    return {
      setEnabled(next) {
        enabled = next;
        schedule();
      },
      dispose() {
        disposed = true;
        abort.abort();
        clearTimeout(timer);
        if (request !== null) cancelAnimationFrame(request);
        resize.disconnect();
        host.screen.removeEventListener('pointermove', pointer);
        host.screen.removeEventListener('pointerdown', pointer);
        host.screen.removeEventListener('pointerup', invalidate);
        window.removeEventListener('keydown', invalidate);
        canvas.remove();
        images.forEach((image) => image.close());
      },
    };
  } catch (error) {
    abort.abort();
    images.forEach((image) => image.close());
    throw error;
  }
}
