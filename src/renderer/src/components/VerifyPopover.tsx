// "검증" 버튼의 명령 편집창 — 한 줄에 명령 하나. 저장은 워크스페이스에(같은 워크스페이스의 모든 탭이 공유), 실행은 이 탭의 cwd 에서.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { VERIFY_MAX_COMMANDS, parseVerifyCommands } from "@shared/verify";
import { Icon } from "./Icon";

export function VerifyPopover({
  tabId,
  anchor,
  toggle,
  saved,
  onSave,
  onRun,
  onClose,
}: {
  tabId: string;
  /** 붙일 버튼 — 헤더가 overflow-hidden 이라 body 포털로 그리고 이 요소 아래에 fixed 로 놓는다. */
  anchor: HTMLElement | null;
  /** 이 팝오버를 여닫는 버튼. 그 위의 mousedown 은 바깥으로 치지 않는다(아래 참고). */
  toggle: HTMLElement | null;
  /** 워크스페이스에 저장된 명령. 비어 있으면 cwd 에서 추천을 받아 채운다. */
  saved: string[];
  onSave: (commands: string[]) => void;
  onRun: (commands: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(saved.join("\n"));
  const [suggested, setSuggested] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 72, right: 16 });
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  useEffect(() => {
    if (saved.length > 0) return;
    let alive = true;
    void window.sudal.chat.verifySuggest(tabId).then((list) => {
      if (alive && list.length > 0) {
        setText(list.join("\n"));
        setSuggested(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [tabId, saved.length]);
  useEffect(() => {
    ta.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      // 여는 버튼 위의 mousedown 까지 바깥으로 치면 여기서 닫고, 이어서 오는 click 이 다시 연다 —
      // 버튼이 토글로 동작하지 않고 계속 열린 채로 보인다. 그 자리는 넘기고 버튼의 토글에 맡긴다.
      // anchor 가 아니라 토글 버튼만 짚는다. anchor 는 "검증" 실행 버튼까지 감싸고 있어서,
      // 통째로 넘기면 검증을 눌러도 팝오버가 남는다.
      if (toggle?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, toggle]);
  const commands = parseVerifyCommands(text);
  const dirty = commands.join("\n") !== saved.join("\n");
  const run = () => {
    if (commands.length === 0) return;
    if (dirty) onSave(commands);
    onRun(commands);
    onClose();
  };
  return createPortal(
    <div ref={ref} className="fixed z-40 w-[420px] max-w-[calc(100vw-16px)] rounded-lg border border-line bg-panel p-3 shadow-pop" style={{ top: pos.top, right: pos.right }} data-verify-popover>
      <div className="mb-2 flex items-center gap-2">
        <Icon name="check" size={12} className="text-accent" />
        <span className="font-medium">{t("chat.verifyPopover.title")}</span>
        <span className="text-[11px] text-muted">{t("chat.verifyPopover.hint")}</span>
      </div>
      <textarea
        ref={ta}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            run();
          }
        }}
        rows={Math.min(8, Math.max(3, text.split("\n").length + 1))}
        spellCheck={false}
        placeholder={"yarn typecheck\nyarn test"}
        className="mono w-full resize-y rounded-md border border-line bg-inset px-2.5 py-2 text-[12px] leading-[1.6] outline-none focus:border-accent"
        data-verify-commands
      />
      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted">
        {suggested && saved.length === 0 && commands.length > 0 && <span data-verify-suggested>{t("chat.verifyPopover.suggested")}</span>}
        {commands.length > VERIFY_MAX_COMMANDS - 1 && <span>{t("chat.verifyPopover.max", { count: VERIFY_MAX_COMMANDS })}</span>}
        <span className="flex-1" />
        <button
          onClick={() => {
            onSave(commands);
            onClose();
          }}
          disabled={!dirty}
          className="rounded-md border border-line px-2.5 py-1 hover:bg-panel-2 disabled:opacity-40"
          data-verify-save
        >
          {t("common.save")}
        </button>
        <button
          onClick={run}
          disabled={commands.length === 0}
          className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-on-accent hover:bg-accent/90 disabled:opacity-40"
          title={t("chat.verifyPopover.saveAndRunHint")}
          data-verify-run
        >
          <Icon name="play" size={10} />
          {dirty ? t("chat.verifyPopover.saveAndRun") : t("chat.verifyPopover.run")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
