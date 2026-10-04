const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

const asBytes = (input, label) => {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new BpsError('invalid-input', `${label} must be a byte buffer.`);
};

export class BpsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BpsError';
    this.code = code;
    this.details = details;
  }
}

/** Calculate the standard reflected CRC-32 used by BPS patches. */
export function crc32(input) {
  const bytes = asBytes(input, 'Input');
  let value = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    value = CRC32_TABLE[(value ^ bytes[i]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function readNumber(bytes, cursor, limit) {
  let value = 0;
  let shift = 1;

  while (cursor.offset < limit) {
    const byte = bytes[cursor.offset];
    cursor.offset += 1;
    value += (byte & 0x7f) * shift;

    if (!Number.isSafeInteger(value)) {
      throw new BpsError('malformed-patch', 'The BPS patch contains an integer that is too large.');
    }
    if (byte & 0x80) return value;

    shift *= 128;
    if (!Number.isSafeInteger(shift)) {
      throw new BpsError('malformed-patch', 'The BPS patch contains an integer that is too large.');
    }
    value += shift;
    if (!Number.isSafeInteger(value)) {
      throw new BpsError('malformed-patch', 'The BPS patch contains an integer that is too large.');
    }
  }

  throw new BpsError('malformed-patch', 'The BPS patch ended unexpectedly.');
}

/** Parse the BPS header and verify the patch CRC before any patch is applied. */
export function inspectBpsPatch(input) {
  const bytes = asBytes(input, 'BPS patch');
  if (bytes.length < 19) {
    throw new BpsError('malformed-patch', 'The file is too small to be a valid BPS patch.');
  }
  if (bytes[0] !== 0x42 || bytes[1] !== 0x50 || bytes[2] !== 0x53 || bytes[3] !== 0x31) {
    throw new BpsError('invalid-signature', 'The file does not have a BPS1 signature.');
  }

  const footerOffset = bytes.length - 12;
  const cursor = { offset: 4 };
  const sourceSize = readNumber(bytes, cursor, footerOffset);
  const targetSize = readNumber(bytes, cursor, footerOffset);
  const metadataSize = readNumber(bytes, cursor, footerOffset);

  if (metadataSize > footerOffset - cursor.offset) {
    throw new BpsError('malformed-patch', 'The BPS metadata extends past the end of the patch.');
  }
  const metadata = bytes.slice(cursor.offset, cursor.offset + metadataSize);
  cursor.offset += metadataSize;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sourceCrc32 = view.getUint32(bytes.length - 12, true);
  const targetCrc32 = view.getUint32(bytes.length - 8, true);
  const patchCrc32 = view.getUint32(bytes.length - 4, true);
  const actualPatchCrc32 = crc32(bytes.subarray(0, bytes.length - 4));

  if (actualPatchCrc32 !== patchCrc32) {
    throw new BpsError('patch-checksum-mismatch', 'The BPS patch checksum is invalid.', {
      expected: patchCrc32,
      actual: actualPatchCrc32,
    });
  }

  return {
    sourceSize,
    targetSize,
    metadataSize,
    metadata,
    sourceCrc32,
    targetCrc32,
    patchCrc32,
    actionsOffset: cursor.offset,
    footerOffset,
  };
}

/**
 * Apply a verified BPS patch in memory. The source ROM must match both the
 * length and CRC recorded in the patch. No files are uploaded or modified.
 */
export function applyBpsPatch(sourceInput, patchInput, options = {}) {
  const source = asBytes(sourceInput, 'Source ROM');
  const patch = asBytes(patchInput, 'BPS patch');
  const info = inspectBpsPatch(patch);
  const maxTargetBytes = options.maxTargetBytes ?? 64 * 1024 * 1024;

  if (source.length !== info.sourceSize) {
    throw new BpsError('source-size-mismatch', 'The source ROM has the wrong size.', {
      expected: info.sourceSize,
      actual: source.length,
    });
  }

  const actualSourceCrc32 = crc32(source);
  if (actualSourceCrc32 !== info.sourceCrc32) {
    throw new BpsError('source-checksum-mismatch', 'The source ROM checksum does not match this patch.', {
      expected: info.sourceCrc32,
      actual: actualSourceCrc32,
    });
  }

  if (!Number.isSafeInteger(info.targetSize) || info.targetSize > maxTargetBytes) {
    throw new BpsError('target-too-large', 'The output ROM exceeds the safe in-browser size limit.', {
      maxTargetBytes,
      actual: info.targetSize,
    });
  }

  const target = new Uint8Array(info.targetSize);
  const cursor = { offset: info.actionsOffset };
  let targetOffset = 0;
  let sourceRelativeOffset = 0;
  let targetRelativeOffset = 0;

  while (targetOffset < target.length) {
    const command = readNumber(patch, cursor, info.footerOffset);
    const action = command % 4;
    const length = Math.floor(command / 4) + 1;

    if (!Number.isSafeInteger(length) || length > target.length - targetOffset) {
      throw new BpsError('malformed-patch', 'A BPS action writes beyond the declared output size.');
    }

    if (action === 0) {
      const end = targetOffset + length;
      if (end > source.length) {
        throw new BpsError('malformed-patch', 'A SourceRead action extends beyond the source ROM.');
      }
      target.set(source.subarray(targetOffset, end), targetOffset);
    } else if (action === 1) {
      if (length > info.footerOffset - cursor.offset) {
        throw new BpsError('malformed-patch', 'A TargetRead action extends beyond the patch data.');
      }
      target.set(patch.subarray(cursor.offset, cursor.offset + length), targetOffset);
      cursor.offset += length;
    } else if (action === 2) {
      const delta = readNumber(patch, cursor, info.footerOffset);
      const magnitude = Math.floor(delta / 2);
      sourceRelativeOffset += delta % 2 ? -magnitude : magnitude;
      const end = sourceRelativeOffset + length;
      if (
        !Number.isSafeInteger(sourceRelativeOffset) ||
        sourceRelativeOffset < 0 ||
        !Number.isSafeInteger(end) ||
        end > source.length
      ) {
        throw new BpsError('malformed-patch', 'A SourceCopy action points outside the source ROM.');
      }
      target.set(source.subarray(sourceRelativeOffset, end), targetOffset);
      sourceRelativeOffset = end;
    } else {
      const delta = readNumber(patch, cursor, info.footerOffset);
      const magnitude = Math.floor(delta / 2);
      targetRelativeOffset += delta % 2 ? -magnitude : magnitude;

      for (let i = 0; i < length; i += 1) {
        const readOffset = targetRelativeOffset + i;
        const writeOffset = targetOffset + i;
        // TargetCopy may intentionally overlap its output, but may only read
        // bytes which have already been produced.
        if (readOffset < 0 || readOffset >= writeOffset) {
          throw new BpsError('malformed-patch', 'A TargetCopy action reads data that has not been produced yet.');
        }
        target[writeOffset] = target[readOffset];
      }
      targetRelativeOffset += length;
    }

    targetOffset += length;
  }

  if (cursor.offset !== info.footerOffset) {
    throw new BpsError('malformed-patch', 'The BPS patch contains unexpected data after its actions.');
  }

  const actualTargetCrc32 = crc32(target);
  if (actualTargetCrc32 !== info.targetCrc32) {
    throw new BpsError('target-checksum-mismatch', 'The generated ROM checksum does not match the patch.', {
      expected: info.targetCrc32,
      actual: actualTargetCrc32,
    });
  }

  return {
    bytes: target,
    info,
    sourceCrc32: actualSourceCrc32,
    targetCrc32: actualTargetCrc32,
  };
}
