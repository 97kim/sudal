import { execFile } from "node:child_process";

export interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * git 을 실행해 종료 코드·stdout·stderr 를 돌려준다. 실패해도 reject 하지 않는다 — 커밋처럼 실패 이유를 보여 줘야 하는 곳이 있다.
 * quotePath=false: 한글 등 비 ASCII 경로가 "\355\225\234" 로 이스케이프되지 않게 (status 출력을 파일 이름으로 그대로 쓴다).
 */
export function runGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { timeout?: number; maxBuffer?: number; input?: string } = {},
): Promise<GitRun> {
  return new Promise((resolve) => {
    const p = execFile(
      "git",
      ["-c", "core.quotePath=false", ...args],
      { cwd, env, timeout: opts.timeout ?? 15000, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // execFile 의 err.code 는 종료 코드(number) 또는 ENOENT 같은 문자열이다.
        const raw = err ? (err as { code?: unknown }).code : 0;
        resolve({
          code: typeof raw === "number" ? raw : err ? 1 : 0,
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() || (err ? err.message : ""),
        });
      },
    );
    if (opts.input !== undefined) p.stdin?.end(opts.input);
  });
}
