// 앱 업데이트 상태. main 이 들고 있는 것을 그대로 본다 — 사이드바와 설정 카드가 같은 진행을 보여 준다.
import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import type { UpdateStatusDto } from "@shared/ipc";

export function useUpdateStatus(): UpdateStatusDto | null {
  const [status, setStatus] = useState<UpdateStatusDto | null>(null);
  useEffect(() => {
    let alive = true;
    void window.sudal.app.updateStatus().then((s) => alive && setStatus(s));
    const off = window.sudal.app.onUpdateChanged(setStatus);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return status;
}

/** 업데이트가 지금 하는 일을 한 줄로: "확인 중…" · "내려받는 중 43%" · "설치 중…". */
export function updatePhaseLabel(t: TFunction, status: Pick<UpdateStatusDto, "phase" | "percent">): string {
  if (status.phase === "downloading") return status.percent !== undefined ? t("settings.update.phase.downloadingPercent", { percent: status.percent }) : t("settings.update.phase.downloading");
  if (status.phase === "installing") return t("settings.update.phase.installing");
  return t("settings.update.phase.checking");
}
