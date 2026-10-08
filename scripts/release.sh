#!/usr/bin/env bash
# GitHub Releases 에 DMG 와 Windows 설치 파일을 올리고 Homebrew cask 를 갱신한다. 로컬에서 빌드해 올리는 방식이다 —
# 서명·공증을 하지 않아 CI 로 옮길 이유가 없고, 받는 쪽은 어차피 첫 실행 때 한 번 허용해야 한다.
# 소스 저장소(origin, 공개·MIT)에 태그와 릴리즈를 올리고, cask 는 TAP_REPO 에.
#
#   scripts/release.sh            현재 package.json 버전으로
#   scripts/release.sh 0.2.0      버전을 올리고(커밋까지) 릴리스
#   DRY_RUN=1 scripts/release.sh  실제로 올리지 않고 할 일만 보여 준다
#   RELEASE_NOTES=notes.md ...    변경 항목을 커밋 제목 대신 그 파일 내용으로 싣는다
set -euo pipefail

cd "$(dirname "$0")/.."

NEW_VERSION="${1:-}"
DRY_RUN="${DRY_RUN:-}"
PUBLIC_REPO="${PUBLIC_REPO:-97kim/sudal}"
TAP_REPO="${TAP_REPO:-97kim/homebrew-sudal}"

die() { echo "✗ $*" >&2; exit 1; }
step() { echo; echo "▸ $*"; }
run() { if [[ -n "$DRY_RUN" ]]; then echo "  (dry-run) $*"; else "$@"; fi; }

# ===== 올리기 전에 막을 것들 =====
command -v gh >/dev/null || die "gh 가 없다. brew install gh"
gh auth status >/dev/null 2>&1 || die "gh 로그인이 안 돼 있다. gh auth login"
git remote get-url origin >/dev/null 2>&1 || die "origin 원격이 없다. 먼저 GitHub 레포를 만들고 붙일 것."

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" ]] || die "main 에서만 릴리스한다 (지금: $BRANCH)"
[[ -z "$(git status --porcelain)" ]] || die "작업 트리가 깨끗하지 않다. 커밋하거나 되돌릴 것."

# ===== 버전 =====
if [[ -n "$NEW_VERSION" ]]; then
  [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "버전 형식은 x.y.z (받은 값: $NEW_VERSION)"
  step "버전 올리기 → $NEW_VERSION"
  run node -e "
    const fs=require('fs');
    const p='package.json'; const j=JSON.parse(fs.readFileSync(p,'utf8'));
    j.version=process.argv[1];
    fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
  " "$NEW_VERSION"
  run git add package.json
  run git commit -m "v$NEW_VERSION"
fi

VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
DMG="release/sudal-${VERSION}-arm64.dmg"
# Windows 는 이 Mac 에서 크로스 빌드한다. 앱은 latest.yml 을 읽어 스스로 업데이트하고(electron-updater), blockmap 으로 바뀐 부분만 받는다.
EXE="release/sudal-${VERSION}-x64.exe"
WIN_ASSETS=("$EXE" "$EXE.blockmap" "release/latest.yml")

git rev-parse "$TAG" >/dev/null 2>&1 && die "$TAG 태그가 이미 있다. 버전을 올릴 것."
gh release view "$TAG" --repo "$PUBLIC_REPO" >/dev/null 2>&1 && die "$TAG 릴리스가 이미 $PUBLIC_REPO 에 있다."

# ===== 검증하고 빌드 =====
step "타입체크·테스트"
run yarn typecheck
run yarn test

step "패키징 (몇 분 걸린다)"
run yarn package
[[ -n "$DRY_RUN" || -f "$DMG" ]] || die "$DMG 가 만들어지지 않았다."

step "Windows 패키징"
run yarn package:win
if [[ -z "$DRY_RUN" ]]; then
  for f in "${WIN_ASSETS[@]}"; do [[ -f "$f" ]] || die "$f 가 만들어지지 않았다."; done
  # latest.yml 은 버전마다 같은 이름이라 예전 빌드의 것이 남아 있을 수 있다
  grep -qx "version: $VERSION" release/latest.yml || die "release/latest.yml 이 $VERSION 이 아니다."
fi

# ===== 릴리스 노트 =====
# 지난 태그 이후의 커밋 제목. 첫 릴리스면 전체.
PREV_TAG="$(git tag --list 'v*' --sort=-v:refname | head -1)"
# 커밋 제목은 고치는 사람이 읽는 말이라("되풀이를 다 자르지 못한 경우를 셈으로 남긴다") 받는 사람에게는
# 안 읽힌다. RELEASE_NOTES 로 파일을 주면 그 내용을 대신 싣는다. 없으면 커밋 제목으로 대신한다.
# 버전 올리는 커밋(v0.8.7 같은 것)은 뺀다 — 변경 항목이 아니라 릴리스 자체의 부산물이다.
if [[ -n "${RELEASE_NOTES:-}" ]]; then
  [[ -f "$RELEASE_NOTES" ]] || die "RELEASE_NOTES 파일이 없다: $RELEASE_NOTES"
  LOG="$(cat "$RELEASE_NOTES")"
elif [[ -n "$PREV_TAG" ]]; then
  LOG="$(git log --format='- %s' "${PREV_TAG}..HEAD" | grep -v '^- v[0-9]' || true)"
else
  LOG="$(git log --format='- %s' -20 | grep -v '^- v[0-9]' || true)"
fi
NOTES="$(cat <<EOF
## 이번에 달라진 것

${LOG}

## 설치

Homebrew로 설치하면 이후 업데이트는 앱의 설정 → 일반 → 업데이트나 \`brew update && brew upgrade --cask sudal\`로 받을 수 있어요.

\`\`\`
brew tap 97kim/sudal
brew trust --cask 97kim/sudal/sudal
brew install --cask sudal
\`\`\`

Homebrew 7부터는 공식 목록 밖의 레시피를 \`brew trust\`로 한 번 신뢰해야 설치할 수 있어요. 위 명령은 Sudal 하나만 신뢰해요.

DMG를 내려받아 \`Sudal.app\`을 Applications 폴더로 옮겨도 돼요.

서명과 공증을 하지 않은 앱이라 처음 열 때 macOS가 막아요. 터미널에서 격리 표시를 떼는 방법이 가장 확실해요.

\`\`\`
xattr -d com.apple.quarantine /Applications/Sudal.app
\`\`\`

한 번 열어 본 뒤 **시스템 설정 → 개인정보 보호 및 보안**에서 "그래도 열기"를 눌러도 돼요.
예전에 쓰던 우클릭 → 열기는 macOS 15 Sequoia부터 통하지 않아요.

## Windows에 설치하기

아래 \`sudal-${VERSION}-x64.exe\`를 내려받아 실행하면 관리자 권한 없이 바로 설치되고 Sudal이 열려요.

코드 서명을 하지 않은 설치 파일이라 처음 실행할 때 "Windows의 PC 보호" 창이 떠요. **추가 정보**를 누른 뒤 **실행**을 누르세요.

이후 업데이트는 앱의 설정 → 일반 → 업데이트에서 받을 수 있어요.

## 필요한 것

Apple Silicon Mac 또는 64비트 Windows 10·11, 그리고 로그인을 마친 \`claude\` 또는 \`codex\` CLI가 필요해요.
Windows에서 Claude Code를 쓰려면 [Git for Windows](https://git-scm.com/downloads/win)(Git Bash)도 설치해야 해요.
EOF
)"

step "태그 $TAG 를 만들고 올린다"
run git tag -a "$TAG" -m "$TAG"
run git push origin main
run git push origin "$TAG"

step "릴리스 만들기 ($PUBLIC_REPO, $DMG, $EXE)"
if [[ -n "$DRY_RUN" ]]; then
  echo "  (dry-run) gh release create $TAG $DMG ${WIN_ASSETS[*]} --repo $PUBLIC_REPO --title $TAG --notes …"
  echo "$NOTES" | sed 's/^/    | /'
else
  gh release create "$TAG" "$DMG" "${WIN_ASSETS[@]}" --repo "$PUBLIC_REPO" --title "$TAG" --notes "$NOTES"
fi

# ===== Homebrew cask =====
# 탭 저장소의 Casks/sudal.rb 를 이번 버전·체크섬으로 다시 쓴다. 주소는 공개 저장소의 릴리스 파일이라 토큰이 필요 없다.
step "Homebrew cask 갱신 ($TAP_REPO)"
SHA="$([[ -n "$DRY_RUN" ]] && echo "<sha256>" || shasum -a 256 "$DMG" | cut -d' ' -f1)"
CASK="$(cat <<EOF
cask "sudal" do
  version "$VERSION"
  sha256 "$SHA"

  url "https://github.com/$PUBLIC_REPO/releases/download/v#{version}/sudal-#{version}-arm64.dmg"
  name "Sudal"
  desc "Chat tabs for Claude Code and Codex"
  homepage "https://github.com/$PUBLIC_REPO"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64

  app "Sudal.app"

  zap trash: [
    "~/Library/Application Support/Sudal",
    "~/Library/Preferences/io.github.97kim.sudal.plist",
    "~/Library/Saved Application State/io.github.97kim.sudal.savedState",
  ]

  caveats <<~CAVEATS
    서명과 공증을 하지 않은 앱이라 처음 열 때 macOS가 막아요.
    시스템 설정 → 개인정보 보호 및 보안에서 "그래도 열기"를 누르거나 다음을 실행하세요.
      xattr -d com.apple.quarantine #{appdir}/Sudal.app
    한 번 허용하면 이후 brew upgrade는 허용을 이어받아요.
  CAVEATS
end
EOF
)"
if [[ -n "$DRY_RUN" ]]; then
  echo "$CASK" | sed 's/^/    | /'
else
  TAP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TAP_DIR"' EXIT
  gh repo clone "$TAP_REPO" "$TAP_DIR" -- -q
  mkdir -p "$TAP_DIR/Casks"
  printf '%s\n' "$CASK" > "$TAP_DIR/Casks/sudal.rb"
  git -C "$TAP_DIR" add Casks/sudal.rb
  # 임시 폴더라 저장소 설정이 없다 — 전역(회사 계정 등)이 아니라 소스 저장소의 이름·이메일로 커밋한다
  git -C "$TAP_DIR" -c user.name="$(git config user.name)" -c user.email="$(git config user.email)" commit -q -m "Sudal $VERSION 버전을 올렸어요"
  git -C "$TAP_DIR" push -q origin HEAD
fi

step "끝"
echo "  $TAG · DMG $(du -h "$DMG" 2>/dev/null | cut -f1 || echo '?') · EXE $(du -h "$EXE" 2>/dev/null | cut -f1 || echo '?') · https://github.com/$PUBLIC_REPO/releases/tag/$TAG"
