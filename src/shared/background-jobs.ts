import type { TFunction } from "i18next";
// 탭의 턴이 끝난 뒤에도 계속 도는 작업(지금은 Codex 플러그인의 백그라운드 rescue).
// 턴에 묶인 하위 에이전트 미러와 달리 프로세스가 앱에서 떨어져 나가므로, 플러그인이 디스크에 쓰는 작업 목록을 읽어서 보여 준다.

export type BackgroundJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface BackgroundJobDto {
  id: string;
  /** 어느 대화의 작업인지 — provider 세션 id. 탭과 잇는 열쇠. */
  sessionId: string;
  /** 화면에 쓸 종류 이름 ("rescue" 등). */
  label: string;
  title: string;
  status: BackgroundJobStatus;
  /** 지시 앞부분. 무엇을 시켰는지 알아보게. */
  summary: string;
  startedAt: number;
  completedAt: number | null;
  /** 이 작업을 기록한 곳(작업 디렉토리). 같은 id 가 다른 저장소에 있을 수 있다. */
  root: string;
  /** 이 작업을 띄운 작업(하위 에이전트)의 id. 목록에서 그 아래에 들여 쓴다. */
  parentId?: string;
  /** 이 작업을 띄운 tool_use 블록의 id. 대화 타임라인의 카드로 건너뛸 때 쓴다. */
  toolUseId?: string;
}

export const isActiveJob = (s: BackgroundJobStatus): boolean => s === "queued" || s === "running";

/**
 * 펼친 목록 순서: 하위 에이전트가 띄운 작업은 그 에이전트 바로 아래에 들여 쓴다.
 * 부모가 목록에 없으면(이미 끝났거나 포그라운드) 맨 위 단계로 둔다 — 모르는 부모는 없는 것으로 친다.
 */
export function nestJobs(jobs: BackgroundJobDto[]): { job: BackgroundJobDto; depth: number }[] {
  const ids = new Set(jobs.map((j) => j.id));
  const kids = new Map<string, BackgroundJobDto[]>();
  const roots: BackgroundJobDto[] = [];
  for (const j of jobs) {
    if (j.parentId && j.parentId !== j.id && ids.has(j.parentId)) kids.set(j.parentId, [...(kids.get(j.parentId) ?? []), j]);
    else roots.push(j);
  }
  const out: { job: BackgroundJobDto; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (j: BackgroundJobDto, depth: number) => {
    if (seen.has(j.id)) return;
    seen.add(j.id);
    out.push({ job: j, depth });
    for (const k of kids.get(j.id) ?? []) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  // 부모끼리 서로를 가리키는 고리처럼 위에서 못 닿은 것도 빠뜨리지 않는다
  for (const j of jobs) walk(j, 0);
  return out;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const time = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

const STATUSES: BackgroundJobStatus[] = ["queued", "running", "completed", "failed", "cancelled"];

/**
 * 플러그인 state.json 의 jobs 항목 하나를 읽는다. 우리가 못 읽는 형식이면 null.
 * 남이 쓰는 파일이라 필드가 없거나 형식이 바뀔 수 있다 — 모르는 값은 버리고 읽히는 것만 쓴다.
 */
export function parseBackgroundJob(t: TFunction, raw: unknown, root: string): BackgroundJobDto | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as Record<string, unknown>;
  const id = str(j.id);
  const sessionId = str(j.sessionId);
  if (!id || !sessionId) return null;
  const status = STATUSES.find((s) => s === j.status);
  if (!status) return null;
  const started = time(j.startedAt) ?? time(j.createdAt);
  if (started === null) return null;
  return {
    id,
    sessionId,
    label: str(j.kindLabel) || str(j.kind) || t("session.bgJob.label"),
    title: str(j.title) || t("session.bgJob.title"),
    status,
    summary: str(j.summary).replace(/\s+/g, " ").trim().slice(0, 200),
    startedAt: started,
    completedAt: time(j.completedAt),
    root,
  };
}

/** 저장소+id 가 같으면 한 작업. 나중에 읽은(더 늦게 시작한) 쪽을 남기고 시작 순으로 정렬한다. */
export function mergeJobs(jobs: BackgroundJobDto[]): BackgroundJobDto[] {
  const by = new Map<string, BackgroundJobDto>();
  for (const j of jobs) {
    const key = `${j.root}|${j.id}`;
    const cur = by.get(key);
    if (!cur || j.startedAt >= cur.startedAt) by.set(key, j);
  }
  return [...by.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** 진행 줄에 쓸 경과 시간. "3분 12초" */
export function jobElapsed(job: BackgroundJobDto, now: number, t: TFunction): string {
  const secs = Math.max(0, Math.floor((now - job.startedAt) / 1000));
  return secs >= 60 ? t("shared.duration.minSec", { min: Math.floor(secs / 60), sec: secs % 60 }) : t("shared.duration.sec", { sec: secs });
}

/** "rescue · 3분 12초 경과" */
export function jobRunningLabel(job: BackgroundJobDto, now: number, t: TFunction): string {
  return t("shared.jobs.elapsed", { label: job.label, time: jobElapsed(job, now, t) });
}

/**
 * 여러 개일 때 접어 두는 한 줄. 시간은 가장 오래 돈 것 기준이지만 그렇다고 쓰지는 않는다 —
 * "가장 오래 12초 경과" 는 읽고 무슨 뜻인지 되묻게 된다. 여럿을 띄울 땐 대개 같이 시작해 차이가 작고,
 * 펼치면 각 줄에 자기 시간이 따로 나오므로 여기서까지 정확할 필요가 없다.
 */
export function jobsSummaryLabel(jobs: BackgroundJobDto[], now: number, t: TFunction): string {
  if (jobs.length === 0) return "";
  const oldest = jobs.reduce((a, j) => (j.startedAt < a.startedAt ? j : a), jobs[0]);
  return t("shared.jobs.summary", { count: jobs.length, time: jobElapsed(oldest, now, t) });
}
