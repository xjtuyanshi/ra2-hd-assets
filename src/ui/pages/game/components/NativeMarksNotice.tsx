/** The owner opt-in is per launch; no stored preference can silently enable capture on a later launch. */
export function NativeMarksNotice() {
  if (!import.meta.env.DEV) return null;
  const query = new URLSearchParams(window.location.search);
  if (query.get('backend') !== 'native' || query.get('native-draw-journal') !== '1') return null;
  return (
    <p className="native-hd-marks-notice" style={{ margin: 0, fontSize: 12, lineHeight: 1.6, maxWidth: '80vw' }}>
      高清血条和编队数字为实验功能；要关闭，请在启动器按 Ctrl-C 退出，重新启动时不加 --hd-marks。
    </p>
  );
}
