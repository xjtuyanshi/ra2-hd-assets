import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Read only the self-check facts written during this launch. Old launches have
// no observation JSON, so their retained stdout remains the historical fallback.
export async function readWineSelfCheckEvidence(runDirectory) {
  const logPath = join(runDirectory, 'wine-check.log');
  const observationPath = join(runDirectory, 'wine-check.json');
  const log = await readFile(logPath, 'utf8');
  const observation = await readFile(observationPath, 'utf8')
    .then((text) => {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected a Wine self-check observation object');
      return value;
    })
    .catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  const observedExactOkLine = observation
    ? observation.source === 'stdout-exact-trimmed-line' && observation.acknowledged === true
    : log.split(/\r?\n/).some((line) => line.trim() === 'RA2_NATIVE_WINE_OK');
  return {
    logPath,
    observationPath: observation ? observationPath : null,
    observation,
    observedExactOkLine,
    successful: observation
      ? observedExactOkLine && observation.closed === true && observation.exitCode === 0 && observation.error === null
      : observedExactOkLine,
  };
}
