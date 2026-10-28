// 제공자 로고(Claude / Codex / Antigravity). 정사각 이미지라 모서리만 둥글리고 크기만 받는다.
import type { Provider } from "@shared/ipc";
import claude from "../assets/claude.webp";
import codex from "../assets/codex.webp";
import agy from "../assets/antigravity.png";

const SRC: Record<Provider, string> = { claude, codex, agy };
const ALT: Record<Provider, string> = { claude: "Claude", codex: "Codex", agy: "Antigravity" };

export function ProviderLogo({ provider, size = 16, className = "" }: { provider: Provider; size?: number; className?: string }) {
  return (
    <img
      src={SRC[provider]}
      alt={ALT[provider]}
      width={size}
      height={size}
      draggable={false}
      className={`shrink-0 select-none object-cover ${size >= 28 ? "rounded-md" : "rounded"} ${className}`}
      style={{ width: size, height: size }}
      data-provider-logo={provider}
    />
  );
}
