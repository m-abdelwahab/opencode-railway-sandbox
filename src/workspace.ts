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
