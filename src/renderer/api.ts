import type { Bridge, Reply } from '../shared/bridge'
declare global { interface Window { focusResume: Bridge } }
export const api = window.focusResume
export async function unwrap<T>(promise: Promise<Reply<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) throw new Error(result.error)
  return result.value
}
export const formatDuration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(unit => String(unit).padStart(2, '0')).join(':')
}
export const dateLabel = (value: number) => new Intl.DateTimeFormat('zh-CN', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
}).format(value)
