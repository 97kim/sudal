// 휴대폰에서 이어 쓰기(Tailscale): 누가 들어올 수 있는지. 서버(mobile-server.ts)는 여기 판단만 쓴다.
// 신뢰 모델: Tailscale 주소에서 온 요청 + 처음 한 번 Sudal 설정에 뜬 6자리 코드로 짝지은 기기만. 짝지은 기기는 메시지를 보낼 수 있고,
// "전부 자동" 탭이면 그건 이 Mac 에서 명령을 실행시키는 것과 같다 — 그래서 토큰은 해시로만 두고, 코드는 짧게 살고 틀리면 버린다.

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Tailscale 이 기기에 주는 주소: IPv4 100.64.0.0/10(CGNAT), IPv6 fd7a:115c:a1e0::/48. IPv4-mapped(::ffff:100.x)도 받는다. */
export function isTailscaleAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, "");
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 100 && b >= 64 && b <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(ip);
}

/**
 * `tailscale status --json` 이 알려 주는 이 기기의 Tailscale 주소. 100.64.0.0/10 은 Tailscale 전용이 아니어서(다른 VPN·통신사 망),
 * 대역만 보고 열면 Tailscale 이 아닌 길에도 열린다 — Tailscale 이 자기 주소라고 한 것만 믿는다. 못 읽으면 [].
 */
export function parseTailscaleSelf(statusJson: string): string[] {
  try {
    const ips = (JSON.parse(statusJson) as { Self?: { TailscaleIPs?: unknown } }).Self?.TailscaleIPs;
    return Array.isArray(ips) ? ips.filter((ip): ip is string => typeof ip === "string" && isTailscaleAddress(ip)) : [];
  } catch {
    return [];
  }
}

/** 이 Mac 의 Tailscale 대역 주소들(os.networkInterfaces() 결과에서). 실제로 열 주소는 parseTailscaleSelf 와 겹치는 것만. */
export function tailscaleAddresses(ifaces: NodeJS.Dict<{ address: string; family: string | number; internal: boolean }[]>): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces))
    for (const a of list ?? []) if (!a.internal && isTailscaleAddress(a.address) && !out.includes(a.address)) out.push(a.address);
  // IPv4 를 앞에 — 휴대폰 주소창에 치기 쉽다
  return out.sort((x, y) => Number(x.includes(":")) - Number(y.includes(":")));
}

export interface MobileDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}
interface StoredDevice extends MobileDevice {
  /** 토큰의 sha256. 토큰 자체는 휴대폰에만 있다. */
  tokenHash: string;
}

const CODE_TTL_MS = 5 * 60_000;
const CODE_MAX_TRIES = 5;
/** 코드를 새로 만들어도 이어지는 실패 한도 — 10분에 10번 넘게 틀리면 그동안 연결을 받지 않는다. */
const FAIL_WINDOW_MS = 10 * 60_000;
const FAIL_LIMIT = 10;
const MAX_DEVICES = 20;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** 짝짓기 코드와 짝지은 기기. 기기 목록은 userData 의 파일(0600)에 둔다. */
export class MobilePairing {
  private devices: StoredDevice[];
  private code: { value: string; expiresAt: number; tries: number } | null = null;
  private failures: number[] = [];

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.devices = this.load();
  }

  private load(): StoredDevice[] {
    try {
      // 예전에 권한이 넓게 만들어졌거나 복원된 파일이면 좁힌다 — 다른 계정이 해시를 끼워 넣지 못하게
      if ((fs.statSync(this.file).mode & 0o077) !== 0) fs.chmodSync(this.file, 0o600);
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(raw)
        ? raw.filter((d): d is StoredDevice => !!d && typeof d.id === "string" && typeof d.tokenHash === "string" && /^[0-9a-f]{64}$/.test(d.tokenHash))
        : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // 임시 파일에 다 쓴 뒤 바꿔 넣는다 — 이미 있던 파일의 권한을 물려받지 않고, 쓰다 꺼져도 반쪽 파일이 남지 않는다
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.devices, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }

  /** 최근 실패가 한도를 넘었나. 넘었으면 맞는 코드도 받지 않는다. */
  locked(): boolean {
    const t = this.now();
    this.failures = this.failures.filter((x) => t - x < FAIL_WINDOW_MS);
    return this.failures.length >= FAIL_LIMIT;
  }

  /** 새 6자리 코드. 이전 코드는 무효가 된다. */
  newCode(): { code: string; expiresAt: number } {
    const value = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.code = { value, expiresAt: this.now() + CODE_TTL_MS, tries: 0 };
    return { code: value, expiresAt: this.code.expiresAt };
  }

  /** 지금 살아 있는 코드(설정 화면이 다시 열려도 보이게). */
  activeCode(): { code: string; expiresAt: number } | null {
    const c = this.code;
    if (!c || c.expiresAt <= this.now() || c.tries >= CODE_MAX_TRIES) return null;
    return { code: c.value, expiresAt: c.expiresAt };
  }

  /** 코드가 맞으면 기기를 등록하고 토큰을 준다. 틀리면 null — 다섯 번 틀리면 코드를 버린다. 맞으면 코드는 한 번 쓰고 버린다. */
  pair(code: string, name: string): { token: string; device: MobileDevice } | null {
    const c = this.code;
    if (this.locked() || !c || c.expiresAt <= this.now() || c.tries >= CODE_MAX_TRIES) return null;
    const given = Buffer.from(String(code).trim());
    const ok = given.length === c.value.length && timingSafeEqual(given, Buffer.from(c.value));
    if (!ok) {
      this.failures.push(this.now());
      c.tries += 1;
      if (c.tries >= CODE_MAX_TRIES) this.code = null;
      return null;
    }
    this.code = null;
    const token = randomBytes(32).toString("base64url");
    const t = this.now();
    const device: StoredDevice = {
      id: randomBytes(8).toString("hex"),
      // 비면 화면이 "휴대폰" 같은 이름을 번역해 보여 준다 — 저장하는 글에 언어를 박지 않는다
      name: String(name || "").trim().slice(0, 60),
      createdAt: t,
      lastSeenAt: t,
      tokenHash: hash(token),
    };
    this.devices = [...this.devices, device].slice(-MAX_DEVICES);
    this.save();
    return { token, device: publicDevice(device) };
  }

  /** 토큰의 기기. 마지막 접속 시각을 갱신한다(파일에는 1분에 한 번만 쓴다). */
  verify(token: string | undefined): MobileDevice | null {
    if (!token) return null;
    const h = hash(token);
    const d = this.devices.find((x) => timingSafeEqual(Buffer.from(x.tokenHash), Buffer.from(h)));
    if (!d) return null;
    const t = this.now();
    if (t - d.lastSeenAt > 60_000) {
      d.lastSeenAt = t;
      this.save();
    }
    return publicDevice(d);
  }

  /** 그 기기가 아직 등록돼 있는지(끊기거나 새 기기에 밀려 빠지면 false). */
  has(id: string): boolean {
    return this.devices.some((d) => d.id === id);
  }

  list(): MobileDevice[] {
    return this.devices.map(publicDevice);
  }

  revoke(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.save();
    return true;
  }
}

function publicDevice(d: StoredDevice): MobileDevice {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt };
}
