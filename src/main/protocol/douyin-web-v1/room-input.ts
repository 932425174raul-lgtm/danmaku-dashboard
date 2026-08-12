export interface DouyinRoomTarget {
  roomDisplay: string
  url: string
}

const WEB_RID_PATTERN = /^\d{1,32}$/

export function parseDouyinRoomInput(input: string): DouyinRoomTarget | null {
  const value = input.trim()
  if (WEB_RID_PATTERN.test(value)) {
    return { roomDisplay: value, url: `https://live.douyin.com/${value}` }
  }

  try {
    const url = new URL(value)
    const match = /^\/(\d{1,32})\/?$/.exec(url.pathname)
    if (
      url.protocol !== 'https:' ||
      url.host !== 'live.douyin.com' ||
      url.username !== '' ||
      url.password !== '' ||
      match?.[1] === undefined
    ) {
      return null
    }

    return {
      roomDisplay: match[1],
      url: `https://live.douyin.com/${match[1]}`,
    }
  } catch {
    return null
  }
}
