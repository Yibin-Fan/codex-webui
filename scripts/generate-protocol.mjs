import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const output = 'src/server/generated/codex-protocol';

if (!existsSync('node_modules')) {
  console.log('Skipping protocol generation: dependencies are not installed.');
  process.exit(0);
}

mkdirSync(output, { recursive: true });
const result = spawnSync('codex', ['app-server', 'generate-ts', '--out', output], {
  encoding: 'utf8',
  stdio: 'inherit'
});

if (result.error?.code === 'ENOENT') {
  rmSync(output, { recursive: true, force: true });
  console.warn('Skipping protocol generation: codex was not found on PATH.');
  process.exit(0);
}

if (result.status !== 0) process.exit(result.status ?? 1);
