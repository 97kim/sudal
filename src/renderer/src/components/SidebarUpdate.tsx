import { useTranslation } from "react-i18next";
import { updatePhaseLabel, useUpdateStatus } from "../hooks/useUpdate";

/**
 * 사이드바 아래 버전 옆의 업데이트 자리. 평소에는 아무것도 없고, 새 버전이 있을 때만 버튼이 나타난다 —
 * 누르면 그 자리에서 단계와 진행률이 보이고, 끝나면 "다시 시작" 이 된다. 자세한 내용과 오류는 설정의 업데이트 카드에 있다.
 */
export function SidebarUpdate({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation();
  const status = useUpdateStatus();
  if (!status) return null;
  // 사이드바는 창을 끌어 옮기는 영역(drag)이다 — no-drag 가 없으면 클릭이 창 끌기로 먹힌다
  const btn = "no-drag mono mt-1.5 block rounded border border-accent/40 px-1.5 py-px text-[10px] text-accent hover:bg-accent/10";
  // data-sidebar-update 의 값으로 상태를 본다(e2e 가 문구에 기대지 않게)
  if (status.installed)
    return (
      <button onClick={() => void window.sudal.app.relaunch()} className={btn} data-sidebar-update="done">
        {t("settings.update.relaunch")}
      </button>
    );
  if (status.running)
    return (
      <span className="no-drag mono mt-1.5 block text-[10px] text-accent" data-sidebar-update="running" data-update-phase={status.phase} title={t("settings.update.upgrading", { version: status.running })}>
        {updatePhaseLabel(t, status)}
      </span>
    );
  if (status.error)
    return (
      <button onClick={onOpenSettings} className={`${btn} border-err/40 text-err hover:bg-err/10`} title={t("settings.update.sidebarFailedTitle")} data-sidebar-update="error">
        {t("settings.update.sidebarFailed")}
      </button>
    );
  const c = status.check;
  if (!c?.available) return null;
  return c.brew ? (
    <button onClick={() => void window.sudal.app.runUpdate()} className={btn} title={t("settings.update.sidebarRunTitle", { version: c.latest })} data-sidebar-update="available">
      {t("settings.update.sidebarRun", { version: c.latest })}
    </button>
  ) : (
    <button onClick={() => void window.sudal.browser.openExternal(c.releaseUrl)} className={btn} title={t("settings.update.sidebarAvailableTitle")} data-sidebar-update="available-manual">
      {t("settings.update.sidebarAvailable", { version: c.latest })}
    </button>
  );
}
