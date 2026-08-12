export const LIVE_IPC_CHANNELS = {
  getSnapshot: 'live:get-snapshot',
  start: 'live:start',
  stop: 'live:stop',
  snapshot: 'live:snapshot',
} as const

export const HISTORY_IPC_CHANNELS = {
  list: 'history:list',
  getReview: 'history:get-review',
  listDanmaku: 'history:list-danmaku',
  searchDanmaku: 'history:search-danmaku',
  prepareDelete: 'history:prepare-delete',
  confirmDelete: 'history:confirm-delete',
} as const
