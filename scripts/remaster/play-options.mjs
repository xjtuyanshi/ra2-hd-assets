import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Both owner launchers use this exact look. Resolution belongs to each backend:
// v86 can measure the page at boot; a native process reads its INI before start.
export const HD_PLAY_OPTIONS = Object.freeze({
  hd: '1',
  'hd-look': 'cinematic',
  'hd-fx': 'enhanced',
  'hd-water': 'enhanced',
  'hd-vlook': 'remaster',
  'hd-vproj': 'vehicles-hd',
  'hd-ui': '1',
  // Single-pass reconstruction of the original menus/dialogs; HD passthrough
  // keeps its separate 1:1 overlay path and does not run this filter.
  sr: '1',
});

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(new URLSearchParams(HD_PLAY_OPTIONS).toString());
