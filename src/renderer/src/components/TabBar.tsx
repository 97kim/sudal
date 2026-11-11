import { useEffect, useRef } from 'react';
import { useTranslation } from "react-i18next";
import type { WorkspaceStateDto } from "@shared/ipc";
import { tabTitle } from "@shared/workspace-model";
import { isSubagentTabId } from '@shared/subagent-tabs';
import { Icon } from "./Icon";
import { effectiveLabel, StatusDot } from "./StatusDot";

/**
 * 브라우저식 밀착 탭. 스트립은 내용 영역보다 한 톤 어둡고(bg-chrome), 활성 탭은 내용과 같은 색(bg-bg)으로
 * 아래와 이어진다. 탭 = 세션, 한 줄(상태점 + 제목). 워크스페이스·상태 라벨은 헤더와 사이드바에 있으므로 뺐다.
 */
export function TabBar({
  ws,
  onActivate,
  onClose,
  onNew,
  onRename,
}: {
  ws: WorkspaceStateDto;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
  /** 탭 더블클릭 → 이름 편집 (활성 탭만 편집, 아니면 활성화만). */
  onRename?: (tabId: string) => void;
}) {
  const { t } = useTranslation();
  const { model, statuses, attention } = ws;
  const ids = model.openTabIds;
  const strip = useRef<HTMLDivElement>(null);
  const order = ids.join('\0');
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const reveal = () => {
      const active = element.querySelector<HTMLElement>('[data-active="true"]');
      if (!active) return;
      const row = active.getBoundingClientRect(), viewport = element.getBoundingClientRect();
      if (row.right > viewport.right) element.scrollLeft += row.right - viewport.right;
      else if (row.left < viewport.left) element.scrollLeft -= viewport.left - row.left;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    return () => observer.disconnect();
  }, [model.activeTabId, order]);
  return (
    // 헤더(타이틀바 줄) 아래 36px 스트립. 바닥에 선을 두지 않아 활성 탭이 내용으로 흘러든다.
    <div className="flex h-9 shrink-0 items-end bg-chrome px-2 pt-1">
      <div ref={strip} className="no-scrollbar flex min-w-0 flex-1 items-end overflow-x-auto overflow-y-hidden">
        {ids.map((id, i) => {
          const tab = model.tabs.find((t) => t.id === id);
          if (!tab) return null;
          const active = id === model.activeTabId;
          const readOnly = isSubagentTabId(id);
          const status = statuses[id] ?? "idle";
          const att = attention[id] ?? null;
          const wsName =
            model.workspaces.find((w) => w.id === tab.workspaceId)?.name ?? "";
          // 비활성 탭 사이에만 얇은 세로 구분점. 활성 탭 옆은 카드 모양이 이미 경계라 생략.
          const prevActive = i > 0 && ids[i - 1] === model.activeTabId;
          const showDivider = i > 0 && !active && !prevActive;
          return (
            <div key={id} className="flex items-end">
              <span
                aria-hidden
                className={`mb-2 h-4 w-px shrink-0 ${showDivider ? "bg-line" : "bg-transparent"}`}
              />
              <div
                data-tab={id}
                data-active={active ? "true" : "false"}
                onClick={() => onActivate(id)}
                onDoubleClick={() => { if (!readOnly) onRename?.(id); }}
                onAuxClick={(e) => {
                  if (e.button === 1) onClose(id);
                }}
                title={readOnly ? `${tab.title} · ${t('nav.subagentHistory.readOnly')}` : t("nav.tabBar.tabTitle", { title: tabTitle(tab, t("shared.untitledTab")), workspace: wsName, status: effectiveLabel(status, att), index: i + 1 })}
                className={`group flex h-8 min-w-[120px] max-w-[220px] cursor-default items-center gap-2 rounded-t-md pl-3 pr-2 text-[12.5px] ${
                  active
                    ? "bg-bg text-fg"
                    : "text-muted hover:bg-panel/60 hover:text-fg"
                }`}
              >
                {readOnly ? <Icon name="lock" size={11} className="text-muted"/> : <StatusDot status={status} attention={att} />}
                <span className="min-w-0 flex-1 truncate">{tabTitle(tab, t("shared.untitledTab"))}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(id);
                  }}
                  className={`rounded-sm p-0.5 hover:bg-panel-2 hover:text-fg ${
                    active ? "" : "opacity-0 group-hover:opacity-100"
                  }`}
                  title={t("nav.tabBar.closeTab")}
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <button
        onClick={onNew}
        className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel/60 hover:text-fg"
        title={t("nav.tabBar.newSession")}
      >
        <Icon name="edit" size={13} />
      </button>
    </div>
  );
}
