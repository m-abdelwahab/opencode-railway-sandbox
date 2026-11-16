import { expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pack } from "../src/workspace.ts"

test("packs tracked and untracked files, skipping ignored and deleted ones", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rc-pack-"))
  try {
    execSync("git init -q", { cwd: dir })
    writeFileSync(path.join(dir, ".gitignore"), "node_modules\n.env\n")
    writeFileSync(path.join(dir, "tracked.js"), "1")
    writeFileSync(path.join(dir, "gone.js"), "2")
    execSync("git add -A && git -c user.name=t -c user.email=t@t commit -qm init", { cwd: dir })
    rmSync(path.join(dir, "gone.js"))
    writeFileSync(path.join(dir, "untracked.md"), "3")
    writeFileSync(path.join(dir, ".env"), "SECRET=1")
    mkdirSync(path.join(dir, "node_modules"))
    writeFileSync(path.join(dir, "node_modules", "x.js"), "4")

    const packed = await pack(dir)
    const listing = execSync("tar -tzf -", { input: packed.archive }).toString().split("\n").filter(Boolean).sort()
    expect(packed.git).toBe(true)
    expect(listing).toEqual([".gitignore", "tracked.js", "untracked.md"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
