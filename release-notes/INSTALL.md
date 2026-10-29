## 설치

Homebrew로 설치하면 이후 업데이트는 앱의 설정 → 일반 → 업데이트나 `brew update && brew upgrade --cask sudal`로 받을 수 있어요.

```
brew tap 97kim/sudal
brew trust --cask 97kim/sudal/sudal
brew install --cask sudal
```

Homebrew 7부터는 공식 목록 밖의 레시피를 `brew trust`로 한 번 신뢰해야 설치할 수 있어요. 위 명령은 Sudal 하나만 신뢰해요.

DMG를 내려받아 `Sudal.app`을 Applications 폴더로 옮겨도 돼요.

서명과 공증을 하지 않은 앱이라 처음 열 때 macOS가 막아요. 터미널에서 격리 표시를 떼는 방법이 가장 확실해요.

```
xattr -d com.apple.quarantine /Applications/Sudal.app
```

한 번 열어 본 뒤 **시스템 설정 → 개인정보 보호 및 보안**에서 "그래도 열기"를 눌러도 돼요.
예전에 쓰던 우클릭 → 열기는 macOS 15 Sequoia부터 통하지 않아요.

## Windows에 설치하기

아래 `sudal-{{version}}-x64.exe`를 내려받아 실행하면 관리자 권한 없이 바로 설치되고 Sudal이 열려요.

코드 서명을 하지 않은 설치 파일이라 처음 실행할 때 "Windows의 PC 보호" 창이 떠요. **추가 정보**를 누른 뒤 **실행**을 누르세요.

이후 업데이트는 앱의 설정 → 일반 → 업데이트에서 받을 수 있어요.

## 필요한 것

Apple Silicon Mac 또는 64비트 Windows 10·11, 그리고 로그인을 마친 `claude`, `codex` 또는 `agy` CLI가 필요해요.
Windows에서 Claude Code를 쓰려면 [Git for Windows](https://git-scm.com/downloads/win)(Git Bash)도 설치해야 해요.
