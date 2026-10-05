// 턴이 끝난 뒤에도 도는 일(백그라운드 명령·하위 에이전트)을 보여 주는 줄.
//
// 대화 맨 끝에 두었더니 위로 올려 읽는 동안 화면 밖으로 밀려 보이지 않았다.
// 무엇이 도는지는 대화의 어느 지점을 보고 있든 알아야 하므로, 입력창 바로 위에 붙박이로 둔다.
//
// 여러 개일 때 줄마다 늘어놓으면 "백그라운드 · 명령 · N초 경과" 가 똑같이 반복되고,
// 정작 서로 다른 정보(무슨 일인지)는 뒤로 밀려 먼저 잘린다. 그래서 한 줄로 접고, 눌러서 펼친다.
// 붙박이는 늘 한 줄이어야 한다 — 화면을 먹는 만큼 대화가 줄어든다.
//
// 도는 동안만 있다가 끝나면 사라진다. 끝났다는 사실은 알림과 탭 표시(attention)가 맡는다.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { jobRunningLabel, jobsSummaryLabel, type BackgroundJobDto } from "@shared/background-jobs";
import { Icon } from "./Icon";
import { useNow } from "../hooks/useNow";

/** 펼쳤을 때의 최대 높이(줄이 많아도 대화를 가리지 않게). 넘치면 그 안에서 스크롤한다. */
const LIST_MAX_H = "max-h-32";

export function BackgroundJobsBar({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<BackgroundJobDto[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.workbench.jobs.list().then((j) => alive && setJobs(j));
    const off = window.workbench.jobs.onChanged((j) => setJobs(j));
    return () => {
      alive = false;
      off();
    };
  }, []);
  const mine = sessionId ? jobs.filter((j) => j.sessionId === sessionId) : [];
  const now = useNow(mine.length > 0);
  // 다 끝나면 접힌 상태로 돌아간다 — 다음에 다시 뜰 때 펼쳐진 채로 나타나지 않게.
  useEffect(() => {
    if (mine.length <= 1) setOpen(false);
  }, [mine.length]);

  if (mine.length === 0) return null;
  return (
    <div className="flex flex-col items-center gap-1 px-4 pb-1.5 pt-2" data-background-jobs={mine.length}>
      {mine.length === 1 ? (
        <JobLine job={mine[0]} now={now} />
      ) : (
        <>
          <button
            onClick={() => setOpen((v) => !v)}
            data-background-jobs-toggle={open ? "open" : "closed"}
            title={open ? t("chat.background.collapse") : t("chat.background.show")}
            className="flex max-w-full items-center gap-2 rounded-full bg-panel-2 px-3 py-1 text-[11px] text-muted-2 hover:text-fg"
          >
            <Spinner />
            <span className="shrink-0 shimmer" style={SHIMMER}>
              {t("chat.background.label")}
            </span>
            <span className="mono shrink-0">{jobsSummaryLabel(mine, now, t)}</span>
            <Icon name="chevronRight" size={11} className={`shrink-0 transition-transform ${open ? "-rotate-90" : "rotate-90"}`} />
          </button>
          {open && (
            <div className={`flex w-full max-w-[680px] flex-col gap-1 overflow-y-auto rounded-lg bg-panel-2 px-3 py-2 ${LIST_MAX_H}`}>
              {mine.map((j) => (
                <JobLine key={j.id} job={j} now={now} plain />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const SHIMMER = { "--shimmer-base": "var(--color-muted)", "--shimmer-hi": "var(--color-fg)" } as React.CSSProperties;

function Spinner() {
  return <span className="spin inline-block h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-warn border-t-transparent" />;
}

/** 한 줄. 접힌 줄(알약)과 펼친 목록에서 같이 쓴다 — 목록 안에서는 배경이 이미 있으므로 알약을 입히지 않는다. */
function JobLine({ job, now, plain = false }: { job: BackgroundJobDto; now: number; plain?: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      className={`flex max-w-full items-center gap-2 text-[11px] text-muted-2 ${plain ? "" : "rounded-full bg-panel-2 px-3 py-1"}`}
      data-background-job={job.id}
    >
      <Spinner />
      {!plain && (
        <span className="shrink-0 shimmer" style={SHIMMER}>
          {t("chat.background.label")}
        </span>
      )}
      <span className="mono shrink-0">{jobRunningLabel(job, now, t)}</span>
      {job.summary && <span className="min-w-0 truncate opacity-70">{job.summary}</span>}
    </div>
  );
}
