import { realpath } from 'node:fs/promises';
import { createWebUi } from './app.js';
import { CodexAdapter } from './codex-adapter.js';

const args = parseArgs(process.argv.slice(2));
const workspace = await realpath(optionString(args.workspace) ?? process.cwd());
const port = Number(optionString(args.port) ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be an integer between 1 and 65535.');

const adapter = new CodexAdapter({ command: optionString(args.codex) });
const webUi = await createWebUi({ workspace, adapter });
const address = await webUi.app.listen({ host: '127.0.0.1', port });
const launchUrl = `${address}/#bootstrap=${webUi.bootstrapToken}`;
process.stdout.write(`Codex WebUI: ${launchUrl}\nWorkspace: ${workspace}\nStop: Ctrl+C\n`);

void adapter.start().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Codex is unavailable: ${message}\nThe WebUI will remain open and report the unavailable state.\n`);
});

if (!args.noOpen) {
  const open = (await import('node:child_process')).spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [launchUrl], { stdio: 'ignore', detached: true });
  open.unref();
}

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    if (closing) return;
    closing = true;
    await webUi.close();
    process.exit(0);
  });
}

function parseArgs(argv: string[]): Record<string, string | boolean | undefined> {
  const options: Record<string, string | boolean | undefined> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-open') options.noOpen = true;
    else if (arg === '--workspace' || arg === '--port' || arg === '--codex') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      options[arg.slice(2)] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function optionString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
