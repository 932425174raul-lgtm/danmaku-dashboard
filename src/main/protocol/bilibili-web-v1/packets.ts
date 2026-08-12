import { promisify } from 'node:util'
import { brotliDecompress, brotliDecompressSync, inflate, inflateSync } from 'node:zlib'

const HEADER_LENGTH = 16
const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_RECURSION_DEPTH = 4
const MAX_PACKETS_PER_FRAME = 10_000
const inflateAsync = promisify(inflate)
const brotliDecompressAsync = promisify(brotliDecompress)

export class BilibiliProtocolError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'BilibiliProtocolError'
  }
}

export interface BilibiliPacket {
  operation: number
  version: number
  sequence: number
  body: Buffer
}

export interface EncodePacketInput {
  operation: number
  version: number
  body?: Uint8Array
  sequence?: number
}

export function encodeBilibiliPacket(input: EncodePacketInput): Buffer {
  const body = input.body === undefined ? Buffer.alloc(0) : Buffer.from(input.body)
  const packet = Buffer.allocUnsafe(HEADER_LENGTH + body.byteLength)
  packet.writeUInt32BE(packet.byteLength, 0)
  packet.writeUInt16BE(HEADER_LENGTH, 4)
  packet.writeUInt16BE(input.version, 6)
  packet.writeUInt32BE(input.operation, 8)
  packet.writeUInt32BE(input.sequence ?? 1, 12)
  body.copy(packet, HEADER_LENGTH)
  return packet
}

function decompress(version: number, body: Buffer): Buffer {
  let output: Buffer
  try {
    output =
      version === 2
        ? inflateSync(body, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
        : brotliDecompressSync(body, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
  } catch {
    throw new BilibiliProtocolError('DECOMPRESSION_FAILED')
  }
  if (output.byteLength > MAX_DECOMPRESSED_BYTES) {
    throw new BilibiliProtocolError('DECOMPRESSED_FRAME_TOO_LARGE')
  }
  return output
}

function decodeInto(frame: Buffer, depth: number, output: BilibiliPacket[]): void {
  if (depth > MAX_RECURSION_DEPTH) throw new BilibiliProtocolError('MAX_RECURSION_EXCEEDED')
  if (frame.byteLength > MAX_FRAME_BYTES && depth === 0) {
    throw new BilibiliProtocolError('FRAME_TOO_LARGE')
  }

  let offset = 0
  while (offset < frame.byteLength) {
    if (output.length >= MAX_PACKETS_PER_FRAME) {
      throw new BilibiliProtocolError('TOO_MANY_PACKETS')
    }
    if (frame.byteLength - offset < HEADER_LENGTH) {
      throw new BilibiliProtocolError('TRUNCATED_HEADER')
    }

    const packetLength = frame.readUInt32BE(offset)
    const headerLength = frame.readUInt16BE(offset + 4)
    const version = frame.readUInt16BE(offset + 6)
    const operation = frame.readUInt32BE(offset + 8)
    const sequence = frame.readUInt32BE(offset + 12)
    if (headerLength !== HEADER_LENGTH || packetLength < HEADER_LENGTH) {
      throw new BilibiliProtocolError('INVALID_HEADER')
    }
    if (offset + packetLength > frame.byteLength) {
      throw new BilibiliProtocolError('PACKET_LENGTH_OUT_OF_BOUNDS')
    }

    const body = frame.subarray(offset + headerLength, offset + packetLength)
    if (version === 2 || version === 3) {
      decodeInto(decompress(version, body), depth + 1, output)
    } else {
      output.push({ operation, version, sequence, body })
    }
    offset += packetLength
  }
}

export function decodeBilibiliPackets(frame: Uint8Array): BilibiliPacket[] {
  const output: BilibiliPacket[] = []
  decodeInto(Buffer.from(frame), 0, output)
  return output
}

async function decompressAsync(version: number, body: Buffer): Promise<Buffer> {
  try {
    const output = await (version === 2
      ? inflateAsync(body, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
      : brotliDecompressAsync(body, { maxOutputLength: MAX_DECOMPRESSED_BYTES }))
    if (output.byteLength > MAX_DECOMPRESSED_BYTES) {
      throw new BilibiliProtocolError('DECOMPRESSED_FRAME_TOO_LARGE')
    }
    return output
  } catch (error) {
    if (error instanceof BilibiliProtocolError) throw error
    throw new BilibiliProtocolError('DECOMPRESSION_FAILED')
  }
}

async function decodeIntoAsync(
  frame: Buffer,
  depth: number,
  output: BilibiliPacket[],
): Promise<void> {
  if (depth > MAX_RECURSION_DEPTH) throw new BilibiliProtocolError('MAX_RECURSION_EXCEEDED')
  if (frame.byteLength > MAX_FRAME_BYTES && depth === 0) {
    throw new BilibiliProtocolError('FRAME_TOO_LARGE')
  }

  let offset = 0
  while (offset < frame.byteLength) {
    if (output.length >= MAX_PACKETS_PER_FRAME) {
      throw new BilibiliProtocolError('TOO_MANY_PACKETS')
    }
    if (frame.byteLength - offset < HEADER_LENGTH) {
      throw new BilibiliProtocolError('TRUNCATED_HEADER')
    }

    const packetLength = frame.readUInt32BE(offset)
    const headerLength = frame.readUInt16BE(offset + 4)
    const version = frame.readUInt16BE(offset + 6)
    const operation = frame.readUInt32BE(offset + 8)
    const sequence = frame.readUInt32BE(offset + 12)
    if (headerLength !== HEADER_LENGTH || packetLength < HEADER_LENGTH) {
      throw new BilibiliProtocolError('INVALID_HEADER')
    }
    if (offset + packetLength > frame.byteLength) {
      throw new BilibiliProtocolError('PACKET_LENGTH_OUT_OF_BOUNDS')
    }

    const body = frame.subarray(offset + headerLength, offset + packetLength)
    if (version === 2 || version === 3) {
      await decodeIntoAsync(await decompressAsync(version, body), depth + 1, output)
    } else {
      output.push({ operation, version, sequence, body })
    }
    offset += packetLength
  }
}

export async function decodeBilibiliPacketsAsync(frame: Uint8Array): Promise<BilibiliPacket[]> {
  const output: BilibiliPacket[] = []
  await decodeIntoAsync(Buffer.from(frame), 0, output)
  return output
}
