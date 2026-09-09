import { useCallback, useEffect, useState } from 'react'

/** 通用异步加载：返回数据、错误、重载函数。 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[],
): { data: T | undefined; error: string | undefined; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(undefined)
    loader()
      .then((value) => {
        if (alive) setData(value)
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // deps 由调用方显式传入（useAsync 的设计约定），无 eslint-plugin-react-hooks 时无需 disable
  }, [...deps, tick])

  return { data, error, loading, reload }
}
