// Shared low-level helpers: hashing, pkt-lines, deterministic time and ids.
//
// Nothing here reads the wall clock or unseeded randomness: every timestamp an
// API answer carries comes from the trial clock (MAKEFUN_TRIAL_NOW plus a
// monotonic counter), so two runs of the same request sequence answer
// byte-for-byte the same values.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);

const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

/** SHA-1 hex of raw bytes. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of `type` + `data` (the `<type> <len>\0` header is hashed in). */
export function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Base64url without padding: the opaque Relay-style global ids. */
export function opaqueId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

/** Decode an opaque id back to its `kind:parts` text, or null when it is not one. */
export function decodeOpaqueId(value: string): string | null {
  if (typeof value !== 'string' || value === '' || /[^A-Za-z0-9_-]/.test(value)) return null;
  try {
    const text = Buffer.from(value, 'base64url').toString('utf8');
    return text.includes(':') ? text : null;
  } catch {
    return null;
  }
}

/** One pkt-line framing `payload` (a string line or raw bytes). */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/**
 * Parse a whole pkt-line stream. Throws on a bad length header or a truncated
 * line, so a malformed client body is a clean 400 instead of a crash.
 */
export function parsePktLines(body: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('pkt-line stream is truncated at a length header');
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) throw new Error('pkt-line length runs past the body');
    out.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return out;
}

/** The data lines of a pkt-line stream, as UTF-8 strings without trailing newline. */
export function pktDataLines(body: Buffer): string[] {
  const lines: string[] = [];
  for (const packet of parsePktLines(body)) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/**
 * The trial clock: MAKEFUN_TRIAL_NOW is the instance's opening time (the only
 * "now" a request may carry); every timestamp handed out is that base plus a
 * monotonic sequence, so timestamps are distinct, increasing and replay-stable.
 */
export class TrialClock {
  private readonly baseMs: number;
  private seq = 0;

  constructor() {
    const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
    let base = 0;
    if (/^\d+$/.test(raw)) base = Number(raw);
    else if (raw !== '') {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) base = parsed;
    }
    this.baseMs = base > 0 ? base : 1_700_000_000_000;
  }

  /** The next timestamp: epoch seconds and its ISO string, from the same tick. */
  next(): { epochSec: number; iso: string } {
    const ms = this.baseMs + this.seq * 1000;
    this.seq += 1;
    return { epochSec: Math.floor(ms / 1000), iso: new Date(ms).toISOString() };
  }

  /** A timestamp without consuming a tick (for read-only answers). */
  currentIso(): string {
    return new Date(this.baseMs + this.seq * 1000).toISOString();
  }
}

/** Split a path into segments, decoding each percent-encoded piece. */
export function decodePath(path: string): string[] {
  return path
    .split('/')
    .filter((piece) => piece !== '')
    .map((piece) => {
      try {
        return decodeURIComponent(piece);
      } catch {
        return piece;
      }
    });
}

/** Base64 of UTF-8 text (the contents API's encoding). */
export function b64encode(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64');
}

/** Count the lines of a text buffer (a trailing newline does not start a line). */
export function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) count += 1;
  if (data[data.length - 1] !== 0x0a) count += 1;
  return count;
}
