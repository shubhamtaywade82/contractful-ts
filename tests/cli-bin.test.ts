/**
 * Regression: the `contractful-gen` binary must work when invoked through a
 * `node_modules/.bin`-style SYMLINK. npm links bins as symlinks to the
 * package's dist file; the CLI's main guard previously compared
 * `process.argv[1]` (the symlink path) against `import.meta.url` (the
 * resolved real path), never matched, and the installed binary exited 0
 * without doing anything. Found by the tarball smoke test; pinned here.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, symlink, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const run = promisify(execFile);
const TMP = resolve(fileURLToPath(new URL('./.cli-bin-tmp', import.meta.url)));

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Bin', version: '1.0.0' },
  servers: [{ url: 'https://bin.test' }],
  paths: {
    '/ping': {
      get: {
        operationId: 'ping',
        tags: ['misc'],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
});

describe('contractful-gen as an installed binary', () => {
  it('executes through a node_modules/.bin-style symlink', async () => {
    const distCli = realpathSync(resolve(fileURLToPath(new URL('../dist/codegen/cli.js', import.meta.url))));
    const binDir = join(TMP, 'bin');
    const outDir = join(TMP, 'out');
    await mkdir(binDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    await writeFile(join(TMP, 'spec.json'), SPEC, 'utf8');

    const linkPath = join(binDir, 'contractful-gen');
    await symlink(distCli, linkPath);

    const { stderr } = await run(process.execPath, [
      linkPath,
      '--spec',
      join(TMP, 'spec.json'),
      '--out',
      outDir,
    ]);
    expect(stderr).toContain('generated');

    // The index was actually written (previously nothing was emitted).
    await access(join(outDir, 'index.ts'));
    await access(join(outDir, 'misc.ts'));

    // And the emitted code is importable (the self-referencing package
    // name resolves within this repo) and defines a working client.
    const mod = (await import(pathToFileURL(join(outDir, 'misc.ts')).href)) as {
      miscApi: new (opts: unknown) => { ping: () => Promise<unknown> };
    };
    expect(typeof mod.miscApi).toBe('function');
    const client = new mod.miscApi({
      transport: { send: async () => ({ status: 200, headers: {}, body: 'pong' }) },
    });
    await expect(client.ping()).resolves.toBe('pong');
  }, 30_000);
});
