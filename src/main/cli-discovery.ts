// CLI 자동 탐지. macOS 앱이라 POSIX 셸만 본다.
//
// 사용자 셸 PATH가 진실의 소스다. npm/bun/asdf/brew 어디에 깔든 사용자가 터미널에서
// `claude` 칠 수 있으면 우리도 잡는다. 하드코딩된 후보 디렉토리나 패키지 매니저
// prefix 질의는 셸 PATH가 이미 포함하므로 불필요.
//
// PATH 첫 매치만 보지 않고 전체를 walk해서 모든 매치를 후보로 모은 뒤 순서대로
// verify한다. cmux wrapper처럼 첫 매치가 트램폴린이라 실패해도 같은 PATH의 다음
// 매치(예: ~/.local/bin/claude)로 자동 fallback된다.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import type { CliCandidateDto, CliStatusDto, OverrideSetResultDto, Provider } from "@shared/ipc";
import { mt } from "./i18n";

type CliStatus = Pick<CliStatusDto, "installed" | "path" | "source" | "error">;

export interface CliDiscovery {
  find(provider: Provider): Promise<CliStatus>;
  buildEnv(): Promise<NodeJS.ProcessEnv>;
  invalidate(provider?: Provider): void;
  setOverride(provider: Provider, binPath: string | null): OverrideSetResultDto;
  // 사용자에게 보여줄 후보 리스트. PATH walk + 각각 verify 결과 포함.
  listCandidates(provider: Provider): Promise<CliCandidateDto[]>;
}

/**
 * --version 첫 줄. 응답이 없거나 실패하면 null.
 * 동명 가짜 스크립트가 PATH에 있을 수 있으니 응답 유무만 가볍게 확인한다
 * (provider별 출력 포맷 strict 매치는 false negative가 늘어 채택하지 않음).
 */
function captureVersion(binPath: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binPath, ["--version"], { timeout: 1500, env }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const text = (stdout || stderr || "").toString().trim();
      resolve(text ? text.split("\n")[0] : null);
    });
  });
}

/**
 * 사용자 로그인 셸의 PATH. 모든 POSIX 셸(bash/zsh/fish)이 자식 프로세스에 PATH를 콜론 join으로
 * export하므로, 외부 명령 printenv를 통해 받으면 셸 별 분기가 불필요하다.
 * (fish는 내부적으로 $PATH가 list지만 export 시 콜론으로 join — fish 공식 문서)
 */
class ShellPath {
  private cached: string[] | null = null;
  private inflight: Promise<string[]> | null = null;

  capture(): Promise<string[]> {
    if (this.cached) return Promise.resolve(this.cached);
    if (this.inflight) return this.inflight;
    const shell = process.env.SHELL || "/bin/zsh";
    this.inflight = new Promise((resolve) => {
      execFile(shell, ["-ilc", "printenv PATH"], { timeout: 8000 }, (err, stdout) => {
        const list = err || !stdout ? [] : stdout.toString().trim().split(":").filter(Boolean);
        this.cached = list;
        this.inflight = null;
        resolve(list);
      });
    });
    return this.inflight;
  }

  invalidate(): void {
    this.cached = null;
    this.inflight = null;
  }
}

/**
 * 사용자가 직접 지정한 경로. userData 디렉토리에 JSON으로 저장한다. localStorage는 렌더러 origin에 종속이라
 * CLI 경로처럼 main 권한이 필요한 데이터를 저장하기엔 부적절(렌더러 조작 위험).
 */
class OverrideStore {
  private cache: Record<string, string> | null = null;

  constructor(private readonly filePath: string) {}

  get(provider: Provider): string | null {
    this.cache ??= this.readFromDisk();
    return this.cache[provider] || null;
  }

  set(provider: Provider, binPath: string | null): OverrideSetResultDto {
    // 매 write 전에 디스크에서 fresh read — 외부에서 파일을 수정한 경우 메모리
    // 캐시가 stale일 수 있으므로 그 변경을 덮어쓰지 않도록 한다.
    const data = { ...this.readFromDisk() };
    if (binPath) data[provider] = binPath;
    else delete data[provider];
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf8");
      // 디스크 성공 후에만 메모리 갱신 — 거짓 성공 상태 방지
      this.cache = data;
      return { ok: true };
    } catch (e) {
      console.error("[cli-discovery] override persist failed:", e);
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "EACCES" || code === "EPERM") return { ok: false, message: mt("session.error.cli.permissionDenied", { path: this.filePath }) };
      if (code === "ENOSPC") return { ok: false, message: mt("session.error.cli.diskFull") };
      if (code === "EROFS") return { ok: false, message: mt("session.error.cli.readonlyFs") };
      return {
        ok: false,
        message: e instanceof Error ? mt("session.error.cli.saveFailed", { detail: e.message }) : mt("session.error.cli.saveFailedUnknown"),
      };
    }
  }

  // 디스크에서 fresh read. 손상된 JSON은 백업 후 빈 객체로 시작 — 사용자가
  // 수동 복구할 수 있게 원본을 보존하면서, 다음 set이 손상 파일을 그대로
  // 덮어쓰는 사고를 막는다.
  private readFromDisk(): Record<string, string> {
    if (!fs.existsSync(this.filePath)) return {};
    let raw = "";
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (e) {
      console.error("[cli-discovery] override read failed:", e);
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
      // valid JSON이지만 객체 아님 — 손상으로 간주
      // i18n-ignore: log
      throw new Error("override JSON이 객체 형태가 아닙니다.");
    } catch (e) {
      const backup = `${this.filePath}.broken-${Date.now()}`;
      try {
        fs.renameSync(this.filePath, backup);
        console.error(`[cli-discovery] 손상된 override JSON 발견. 백업: ${backup}`, e);
      } catch (renameErr) {
        console.error("[cli-discovery] 손상된 override JSON 백업 실패:", renameErr);
      }
      return {};
    }
  }
}

class DefaultCliDiscovery implements CliDiscovery {
  private statuses = new Map<Provider, CliStatus>();
  private cachedEnv: NodeJS.ProcessEnv | null = null;
  private cachedEnvInflight: Promise<NodeJS.ProcessEnv> | null = null;
  private readonly shellPath = new ShellPath();

  constructor(private readonly overrides: OverrideStore) {}

  buildEnv(): Promise<NodeJS.ProcessEnv> {
    if (this.cachedEnv) return Promise.resolve(this.cachedEnv);
    if (this.cachedEnvInflight) return this.cachedEnvInflight;
    this.cachedEnvInflight = (async () => {
      const shellPath = await this.shellPath.capture();
      const existing = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
      const merged = Array.from(new Set([...shellPath, ...existing]));
      this.cachedEnv = { ...process.env, PATH: merged.join(path.delimiter) };
      this.cachedEnvInflight = null;
      return this.cachedEnv;
    })();
    return this.cachedEnvInflight;
  }

  /** 캐시된 결과. 그 사이에 실행 파일이 사라졌으면 버린다. */
  private cached(provider: Provider): CliStatus | null {
    const entry = this.statuses.get(provider);
    if (entry?.installed && entry.path && !fs.existsSync(entry.path)) {
      this.statuses.delete(provider);
      return null;
    }
    return entry ?? null;
  }

  private remember(provider: Provider, status: CliStatus): CliStatus {
    this.statuses.set(provider, status);
    return status;
  }

  /** PATH 순서대로 이 명령의 실행 파일을 모두 모은다(중복 제외). 명령 이름은 provider 와 같다. */
  private candidates(provider: Provider, env: NodeJS.ProcessEnv): string[] {
    const found: string[] = [];
    for (const dir of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
      const full = path.join(dir, provider);
      if (fs.existsSync(full) && !found.includes(full)) found.push(full);
    }
    return found;
  }

  async find(provider: Provider): Promise<CliStatus> {
    const cached = this.cached(provider);
    if (cached) return cached;
    const env = await this.buildEnv();

    // 사용자 수동 override 우선
    const override = this.overrides.get(provider);
    if (override && fs.existsSync(override)) {
      const ok = (await captureVersion(override, env)) !== null;
      return this.remember(
        provider,
        ok
          ? { installed: true, path: override, source: "override" }
          : { installed: false, path: null, source: "override", error: mt("session.error.cli.overrideNoResponse", { path: override }) },
      );
    }

    const candidates = this.candidates(provider, env);
    if (candidates.length === 0) {
      return this.remember(provider, { installed: false, path: null, source: "auto", error: mt("session.error.cli.notFound", { command: provider }) });
    }
    // 후보 순서대로 verify, 첫 pass 채택
    for (const candidate of candidates) {
      if ((await captureVersion(candidate, env)) !== null) {
        return this.remember(provider, { installed: true, path: candidate, source: "auto" });
      }
    }
    const preview = candidates.slice(0, 3).join(", ");
    return this.remember(provider, {
      installed: false,
      path: null,
      source: "auto",
      error:
        candidates.length > 3
          ? mt("session.error.cli.noResponseMore", { total: candidates.length, preview, more: candidates.length - 3 })
          : mt("session.error.cli.noResponse", { count: candidates.length, preview }),
    });
  }

  invalidate(provider?: Provider): void {
    if (provider) {
      this.statuses.delete(provider);
      return;
    }
    this.statuses.clear();
    this.cachedEnv = null;
    this.cachedEnvInflight = null;
    this.shellPath.invalidate();
  }

  setOverride(provider: Provider, binPath: string | null): OverrideSetResultDto {
    // 없는 경로를 저장하면 find()가 조용히 자동 탐지로 빠져 사용자가 실패를 모른다. 저장 전에 거른다.
    if (binPath) {
      let isFile = false;
      try {
        isFile = fs.statSync(binPath).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) return { ok: false, message: mt("session.error.cli.noExecutable", { path: binPath }) };
    }
    const result = this.overrides.set(provider, binPath);
    // 디스크 persist 성공 시에만 캐시 무효화 → 다음 find()가 새 override 사용.
    // 실패 시엔 메모리/캐시 모두 그대로 → find()는 옛 결과 또는 자동 탐지 fallback.
    if (result.ok) this.statuses.delete(provider);
    return result;
  }

  async listCandidates(provider: Provider): Promise<CliCandidateDto[]> {
    const env = await this.buildEnv();
    // 모든 후보를 병렬로 verify해 1.5초 timeout 안에 끝나도록 한다.
    return Promise.all(
      this.candidates(provider, env).map(async (p) => {
        const versionOutput = await captureVersion(p, env);
        return { path: p, verified: versionOutput !== null, versionOutput: versionOutput ?? undefined };
      }),
    );
  }
}

/** overrideFilePath: userData/cli-overrides.json — 사용자가 직접 지정한 경로를 저장한다. */
export function buildCliDiscovery(options: { overrideFilePath: string }): CliDiscovery {
  return new DefaultCliDiscovery(new OverrideStore(options.overrideFilePath));
}
