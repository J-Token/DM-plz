# DM-Plz

[English](./README.md) | **한국어**

**Claude Code가 입력이 필요할 때 Telegram이나 Discord로 알림을 받으세요.**

[call-me](https://github.com/ZeframLou/call-me)에서 영감을 받은 DM-Plz는 Claude가 작업을 완료하거나, 결정이 필요하거나, 진행 상황을 보고하고 싶을 때 Telegram이나 Discord로 메시지를 보낼 수 있게 합니다. Claude가 작업하는 것을 지켜보고 싶지 않은 긴 작업에 완벽합니다.

## 기능

- **다중 플랫폼** - Telegram과 Discord 중 선택
- **간단한 알림** - 전화 없이 업데이트 받기
- **질문하기** - Claude가 질문하고 답변을 기다릴 수 있음
- **권한 요청 거부 사유 입력** - 권한 요청을 거부할 때 사유를 입력할 수 있으며, 입력한 사유는 "다음 지시"로 간주되어 Claude가 작업을 조정해 다시 진행합니다

- **간단한 설정** - 봇 토큰과 채널/채팅 ID만 필요
- **무료** - Telegram과 Discord 봇 API 모두 완전 무료
- **비동기 친화적** - 실시간 압박 없이 자신의 페이스대로 답변

---

## 빠른 시작

선호하는 플랫폼을 선택하세요:

### 옵션 1: Telegram

#### 1. Telegram 봇 생성

1. Telegram에서 [@BotFather](https://t.me/BotFather)에게 메시지 보내기
2. `/newbot` 전송 후 안내 따르기
3. 봇 이름 설정 (예: "Claude Code Bot")
4. 봇 사용자명 설정 (예: "my_claude_code_bot")
5. 받은 **봇 토큰** 복사 (`123456789:ABCdefGHIjklMNOpqrsTUVwxyz` 형식)

#### 2. Chat ID 얻기

1. Telegram에서 [@userinfobot](https://t.me/userinfobot)에게 메시지 보내기
2. **Chat ID** 복사 (`123456789` 같은 숫자)

#### 3. 환경 변수 설정

`~/.claude/settings.json`에 추가:

```json
{
  "env": {
    "DMPLZ_PROVIDER": "telegram",
    "DMPLZ_TELEGRAM_BOT_TOKEN": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
    "DMPLZ_TELEGRAM_CHAT_ID": "123456789"
  }
}
```

### 옵션 2: Discord

#### 1. Discord 봇 생성

1. [Discord Developer Portal](https://discord.com/developers/applications) 접속
2. "New Application" 클릭 후 이름 설정
3. "Bot" 섹션 이동 후 "Add Bot" 클릭
4. "Token" 아래 "Copy"를 눌러 **봇 토큰** 복사
5. Privileged Gateway Intents에서 "MESSAGE CONTENT INTENT" 활성화

#### 2. 서버에 봇 초대

1. "OAuth2" > "URL Generator"로 이동
2. 스코프 선택: `bot`
3. 권한 선택: `Send Messages`, `Read Messages`, `Read Message History`
4. 생성된 URL 복사 후 브라우저에서 열기
5. 서버 선택 후 봇 승인

#### 3. 채널 ID 얻기

1. Discord에서 개발자 모드 활성화 (설정 > 고급 > 개발자 모드)
2. 알림을 받을 채널 우클릭
3. "ID 복사"를 눌러 **채널 ID** 얻기
4. (선택) 권한 요청을 DM으로 받고 싶다면 본인 사용자 프로필 우클릭 후 **사용자 ID**도 복사

#### 4. 환경 변수 설정

`~/.claude/settings.json`에 추가:

```json
{
  "env": {
    "DMPLZ_PROVIDER": "discord",
    "DMPLZ_DISCORD_BOT_TOKEN": "your_discord_bot_token_here",
    "DMPLZ_DISCORD_CHANNEL_ID": "123456789012345678",
    "DMPLZ_DISCORD_DM_USER_ID": "123456789012345678",
    "DMPLZ_PERMISSION_CHAT_ID": "123456789012345678"
  }
}
```

---

## 설치

```bash
# 로컬 디렉토리에서 설치
/plugin marketplace add /path/to/dm-plz
/plugin install dm-plz@dm-plz
```

또는 GitHub에 게시된 경우:

```bash
/plugin marketplace add yourusername/dm-plz
/plugin install dm-plz@dm-plz
```

Claude Code를 재시작하면 완료!

---

## 설정 변수

| 변수 | 필수 여부 | 설명 |
|----------|----------|-------------|
| `DMPLZ_PROVIDER` | 아니오 (기본값: `telegram`) | 사용할 플랫폼: `telegram` 또는 `discord` |
| `DMPLZ_TELEGRAM_BOT_TOKEN` | 예 (Telegram 사용시) | @BotFather에서 받은 봇 토큰 |
| `DMPLZ_TELEGRAM_CHAT_ID` | 예 (Telegram 사용시) | @userinfobot에서 받은 개인 채팅 ID |
| `DMPLZ_DISCORD_BOT_TOKEN` | 예 (Discord 사용시) | Discord Developer Portal에서 받은 봇 토큰 |
| `DMPLZ_DISCORD_CHANNEL_ID` | 예 (Discord 사용시) | 채널 ID (개발자 모드에서 복사) |
| `DMPLZ_DISCORD_DM_USER_ID` | 아니오 (Discord) | 권한 요청을 DM으로 보낼 사용자 ID |
| `DMPLZ_PERMISSION_CHAT_ID` | 아니오 | 권한 요청을 보낼 별도 채팅/채널 ID |
| `DMPLZ_QUESTION_TIMEOUT_MS` | 아니오 (기본값: `10800000`) | 응답 대기 시간 제한 (3시간) |
| `DMPLZ_REJECT_REASON_TIMEOUT_MS` | 아니오 (기본값: `600000`) | 거부 사유 입력 대기 시간 제한 (10분) |


권한 요청은 `DMPLZ_PERMISSION_CHAT_ID`가 있으면 그 값을 우선 사용하고, 없으면 `DMPLZ_DISCORD_DM_USER_ID`(Discord 전용), 그것도 없으면 기본 채널/채팅으로 전송됩니다.

---

## 작동 원리

```
Claude Code                DM-Plz MCP Server (로컬)
    │                              │
    │  "작업 완료!"                │
    ▼                              ▼
Plugin ──────stdio───────────► MCP Server
                                   │
                                   │ HTTPS
                                   ▼
                    Telegram Bot API / Discord API
                                   │
                                   ▼
                       Telegram / Discord 앱
```

MCP 서버는 로컬에서 실행되며 폴링 방식으로 봇 API를 사용합니다 (웹훅 불필요).

---

## 도구

### `send_message`
간단한 알림 메시지를 전송합니다.

```typescript
await send_message({
  message: "빌드가 성공적으로 완료되었습니다! ✅",
  parse_mode: "Markdown" // 선택사항
});
```

### `ask_question`
질문을 보내고 사용자의 답변을 기다립니다.

```typescript
const response = await ask_question({
  question: "3개의 버그를 발견했습니다. 지금 수정할까요 아니면 이슈를 생성할까요?",
  parse_mode: "Markdown" // 선택사항
});
// 사용자의 응답이 텍스트로 반환됩니다
```

### `send_notification`
제목과 상세 메시지가 있는 알림을 전송합니다.

```typescript
await send_notification({
  title: "배포 완료",
  message: "프로덕션에 성공적으로 배포되었습니다\n• 15개 파일 변경\n• 0개 에러\n• 2개 경고",
  parse_mode: "Markdown" // 선택사항
});
```

---

## 사용 예시

### 작업 완료 알림
```
Claude: *인증 시스템 구현 완료*
Claude: send_message("인증 시스템을 구현했습니다! JWT 토큰, 로그인/로그아웃, 비밀번호 해싱을 추가했습니다.")
사용자: *Telegram/Discord에서 알림 수신*
```

### 대화형 의사결정
```
Claude: *문제를 해결하는 여러 방법 발견*
Claude: ask_question("캐싱을 Redis나 in-memory로 구현할 수 있습니다. 어떤 것을 선호하시나요?")
사용자: *Telegram/Discord에서 답변* "일단 in-memory로"
Claude: *사용자의 선택에 따라 계속 진행*
```

### 진행 상황 업데이트
```
Claude: *테스트 실행 중*
Claude: send_notification(title: "테스트 실행 중", message: "250개의 테스트를 실행 중입니다... 몇 분 정도 걸릴 수 있습니다")
사용자: *다른 일을 할 수 있음*
Claude: *테스트 완료*
Claude: send_notification(title: "테스트 완료", message: "250개의 테스트 모두 통과 ✅")
```

---

## 자동 트리거

플러그인에는 Claude가 작업을 멈췄을 때 알림을 보내야 하는지 자동으로 평가하도록 하는 **Stop 훅**이 포함되어 있습니다. 이는 Claude가 명시적으로 지시받지 않아도 종종 자발적으로 메시지를 보낸다는 의미입니다.

`.claude-plugin/plugin.json`을 편집하여 이 동작을 사용자 정의할 수 있습니다.

### ⚠️ 중요: Stop Hook 충돌

다른 플러그인(예: `oh-my-claude-sisyphus`)도 Stop hook을 가지고 있다면 DM-Plz의 Stop hook과 충돌할 수 있습니다. Claude Code는 하나의 Stop hook 응답만 사용합니다.

**프로젝트에서 다른 Stop hook을 비활성화하려면**, 프로젝트의 `.claude/settings.json`에 다음을 추가하세요:

```json
{
  "hooks": {
    "Stop": []
  }
}
```

이렇게 하면 Claude가 작업을 멈출 때 DM-Plz의 Stop hook만 실행됩니다.

### 🔧 Stop Hook 설치 (Continue 기능에 필요)

Claude Code 버그([#10412](https://github.com/anthropics/claude-code/issues/10412))로 인해 플러그인으로 설치된 Stop hook은 `continueInstruction` 기능을 사용할 수 없습니다. "DM으로 계속하기" 기능을 사용하려면 Stop hook을 직접 설치해야 합니다.

**방법 1: npm 스크립트 사용 (권장)**

```bash
cd /path/to/dm-plz/server
bun run install-stop-hook
```

이 명령은 `~/.claude/settings.json`에 Stop hook을 추가합니다.

**방법 2: 수동 설치**

`~/.claude/settings.json`에 다음을 추가하세요:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bun run \"/path/to/dm-plz/server/src/stop-hook.ts\"",
            "timeout": 300000
          }
        ]
      }
    ]
  }
}
```

`/path/to/dm-plz`를 실제 DM-Plz 설치 경로로 변경하세요.

**설치 후** Claude Code를 재시작하면 변경 사항이 적용됩니다.

---

## 메시지 포맷팅

Markdown과 HTML 포맷팅 모두 지원됩니다:

### Markdown (권장)
```
**굵게** *기울임* `코드`
[링크](https://example.com)
```

### HTML
```
<b>굵게</b> <i>기울임</i> <code>코드</code>
<a href="https://example.com">링크</a>
```

**참고**: Discord는 기본적으로 Markdown을 사용합니다. HTML 모드는 Discord에서 Markdown으로 변환됩니다.

---

## 비용

**$0.00** - Telegram과 Discord 봇 API 모두 완전 무료입니다!

---

## 비교

| 기능 | Telegram | Discord |
|---------|----------|---------|
| 설정 복잡도 | 매우 낮음 | 낮음 |
| 개인 DM | 예 | 예 (채널 통해) |
| Markdown 지원 | 예 | 예 (기본) |
| 속도 제한 | 매우 관대함 | 보통 |
| 폴링 속도 | 10초 간격 | 2초 간격 |
| 적합한 용도 | 개인 알림 | 팀/서버 알림 |

---

## 문제 해결

### Claude가 도구를 사용하지 않음
1. `~/.claude/settings.json`에 모든 환경 변수가 설정되어 있는지 확인
2. 플러그인 설치 후 Claude Code 재시작
3. 명시적으로 시도: "작업이 끝나면 메시지 보내줘."

### Telegram: 메시지가 수신되지 않음
1. 봇 토큰이 올바른지 확인
2. 봇과 채팅을 시작했는지 확인 (`/start` 전송)
3. 채팅 ID가 개인 채팅 ID인지 확인 (그룹이 아님)
4. `claude --debug`로 MCP 서버 로그 확인

### Discord: 메시지가 수신되지 않음
1. 봇 토큰과 채널 ID가 올바른지 확인
2. 봇이 서버에 초대되었는지 확인
3. 봇에 권한이 있는지 확인: Send Messages, Read Messages, Read Message History
4. Discord Developer Portal에서 MESSAGE CONTENT INTENT가 활성화되어 있는지 확인
5. `claude --debug`로 MCP 서버 로그 확인

### 질문 시간 초과
1. 응답하는 데 더 많은 시간이 필요하면 `DMPLZ_QUESTION_TIMEOUT_MS` 증가
2. 올바른 채팅/채널에서 답변하고 있는지 확인

### API 오류
1. 토큰 형식이 올바른지 확인
2. 인터넷 연결 확인
3. Discord: 봇이 서버에서 제거되지 않았는지 확인
4. Telegram: 봇이 @BotFather에 의해 삭제되지 않았는지 확인

---

## 개발

```bash
cd server
bun install
bun run dev
```

서버를 수동으로 테스트하려면:

**Telegram:**
```bash
export DMPLZ_PROVIDER=telegram
export DMPLZ_TELEGRAM_BOT_TOKEN="your_token"
export DMPLZ_TELEGRAM_CHAT_ID="your_chat_id"
bun run src/index.ts
```

**Discord:**
```bash
export DMPLZ_PROVIDER=discord
export DMPLZ_DISCORD_BOT_TOKEN="your_token"
export DMPLZ_DISCORD_CHANNEL_ID="your_channel_id"
bun run src/index.ts
```

---

## 프로젝트 구조

```
dm-plz/
├── .claude-plugin/
│   ├── plugin.json          # 플러그인 설정
│   └── marketplace.json     # 마켓플레이스 메타데이터
├── server/
│   ├── src/
│   │   ├── index.ts         # MCP 서버 메인
│   │   ├── types.ts         # 타입 정의
│   │   └── providers/
│   │       ├── index.ts     # Provider 팩토리
│   │       ├── telegram.ts  # Telegram 구현
│   │       └── discord.ts   # Discord 구현
│   └── package.json
├── .env.example
├── .gitignore
├── README.md                # 영어 문서
└── README.ko.md             # 한국어 문서
```

---

## 기여

기여를 환영합니다! 이슈나 PR을 열어주세요.

---

## 라이선스

MIT

---

## 감사의 말

- [@ZeframLou](https://github.com/ZeframLou)의 [call-me](https://github.com/ZeframLou/call-me)에서 영감을 받음
- 참고한 구현:
  - [telegram-notification-mcp](https://github.com/kstonekuan/telegram-notification-mcp)
  - [claude-telegram-mcp](https://www.npmjs.com/package/@s1lverain/claude-telegram-mcp)
  - [innerVoice](https://github.com/RichardDillman/claude-telegram-bridge)
