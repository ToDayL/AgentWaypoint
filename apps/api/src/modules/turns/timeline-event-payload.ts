import { Prisma } from '@prisma/client';

const MAX_TIMELINE_METADATA_LENGTH = 4_096;
const MAX_TOOL_DETAIL_REF_LENGTH = 512;

export type ToolDetailRefKind = 'call' | 'item' | 'tool' | 'event';

export function summarizeTimelineEventPayload(type: string, payload: unknown): Prisma.InputJsonValue {
  const record = asRecord(payload);
  if (!record) {
    return {};
  }

  if (type === 'diff.updated') {
    return {
      diffAvailable: record.diffAvailable === true || readDiffText(record).length > 0,
      snapshotAvailable: record.snapshotAvailable !== false,
    };
  }

  if (type === 'tool.output') {
    return summarizeToolOutput(record);
  }

  if (type === 'tool.started' || type === 'tool.completed') {
    return summarizeToolLifecycle(record);
  }

  if (type === 'turn.approval.requested') {
    return copyFields(record, [
      'requestId',
      'kind',
      'reason',
      'itemId',
      'approvalId',
      'autoApproveAt',
      'pausedAt',
      'pausedRemainingMs',
    ]);
  }

  return JSON.parse(JSON.stringify(record)) as Prisma.InputJsonValue;
}

export function resolveEventToolDetailRef(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  const explicit = readTrimmedString(record.detailRef);
  if (explicit && parseEventToolDetailRef(explicit)) {
    return explicit;
  }

  const callId = readFirstTrimmedString(record.toolCallId, record.tool_call_id, record.callId);
  if (callId) {
    return buildToolDetailRef('call', callId);
  }

  const toolId = readTrimmedString(record.toolId);
  if (toolId) {
    return buildToolDetailRef('tool', toolId);
  }

  const itemId = readFirstTrimmedString(record.itemId, record.item_id, asRecord(record.item)?.id);
  if (itemId) {
    return buildToolDetailRef('item', itemId);
  }

  const eventId = readTrimmedString(record.id);
  return eventId ? buildToolDetailRef('event', eventId) : null;
}

export function parseEventToolDetailRef(
  detailRef: string,
): { kind: ToolDetailRefKind; value: string } | null {
  if (detailRef.length > MAX_TOOL_DETAIL_REF_LENGTH) {
    return null;
  }
  const separatorIndex = detailRef.indexOf(':');
  if (separatorIndex <= 0) {
    return null;
  }
  const kind = detailRef.slice(0, separatorIndex);
  const value = detailRef.slice(separatorIndex + 1).trim();
  if (!['call', 'item', 'tool', 'event'].includes(kind) || value.length === 0) {
    return null;
  }
  return { kind: kind as ToolDetailRefKind, value };
}

export function attachEventToolDetailRef(payload: Record<string, unknown>): Record<string, unknown> {
  const detailRef = resolveEventToolDetailRef(payload);
  if (!detailRef || payload.detailRef === detailRef) {
    return payload;
  }
  return { ...payload, detailRef };
}

export function resolveEventToolKind(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  return readTrimmedString(record.kind) ?? readTrimmedString(asRecord(record.item)?.type);
}

export function isCommandToolKind(kind: string | null): boolean {
  if (!kind) {
    return false;
  }
  const normalized = kind.replace(/[^a-z0-9]+/gi, '').toLowerCase();
  return ['bash', 'command', 'commandexecution', 'localcommand', 'shell'].includes(normalized);
}

export function readToolOutputText(payload: unknown): string {
  const record = asRecord(payload);
  if (!record) {
    return '';
  }
  return readString(record.text) ?? readString(record.output) ?? '';
}

export function readAggregatedToolOutput(payload: unknown): string {
  const record = asRecord(payload);
  if (!record) {
    return '';
  }
  return readString(asRecord(record.item)?.aggregatedOutput) ?? '';
}

function summarizeToolOutput(record: Record<string, unknown>): Prisma.InputJsonValue {
  const output = readString(record.text) ?? readString(record.output) ?? '';
  const summary = copyFields(record, [
    'toolCallId',
    'tool_call_id',
    'toolId',
    'itemId',
    'item_id',
    'callId',
    'id',
    'title',
    'kind',
    'stream',
    'taskId',
  ]);
  const kind = readTrimmedString(record.kind);
  copyToolDetailRef(summary, record);

  if (!isCommandToolKind(kind) && kind !== 'file_change' && kind !== 'fileChange') {
    const textField = typeof record.text === 'string' ? 'text' : typeof record.output === 'string' ? 'output' : null;
    if (textField && output.length > 0) {
      summary[textField] = output;
    }
  }

  if (output.length > 0) {
    summary.outputAvailable = true;
    summary.outputBytes = Buffer.byteLength(output, 'utf8');
  }
  return summary as Prisma.InputJsonValue;
}

function summarizeToolLifecycle(record: Record<string, unknown>): Prisma.InputJsonValue {
  const item = asRecord(record.item);
  const summary = copyFields(record, [
    'phase',
    'toolCallId',
    'tool_call_id',
    'toolId',
    'itemId',
    'item_id',
    'callId',
    'id',
    'title',
    'kind',
    'status',
    'command',
    'cwd',
    'path',
    'summary',
    'result',
    'outcome',
    'exitCode',
    'durationMs',
  ]);

  copyFallbackScalar(summary, 'itemId', item?.id);
  copyFallbackScalar(summary, 'kind', item?.type);
  copyFallbackScalar(summary, 'status', item?.status);
  copyFallbackScalar(summary, 'command', item?.command);
  copyFallbackScalar(summary, 'cwd', item?.cwd);
  copyFallbackScalar(summary, 'path', item?.path);
  copyFallbackScalar(summary, 'exitCode', item?.exitCode);
  copyFallbackScalar(summary, 'durationMs', item?.durationMs);
  copyToolDetailRef(summary, record);

  const aggregatedOutput = readString(item?.aggregatedOutput) ?? '';
  if (aggregatedOutput.length > 0) {
    summary.outputAvailable = true;
    summary.outputBytes = Buffer.byteLength(aggregatedOutput, 'utf8');
  }
  return summary as Prisma.InputJsonValue;
}

function copyToolDetailRef(
  target: Record<string, Prisma.InputJsonValue>,
  record: Record<string, unknown>,
): void {
  const detailRef = resolveEventToolDetailRef(record);
  if (detailRef) {
    target.detailRef = detailRef;
  }
}

function buildToolDetailRef(kind: ToolDetailRefKind, value: string): string | null {
  const detailRef = `${kind}:${value}`;
  return detailRef.length <= MAX_TOOL_DETAIL_REF_LENGTH ? detailRef : null;
}

function copyFields(record: Record<string, unknown>, fields: string[]): Record<string, Prisma.InputJsonValue> {
  const result: Record<string, Prisma.InputJsonValue> = {};
  for (const field of fields) {
    const value = toTimelineScalar(record[field]);
    if (value !== undefined) {
      result[field] = value;
    }
  }
  return result;
}

function copyFallbackScalar(
  target: Record<string, Prisma.InputJsonValue>,
  field: string,
  value: unknown,
): void {
  if (Object.prototype.hasOwnProperty.call(target, field)) {
    return;
  }
  const normalized = toTimelineScalar(value);
  if (normalized !== undefined) {
    target[field] = normalized;
  }
}

function toTimelineScalar(value: unknown): Prisma.InputJsonValue | undefined {
  if (typeof value === 'string') {
    return value.length > MAX_TIMELINE_METADATA_LENGTH
      ? `${value.slice(0, MAX_TIMELINE_METADATA_LENGTH)}…`
      : value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

function readDiffText(record: Record<string, unknown>): string {
  return readString(record.unifiedDiff) ?? readString(record.diff) ?? '';
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readFirstTrimmedString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = readTrimmedString(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
