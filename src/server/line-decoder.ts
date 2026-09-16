/** Incrementally decodes newline-delimited JSON without assuming stream chunk boundaries. */
export class JsonLineDecoder<T = unknown> {
  private remainder = '';

  push(chunk: Buffer | string): T[] {
    this.remainder += chunk.toString();
    const lines = this.remainder.split(/\r?\n/);
    this.remainder = lines.pop() ?? '';
    return lines.filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as T);
  }

  finish(): T[] {
    const last = this.remainder.trim();
    this.remainder = '';
    return last === '' ? [] : [JSON.parse(last) as T];
  }
}
