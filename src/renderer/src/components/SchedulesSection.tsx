// 설정 > 예약. 목록·다음 실행 시각·최근 결과를 보여 주고, 만들기·고치기·켜기/끄기·지금 실행·삭제를 한다.
//
// 폼은 프리셋(매시·매일·평일·매주)을 먼저 보여 주고 cron 은 "직접" 을 골랐을 때만 드러낸다.
// 대부분의 예약은 네 가지 중 하나인데, 그걸 위해 cron 을 배우게 할 이유가 없다.
// 저장 전에 다음 실행 시각을 계산해 보여 준다 — 사용자가 고른 것이 정말 언제 도는지 확인하는 자리다.

import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { intlLocale, type Locale } from "@shared/i18n/locale";
import { msgText } from "@shared/i18n/msg";
import type { ScheduleListDto } from "@shared/ipc";
import type { PermissionPolicy } from "@shared/chat-events";
import type { ProviderId } from "@shared/workspace-model";
import { classify, nextOccurrence, parseCron, presetToCron } from "@shared/cron";
import type { Run, RunStatus, Schedule } from "@shared/schedules";
import { Icon } from "./Icon";
import { shortenHome } from "@shared/path-display";

const STATUS_TONE: Record<RunStatus, string> = {
  pending: "text-muted",
  running: "text-accent",
  needs_action: "text-warn",
  completed: "text-ok",
  failed: "text-err",
  skipped_precheck: "text-muted",
  skipped_missed: "text-muted",
  skipped_unavailable: "text-muted",
  skipped_overlap: "text-muted",
  interrupted: "text-warn",
};

// 문구는 값(키)만 들고 그릴 때 사전에서 가져온다.
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const POLICIES: PermissionPolicy[] = ["ask", "auto_edit", "full"];

const REPEATS: Repeat[] = ["hourly", "daily", "weekdays", "weekly", "custom"];

/** cron 을 사람 말로. 프리셋이 아니면 식을 그대로 보여 준다 — 거짓말하지 않는다. */
function scheduleLabel(t: TFunction, cron: string): string {
  const p = classify(cron);
  const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  switch (p.kind) {
    case "hourly":
      return t("schedules.label.hourly", { minute: String(p.minute).padStart(2, "0") });
    case "daily":
      return t("schedules.label.daily", { time: hhmm(p.hour, p.minute) });
    case "weekdays":
      return t("schedules.label.weekdays", { time: hhmm(p.hour, p.minute) });
    case "weekly":
      {
      const day = WEEKDAYS[p.dayOfWeek];
      return t("schedules.label.weekly", { day: day ? t(`schedules.weekday.${day}`) : "?", time: hhmm(p.hour, p.minute) });
    }
    case "invalid":
      return t("schedules.label.invalid", { cron });
    default:
      return cron;
  }
}

function when(t: TFunction, locale: Locale, ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const tag = intlLocale(locale);
  const time = d.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" });
  return sameDay ? t("schedules.today", { time }) : `${d.toLocaleDateString(tag, { month: "numeric", day: "numeric" })} ${time}`;
}

type Repeat = "hourly" | "daily" | "weekdays" | "weekly" | "custom";

interface Draft {
  id?: string;
  name: string;
  repeat: Repeat;
  /** 매시일 때 쓰는 분. */
  minute: number;
  /** 나머지 프리셋이 쓰는 시각(HH:MM). */
  time: string;
  dayOfWeek: number;
  /** "직접" 을 골랐을 때만 쓴다. */
  cron: string;
  timezone: string;
  prompt: string;
  provider: ProviderId;
  policy: PermissionPolicy;
  /**
   * 폴더를 앱이 채웠나. 폼을 열면 최근 실행된 세션의 경로가 들어가는데, 그걸 알려 주지 않으면
   * 내가 고른 값인지 앱이 넣은 값인지 구분되지 않는다 — 탭마다 경로가 다르면 더 그렇다.
   * 사용자가 직접 고르는 순간 꺼진다.
   */
  cwdAuto: boolean;
  /** 실행할 폴더. 워크스페이스 기본 경로에 기대지 않는다 — 이름만으로 만든 워크스페이스에는 그 값이 없다. */
  cwd: string;
  worktree: boolean;
}

/** 문장 안에 박히는 값 하나. 칸처럼 보이지 않게 낮게 두되, 누를 수 있다는 것은 테두리로 남긴다. */
const chip =
  "rounded-md border border-line bg-inset px-2 py-1 text-fg outline-none transition-colors hover:border-accent/40 focus:border-accent/60";

/**
 * "언제" 만 한 톤 올린다. 다섯 칸이 전부 같은 무게면 문장으로 바꾼 보람이 없다 —
 * 세로로 쌓였던 값이 가로로 누웠을 뿐 무엇을 먼저 읽어야 할지는 여전히 안 보인다.
 * 어디서·무엇으로·어떤 권한은 보조 정보라 중립 칩으로 남긴다.
 */
const chipWhen =
  "rounded-md border border-accent/30 bg-accent-tint px-2 py-1 font-medium text-accent outline-none transition-colors hover:border-accent/50 focus:border-accent/60";

/**
 * 켜고 끄는 스위치. 글자("끄기"/"켜기")로 두면 지금 상태와 누르면 될 일이 헷갈린다 —
 * "끄기" 는 지금 켜져 있다는 뜻인데 꺼져 있다는 뜻으로도 읽힌다. 스위치는 상태만 보여 준다.
 */
function Toggle({
  on,
  busy,
  title,
  onChange,
  ...rest
}: {
  on: boolean;
  busy: boolean;
  title: string;
  onChange: () => void;
} & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={busy}
      title={title}
      onClick={onChange}
      // 폭은 style 로 박는다. w-8 로 뒀더니 다른 규칙에 밀려 26px 로 그려졌고, 손잡이가 트랙을
      // 4px 넘어 초승달처럼 삐져나왔다. 손잡이도 left 대신 translate 로 옮긴다 — 트랙 폭이
      // 달라져도 오른쪽 끝에서 같은 간격을 지킨다.
      style={{ width: 32, height: 18 }}
      className={`relative shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-accent" : "bg-line"
      }`}
      {...rest}
    >
      <span
        style={{ width: 14, height: 14, top: 2, left: 2 }}
        className={`absolute rounded-full bg-white shadow-sm transition-transform ${
          on ? "translate-x-[14px]" : "translate-x-0"
        }`}
      />
    </button>
  );
}

/** 문장 안에 들어갈 만큼 줄인 경로. 홈은 ~ 로, 너무 길면 뒤쪽 두 칸만 남긴다. */
function shortPath(p: string): string {
  const short = shortenHome(p);
  const parts = short.split("/");
  return parts.length > 4 ? `…/${parts.slice(-2).join("/")}` : short;
}

/**
 * 시·분 고르기. 네이티브 time 입력을 쓰면 OS 가 제 드롭다운을 그린다 — 오전/오후 3열에 밝은 파란 막대라
 * 앱 어디에도 없는 색이고, 문장은 24시간으로 적는데 피커만 12시간이라 읽는 형식까지 달랐다.
 * 다른 값과 같은 고르기로 맞춘다. 분은 60개 다 둔다 — 줄이면 07:07 같은 시각을 못 고르게 된다.
 */
function TimePick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const [h = "09", m = "00"] = value.split(":");
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    <span className="inline-flex items-center gap-1">
      <Pick value={h} onChange={(v) => onChange(`${v}:${m}`)} base={chipWhen} aria-label={t("schedules.form.hour")} data-f-hour>
        {Array.from({ length: 24 }, (_, i) => (
          <option key={i} value={two(i)}>
            {two(i)}
          </option>
        ))}
      </Pick>
      <span className="text-muted-2">:</span>
      <Pick value={m} onChange={(v) => onChange(`${h}:${v}`)} base={chipWhen} aria-label={t("schedules.form.minute")} data-f-minute>
        {Array.from({ length: 60 }, (_, i) => (
          <option key={i} value={two(i)}>
            {two(i)}
          </option>
        ))}
      </Pick>
    </span>
  );
}

/**
 * 문장 안의 고르기. 네이티브 화살표를 지우고 우리 캐럿을 붙인다 —
 * OS 기본 화살표는 칸마다 폭을 다르게 잡아, 문장으로 읽히던 줄을 다시 폼처럼 보이게 만든다.
 */
function Pick({
  value,
  onChange,
  children,
  className = "",
  base = chip,
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  className?: string;
  /** 문장에서 이 값이 갖는 무게. "언제" 는 한 톤 올린 칩을 쓴다. */
  base?: string;
  "aria-label"?: string;
} & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <span className="relative inline-flex items-center">
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${base} appearance-none pr-6 ${className}`} {...rest}>
        {children}
      </select>
      <Icon name="chevronDown" size={11} className="pointer-events-none absolute right-2 text-muted-2" />
    </span>
  );
}

/**
 * 사람에게 보일 오류 문구. Electron 은 IPC 오류 앞에 "Invoking remote method …" 배관을 붙이는데,
 * 그대로 두면 "이름을 적어 주세요" 같은 안내가 내부 채널 이름에 파묻힌다.
 */
function humanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "").trim();
}

function blankDraft(): Draft {
  return {
    name: "",
    repeat: "daily",
    minute: 0,
    time: "09:00",
    dayOfWeek: 1,
    cron: "0 9 * * *",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    prompt: "",
    provider: "claude",
    policy: "ask",
    cwd: "",
    cwdAuto: false,
    worktree: false,
  };
}

/** 저장된 예약을 폼 값으로 되읽는다. 프리셋이 아니면 "직접" 으로 열어 식을 그대로 보여 준다. */
function toDraft(s: Schedule): Draft {
  const p = classify(s.cron);
  const base = { ...blankDraft() };
  const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const when: Partial<Draft> =
    p.kind === "hourly"
      ? { repeat: "hourly", minute: p.minute }
      : p.kind === "daily"
        ? { repeat: "daily", time: hhmm(p.hour, p.minute) }
        : p.kind === "weekdays"
          ? { repeat: "weekdays", time: hhmm(p.hour, p.minute) }
          : p.kind === "weekly"
            ? { repeat: "weekly", time: hhmm(p.hour, p.minute), dayOfWeek: p.dayOfWeek }
            : { repeat: "custom" };
  return {
    ...base,
    ...when,
    id: s.id,
    name: s.name,
    cron: s.cron,
    timezone: s.timezone,
    prompt: s.prompt,
    provider: s.provider,
    policy: s.policy,
    cwd: s.target.cwd ?? "",
    cwdAuto: false,
    worktree: s.target.worktree,
  };
}

/** 폼 값 → cron. "직접" 이면 적은 것을 그대로 쓴다. */
function draftCron(d: Draft): string {
  const [h, m] = d.time.split(":").map((x) => Number(x));
  const hour = Number.isFinite(h) ? h : 9;
  const minute = Number.isFinite(m) ? m : 0;
  switch (d.repeat) {
    case "hourly":
      return presetToCron({ kind: "hourly", minute: d.minute });
    case "daily":
      return presetToCron({ kind: "daily", hour, minute });
    case "weekdays":
      return presetToCron({ kind: "weekdays", hour, minute });
    case "weekly":
      return presetToCron({ kind: "weekly", hour, minute, dayOfWeek: d.dayOfWeek });
    case "custom":
      return d.cron.trim();
  }
}

export function SchedulesSection({ defaultCwd }: { defaultCwd: string | null }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const [data, setData] = useState<ScheduleListDto>({ schedules: [], runs: [] });
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.workbench.schedules.list().then((d) => alive && setData(d));
    const off = window.workbench.schedules.onChanged((d) => setData(d));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const act = async (id: string, fn: () => Promise<ScheduleListDto>) => {
    setBusy(id);
    setError(null);
    try {
      setData(await fn());
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  };

  const cron = draft ? draftCron(draft) : "";
  // 저장하기 전에 "그래서 언제 도나" 를 계산해 보여 준다. 식이 틀렸으면 여기서 바로 드러난다.
  const preview = useMemo(() => {
    if (!draft) return null;
    const c = parseCron(cron);
    if (!c) return null;
    return nextOccurrence(c, Date.now(), draft.timezone);
  }, [cron, draft?.timezone, draft]);

  const submit = async () => {
    if (!draft) return;
    setBusy(draft.id ?? "new");
    setError(null);
    try {
      setData(
        await window.workbench.schedules.save({
          ...(draft.id ? { id: draft.id } : {}),
          name: draft.name.trim(),
          cron,
          timezone: draft.timezone,
          prompt: draft.prompt.trim(),
          provider: draft.provider,
          policy: draft.policy,
          target: { kind: "fresh", cwd: draft.cwd || undefined, worktree: draft.worktree },
        }),
      );
      setDraft(null);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  };

  const set = (patch: Partial<Draft>) => {
    // 값을 고치는 순간 지난 오류는 치운다. 이미 채운 칸을 계속 지적하고 있으면 무엇이 문제인지 흐려진다.
    setError(null);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  return (
    <div data-schedules-section>
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold">{t("schedules.title")}</h1>
          <p className="mt-1 text-muted">{t("schedules.description")}</p>
        </div>
        {!draft && (
          <button
            onClick={() => {
              setError(null);
              setDraft({ ...blankDraft(), cwd: defaultCwd ?? "", cwdAuto: Boolean(defaultCwd) });
            }}
            className="shrink-0 rounded-md border border-line px-2.5 py-1.5 text-[12.5px] hover:bg-panel-2"
            data-new-schedule
          >
            {t("schedules.newSchedule")}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-[12.5px] text-err" data-schedule-error>
          {error}
        </div>
      )}

      <p className="mb-4 text-[12px] leading-5 text-muted">{t("schedules.notice.missed")}</p>
      <p className="mb-4 text-[12px] leading-5 text-muted">{t("schedules.notice.cleanup")}</p>

      {draft && (
        <div className="mb-4 rounded-lg border border-accent/40 bg-panel px-4 py-4" data-schedule-form>
          {/* 이름은 제목처럼 둔다. 라벨을 달면 다른 칸과 같은 무게가 되어 무엇을 만드는 중인지 흐려진다. */}
          <input
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder={t("schedules.form.namePlaceholder")}
            className="w-full bg-transparent text-[15px] font-medium outline-none placeholder:text-muted-2"
            data-f-name
          />

          {/* 설정을 문장 하나로 읽는다. 라벨을 세로로 쌓으면 값 일곱 개가 똑같은 무게로 늘어서는데,
              정작 사람이 확인하고 싶은 것은 "언제 어디서 무엇으로 도는가" 라는 한 줄이다. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-2 text-[13px] text-muted">
            <Pick value={draft.repeat} onChange={(v) => set({ repeat: v as Repeat })} className={chipWhen} data-f-repeat>
              {REPEATS.map((r) => (
                <option key={r} value={r}>
                  {t(`schedules.repeat.${r}`)}
                </option>
              ))}
            </Pick>
            {draft.repeat === "weekly" && (
              <Pick value={String(draft.dayOfWeek)} onChange={(v) => set({ dayOfWeek: Number(v) })} className={chipWhen}>
                {WEEKDAYS.map((w, i) => (
                  <option key={w} value={i}>
                    {t(`schedules.weekday.${w}`)}
                  </option>
                ))}
              </Pick>
            )}
            {draft.repeat === "hourly" ? (
              <Trans
                i18nKey="schedules.form.atMinute"
                components={{
                  minute: (
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={draft.minute}
                      onChange={(e) => set({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })}
                      className={`${chipWhen} w-14`}
                    />
                  ),
                }}
              />
            ) : draft.repeat === "custom" ? (
              <Trans
                i18nKey="schedules.form.atCron"
                components={{
                  cron: (
                    <input
                      value={draft.cron}
                      onChange={(e) => set({ cron: e.target.value })}
                      placeholder={t("schedules.form.cronPlaceholder")}
                      className={`${chipWhen} mono w-40`}
                      data-f-cron
                    />
                  ),
                }}
              />
            ) : (
              <Trans
                i18nKey="schedules.form.atTime"
                components={{ time: <TimePick value={draft.time} onChange={(v) => set({ time: v })} /> }}
              />
            )}
            <Trans
              i18nKey="schedules.form.inFolder"
              components={{
                folder: (
                  <button
                    type="button"
                    onClick={async () => {
                      const dir = await window.workbench.dialog.pickDirectory();
                      if (dir) set({ cwd: dir, cwdAuto: false });
                    }}
                    className={`${chipWhen} max-w-[14rem] truncate text-left`}
                    title={draft.cwd || t("schedules.form.pickFolderTitle")}
                    data-f-cwd
                  >
                    {draft.cwd ? shortPath(draft.cwd) : t("schedules.form.pickFolder")}
                  </button>
                ),
              }}
            />
            <Trans
              i18nKey="schedules.form.runWith"
              components={{
                provider: (
                  <Pick value={draft.provider} onChange={(v) => set({ provider: v as ProviderId })}>
                    <option value="claude">Claude Code</option>
                    <option value="codex">Codex</option>
                  </Pick>
                ),
                policy: (
                  <Pick value={draft.policy} onChange={(v) => set({ policy: v as PermissionPolicy })} data-f-policy>
                    {POLICIES.map((p) => (
                      <option key={p} value={p}>
                        {t(`schedules.policy.${p}`)}
                      </option>
                    ))}
                  </Pick>
                ),
              }}
            />
          </div>

          {/* 고른 것이 정말 언제 도는지. 저장하고 나서 알게 되면 늦다. */}
          <div className="mt-2.5 flex items-center gap-1.5 text-[12px]" data-f-preview>
            {parseCron(cron) ? (
              <>
                <Icon name="clock" size={12} className="text-muted-2" />
                <span className="text-muted">{t("schedules.form.nextRun", { when: when(t, locale, preview) })}</span>
                <span className="mono text-muted-2">({draft.timezone})</span>
              </>
            ) : (
              <>
                <Icon name="x" size={12} className="text-err" />
                <span className="text-err">{t("schedules.form.cronInvalid")}</span>
              </>
            )}
          </div>

          {draft.cwdAuto && (
            <div className="mt-1 text-[11px] text-muted-2" data-f-cwd-auto>
              <Trans
                i18nKey="schedules.form.cwdAuto"
                values={{ cwd: draft.cwd }}
                components={{ path: <span className="mono text-muted" /> }}
              />
            </div>
          )}

          <textarea
            value={draft.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
            // 예약 프롬프트는 사람 없이 혼자 도는 지시라 길게 쓰게 된다. 기본 8줄, 긴 걸 고칠 땐 내용만큼(최대 20줄).
            rows={Math.min(20, Math.max(8, draft.prompt.split("\n").length + 1))}
            placeholder={t("schedules.form.promptPlaceholder")}
            className="mt-3 w-full resize-y rounded-md border border-line bg-inset px-3 py-2 text-[13px] outline-none focus:border-accent/50"
            data-f-prompt
          />

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <label className="flex cursor-pointer flex-wrap items-center gap-2 text-[12.5px]">
              <input type="checkbox" checked={draft.worktree} onChange={(e) => set({ worktree: e.target.checked })} data-f-worktree />
              <span>{t("schedules.form.worktree")}</span>
              <span className="text-muted-2">{t("schedules.form.worktreeHint")}</span>
            </label>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  // 폼이 사라지면 그 폼이 낸 오류도 같이 사라져야 한다. 남겨 두면 가리킬 대상이 없는 지적이 된다.
                  setError(null);
                  setDraft(null);
                }}
                className="rounded-md px-3 py-1.5 text-[12.5px] text-muted hover:bg-panel-2 hover:text-fg"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => void submit()}
                disabled={busy !== null}
                className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] text-on-accent hover:bg-accent/90 disabled:opacity-50"
                data-f-save
              >
                {draft.id ? t("common.save") : t("schedules.form.create")}
              </button>
            </div>
          </div>

          {draft.policy === "full" && (
            <p className="mt-2 text-[11.5px] text-warn">{t("schedules.form.fullWarning")}</p>
          )}
        </div>
      )}

      {data.schedules.length === 0 ? (
        !draft && (
          <div className="rounded-lg border border-dashed border-line px-4 py-6 text-muted">
            <p>{t("schedules.empty.title")}</p>
            <p className="mt-2 text-[12px] text-muted-2">
              {t("schedules.empty.hint")}
              <code className="mono ml-1">{t("schedules.empty.example")}</code>
            </p>
          </div>
        )
      ) : (
        <ul className="flex flex-col gap-2">
          {data.schedules.map((s) => {
            const last: Run | undefined = data.runs.find((r) => r.scheduleId === s.id);
            return (
              <li key={s.id} className="rounded-lg border border-line bg-panel px-4 py-3" data-schedule={s.id}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`font-medium ${s.enabled ? "text-fg" : "text-muted"}`}>{s.name}</span>
                      {s.target.kind === "fresh" && s.target.worktree && <span className="label text-muted-2">{t("schedules.item.isolated")}</span>}
                    </div>
                    <div className="mono mt-1 text-[11px] text-muted">
                      {scheduleLabel(t, s.cron)} · {s.timezone} · {t("schedules.item.next", { when: when(t, locale, s.nextRunAt) })}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-2">
                      {s.missedRunGraceMinutes > 0
                        ? t("schedules.item.grace", { minutes: s.missedRunGraceMinutes })
                        : t("schedules.item.graceNone")}
                    </div>
                    <div className="mt-1 truncate text-[12px] text-muted-2" title={s.prompt}>{s.prompt}</div>
                    {last && (
                      <div className="mt-2 flex items-center gap-2 text-[11px]" data-last-run={last.status}>
                        <span className={STATUS_TONE[last.status]}>{t(`schedules.status.${last.status}`)}</span>
                        <span className="mono text-muted-2">{when(t, locale, last.endedAt ?? last.startedAt ?? last.scheduledFor)}</span>
                        {last.reason && <span className="min-w-0 flex-1 truncate text-muted-2">{msgText(i18n, last.reasonMsg, last.reason)}</span>}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => void act(s.id, () => window.workbench.schedules.runNow(s.id))}
                      disabled={busy === s.id}
                      title={t("schedules.item.runNow")}
                      className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-50"
                    >
                      <Icon name="play" size={13} />
                    </button>
                    <button
                      onClick={() => {
                        setError(null);
                        setDraft(toDraft(s));
                      }}
                      title={t("schedules.item.edit")}
                      className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg"
                      data-edit-schedule
                    >
                      <Icon name="edit" size={13} />
                    </button>
                    <Toggle
                      on={s.enabled}
                      busy={busy === s.id}
                      title={s.enabled ? t("common.off") : t("common.on")}
                      onChange={() => void act(s.id, () => window.workbench.schedules.save({ id: s.id, enabled: !s.enabled }))}
                      data-toggle-schedule={s.enabled ? "on" : "off"}
                    />
                    <button
                      onClick={() => void act(s.id, () => window.workbench.schedules.remove(s.id))}
                      disabled={busy === s.id}
                      title={t("schedules.item.remove")}
                      className="rounded-md p-1.5 text-muted hover:bg-err-bg hover:text-err disabled:opacity-50"
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
