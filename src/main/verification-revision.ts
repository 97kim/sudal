import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** HEAD뿐 아니라 저장하지 않은 tracked 변경과 untracked 파일 내용도 검사 대상에 묶는다. */
export async function verificationRevision(cwd: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const git = (args: string[], stream = false) => new Promise<string>((resolveResult, reject) => {
    signal?.throwIfAborted();
    const child = spawn("git", ["--no-optional-locks", ...args], { cwd, signal, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    const timeout = setTimeout(() => child.kill(), 10_000);
    child.stdout.on("data", chunk => {
      if (stream) hash.update(chunk);
      else { output += chunk.toString(); if (output.length > 1024 * 1024) child.kill(); }
    });
    child.stderr.on("data", chunk => { error = (error + chunk.toString()).slice(-1500); });
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timeout);
      if (code === 0) resolveResult(output);
      else reject(new Error(error || "Unable to fingerprint the Git working tree"));
    });
  });
  const root = (await git(["rev-parse", "--show-toplevel"])).trim();
  const head = (await git(["rev-parse", "HEAD"])).trim();
  hash.update(head + "\0");
  await git(["-C", root, "diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"], true);
  const paths = (await git(["-C", root, "ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean).sort();
  if (paths.length > 1000) throw new Error("Too many untracked files to fingerprint (maximum 1000)");
  let bytes = 0;
  for (const name of paths) {
    signal?.throwIfAborted();
    const file = resolve(root, name);
    const rel = relative(root, file);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("..\\") || rel.startsWith("../")) throw new Error("Unexpected Git file path");
    const stat = await lstat(file);
    hash.update("\0untracked\0" + name + "\0");
    if (stat.isSymbolicLink()) { hash.update(await readlink(file)); continue; }
    if (!stat.isFile()) throw new Error("Unsupported untracked file type");
    bytes += stat.size;
    if (bytes > 50 * 1024 * 1024) throw new Error("Untracked files exceed the fingerprint limit (50 MB)");
    for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  }
  return hash.digest("hex");
}
