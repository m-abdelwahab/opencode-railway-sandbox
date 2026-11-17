import { afterEach, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { checkDirectory, MAX_FILES, UnsafeDirectory } from "../src/workspace.ts"

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const tmp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rs-dir-"))
  dirs.push(dir)
  return dir
}

test("refuses the home folder, the root, and ancestors of home", async () => {
  const home = path.join(tmp(), "Users", "me")
  mkdirSync(home, { recursive: true })
  await expect(checkDirectory(home, home)).rejects.toBeInstanceOf(UnsafeDirectory)
  await expect(checkDirectory(path.dirname(home), home)).rejects.toThrow(/contains the home folder/)
  await expect(checkDirectory("/", home)).rejects.toThrow(/filesystem root/)
})

test("allows a project inside home", async () => {
  const home = tmp()
  const project = path.join(home, "code", "app")
  mkdirSync(project, { recursive: true })
  writeFileSync(path.join(project, "index.js"), "1")
  await expect(checkDirectory(project, home)).resolves.toBeUndefined()
})

test("refuses a non-git tree with too many files, ignoring node_modules", async () => {
  const home = tmp()
  const big = path.join(home, "big")
  mkdirSync(path.join(big, "node_modules"), { recursive: true })
  for (let i = 0; i < 50; i++) writeFileSync(path.join(big, "node_modules", `${i}.js`), "")
  await expect(checkDirectory(big, home)).resolves.toBeUndefined()
  const many = path.join(big, "data")
  mkdirSync(many)
  for (let i = 0; i <= MAX_FILES; i++) writeFileSync(path.join(many, `${i}`), "")
  await expect(checkDirectory(big, home)).rejects.toThrow(/more than 20,000 files/)
}, 60_000)

test("counts only files git would upload in a repo", async () => {
  const home = tmp()
  const repo = path.join(home, "repo")
  mkdirSync(path.join(repo, "dist"), { recursive: true })
  execSync("git init -q", { cwd: repo })
  writeFileSync(path.join(repo, ".gitignore"), "dist\n")
  for (let i = 0; i <= MAX_FILES; i++) writeFileSync(path.join(repo, "dist", `${i}`), "")
  await expect(checkDirectory(repo, home)).resolves.toBeUndefined()
}, 60_000)
