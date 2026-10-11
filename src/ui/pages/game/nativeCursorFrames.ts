import type { VmFrame } from '../../../vm86/win32';

/** Own native frame cursor presentation and fallback CSS for one page session. */
export function createNativeCursorFrames(host: {
  screen: Pick<HTMLCanvasElement, 'style'>;
  pageCursor(): { update(frame: VmFrame): void } | null;
  presentCursor(x: number, y: number, visible: boolean): void;
  isReleased(): boolean;
}) {
  let disposed = false;
  let savedStyle: { value: string; priority: string } | null = null;
  return {
    onFrame(frame: VmFrame) {
      // Release precedes asynchronous VM destruction; a late current-session
      // picture must not reacquire CSS after the page overlay restored it.
      if (disposed || host.isReleased()) return;
      const pageCursor = host.pageCursor();
      if (pageCursor && 'pointer' in frame) {
        pageCursor.update({ ...frame });
        delete frame.cursor;
      } else if ('pointer' in frame) {
        savedStyle ??= {
          value: host.screen.style.getPropertyValue('cursor'),
          priority: host.screen.style.getPropertyPriority('cursor'),
        };
        host.screen.style.setProperty('cursor', 'none', 'important');
        host.presentCursor(frame.cursor?.x ?? 0, frame.cursor?.y ?? 0, !!frame.cursor);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (savedStyle) {
        if (savedStyle.value) host.screen.style.setProperty('cursor', savedStyle.value, savedStyle.priority);
        else host.screen.style.removeProperty('cursor');
        savedStyle = null;
      }
    },
  };
}
