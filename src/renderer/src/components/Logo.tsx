import logo from "../assets/logo.svg";

/**
 * Sudal 마크(벡터). 14~22px 로 작게 그려도 가장자리가 뭉개지지 않게 PNG 대신 SVG 를 쓴다.
 * CSS mask 로 그리므로 색은 text-* 클래스(currentColor)로 정한다.
 */
export function Logo({ size = 16, className = "" }: { size?: number; className?: string }) {
  // 작은 SVG 는 빌드 때 데이터 URL 로 들어가고 그 안에 따옴표·공백이 있다 — 따옴표로 감싸지 않으면 mask 가 통째로 버려진다.
  const mask = `url("${logo}") center / contain no-repeat`;
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 bg-current ${className}`}
      style={{ width: size, height: size, WebkitMask: mask, mask }}
    />
  );
}
