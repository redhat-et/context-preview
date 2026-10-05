import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"

export function reportCacheFile(worktree) {
  const root = process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR ?? path.join(os.homedir(), ".cache", "opencode", "context-preview")
  const key = createHash("sha256").update(path.resolve(worktree)).digest("hex").slice(0, 24)
  return path.join(root, `${key}.json`)
}
