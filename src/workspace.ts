import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

const run = (cmd: string, args: string[], options: { cwd: string; input?: Buffer; env?: NodeJS.ProcessEnv }) =>
  new Promise<{ code: number; stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env ?? process.env })
    const out: Buffer[] = []
    let err = ""
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }))
    if (options.input) child.stdin.end(options.input)
    else child.stdin.end()
  })

export interface PackedWorkspace {
  readonly archive: Buffer
  readonly files: number
  readonly git: boolean
}

/**
 * Packs the directory into a gzipped tarball. In a git checkout this ships tracked and untracked-but-not-ignored
 * files, i.e. the working tree exactly as the local agent sees it, without `.git` or ignored build output.
 */
export async function pack(directory: string): Promise<PackedWorkspace> {
  const packed = await packArchive(directory)
  if (packed.archive.byteLength > MAX_BYTES)
    throw new UnsafeDirectory(
      `The project packs to ${(packed.archive.byteLength / 1024 / 1024).toFixed(0)} MB, over the ${MAX_BYTES / 1024 / 1024} MB limit. Nothing was uploaded. Add large build output or data files to .gitignore, or move this session to a smaller project folder.`,
    )
  return packed
}

async function packArchive(directory: string): Promise<PackedWorkspace> {
  const git = (await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: directory }).catch(() => undefined))
    ?.stdout.toString()
    .trim() === "true"
  // macOS bsdtar would otherwise add AppleDouble `._*` entries and xattr headers that GNU tar warns about.
  const env = { ...process.env, COPYFILE_DISABLE: "1" }
  const macFlags = process.platform === "darwin" ? ["--no-mac-metadata", "--no-xattrs"] : []

  if (git) {
    const listed = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: directory })
    if (listed.code !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`)
    // Tracked files deleted from the working tree are still listed; skip them so tar does not fail.
    const files = [...new Set(listed.stdout.toString().split("\0").filter(Boolean))].filter((file) =>
      existsSync(path.join(directory, file)),
    )
    const tar = await run("tar", [...macFlags, "--null", "-T", "-", "-czf", "-"], {
      cwd: directory,
      env,
      input: Buffer.from(files.join("\0")),
    })
    if (tar.code !== 0) throw new Error(`tar failed: ${tar.stderr}`)
    return { archive: tar.stdout, files: files.length, git }
  }

  const tar = await run(
    "tar",
    [...macFlags, "--exclude=node_modules", "--exclude=.git", "--exclude=.DS_Store", "-czf", "-", "."],
    { cwd: directory, env },
  )
  if (tar.code !== 0) throw new Error(`tar failed: ${tar.stderr}`)
  return { archive: tar.stdout, files: -1, git }
}

/** Most files and bytes a task may upload. Real projects (sans node_modules and ignored output) stay far below. */
export const MAX_FILES = 20_000
export const MAX_BYTES = 200 * 1024 * 1024

export class UnsafeDirectory extends Error {}

/** Counts files outside node_modules/.git, giving up once past `limit`. */
async function countFiles(directory: string, limit: number) {
  const { readdir } = await import("node:fs/promises")
  let count = 0
  const stack = [directory]
  while (stack.length && count <= limit) {
    const entries = await readdir(stack.pop()!, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      if (entry.isDirectory()) stack.push(path.join(entry.parentPath, entry.name))
      else if (++count > limit) break
    }
  }
  return count
}

/**
 * Refuses directories that are clearly not a project, before anything is packed: the home folder, the filesystem root,
 * any ancestor of the home folder, and trees with too many files to be one project. A session started in `~` would
 * otherwise upload the user's whole home folder.
 */
export async function checkDirectory(directory: string, home: string) {
  const resolved = path.resolve(directory)
  const hint = "Move this session to the project's folder (or start OpenCode there) and retry."
  if (resolved === path.parse(resolved).root) throw new UnsafeDirectory(`The session's folder is the filesystem root, so nothing was uploaded. ${hint}`)
  if (resolved === path.resolve(home)) throw new UnsafeDirectory(`The session's folder is the home folder (${resolved}), so nothing was uploaded. ${hint}`)
  if (path.resolve(home).startsWith(resolved + path.sep))
    throw new UnsafeDirectory(`The session's folder (${resolved}) contains the home folder, so nothing was uploaded. ${hint}`)
  const listed = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: resolved }).catch(() => undefined)
  const files = listed?.code === 0 ? listed.stdout.toString().split("\0").filter(Boolean).length : await countFiles(resolved, MAX_FILES)
  if (files > MAX_FILES)
    throw new UnsafeDirectory(
      `The session's folder (${resolved}) has more than ${MAX_FILES.toLocaleString("en-US")} files to upload, which looks like more than one project. Nothing was uploaded. ${hint}`,
    )
}
