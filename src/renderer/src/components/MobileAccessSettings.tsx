// 설정 > 휴대폰에서 이어 쓰기(Tailscale). 켜기·접속 주소·짝짓기 코드·짝지은 기기.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MobileStatusDto } from "@shared/ipc";
import { intlLocale, type Locale } from "@shared/i18n/locale";
import { Icon } from "./Icon";

export function MobileAccessSettings({ enabled, onToggle }: { enabled: boolean | undefined; onToggle: (on: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<MobileStatusDto | null>(null);
  useEffect(() => {
    void window.sudal.mobile.status().then(setStatus);
    return window.sudal.mobile.onChanged(setStatus);
  }, []);
  // 코드가 만료되면 화면에서도 사라지게 가끔 다시 그린다
  const [, tick] = useState(0);
  useEffect(() => {
    if (!status?.code) return;
    const timer = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(timer);
  }, [status?.code]);
  const time = (ms: number) => new Date(ms).toLocaleTimeString(intlLocale(i18n.language as Locale), { hour: "2-digit", minute: "2-digit" });
  const code = status?.code && status.code.expiresAt > Date.now() ? status.code : null;

  return (
    <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="mobile-access">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <Icon name="laptop" size={14} className="text-accent" />
        {t("settings.mobile.title")}
      </div>
      <p className="mb-2 text-[12px] leading-5 text-muted">{t("settings.mobile.description")}</p>
      <p className="mb-3 text-[12px] leading-5 text-warn">{t("settings.mobile.warning")}</p>
      <label className="flex cursor-pointer items-center gap-2 text-[12.5px]">
        <input type="checkbox" checked={enabled ?? false} disabled={enabled === undefined} onChange={(e) => onToggle(e.target.checked)} data-mobile-access />
        <span>{t("settings.mobile.checkbox")}</span>
      </label>

      {enabled && status && (
        <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3 text-[12.5px]">
          {status.urls.length > 0 ? (
            <div>
              <div className="mb-1 text-muted">{t("settings.mobile.address")}</div>
              {status.urls.map((u) => (
                <div key={u} className="mono select-text text-[12px]" data-mobile-url>
                  {u}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-warn" data-mobile-error>
              {status.error === "noTailscale"
                ? t("settings.mobile.noTailscale")
                : status.error === "noTailscaleCli"
                  ? t("settings.mobile.noTailscaleCli")
                  : t("settings.mobile.error", { error: status.error ?? "" })}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={() => void window.sudal.mobile.newCode().then(setStatus)}
              disabled={status.urls.length === 0}
              className="rounded-md border border-line px-2.5 py-1 hover:bg-panel-2 disabled:opacity-40"
              data-mobile-new-code
            >
              {t("settings.mobile.newCode")}
            </button>
            {code && (
              <span className="flex items-baseline gap-2">
                <span className="mono text-[20px] font-semibold tracking-[0.2em]" data-mobile-code>
                  {code.code}
                </span>
                <span className="text-[11.5px] text-muted">{t("settings.mobile.codeHint", { time: time(code.expiresAt) })}</span>
              </span>
            )}
          </div>

          <div>
            <div className="mb-1 text-muted">{t("settings.mobile.devices")}</div>
            {status.devices.length === 0 ? (
              <div className="text-[12px] text-muted-2">{t("settings.mobile.noDevices")}</div>
            ) : (
              status.devices.map((d) => (
                <div key={d.id} className="flex items-center gap-2 py-0.5" data-mobile-device>
                  <span className="min-w-0 flex-1 truncate">{d.name || t("settings.mobile.unnamed")}</span>
                  <span className="text-[11.5px] text-muted-2">{t("settings.mobile.lastSeen", { time: new Date(d.lastSeenAt).toLocaleString(intlLocale(i18n.language as Locale)) })}</span>
                  <button onClick={() => void window.sudal.mobile.revoke(d.id).then(setStatus)} className="rounded-md border border-line px-2 py-0.5 text-[11.5px] hover:bg-panel-2" data-mobile-revoke>
                    {t("settings.mobile.revoke")}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
