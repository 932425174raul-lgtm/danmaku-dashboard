export interface BilibiliRoomInput {
  roomId: string
}

const ROOM_ID_PATTERN = /^\d{1,20}$/u

function normalizeRoomId(value: string): string | null {
  if (!ROOM_ID_PATTERN.test(value)) return null
  const normalized = value.replace(/^0+(?=\d)/u, '')
  return normalized === '0' ? null : normalized
}

export function parseBilibiliRoomInput(input: string): BilibiliRoomInput | null {
  const trimmed = input.trim()
  const directRoomId = normalizeRoomId(trimmed)
  if (directRoomId !== null) return { roomId: directRoomId }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' || url.hostname !== 'live.bilibili.com') return null
  const pathSegments = url.pathname.split('/').filter(Boolean)
  if (pathSegments.length !== 1) return null
  const roomId = normalizeRoomId(pathSegments[0] ?? '')
  return roomId === null ? null : { roomId }
}
