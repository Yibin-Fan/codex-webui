export interface StreamEvent {
  kind: string;
  threadId?: string;
  payload: unknown;
}

export interface ProjectedItem {
  id: string;
  threadId: string;
  turnId?: string;
  type: string;
  status?: string;
  text?: string;
  output?: string;
  command?: string;
  cwd?: string;
  changes?: unknown[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface ToolProjection {
  items: Record<string, ProjectedItem>;
  diffs: Record<string, string>;
}

export const emptyToolProjection = (): ToolProjection => ({ items: {}, diffs: {} });

/** Reduces the stable item lifecycle notifications into renderable UI state. */
export function projectToolEvent(current: ToolProjection, event: StreamEvent): ToolProjection {
  const params = object(event.payload);
  if (!params) return current;

  if (event.kind === 'codex.item/started' || event.kind === 'codex.item/completed') {
    const item = object(params.item);
    if (!item || typeof item.id !== 'string' || typeof item.type !== 'string' || typeof params.threadId !== 'string') return current;
    const prior = current.items[item.id];
    const next: ProjectedItem = {
      ...prior,
      ...item,
      id: item.id,
      type: item.type,
      threadId: params.threadId,
      ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
      ...(item.type === 'commandExecution' && typeof item.aggregatedOutput === 'string' ? { output: item.aggregatedOutput } : {}),
      ...(item.type === 'agentMessage' && typeof item.text === 'string' ? { text: item.text } : {})
    };
    return { ...current, items: { ...current.items, [next.id]: next } };
  }

  if (event.kind === 'codex.item/commandExecution/outputDelta' || event.kind === 'codex.item/agentMessage/delta') {
    if (typeof params.itemId !== 'string' || typeof params.threadId !== 'string' || typeof params.delta !== 'string') return current;
    const type = event.kind.endsWith('outputDelta') ? 'commandExecution' : 'agentMessage';
    const prior = current.items[params.itemId];
    const next: ProjectedItem = {
      ...prior,
      id: params.itemId,
      threadId: params.threadId,
      ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
      type,
      ...(type === 'commandExecution' ? { output: `${prior?.output ?? ''}${params.delta}` } : { text: `${prior?.text ?? ''}${params.delta}` })
    };
    return { ...current, items: { ...current.items, [next.id]: next } };
  }

  if (event.kind === 'codex.item/fileChange/patchUpdated') {
    if (typeof params.itemId !== 'string' || typeof params.threadId !== 'string' || !Array.isArray(params.changes)) return current;
    const prior = current.items[params.itemId];
    const next: ProjectedItem = { ...prior, id: params.itemId, threadId: params.threadId, type: 'fileChange', changes: params.changes };
    return { ...current, items: { ...current.items, [next.id]: next } };
  }

  if (event.kind === 'codex.turn/diff/updated') {
    if (typeof params.threadId !== 'string' || typeof params.turnId !== 'string' || typeof params.diff !== 'string') return current;
    return { ...current, diffs: { ...current.diffs, [`${params.threadId}:${params.turnId}`]: params.diff } };
  }

  return current;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
