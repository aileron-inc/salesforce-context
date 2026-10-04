export interface CsvConsumeStats {
  readMs: number;
  totalBytes: number;
  partCount: number;
}

/**
 * Salesforce の結果 CSV を、引用符内の改行を壊さずにバイト上限で分割する。
 * 各パートは元のヘッダ行を繰り返した単独で読める CSV になる。
 */
export async function consumeCsvParts(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onPart: (part: Uint8Array) => Promise<void>,
): Promise<CsvConsumeStats> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("part_max_bytes must be a positive integer");
  }

  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  let recordStart = 0;
  let index = 0;
  let inQuotes = false;
  let header: Uint8Array | null = null;
  let pending: Uint8Array[] = [];
  let pendingSize = 0;
  let readMs = 0;
  let totalBytes = 0;
  let partCount = 0;
  let streamDone = false;

  const emit = async (records: Uint8Array[]): Promise<void> => {
    if (!header) {
      return;
    }
    await onPart(concatBytes([header, ...records]));
    partCount += 1;
  };

  const takeRecord = async (end: number): Promise<void> => {
    const record = buffer.slice(recordStart, end);
    recordStart = end;
    if (!header) {
      header = record;
      pendingSize = header.byteLength;
      return;
    }

    if (pending.length > 0 && pendingSize + record.byteLength > maxBytes) {
      await emit(pending);
      pending = [];
      pendingSize = header.byteLength;
    }

    pending.push(record);
    pendingSize += record.byteLength;
    if (pendingSize > maxBytes) {
      await emit(pending);
      pending = [];
      pendingSize = header.byteLength;
    }
  };

  const compact = (): void => {
    if (recordStart === 0) {
      return;
    }
    if (recordStart < 64 * 1024 && recordStart !== buffer.length) {
      return;
    }
    buffer = buffer.slice(recordStart);
    index -= recordStart;
    recordStart = 0;
  };

  try {
    while (!streamDone) {
      const started = Date.now();
      const { done, value } = await reader.read();
      readMs += Date.now() - started;
      if (done) {
        streamDone = true;
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      totalBytes += value.byteLength;
      const next = new Uint8Array(buffer.byteLength + value.byteLength);
      next.set(buffer, 0);
      next.set(value, buffer.byteLength);
      buffer = next;

      while (index < buffer.length) {
        const byte = buffer[index];
        if (inQuotes) {
          if (byte !== 0x22) {
            index += 1;
            continue;
          }
          if (index + 1 >= buffer.length) {
            break;
          }
          if (buffer[index + 1] === 0x22) {
            index += 2;
            continue;
          }
          inQuotes = false;
          index += 1;
          continue;
        }

        if (byte === 0x22) {
          inQuotes = true;
          index += 1;
          continue;
        }

        if (byte === 0x0d) {
          if (index + 1 >= buffer.length) {
            break;
          }
          if (buffer[index + 1] === 0x0a) {
            index += 1;
            continue;
          }
          await takeRecord(index + 1);
          index += 1;
          continue;
        }

        if (byte === 0x0a) {
          await takeRecord(index + 1);
          index += 1;
          continue;
        }

        index += 1;
      }

      compact();
    }

    if (inQuotes && index < buffer.length && buffer[index] === 0x22) {
      inQuotes = false;
      index += 1;
    }

    if (recordStart < buffer.length) {
      await takeRecord(buffer.length);
    } else if (recordStart < index) {
      await takeRecord(index);
    }

    if (!header) {
      await onPart(new Uint8Array(0));
      partCount += 1;
    } else if (pending.length > 0) {
      await emit(pending);
    } else if (partCount === 0) {
      await onPart(header);
      partCount += 1;
    }
  } finally {
    reader.releaseLock();
  }

  return { readMs, totalBytes, partCount };
}

export async function splitCsvBytes(
  bytes: Uint8Array,
  maxBytes: number,
  chunkSize = bytes.byteLength || 1,
): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  await consumeCsvParts(streamBytes(bytes, chunkSize), maxBytes, async (part) => {
    parts.push(part);
  });
  return parts;
}

function streamBytes(
  bytes: Uint8Array,
  chunkSize: number,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
