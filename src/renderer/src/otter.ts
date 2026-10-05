// 화면에 떠 있는 수달(otter.html). 기분마다 손그림 프레임 4장을 정해진 간격으로 번갈아 보여 준다.
import "./otter.css";
import type { OtterViewDto } from "@shared/ipc";
import type { OtterMood } from "@shared/otter";
import { OTTER_FRAMES } from "./otter-frames";

const otter = document.getElementById("otter")!;
const bubble = document.getElementById("bubble")!;
const badge = document.getElementById("badge")!;
const stage = document.getElementById("stage")!;
const sprite = document.getElementById("sprite") as HTMLImageElement;

// 처음 바뀔 때 비어 보이지 않게 모든 프레임을 미리 받아 둔다.
for (const frames of Object.values(OTTER_FRAMES)) for (const f of frames) new Image().src = f.src;

let mood: OtterMood = "idle";
let frame = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
/** 지금 기분의 프레임을 간격대로 돌린다. 끄는 동안은 멈춘다(창이 움직이는 중에 그림까지 바뀌면 산만하다). */
const tick = () => {
  const frames = OTTER_FRAMES[mood];
  const f = frames[frame % frames.length];
  sprite.src = f.src;
  timer = setTimeout(() => {
    if (!dragging) frame = (frame + 1) % frames.length;
    tick();
  }, f.ms);
};
const play = (next: OtterMood) => {
  if (next === mood && timer) return;
  mood = next;
  frame = 0;
  if (timer) clearTimeout(timer);
  tick();
};

window.otter.onState((v: OtterViewDto) => {
  otter.dataset.mood = v.mood;
  play(v.mood);
  stage.classList.toggle("dim", v.dim);
  // 일하는 탭이 둘 이상이면 몇 개인지 붙인다. 다른 기분의 개수는 말풍선이 말한다.
  badge.hidden = !(v.mood === "working" && v.count > 1);
  badge.textContent = String(v.count);
  bubble.hidden = !v.bubble;
  bubble.textContent = v.bubble ?? "";
});
play("idle");
window.otter.ready();

// 마우스가 수달·말풍선 위에 있을 때만 클릭을 받는다. 나머지 투명한 부분은 아래 창으로 지나간다.
let dragging = false;
let pressed = false;
for (const el of [otter, bubble]) {
  el.addEventListener("pointerenter", () => window.otter.setInteractive(true));
  el.addEventListener("pointerleave", () => {
    if (!pressed) window.otter.setInteractive(false);
  });
}

// 누른 채 3px 넘게 움직이면 끌기, 아니면 클릭. 창이 따라 움직이므로 화면 좌표의 차이만 보낸다.
let lastX = 0;
let lastY = 0;
let moved = 0;
const onDown = (e: PointerEvent) => {
  if (e.button !== 0) return;
  pressed = true;
  dragging = false;
  moved = 0;
  lastX = e.screenX;
  lastY = e.screenY;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
};
const onMove = (e: PointerEvent) => {
  if (!pressed) return;
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;
  moved += Math.abs(dx) + Math.abs(dy);
  if (!dragging && moved < 3) return;
  dragging = true;
  stage.classList.add("dragging");
  lastX = e.screenX;
  lastY = e.screenY;
  window.otter.drag(dx, dy);
};
const onUp = () => {
  if (!pressed) return;
  pressed = false;
  stage.classList.remove("dragging");
  if (dragging) window.otter.dragEnd();
  else window.otter.click();
  dragging = false;
};
for (const el of [otter, bubble]) {
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    window.otter.menu();
  });
}
