/**
 * Spawned detached by the CLI to refresh the update cache, so no command ever waits on npm.
 * Usage: node update-worker.js <cache path>
 */
import { refreshUpdateCache } from './update-cache.ts';
import { VERSION } from './version.ts';

// Never linger, whatever npm does.
setTimeout(() => process.exit(1), 10_000).unref();

const path = process.argv[2];

if (path) {
  await refreshUpdateCache(path, {
    fetch: (input, init) => fetch(input, init),
    userAgent: `filecafe-cli/${VERSION} node/${process.versions.node} (${process.platform})`,
    now: () => Date.now(),
  }).catch(() => {});
}
