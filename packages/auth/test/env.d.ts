declare namespace Cloudflare {
  interface Env {
    HYPERDRIVE: Hyperdrive
    /** 指向无人监听的端口（vitest.config.ts）：用于证明某条路径没有查库 */
    HYPERDRIVE_REFUSED: Hyperdrive
    CACHE: KVNamespace
    CACHE_EMPTY: KVNamespace
    RL_AUTH: RateLimit
  }
}
