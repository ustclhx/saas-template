declare namespace Cloudflare {
  interface Env {
    /** 指向接受连接但从不响应的端口（vitest.config.ts） */
    HYPERDRIVE_HANGING: Hyperdrive
    /** 指向无人监听的端口（vitest.config.ts） */
    HYPERDRIVE_REFUSED: Hyperdrive
  }
}
