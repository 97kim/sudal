import logo from "../assets/logo.png";

/**
 * Sudal 마크(sudal-logo.png 에서 흰 배경을 뺀 알파 PNG).
 * CSS mask 로 그리므로 색은 text-* 클래스(currentColor)로 정한다.
 */
export function Logo({ size = 16, className = "" }: { size?: number; className?: string }) {
  const mask = `url(${logo}) center / contain no-repeat`;
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 bg-current ${className}`}
      style={{ width: size, height: size, WebkitMask: mask, mask }}
    />
  );
}
