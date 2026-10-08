/** The explicit development launcher attaches only to its supplied Yuri's Revenge copy. */
export function nativeAutoStart(search: string, dev: boolean = import.meta.env.DEV): 'yr' | null {
  if (!dev) return null;
  const query = new URLSearchParams(search);
  return query.get('backend') === 'native' && query.get('native-autostart') === 'yr' ? 'yr' : null;
}

/** Native canvas presses carry absolute positions; explicit relative input remains available. */
export function desktopPointerLock(search: string, backend: string | undefined): boolean {
  const preference = new URLSearchParams(search).get('mouse-lock');
  return preference === null ? backend !== 'native' : preference !== '0';
}
