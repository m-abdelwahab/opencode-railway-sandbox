import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const git = (cwd: string, args: string[], stdin?: string) =>
  new Promise<Run>((resolve, reject) => {
    const child = spawn("git", args, { cwd })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.end(stdin)
  })

interface FilePatch {
  readonly file: string
  /** Blob the remote started from; undefined for files the patch creates. */
  readonly preimage?: string
  readonly created: boolean
  readonly deleted: boolean
}

/** Splits a `git diff` into its files, with the preimage blob each one was diffed against. */
export async function parsePatch(patchFile: string): Promise<FilePatch[]> {
  const text = await readFile(patchFile, "utf8")
  return text
    .split(/^diff --git /m)
    .slice(1)
    .map((section) => {
      const header = section.slice(0, section.indexOf("\n"))
      const target = section.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? section.match(/^rename to (.+)$/m)?.[1]
      const file = target ?? header.match(/ b\/(.+)$/)?.[1] ?? header
      const preimage = section.match(/^index ([0-9a-f]+)\.\./m)?.[1]
      const created = /^new file mode/m.test(section)
      return { file, preimage: created || !preimage || /^0+$/.test(preimage) ? undefined : preimage, created, deleted: /^deleted file mode/m.test(section) }
    })
}

/** Files a patch touches, relative to the directory it applies in. */
export async function patchFiles(_directory: string, patchFile: string) {
  return [...new Set((await parsePatch(patchFile)).map((entry) => entry.file))]
}

const isRepo = async (directory: string) =>
  (await git(directory, ["rev-parse", "--is-inside-work-tree"]).catch(() => undefined))?.stdout.trim() === "true"

/**
 * Writes the current contents of the files a patch touches into git's object store. The remote run started from
 * those same contents, so the patch's `index` lines name these blobs. That gives a later apply a merge base even
 * after the files change locally.
 */
export async function rememberPreimages(directory: string, patchFile: string) {
  if (!(await isRepo(directory))) return
  const files = (await patchFiles(directory, patchFile)).filter((file) => existsSync(path.join(directory, file)))
  if (files.length) await git(directory, ["hash-object", "-w", "--", ...files])
}

export interface ApplyResult {
  readonly status: "applied" | "merged" | "conflicts" | "partial" | "failed"
  readonly files: readonly string[]
  /** Files left with conflict markers by a three-way merge. */
  readonly conflicts: readonly string[]
  /** `.rej` files holding hunks that could not be applied. */
  readonly rejects: readonly string[]
  readonly message: string
}

/**
 * Three-way merges one file: base is the remote's starting content, theirs is base plus the patch, ours is the local
 * file. Returns whether conflicts remain. Never touches the git index.
 */
async function mergeFile(directory: string, patchFile: string, entry: FilePatch, scratch: string) {
  const ours = path.join(directory, entry.file)
  const base = path.join(scratch, "base", entry.file)
  const theirs = path.join(scratch, "theirs", entry.file)
  const content = entry.preimage ? await git(directory, ["cat-file", "blob", entry.preimage]) : { code: 0, stdout: "" }
  if (content.code !== 0) return undefined // no merge base available
  await Promise.all([mkdir(path.dirname(base), { recursive: true }), mkdir(path.dirname(theirs), { recursive: true })])
  await writeFile(base, content.stdout)
  if (entry.preimage) await writeFile(theirs, content.stdout)
  const applied = await git(path.join(scratch, "theirs"), ["apply", `--include=${entry.file}`, patchFile])
  if (applied.code !== 0) return undefined
  if (entry.deleted) return existsSync(ours) ? true : false
  if (!existsSync(ours)) {
    await mkdir(path.dirname(ours), { recursive: true })
    await writeFile(ours, await readFile(theirs))
    return false
  }
  const merged = await git(directory, ["merge-file", "-L", "local", "-L", "base", "-L", "railway", ours, base, theirs])
  return merged.code !== 0
}

export async function applyPatch(directory: string, patchFile: string, options: { check?: boolean } = {}): Promise<ApplyResult> {
  const entries = await parsePatch(patchFile)
  const files = [...new Set(entries.map((entry) => entry.file))]
  const clean = await git(directory, ["apply", "--check", patchFile])
  if (options.check)
    return {
      status: clean.code === 0 ? "applied" : "conflicts",
      files,
      conflicts: [],
      rejects: [],
      message: clean.code === 0 ? "The patch applies cleanly." : `The patch does not apply cleanly:\n${clean.stderr.trim()}`,
    }
  if (clean.code === 0 && (await git(directory, ["apply", patchFile])).code === 0)
    return { status: "applied", files, conflicts: [], rejects: [], message: "Applied cleanly." }

  // File by file: apply what applies, three-way merge what has a base, and reject the rest.
  const repo = await isRepo(directory)
  const scratch = await mkdtemp(path.join(os.tmpdir(), "rc-merge-"))
  const conflicts: string[] = []
  const merged: string[] = []
  const rejectsFor: string[] = []
  try {
    for (const entry of entries) {
      const only = `--include=${entry.file}`
      if ((await git(directory, ["apply", "--check", only, patchFile])).code === 0) {
        await git(directory, ["apply", only, patchFile])
        continue
      }
      const conflicted = repo ? await mergeFile(directory, patchFile, entry, scratch) : undefined
      if (conflicted === undefined) {
        await git(directory, ["apply", "--reject", only, patchFile])
        rejectsFor.push(entry.file)
      } else (conflicted ? conflicts : merged).push(entry.file)
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  const rejects = rejectsFor.map((file) => `${file}.rej`).filter((file) => existsSync(path.join(directory, file)))
  const status = rejects.length ? "partial" : conflicts.length ? "conflicts" : "merged"
  return {
    status,
    files,
    conflicts,
    rejects,
    message:
      status === "merged"
        ? `Applied with a three-way merge; local edits were kept${merged.length ? ` (${merged.join(", ")})` : ""}.`
        : status === "conflicts"
          ? "Merged with conflicts. Resolve the conflict markers (<<<<<<< local / >>>>>>> railway) in the listed files."
          : "Some hunks could not be applied and have no merge base; they are in the .rej files.",
  }
}
