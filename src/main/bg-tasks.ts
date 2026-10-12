// 탭별로 "지금 도는 백그라운드 작업" 을 들고 있다가 화면이 쓰는 모양으로 내준다.
//
// SDK 가 살아 있는 작업 전체 집합을 주므로 우리는 갈아 끼우기만 한다 — 시작·종료를 짝지어 세지 않는다.
// 그래서 신호를 하나 놓쳐도 표시가 남아 돌지 않는다. 폴링도, 파일 읽기도 없다.
//
// 우리가 따로 기억하는 것은 시작 시각 하나다(SDK 가 주지 않는다. "3분 경과" 를 보여 주려면 필요하다).

import type { BackgroundJobDto } from "@shared/background-jobs";
import { taskName, taskSummary, type LiveBackgroundTask } from "@shared/bg-tasks";
import { mt } from "./i18n";

/** 끝난 작업의 이름을 알림에 쓰려고 잠깐 기억해 둔다 — 끝났다는 알림이 목록에서 빠진 뒤에 올 수 있다. */
const RECENT_MAX = 64;

interface Tracked extends LiveBackgroundTask {
  startedAt: number;
}

interface SessionTasks {
  /** provider 세션 id — 화면이 "내 대화의 작업" 을 고르는 열쇠. */
  sessionId: string;
  cwd: string;
  tasks: Map<string, Tracked>;
}

export class BackgroundTaskRegistry {
  private bySession = new Map<string, SessionTasks>();
  private recent = new Map<string, BackgroundJobDto>();

  /** 전체 집합을 갈아 끼운다. */
  replace(sessionKey: string, sessionId: string, cwd: string, tasks: LiveBackgroundTask[]): void {
    const now = Date.now();
    const prev = this.bySession.get(sessionKey);
    const next = new Map<string, Tracked>();
    for (const t of tasks) {
      const was = prev?.tasks.get(t.id);
      next.set(t.id, { ...t, startedAt: was?.startedAt ?? now });
    }
    this.bySession.set(sessionKey, { sessionId, cwd, tasks: next });
    for (const job of this.jobsOf(sessionKey)) this.remember(job);
  }

  /** 프로세스가 내려갔다. 살아 있는 작업 집합은 그 프로세스의 것이므로 통째로 버린다. */
  clear(sessionKey: string): void {
    this.bySession.delete(sessionKey);
  }

  /** 지금 도는 작업 전부(모든 탭). */
  current(): BackgroundJobDto[] {
    const out: BackgroundJobDto[] = [];
    for (const key of this.bySession.keys()) out.push(...this.jobsOf(key));
    return out;
  }

  /** 끝났다는 알림에 쓸 정보. 이미 목록에서 빠졌어도 최근 것이면 찾는다. */
  recall(id: string): BackgroundJobDto | null {
    return this.recent.get(id) ?? null;
  }

  private jobsOf(sessionKey: string): BackgroundJobDto[] {
    const s = this.bySession.get(sessionKey);
    if (!s) return [];
    return [...s.tasks.values()].map((t) => ({
      id: t.id,
      sessionId: s.sessionId,
      label: taskName(mt, t),
      title: taskSummary(t.description) || taskName(mt, t),
      status: "running" as const,
      summary: taskSummary(t.description),
      startedAt: t.startedAt,
      completedAt: null,
      root: s.cwd,
      ...(t.parentId ? { parentId: t.parentId } : {}),
      ...(t.toolUseId ? { toolUseId: t.toolUseId } : {}),
    }));
  }

  private remember(job: BackgroundJobDto): void {
    this.recent.delete(job.id);
    this.recent.set(job.id, job);
    if (this.recent.size > RECENT_MAX) this.recent.delete(this.recent.keys().next().value as string);
  }
}
