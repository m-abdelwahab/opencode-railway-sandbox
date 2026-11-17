import { expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pack } from "../src/workspace.ts"

test("packs tracked and untracked files, skipping ignored and deleted ones", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rs-pack-"))
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

test("withholds files that look like secrets, even when not gitignored", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rs-secrets-"))
  try {
    execSync("git init -q", { cwd: dir })
    for (const file of ["app.js", ".env", ".env.local", ".env.example", "server.key", "certs/tls.pem", "deploy/id_ed25519", "infra/terraform.tfstate", ".aws/credentials", "keys.md"])
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }), writeFileSync(path.join(dir, file), "x")
    const packed = await pack(dir)
    const listing = execSync("tar -tzf -", { input: packed.archive }).toString().split("\n").filter(Boolean).sort()
    expect(listing).toEqual([".env.example", "app.js", "keys.md"])
    expect(packed.withheld.toSorted()).toEqual([".aws/credentials", ".env", ".env.local", "certs/tls.pem", "deploy/id_ed25519", "infra/terraform.tfstate", "server.key"])
    const opted = await pack(dir, { include: [".env.local"], exclude: ["*.md"] })
    const optedListing = execSync("tar -tzf -", { input: opted.archive }).toString().split("\n").filter(Boolean).sort()
    expect(optedListing).toEqual([".env.example", ".env.local", "app.js"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("packs a non-git folder with the same rules", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rs-nogit-"))
  try {
    mkdirSync(path.join(dir, "node_modules"))
    writeFileSync(path.join(dir, "node_modules", "dep.js"), "x")
    writeFileSync(path.join(dir, "index.js"), "x")
    writeFileSync(path.join(dir, ".env"), "SECRET=1")
    const packed = await pack(dir)
    expect(execSync("tar -tzf -", { input: packed.archive }).toString().split("\n").filter(Boolean)).toEqual(["index.js"])
    expect(packed.withheld).toEqual([".env"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
