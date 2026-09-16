import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { JsonLineDecoder } from './line-decoder.js';
import type { JsonObject, RpcMessage } from './types.js';

export class CodexUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexUnavailableError';
  }
}

interface PendingCall {
  resolve(value: JsonObject): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface CodexAdapterOptions {
  command?: string;
  requestTimeoutMs?: number;
}

/** A narrowly-scoped stdio client for `codex app-server`. */
export class CodexAdapter extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string | number, PendingCall>();
  private readonly decoder = new JsonLineDecoder<RpcMessage>();
  private requestId = 0;
  private started = false;
  private available = false;
  private readonly command: string;
  private readonly requestTimeoutMs: number;

  constructor(options: CodexAdapterOptions = {}) {
    super();
    this.command = options.command ?? 'codex';
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  get isAvailable(): boolean {
    return this.available;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    try {
      this.child = spawn(this.command, ['app-server', '--listen', 'stdio://'], {
        shell: false,
        stdio: 'pipe'
      });
    } catch (error) {
      this.started = false;
      throw new CodexUnavailableError(`Could not start Codex: ${String(error)}`);
    }

    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => this.emit('diagnostic', chunk.toString()));
    this.child.on('error', (error) => this.onExit(new CodexUnavailableError(`Codex process error: ${error.message}`)));
    this.child.on('exit', (code, signal) => this.onExit(new CodexUnavailableError(`Codex exited (${code ?? 'unknown'}${signal ? `, ${signal}` : ''})`)));

    try {
      await this.request('initialize', {
        clientInfo: { name: 'codex_webui', title: 'Codex WebUI', version: '0.1.0' }
      });
      this.notify('initialized', {});
      this.available = true;
      this.emit('ready');
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async request(method: string, params: JsonObject = {}): Promise<JsonObject> {
    if (!this.child?.stdin.writable) throw new CodexUnavailableError('Codex app-server is not connected.');
    const id = ++this.requestId;
    const message = { id, method, params };
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexUnavailableError(`Timed out waiting for Codex response to ${method}.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CodexUnavailableError(`Could not send ${method}: ${error.message}`));
      });
    });
  }

  notify(method: string, params: JsonObject): void {
    if (!this.child?.stdin.writable) throw new CodexUnavailableError('Codex app-server is not connected.');
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id: string | number, result: JsonObject): void {
    if (!this.child?.stdin.writable) throw new CodexUnavailableError('Codex app-server is not connected.');
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.available = false;
    this.started = false;
    if (child && !child.killed) child.kill('SIGTERM');
    this.rejectPending(new CodexUnavailableError('Codex app-server stopped.'));
  }

  private onStdout(chunk: Buffer): void {
    try {
      for (const message of this.decoder.push(chunk)) this.handle(message);
    } catch (error) {
      this.emit('protocolError', error);
    }
  }

  private handle(message: RpcMessage): void {
    if (message.id !== undefined && message.method !== undefined) {
      this.emit('serverRequest', message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new CodexUnavailableError(message.error.message));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method) this.emit('notification', message);
  }

  private onExit(error: CodexUnavailableError): void {
    if (!this.started && !this.available) return;
    this.available = false;
    this.child = undefined;
    this.rejectPending(error);
    this.emit('unavailable', error);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
