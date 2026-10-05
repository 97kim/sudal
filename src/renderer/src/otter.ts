// 화면에 떠 있는 수달(otter.html). 그림은 otter.html 의 SVG, 기분별 몸짓은 otter.css 가 맡는다.
import "./otter.css";
import type { OtterViewDto } from "@shared/ipc";

const otter = document.getElementById("otter")!;
const bubble = document.getElementById("bubble")!;
const badge = document.getElementById("badge")!;
const stage = document.getElementById("stage")!;

window.otter.onState((v: OtterViewDto) => {
  otter.dataset.mood = v.mood;
  stage.classList.toggle("dim", v.dim);
  // 일하는 탭이 둘 이상이면 몇 개인지 붙인다. 다른 기분의 개수는 말풍선이 말한다.
  badge.hidden = !(v.mood === "working" && v.count > 1);
  badge.textContent = String(v.count);
  bubble.hidden = !v.bubble;
  bubble.textContent = v.bubble ?? "";
});
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
