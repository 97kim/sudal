/// <reference types="vite/client" />
// 확정 수달 캐릭터(손그림)의 프레임과 간격. 원본은 .sudal/otter-art/handdrawn/ 의 color-v3(기분)·move-v6(걷기·뛰기).
// 192px 를 96 CSS px 로 그려 Retina 에서도 선명하다.
import type { OtterMood, OtterMotion } from "@shared/otter";

const urls = import.meta.glob<string>("./assets/otter/*.png", { eager: true, query: "?url", import: "default" });

/** 기분·동작마다 프레임별 표시 시간(ms). 걷기·뛰기는 이동 속도(OTTER_ROAM.speed)와 짝이다 — 따로 바꾸면 발이 미끄러진다. */
const TIMING: Record<OtterMood | OtterMotion, number[]> = {
  idle: [1700, 250, 130, 650],
  working: [420, 180, 120, 350],
  waiting: [600, 240, 240, 650],
  done: [220, 180, 220, 550],
  error: [850, 280, 280, 700],
  limit: [1000, 400, 1000, 500],
  walk: [120, 120, 120, 120, 120, 120],
  run: [100, 100, 100, 100, 100, 100],
};

export const OTTER_FRAMES: Record<OtterMood | OtterMotion, { src: string; ms: number }[]> = Object.fromEntries(
  (Object.keys(TIMING) as (OtterMood | OtterMotion)[]).map((mood) => [
    mood,
    TIMING[mood].map((ms, i) => ({ src: urls[`./assets/otter/${mood}-${i}.png`], ms })),
  ]),
) as Record<OtterMood | OtterMotion, { src: string; ms: number }[]>;
