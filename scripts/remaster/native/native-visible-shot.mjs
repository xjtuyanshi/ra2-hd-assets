import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

/** Capture an actual visible Wine game window, independent of the tapped primary. */
export async function captureVisibleNativeWindow({ out, label, ownerName = 'gamemd', hostPid }) {
  await mkdir(out, { recursive: true });
  const source = join(out, 'visible-window-list.swift');
  await writeFile(
    source,
    `import CoreGraphics
import Foundation
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
let names = CommandLine.arguments[1].lowercased()
let pid = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2]) : nil
let selected = windows.filter { window in
    let owner = (window["kCGWindowOwnerName"] as? String ?? "").lowercased()
    return owner.contains(names) && (pid == nil || (window["kCGWindowOwnerPID"] as? Int) == pid)
}.map { window -> [String: Any] in
    return ["id": window["kCGWindowNumber"] ?? 0,
            "pid": window["kCGWindowOwnerPID"] ?? 0,
            "owner": window["kCGWindowOwnerName"] ?? "",
            "title": window["kCGWindowName"] ?? "",
            "bounds": window["kCGWindowBounds"] ?? [:],
            "layer": window["kCGWindowLayer"] ?? 0]
}
let data = try JSONSerialization.data(withJSONObject: selected, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
`,
  );
  const args = ['-module-cache-path', '/private/tmp/native-phase7-swift-cache', source, ownerName];
  if (hostPid !== undefined) args.push(String(hostPid));
  const { stdout } = await execFile('swift', args, { timeout: 30000, maxBuffer: 1024 * 1024 });
  const windows = JSON.parse(stdout.trim());
  const candidates = windows.filter((window) => window.layer === 0);
  candidates.sort((a, b) => b.bounds.Width * b.bounds.Height - a.bounds.Width * a.bounds.Height);
  const selected = candidates[0];
  const metadataPath = join(out, `${label}-visible-window.json`);
  await writeFile(
    metadataPath,
    JSON.stringify({ windows, selected: selected ?? null, hostPid: hostPid ?? null }, null, 2),
  );
  if (!selected) throw new Error(`No visible native window owned by ${ownerName}`);
  const path = join(out, `${label}-visible-window.png`);
  await execFile('screencapture', ['-x', '-o', `-l${selected.id}`, path], { timeout: 30000 });
  return { path, metadataPath, window: selected };
}

/** Keep both source screenshots and produce an inspectable comparison artifact. */
export async function combineNativeWindowComparison({ hiddenPath, visiblePath, path }) {
  await mkdir(dirname(path), { recursive: true });
  await execFile(
    'python3',
    [
      '-c',
      `from PIL import Image, ImageDraw
import sys
hidden = Image.open(sys.argv[1]).convert('RGB')
visible = Image.open(sys.argv[2]).convert('RGB')
height = max(hidden.height, visible.height)
images = [image.resize((round(image.width * height / image.height), height)) for image in (hidden, visible)]
result = Image.new('RGB', (images[0].width + images[1].width + 12, height + 24), '#202020')
result.paste(images[0], (0, 24))
result.paste(images[1], (images[0].width + 12, 24))
draw = ImageDraw.Draw(result)
draw.text((8, 5), 'HIDDEN - native primary', fill='white')
draw.text((images[0].width + 20, 5), 'VISIBLE - actual OS window', fill='white')
result.save(sys.argv[3])`,
      hiddenPath,
      visiblePath,
      path,
    ],
    { timeout: 30000 },
  );
  return path;
}
