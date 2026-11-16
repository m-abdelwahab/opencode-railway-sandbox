import { describe, expect, test } from "bun:test"
import { classify } from "../src/free-vm.ts"
import { AnonymousUnavailable } from "../src/types.ts"

// Captured from `ssh railway.new` on 2026-11-16 while anonymous trials were capacity-capped.
const AGENT_PATH_DISABLED = '{"description":"The agent path is temporarily unavailable. Try again later.","status":"error"}\n'
const TTY_REFUSAL =
  "\n  Anonymous trials are unavailable right now. Sign up to keep building.\n  Sign up: https://railway.com/ssh-signup?code=yRmdcfQZZqkfb5Lb94J8Tw\n\nConnection to railway.new closed.\n"

describe("classify", () => {
  test("JSON refusal on stderr raises AnonymousUnavailable", () => {
    expect(() => classify({ code: 0, stdout: "", stderr: AGENT_PATH_DISABLED })).toThrow(AnonymousUnavailable)
  })

  test("text refusal carries the sign-up link", () => {
    try {
      classify({ code: 255, stdout: TTY_REFUSAL, stderr: "" })
      throw new Error("expected a refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(AnonymousUnavailable)
      expect((error as AnonymousUnavailable).signupURL).toBe("https://railway.com/ssh-signup?code=yRmdcfQZZqkfb5Lb94J8Tw")
    }
  })

  test("network failures are not mistaken for refusals", () => {
    expect(() => classify({ code: 255, stdout: "", stderr: "ssh: connect to host railway.new port 22: Operation timed out" })).toThrow(
      /Could not reach railway.new/,
    )
  })

  test("success returns the welcome manifest", () => {
    const manifest = { preview_url: "https://box.up.railway.app", claim_url: "https://railway.com/claim/abc" }
    expect(classify({ code: 0, stdout: "__railway_computer_ready__\n", stderr: JSON.stringify(manifest) + "\n" })).toEqual([manifest])
  })
})
