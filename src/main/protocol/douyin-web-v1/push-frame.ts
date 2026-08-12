import { gunzipSync } from 'node:zlib'

const MAX_FRAME_BYTES = 1024 * 1024
const MAX_INFLATED_BYTES = 8 * 1024 * 1024
const MAX_MESSAGE_COUNT = 5_000
const MAX_METHOD_BYTES = 96

export type ProtocolErrorCode =
  | 'FRAME_TOO_LARGE'
  | 'INFLATED_PAYLOAD_TOO_LARGE'
  | 'MALFORMED_PROTOBUF'
  | 'MISSING_PAYLOAD'
  | 'TOO_MANY_MESSAGES'
  | 'UNSUPPORTED_COMPRESSION'
  | 'UNSUPPORTED_PAYLOAD_TYPE'

export class DouyinProtocolError extends Error {
  readonly code: ProtocolErrorCode

  constructor(code: ProtocolErrorCode) {
    super(code)
    this.name = 'DouyinProtocolError'
    this.code = code
  }
}

export interface DouyinPushFrameSummary {
  compression: 'gzip' | 'none'
  payloadType: 'protobuf' | 'unknown'
  messageMethods: string[]
  needsAck: boolean
}

export interface DouyinChatPayload {
  displayName: string
  content: string
  localUserKey?: string
}

export type DouyinOutboundFrameKind = 'ack' | 'heartbeat' | 'unknown'

class ProtobufReader {
  private offset = 0
  private readonly bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  get done(): boolean {
    return this.offset === this.bytes.length
  }

  readTag(): { field: number; wire: number } {
    const tag = this.readVarintNumber()
    const field = Math.floor(tag / 8)
    const wire = tag & 0x07

    if (field === 0 || ![0, 1, 2, 5].includes(wire)) {
      throw new DouyinProtocolError('MALFORMED_PROTOBUF')
    }

    return { field, wire }
  }

  readVarintBoolean(): boolean {
    return this.readVarintNumber() !== 0
  }

  readVarintBigInt(): bigint {
    let value = 0n

    for (let index = 0; index < 10; index += 1) {
      const byte = this.bytes[this.offset]
      if (byte === undefined || (index === 9 && byte > 1)) {
        throw new DouyinProtocolError('MALFORMED_PROTOBUF')
      }

      this.offset += 1
      value |= BigInt(byte & 0x7f) << BigInt(index * 7)
      if ((byte & 0x80) === 0) {
        return value
      }
    }

    throw new DouyinProtocolError('MALFORMED_PROTOBUF')
  }

  readBytes(): Uint8Array {
    const length = this.readVarintNumber()
    const end = this.offset + length

    if (!Number.isSafeInteger(end) || end > this.bytes.length) {
      throw new DouyinProtocolError('MALFORMED_PROTOBUF')
    }

    const value = this.bytes.subarray(this.offset, end)
    this.offset = end
    return value
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.skipVarint()
        return
      case 1:
        this.skipFixed(8)
        return
      case 2:
        this.readBytes()
        return
      case 5:
        this.skipFixed(4)
        return
      default:
        throw new DouyinProtocolError('MALFORMED_PROTOBUF')
    }
  }

  private readVarintNumber(): number {
    let value = 0
    let factor = 1

    for (let index = 0; index < 10; index += 1) {
      const byte = this.bytes[this.offset]
      if (byte === undefined) {
        throw new DouyinProtocolError('MALFORMED_PROTOBUF')
      }

      this.offset += 1
      value += (byte & 0x7f) * factor

      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(value)) {
          throw new DouyinProtocolError('MALFORMED_PROTOBUF')
        }
        return value
      }

      factor *= 128
    }

    throw new DouyinProtocolError('MALFORMED_PROTOBUF')
  }

  private skipVarint(): void {
    for (let index = 0; index < 10; index += 1) {
      const byte = this.bytes[this.offset]
      if (byte === undefined) {
        throw new DouyinProtocolError('MALFORMED_PROTOBUF')
      }

      this.offset += 1
      if ((byte & 0x80) === 0) {
        if (index === 9 && byte > 1) {
          throw new DouyinProtocolError('MALFORMED_PROTOBUF')
        }
        return
      }
    }

    throw new DouyinProtocolError('MALFORMED_PROTOBUF')
  }

  private skipFixed(length: number): void {
    const end = this.offset + length
    if (end > this.bytes.length) {
      throw new DouyinProtocolError('MALFORMED_PROTOBUF')
    }
    this.offset = end
  }
}

const textDecoder = new TextDecoder('utf-8', { fatal: true })

function decodeText(bytes: Uint8Array): string {
  try {
    return textDecoder.decode(bytes)
  } catch {
    throw new DouyinProtocolError('MALFORMED_PROTOBUF')
  }
}

function isInflatedPayloadLimitError(error: unknown): boolean {
  return (
    error instanceof RangeError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ERR_BUFFER_TOO_LARGE')
  )
}

function decodeHeader(bytes: Uint8Array): { key?: string; value?: string } {
  const reader = new ProtobufReader(bytes)
  let key: string | undefined
  let value: string | undefined

  while (!reader.done) {
    const tag = reader.readTag()
    if (tag.wire !== 2) {
      reader.skip(tag.wire)
      continue
    }

    if (tag.field === 1) {
      key = decodeText(reader.readBytes())
    } else if (tag.field === 2) {
      value = decodeText(reader.readBytes())
    } else {
      reader.skip(tag.wire)
    }
  }

  return { ...(key === undefined ? {} : { key }), ...(value === undefined ? {} : { value }) }
}

function decodeMessageMethod(bytes: Uint8Array): string | undefined {
  const reader = new ProtobufReader(bytes)

  while (!reader.done) {
    const tag = reader.readTag()
    if (tag.field === 1 && tag.wire === 2) {
      const methodBytes = reader.readBytes()
      if (methodBytes.length > MAX_METHOD_BYTES) {
        throw new DouyinProtocolError('MALFORMED_PROTOBUF')
      }

      const method = decodeText(methodBytes)
      return /^[A-Za-z][A-Za-z0-9_.]{0,95}$/.test(method) ? method : undefined
    }
    reader.skip(tag.wire)
  }

  return undefined
}

function decodeMessageEnvelope(bytes: Uint8Array): { method?: string; payload?: Uint8Array } {
  const reader = new ProtobufReader(bytes)
  let method: string | undefined
  let payload: Uint8Array | undefined

  while (!reader.done) {
    const tag = reader.readTag()
    if (tag.field === 1 && tag.wire === 2) {
      const methodBytes = reader.readBytes()
      if (methodBytes.length > MAX_METHOD_BYTES) {
        throw new DouyinProtocolError('MALFORMED_PROTOBUF')
      }
      const candidate = decodeText(methodBytes)
      method = /^[A-Za-z][A-Za-z0-9_.]{0,95}$/.test(candidate) ? candidate : undefined
    } else if (tag.field === 2 && tag.wire === 2) {
      payload = reader.readBytes()
    } else {
      reader.skip(tag.wire)
    }
  }

  return {
    ...(method === undefined ? {} : { method }),
    ...(payload === undefined ? {} : { payload }),
  }
}

function decodeResponse(
  bytes: Uint8Array,
): Pick<DouyinPushFrameSummary, 'messageMethods' | 'needsAck'> {
  const reader = new ProtobufReader(bytes)
  const messageMethods: string[] = []
  let messageCount = 0
  let needsAck = false

  while (!reader.done) {
    const tag = reader.readTag()
    if (tag.field === 1 && tag.wire === 2) {
      messageCount += 1
      if (messageCount > MAX_MESSAGE_COUNT) {
        throw new DouyinProtocolError('TOO_MANY_MESSAGES')
      }

      const method = decodeMessageMethod(reader.readBytes())
      if (method !== undefined) {
        messageMethods.push(method)
      }
    } else if (tag.field === 9 && tag.wire === 0) {
      needsAck = reader.readVarintBoolean()
    } else {
      reader.skip(tag.wire)
    }
  }

  return { messageMethods, needsAck }
}

export function classifyDouyinOutboundFrame(frame: Uint8Array): DouyinOutboundFrameKind {
  if (frame.length > MAX_FRAME_BYTES) {
    throw new DouyinProtocolError('FRAME_TOO_LARGE')
  }

  const reader = new ProtobufReader(frame)
  let payloadType: string | undefined
  while (!reader.done) {
    const tag = reader.readTag()
    if (tag.field === 7 && tag.wire === 2) {
      payloadType = decodeText(reader.readBytes())
    } else {
      reader.skip(tag.wire)
    }
  }

  if (payloadType === 'ack') {
    return 'ack'
  }
  if (payloadType === 'hb') {
    return 'heartbeat'
  }
  return 'unknown'
}

function decodeResponseBytes(frame: Uint8Array): {
  compression: 'gzip' | 'none'
  responseBytes: Uint8Array
} {
  if (frame.length > MAX_FRAME_BYTES) {
    throw new DouyinProtocolError('FRAME_TOO_LARGE')
  }

  const reader = new ProtobufReader(frame)
  let compressionHeader: string | undefined
  let payloadEncoding: string | undefined
  let payloadType: string | undefined
  let payload: Uint8Array | undefined

  while (!reader.done) {
    const tag = reader.readTag()
    if (tag.field === 5 && tag.wire === 2) {
      const header = decodeHeader(reader.readBytes())
      if (header.key === 'compress_type') {
        compressionHeader = header.value
      }
    } else if (tag.field === 6 && tag.wire === 2) {
      payloadEncoding = decodeText(reader.readBytes())
    } else if (tag.field === 7 && tag.wire === 2) {
      payloadType = decodeText(reader.readBytes())
    } else if (tag.field === 8 && tag.wire === 2) {
      payload = reader.readBytes()
    } else {
      reader.skip(tag.wire)
    }
  }

  if (payload === undefined) {
    throw new DouyinProtocolError('MISSING_PAYLOAD')
  }
  if (payloadType !== 'pb' && payloadType !== 'msg') {
    throw new DouyinProtocolError('UNSUPPORTED_PAYLOAD_TYPE')
  }

  const encoding = compressionHeader ?? payloadEncoding ?? 'none'
  let responseBytes: Uint8Array
  if (encoding === 'gzip') {
    try {
      responseBytes = gunzipSync(payload, { maxOutputLength: MAX_INFLATED_BYTES })
    } catch (error) {
      if (isInflatedPayloadLimitError(error)) {
        throw new DouyinProtocolError('INFLATED_PAYLOAD_TOO_LARGE')
      }
      throw new DouyinProtocolError('MALFORMED_PROTOBUF')
    }
  } else if (encoding === 'none') {
    responseBytes = payload
  } else {
    throw new DouyinProtocolError('UNSUPPORTED_COMPRESSION')
  }

  return { compression: encoding, responseBytes }
}

function truncateText(value: string, limit: number): string {
  return Array.from(value.trim()).slice(0, limit).join('')
}

function decodeUser(
  bytes: Uint8Array,
  createLocalUserKey?: (platformUserId: string) => string,
): { displayName?: string; localUserKey?: string } {
  const reader = new ProtobufReader(bytes)
  let displayName: string | undefined
  let localUserKey: string | undefined
  while (!reader.done) {
    const tag = reader.readTag()
    if (tag.field === 1 && tag.wire === 0 && createLocalUserKey !== undefined) {
      localUserKey = createLocalUserKey(reader.readVarintBigInt().toString())
    } else if (tag.field === 3 && tag.wire === 2) {
      const candidate = truncateText(decodeText(reader.readBytes()), 80)
      displayName = candidate === '' ? undefined : candidate
    } else {
      reader.skip(tag.wire)
    }
  }
  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(localUserKey === undefined ? {} : { localUserKey }),
  }
}

function decodeChatPayload(
  bytes: Uint8Array,
  createLocalUserKey?: (platformUserId: string) => string,
): DouyinChatPayload | undefined {
  const reader = new ProtobufReader(bytes)
  let displayName: string | undefined
  let localUserKey: string | undefined
  let content: string | undefined

  while (!reader.done) {
    const tag = reader.readTag()
    if (tag.field === 2 && tag.wire === 2) {
      const user = decodeUser(reader.readBytes(), createLocalUserKey)
      displayName = user.displayName
      localUserKey = user.localUserKey
    } else if (tag.field === 3 && tag.wire === 2) {
      content = truncateText(decodeText(reader.readBytes()), 500)
    } else {
      reader.skip(tag.wire)
    }
  }

  if (content === undefined || content === '') {
    return undefined
  }
  return {
    displayName: displayName ?? '未署名观众',
    content,
    ...(localUserKey === undefined ? {} : { localUserKey }),
  }
}

export function decodeDouyinChatFrame(
  frame: Uint8Array,
  createLocalUserKey?: (platformUserId: string) => string,
): DouyinChatPayload[] {
  const { responseBytes } = decodeResponseBytes(frame)
  const reader = new ProtobufReader(responseBytes)
  const chats: DouyinChatPayload[] = []
  let messageCount = 0

  while (!reader.done) {
    const tag = reader.readTag()
    if (tag.field === 1 && tag.wire === 2) {
      messageCount += 1
      if (messageCount > MAX_MESSAGE_COUNT) {
        throw new DouyinProtocolError('TOO_MANY_MESSAGES')
      }
      const message = decodeMessageEnvelope(reader.readBytes())
      if (message.method === 'WebcastChatMessage' && message.payload !== undefined) {
        const chat = decodeChatPayload(message.payload, createLocalUserKey)
        if (chat !== undefined) {
          chats.push(chat)
        }
      }
    } else {
      reader.skip(tag.wire)
    }
  }
  return chats
}

export function decodeDouyinPushFrame(frame: Uint8Array): DouyinPushFrameSummary {
  const { compression, responseBytes } = decodeResponseBytes(frame)
  return {
    compression,
    payloadType: 'protobuf',
    ...decodeResponse(responseBytes),
  }
}
