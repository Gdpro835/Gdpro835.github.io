import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { applyBpsPatch, crc32, inspectBpsPatch } from '../bps.mjs';

const textEncoder = new TextEncoder();

function encodeNumber(input) {
  let value = input;
  const bytes = [];
  while (true) {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value === 0) {
      bytes.push(byte | 0x80);
      return bytes;
    }
    bytes.push(byte);
    value -= 1;
  }
}

function encodeSignedOffset(offset) {
  return encodeNumber(offset >= 0 ? offset * 2 : (-offset * 2) + 1);
}

const command = (action, length) => encodeNumber(((length - 1) * 4) + action);
const sourceRead = (length) => command(0, length);
const targetRead = (bytes) => [...command(1, bytes.length), ...bytes];
const sourceCopy = (length, offset) => [...command(2, length), ...encodeSignedOffset(offset)];
const targetCopy = (length, offset) => [...command(3, length), ...encodeSignedOffset(offset)];

function makePatch(source, target, actions, metadata = new Uint8Array()) {
  const header = [
    0x42, 0x50, 0x53, 0x31,
    ...encodeNumber(source.length),
    ...encodeNumber(target.length),
    ...encodeNumber(metadata.length),
    ...metadata,
    ...actions,
  ];
  const content = Uint8Array.from(header);
  const footer = new Uint8Array(12);
  const view = new DataView(footer.buffer);
  view.setUint32(0, crc32(source), true);
  view.setUint32(4, crc32(target), true);
  const beforePatchCrc = new Uint8Array(content.length + 8);
  beforePatchCrc.set(content);
  beforePatchCrc.set(footer.subarray(0, 8), content.length);
  view.setUint32(8, crc32(beforePatchCrc), true);
  const patch = new Uint8Array(content.length + footer.length);
  patch.set(content);
  patch.set(footer, content.length);
  return patch;
}

const bytes = (...values) => Uint8Array.from(values);

test('CRC32 matches the standard check value', () => {
  assert.equal(crc32(textEncoder.encode('123456789')), 0xcbf43926);
});

test('the repository patch header, CRCs and SHA-256 match the published build', async () => {
  const patch = new Uint8Array(await readFile(new URL('../files/s1patch.bps', import.meta.url)));
  const info = inspectBpsPatch(patch);
  const sha256 = createHash('sha256').update(patch).digest('hex');

  assert.equal(info.sourceSize, 524288);
  assert.equal(info.targetSize, 915280);
  assert.equal(info.metadataSize, 0);
  assert.equal(info.sourceCrc32, 0xafe05eee);
  assert.equal(info.targetCrc32, 0xce9279c3);
  assert.equal(info.patchCrc32, 0x0664ddc1);
  assert.equal(sha256, 'b024cc1d453b5138e2dd18800107b6d1fb35f5de18e0f1ca0b3cc0b2afe94e72');
});

test('SourceRead copies unchanged bytes from the matching source', () => {
  const source = bytes(1, 2, 3, 4);
  const patch = makePatch(source, source, sourceRead(source.length));
  const result = applyBpsPatch(source, patch);
  assert.deepEqual(result.bytes, source);
  assert.equal(result.targetCrc32, crc32(source));
});

test('TargetRead and relative SourceCopy actions build the expected output', () => {
  const source = textEncoder.encode('ABCDE');
  const target = textEncoder.encode('XYCDD');
  const actions = [
    ...targetRead(textEncoder.encode('XY')),
    ...sourceCopy(2, 2),
    ...sourceCopy(1, -1),
  ];
  const patch = makePatch(source, target, actions, textEncoder.encode('test metadata'));
  const result = applyBpsPatch(source, patch);
  assert.equal(new TextDecoder().decode(result.bytes), 'XYCDD');
  assert.equal(result.info.metadataSize, 13);
});

test('TargetCopy supports forward overlap and signed relative offsets', () => {
  const source = new Uint8Array();
  const target = textEncoder.encode('XYZZXY');
  const actions = [
    ...targetRead(textEncoder.encode('XYZ')),
    ...targetCopy(1, 2),
    ...targetCopy(2, -3),
  ];
  const patch = makePatch(source, target, actions);
  const result = applyBpsPatch(source, patch);
  assert.equal(new TextDecoder().decode(result.bytes), 'XYZZXY');
});

test('bad source size and CRC are rejected before patching', () => {
  const source = bytes(1, 2, 3);
  const target = bytes(4, 5, 6);
  const patch = makePatch(source, target, targetRead([...target]));

  assert.throws(() => applyBpsPatch(bytes(1, 2), patch), (error) => error.code === 'source-size-mismatch');
  assert.throws(() => applyBpsPatch(bytes(1, 2, 4), patch), (error) => error.code === 'source-checksum-mismatch');
});

test('a mismatched output CRC is rejected even if the patch CRC is valid', () => {
  const source = bytes(1);
  const target = bytes(2);
  const patch = makePatch(source, target, targetRead([...target]));
  const view = new DataView(patch.buffer, patch.byteOffset, patch.byteLength);
  view.setUint32(patch.length - 8, 0, true);
  view.setUint32(patch.length - 4, crc32(patch.subarray(0, patch.length - 4)), true);

  assert.throws(
    () => applyBpsPatch(source, patch),
    (error) => error.code === 'target-checksum-mismatch',
  );
});

test('a TargetCopy action cannot read bytes that have not been produced', () => {
  const source = new Uint8Array();
  const target = bytes(1);
  const patch = makePatch(source, target, targetCopy(1, 0));
  assert.throws(() => applyBpsPatch(source, patch), (error) => error.code === 'malformed-patch');
});

test('corrupted patch CRC and unsafe output size are rejected', () => {
  const source = bytes(1, 2, 3);
  const target = bytes(4, 5, 6);
  const patch = makePatch(source, target, targetRead([...target]));
  const damaged = patch.slice();
  damaged[5] ^= 1;

  assert.throws(() => inspectBpsPatch(damaged), (error) => error.code === 'patch-checksum-mismatch');
  assert.throws(
    () => applyBpsPatch(source, patch, { maxTargetBytes: 2 }),
    (error) => error.code === 'target-too-large',
  );
});

test('invalid signatures are rejected', () => {
  assert.throws(() => inspectBpsPatch(bytes(0, 1, 2, 3, 4, 5)), (error) => error.code === 'malformed-patch');
  const source = bytes(1);
  const target = bytes(1);
  const patch = makePatch(source, target, sourceRead(1));
  patch[0] = 0;
  // Recompute the patch checksum so parsing reaches the signature check.
  const view = new DataView(patch.buffer);
  view.setUint32(patch.length - 4, crc32(patch.subarray(0, patch.length - 4)), true);
  assert.throws(() => inspectBpsPatch(patch), (error) => error.code === 'invalid-signature');
});
