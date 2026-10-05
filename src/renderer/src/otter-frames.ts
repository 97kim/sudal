/// <reference types="vite/client" />
// 확정 수달 캐릭터(손그림)의 프레임과 간격. 원본은 .sudal/otter-art/handdrawn/selected/ 의 frames(192px)·sheet.json.
// 192px 를 96 CSS px 로 그려 Retina 에서도 선명하다.
import type { OtterMood } from "@shared/otter";

const urls = import.meta.glob<string>("./assets/otter/*.png", { eager: true, query: "?url", import: "default" });

/** 기분마다 프레임별 표시 시간(ms). sheet.json 의 값 그대로. */
const TIMING: Record<OtterMood, number[]> = {
  idle: [1700, 250, 130, 650],
  working: [420, 180, 120, 350],
  waiting: [600, 240, 240, 650],
  done: [220, 180, 220, 550],
  error: [850, 280, 280, 700],
  limit: [1000, 400, 1000, 500],
};

export const OTTER_FRAMES: Record<OtterMood, { src: string; ms: number }[]> = Object.fromEntries(
  (Object.keys(TIMING) as OtterMood[]).map((mood) => [
    mood,
    TIMING[mood].map((ms, i) => ({ src: urls[`./assets/otter/${mood}-${i}.png`], ms })),
  ]),
) as Record<OtterMood, { src: string; ms: number }[]>;
