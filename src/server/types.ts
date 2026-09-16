export type JsonObject = Record<string, unknown>;

export interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: JsonObject;
  result?: JsonObject;
  error?: { code: number; message: string; data?: unknown };
}

export interface WebEvent {
  protocolVersion: 1;
  type: 'event' | 'snapshot' | 'resync_required';
  epoch: string;
  seq: number;
  kind: string;
  threadId?: string;
  payload: unknown;
}

export interface PendingInteraction {
  id: string;
  upstreamRequestId: string | number;
  method: string;
  threadId?: string;
  turnId?: string;
  payload: JsonObject;
  createdAt: number;
}
