import { useEffect, useState } from "react";
import type { TFunction } from "i18next";

/** 지금 시각(ms). active 인 동안만 1초마다 다시 그린다 — 끝난 카드까지 타이머를 돌리지 않는다. */
export function useNow(active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** 경과 초를 "N분 M초" / "N초" 로. */
export function formatElapsed(t: TFunction, secs: number): string {
  return secs >= 60 ? t("common.elapsedMinSec", { min: Math.floor(secs / 60), sec: secs % 60 }) : t("common.elapsedSec", { sec: secs });
}
