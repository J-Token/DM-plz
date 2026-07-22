/**
 * Media attachment helpers
 *
 * Validates local files before upload and posts them as multipart bodies.
 * Files stream from disk rather than being buffered whole.
 */

import { isAbsolute } from 'node:path';
import type { DmplzMediaError } from './types.js';

/**
 * Fallback upload timeout when none is configured
 */
export const DEFAULT_MEDIA_TIMEOUT_MS = 120000;

/**
 * Describes the single file part of a multipart upload.
 */
export interface MultipartFile {
  /** Form field name expected by the API (e.g. 'video', 'files[0]') */
  field: string;
  /**
   * File content, already bounded to the size that passed inspection.
   * Build it with sliceForUpload() so a file that grows between the size
   * check and the upload cannot smuggle extra bytes past the limit.
   */
  content: Blob;
  /** Filename reported to the API */
  name: string;
}

/**
 * Pins a checked file to the size it had at inspection time.
 *
 * Bun.file() reads lazily, so a recording that is still being written would
 * otherwise reach the network larger than the limit that approved it.
 */
export function sliceForUpload(file: ReturnType<typeof Bun.file>): Blob {
  return file.slice(0, file.size, file.type);
}

/**
 * Validates a media file against the provider's upload limit.
 *
 * Returns the opened file handle, or a structured error when the path is
 * relative, missing, empty, or larger than the limit. No network request
 * should be attempted when this returns an error.
 */
export async function inspectMediaFile(
  filePath: string,
  limitBytes: number
): Promise<{ file: ReturnType<typeof Bun.file> } | { error: DmplzMediaError }> {
  if (!isAbsolute(filePath)) {
    return {
      error: {
        code: 'PATH_NOT_ABSOLUTE',
        message: 'Media path must be absolute.',
        data: { path: filePath },
      },
    };
  }

  const file = Bun.file(filePath);

  let exists = false;
  try {
    exists = await file.exists();
  } catch {
    // Unreadable paths are reported as missing below.
  }

  if (!exists) {
    return {
      error: {
        code: 'FILE_NOT_FOUND',
        message: 'Media file was not found.',
        data: { path: filePath },
      },
    };
  }

  if (file.size === 0) {
    return {
      error: {
        code: 'FILE_EMPTY',
        message: 'Media file is empty.',
        data: { path: filePath },
      },
    };
  }

  if (file.size > limitBytes) {
    return {
      error: {
        code: 'MEDIA_TOO_LARGE',
        message: 'Media file exceeds the upload limit.',
        data: { sizeBytes: file.size, limitBytes, path: filePath },
      },
    };
  }

  return { file };
}

/**
 * Reads the duration of an MP4 from its `mvhd` box, in seconds.
 *
 * Returns Infinity when the box cannot be found or parsed, so callers fall
 * back to the treatment meant for long files. Only the first and last MiB are
 * examined, which covers both plain and fragmented layouts without reading
 * the whole file.
 */
export async function readMp4DurationSec(file: Blob): Promise<number> {
  const window = Math.min(file.size, 1024 * 1024);
  const chunks = [Buffer.from(await file.slice(0, window).arrayBuffer())];
  if (file.size > window) {
    chunks.push(Buffer.from(await file.slice(file.size - window).arrayBuffer()));
  }

  for (const chunk of chunks) {
    const at = chunk.indexOf('mvhd');
    if (at < 0) {
      continue;
    }

    // mvhd layout: 'mvhd' | version(1) | flags(3) | created | modified | timescale | duration
    // Version 1 uses 64-bit created/modified/duration fields, version 0 uses 32-bit.
    const isV1 = chunk[at + 4] === 1;
    const timescaleAt = at + (isV1 ? 24 : 16);
    const durationAt = at + (isV1 ? 28 : 20);
    if (durationAt + (isV1 ? 8 : 4) > chunk.length) {
      continue;
    }

    const timescale = chunk.readUInt32BE(timescaleAt);
    const duration = isV1
      ? Number(chunk.readBigUInt64BE(durationAt))
      : chunk.readUInt32BE(durationAt);

    // A zero duration means the header was never finalized — a killed recorder
    // leaves one behind. Report it as unknown so callers stay on the safe path
    // rather than treating a long recording as a short one.
    if (timescale > 0 && duration > 0) {
      return duration / timescale;
    }
  }

  return Infinity;
}

/**
 * Uploads one file as multipart/form-data.
 *
 * Rejects with a TimeoutError when the upload exceeds timeoutMs. HTTP status
 * codes are returned as-is so callers can handle rate limits themselves; the
 * same MultipartFile may be posted again to retry.
 *
 * Memory: RSS grows by roughly twice the file size during the upload and is
 * released afterwards, so a 50 MB attachment costs about 100 MB. The JS heap
 * stays flat, which makes heap measurements look like streaming — they are
 * not. Two lower-memory alternatives were tried and rejected: a hand-built
 * ReadableStream body loses its Content-Length and panics Bun 1.3.9 when
 * aborted, and a raw node:net/node:tls client means owning redirects, proxies,
 * and chunked decoding forever. See PRD section 10.4.
 */
export async function postMultipart(
  url: string,
  headers: Record<string, string>,
  fields: Record<string, string>,
  file: MultipartFile,
  timeoutMs: number
): Promise<{ status: number; body: string }> {
  const form = new FormData();

  for (const [name, value] of Object.entries(fields)) {
    form.append(name, value);
  }
  form.append(file.field, file.content, file.name.replace(/["\r\n]/g, '_'));

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });

  return { status: response.status, body: await response.text() };
}
