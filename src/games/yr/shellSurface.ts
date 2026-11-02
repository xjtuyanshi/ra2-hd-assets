/**
 * Yuri's Revenge 1.001 draws its front end (menus, films, loading and score screens) on a fixed 800x600 surface,
 * whatever resolution the match uses: the shell size is hard-coded at 0x6BD99C/0x6BD9A6 and 0x789A0F..0x789A34 of
 * gamemd.exe. The native host uses it to tell menu pictures from battle pictures; the page uses it to decide where
 * the presentation-only ambient fill may show beside the 4:3 picture.
 */
export const YR_SHELL_SURFACE: Readonly<{ width: number; height: number }> = Object.freeze({ width: 800, height: 600 });
