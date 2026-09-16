import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { platformFamily: 'test' } })}\n`);
    continue;
  }
  if (message.method === 'initialized') {
    process.stdout.write(`${JSON.stringify({ id: 90, method: 'item/commandExecution/requestApproval', params: { threadId: 'thr_test', command: 'pwd' } })}\n`);
    continue;
  }
  if (message.method === 'thread/list') {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [] } })}\n`);
    continue;
  }
  if (message.id === 90 && message.result?.decision === 'decline') {
    process.stdout.write(`${JSON.stringify({ method: 'test/approvalReceived', params: { ok: true } })}\n`);
  }
}
