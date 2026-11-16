import { afterEach, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { applyPatch, rememberPreimages } from "../src/apply.ts"

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const tmp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rs-apply-"))
  dirs.push(dir)
  return dir
}
const sh = (cwd: string, command: string) => execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString()
const LINES = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
const write = (dir: string, file: string, lines: string[]) => writeFileSync(path.join(dir, file), lines.join("\n") + "\n")

/**
 * Mirrors a real run: the local working tree (with an uncommitted edit, like a user's in-progress work) is copied to a
 * "remote" baseline commit, the remote agent edits line 3, and the diff comes back as a patch.
 */
function scenario(options: { git: boolean }) {
  const local = tmp()
  if (options.git) sh(local, "git init -q && git config user.email t@t && git config user.name t")
  write(local, "app.txt", LINES)
  if (options.git) sh(local, "git add -A && git commit -qm init")
  write(local, "app.txt", LINES.map((line, index) => (index === 19 ? "line 20 (uncommitted local edit)" : line)))

  const remote = tmp()
  sh(remote, "git init -q && git config user.email t@t && git config user.name t")
  writeFileSync(path.join(remote, "app.txt"), readFileSync(path.join(local, "app.txt")))
  sh(remote, "git add -A && git commit -qm baseline")
  const edited = readFileSync(path.join(remote, "app.txt"), "utf8").replace("line 3\n", "line 3 (remote change)\n")
  writeFileSync(path.join(remote, "app.txt"), edited)
  writeFileSync(path.join(remote, "new.txt"), "created remotely\n")
  sh(remote, "git add -A")
  const patch = path.join(tmp(), "task.patch")
  writeFileSync(patch, sh(remote, "git diff --cached --binary HEAD"))
  return { local, patch }
}

describe("applyPatch", () => {
  test("applies cleanly when nothing changed locally", async () => {
    const { local, patch } = scenario({ git: true })
    const result = await applyPatch(local, patch)
    expect(result.status).toBe("applied")
    expect(result.files.toSorted()).toEqual(["app.txt", "new.txt"])
    expect(readFileSync(path.join(local, "app.txt"), "utf8")).toContain("line 3 (remote change)")
    expect(readFileSync(path.join(local, "new.txt"), "utf8")).toBe("created remotely\n")
  })

  test("check mode reports without touching files", async () => {
    const { local, patch } = scenario({ git: true })
    const result = await applyPatch(local, patch, { check: true })
    expect(result.status).toBe("applied")
    expect(existsSync(path.join(local, "new.txt"))).toBe(false)
  })

  test("three-way merges around nearby local edits, keeping them and leaving the index alone", async () => {
    const { local, patch } = scenario({ git: true })
    await rememberPreimages(local, patch) // done when the task finishes, before the user keeps editing
    // Edits inside the hunk's context (lines 1 and 6) make a plain apply fail without overlapping the remote's line 3.
    write(local, "app.txt", LINES.map((line, index) => (index === 0 ? "line 1 (edited)" : index === 5 ? "line 6 (edited)" : index === 19 ? "line 20 (uncommitted local edit)" : line)))
    expect((await applyPatch(local, patch, { check: true })).status).toBe("conflicts")

    const result = await applyPatch(local, patch)
    const text = readFileSync(path.join(local, "app.txt"), "utf8")
    expect(result.status).toBe("merged")
    expect(text).toContain("line 3 (remote change)")
    expect(text).toContain("line 1 (edited)")
    expect(text).toContain("line 6 (edited)")
    expect(text).toContain("line 20 (uncommitted local edit)")
    expect(text).not.toContain("<<<<<<<")
    expect(readFileSync(path.join(local, "new.txt"), "utf8")).toBe("created remotely\n")
    expect(sh(local, "git diff --cached --name-only").trim()).toBe("")
  })

  test("reports conflict markers when both sides changed the same line", async () => {
    const { local, patch } = scenario({ git: true })
    await rememberPreimages(local, patch)
    write(local, "app.txt", LINES.map((line, index) => (index === 2 ? "line 3 (local change)" : index === 19 ? "line 20 (uncommitted local edit)" : line)))

    const result = await applyPatch(local, patch)
    expect(result.status).toBe("conflicts")
    expect(result.conflicts).toEqual(["app.txt"])
    expect(readFileSync(path.join(local, "app.txt"), "utf8")).toContain("<<<<<<<")
  })

  test("outside git, applies what it can and writes .rej files", async () => {
    const { local, patch } = scenario({ git: false })
    write(local, "app.txt", LINES.map((line, index) => (index === 2 ? "line 3 (local change)" : line)))

    const result = await applyPatch(local, patch)
    expect(result.status).toBe("partial")
    expect(result.rejects).toEqual(["app.txt.rej"])
    expect(readFileSync(path.join(local, "new.txt"), "utf8")).toBe("created remotely\n")
  })
})
