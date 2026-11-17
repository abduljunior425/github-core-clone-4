// Packfiles and fetch computation.
//
// Packs are always written delta-free (every object whole, zlib-deflated):
// the suite never requires the server to send deltas, and a whole-object pack
// is byte-stable and cheap to verify. Incoming packs are parsed fully,
// including OFS_DELTA and REF_DELTA entries, so any client that does send
// deltas still unpacks.
//
// The clone hot path never rebuilds a pack: the whole fetch response (ack,
// shallow-info and sideband packfile sections) is built once per
// (repository, wants, haves, depth, shallow boundaries) and cached on the
// repository; a ref change clears the cache.

import { deflateSync, inflateSync } from 'node:zlib';
import { parseTag, type GitObject, type GitType, type Repo, type Store } from './store.ts';
import { isOid, pktDelim, pktFlush, pktLine, sha1Hex, hashObject } from './util.ts';

const TYPE_CODE: Readonly<Record<GitType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The pack header's type/size varint. */
function packObjectHeader(type: GitType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a delta-free packfile from whole objects, with its SHA-1 trailer. */
export function buildPack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

/** Inflate one zlib stream at `offset`; returns its bytes and the next offset. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface PackEntry {
  offset: number;
  kind: 'full' | 'ofs-delta' | 'ref-delta';
  type?: GitType;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Parse a packfile into whole objects, resolving deltas against the pack
 * itself or the store (for thin packs). Throws on a bad header, a bad
 * trailer checksum or an unresolvable delta.
 */
export function parsePack(buf: Buffer, store: Store): GitObject[] {
  if (buf.length < 32) throw new Error('pack is too short');
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  if (sha1Hex(buf.subarray(0, buf.length - 20)) !== trailer) throw new Error('pack trailer checksum mismatch');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const entries: PackEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    if (offset >= buf.length - 20) throw new Error('pack entry runs past the trailer');
    let byte = buf[offset++];
    const typeCode = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= buf.length) throw new Error('pack entry size varint is truncated');
      byte = buf[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    if (typeCode === 6) {
      let b = buf[offset++];
      let baseOff = b & 0x7f;
      while ((b & 0x80) !== 0) {
        if (offset >= buf.length) throw new Error('ofs-delta base offset is truncated');
        b = buf[offset++];
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      const inflated = inflateAt(buf, offset);
      offset = inflated.next;
      entries.push({ offset: entryOffset, kind: 'ofs-delta', data: inflated.data, baseOffset: entryOffset - baseOff });
    } else if (typeCode === 7) {
      if (offset + 20 > buf.length) throw new Error('ref-delta base is truncated');
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(buf, offset);
      offset = inflated.next;
      entries.push({ offset: entryOffset, kind: 'ref-delta', data: inflated.data, baseOid });
    } else {
      const type = CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateAt(buf, offset);
      offset = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack object size does not match its header');
      entries.push({ offset: entryOffset, kind: 'full', type, data: inflated.data });
    }
  }
  const byOffset = new Map<number, PackEntry>(entries.map((entry) => [entry.offset, entry]));
  const resolved = new Map<number, GitObject>();
  const resolve = (entry: PackEntry): GitObject => {
    const done = resolved.get(entry.offset);
    if (done !== undefined) return done;
    let out: GitObject;
    if (entry.kind === 'full') {
      out = { type: entry.type as GitType, data: entry.data };
    } else if (entry.kind === 'ofs-delta') {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      out = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      const baseOid = entry.baseOid as string;
      const stored = store.getObject(baseOid);
      if (stored !== undefined) {
        out = { type: stored.type, data: applyDelta(stored.data, entry.data) };
      } else {
        const baseEntry = entries.find(
          (candidate) => candidate.kind === 'full' && hashObject(candidate.type as GitType, candidate.data) === baseOid,
        );
        if (baseEntry === undefined) throw new Error(`ref-delta base ${baseOid} is not in the pack or the store`);
        const base = resolve(baseEntry);
        out = { type: base.type, data: applyDelta(base.data, entry.data) };
      }
    }
    resolved.set(entry.offset, out);
    return out;
  };
  return entries.map((entry) => resolve(entry));
}

// -------------------------------------------------------------------------------------------
// Fetch computation
// -------------------------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  depth?: number;
  shallow: string[];
}

export interface FetchResult {
  objects: GitObject[];
  shallowOut: string[];
  unshallowOut: string[];
  ack: string | null;
}

/**
 * The objects a fetch must deliver: the want closure (depth-limited when
 * asked) minus everything the client already holds. A shallow boundary the
 * client names is held but its parents are not walked. New shallow
 * boundaries are the included commits at the depth cutoff; old boundaries
 * that are now fully included are reported unshallow.
 */
export function computeFetch(store: Store, req: FetchRequest): FetchResult {
  const shallowIn = new Set(req.shallow.filter((oid) => isOid(oid)));
  const held = store.collectReachable(req.haves, shallowIn);
  const includedCommits = new Map<string, number>();
  const wantObjects = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = req.wants.map((oid) => ({ oid, dist: 0 }));
  while (queue.length > 0) {
    const item = queue.pop() as { oid: string; dist: number };
    const object = store.getObject(item.oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      if (includedCommits.has(item.oid)) continue;
      if (req.depth !== undefined && item.dist >= req.depth) continue;
      includedCommits.set(item.oid, item.dist);
      wantObjects.add(item.oid);
      const meta = store.getCommit(item.oid);
      if (meta !== null) {
        for (const oid of store.collectReachable([meta.tree])) wantObjects.add(oid);
        for (const parent of meta.parents) queue.push({ oid: parent, dist: item.dist + 1 });
      }
    } else if (object.type === 'tag') {
      if (wantObjects.has(item.oid)) continue;
      wantObjects.add(item.oid);
      queue.push({ oid: parseTag(object.data).object, dist: item.dist });
    } else {
      wantObjects.add(item.oid);
    }
  }
  const deliverOids = [...wantObjects].filter((oid) => !held.has(oid)).sort();
  const objects: GitObject[] = [];
  for (const oid of deliverOids) {
    const object = store.getObject(oid);
    if (object !== undefined) objects.push(object);
  }
  const shallowOut: string[] = [];
  if (req.depth !== undefined) {
    for (const [oid, dist] of includedCommits) {
      if (dist !== req.depth - 1) continue;
      const meta = store.getCommit(oid);
      if (meta !== null && meta.parents.length > 0) shallowOut.push(oid);
    }
  }
  const unshallowOut: string[] = [];
  for (const oid of shallowIn) {
    if (includedCommits.has(oid) && !shallowOut.includes(oid)) unshallowOut.push(oid);
  }
  shallowOut.sort();
  unshallowOut.sort();
  let ack: string | null = null;
  for (const have of req.haves) {
    if (store.getObject(have)?.type === 'commit') {
      ack = have;
      break;
    }
  }
  return { objects, shallowOut, unshallowOut, ack };
}

/** Split a pack into sideband band-1 payloads of at most `size` data bytes. */
function sidebandChunks(pack: Buffer, size = 32768): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += size) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + size));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

/**
 * The whole protocol-v2 fetch response, as bytes ready to send. The
 * acknowledgments section is only present when the request carried `have`
 * lines: a clone sends none, and real git expects the response to open with
 * shallow-info or packfile in that case.
 */
export function buildFetchResponseV2(result: FetchResult, hasHaves: boolean): Buffer {
  const parts: Buffer[] = [];
  if (hasHaves) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine(result.ack !== null ? `ACK ${result.ack}\n` : 'NAK\n'));
    parts.push(pktDelim());
  }
  if (result.shallowOut.length > 0 || result.unshallowOut.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of result.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (result.objects.length > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandChunks(buildPack(result.objects)));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The whole protocol-v0 fetch response, as bytes ready to send. */
export function buildFetchResponseV0(result: FetchResult): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(result.ack !== null ? `ACK ${result.ack}\n` : 'NAK\n'));
  for (const oid of result.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  if (result.objects.length > 0) parts.push(...sidebandChunks(buildPack(result.objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** A cached fetch response for a repository, keyed by the exact request. */
export function cachedFetch(
  store: Store,
  repo: Repo,
  protocol: 2 | 0,
  req: FetchRequest,
): Buffer {
  const key = `${protocol}:${JSON.stringify([
    [...req.wants].sort(),
    [...req.haves].sort(),
    req.depth ?? null,
    [...req.shallow].sort(),
  ])}`;
  const cached = repo.packCache.get(key);
  if (cached !== undefined) return cached;
  const result = computeFetch(store, req);
  const bytes = protocol === 2 ? buildFetchResponseV2(result, req.haves.length > 0) : buildFetchResponseV0(result);
  if (repo.packCache.size > 256) repo.packCache.clear();
  repo.packCache.set(key, bytes);
  return bytes;
}
