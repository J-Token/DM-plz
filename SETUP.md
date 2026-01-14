# DM-Plz 설치 가이드

## 플랫폼 선택

Telegram 또는 Discord 중 선택하세요.

---

## Option 1: Telegram으로 설치

### 1. 텔레그램 봇 생성
1. 텔레그램에서 [@BotFather](https://t.me/BotFather) 검색
2. `/newbot` 명령어 입력
3. 봇 이름 입력 (예: "My Claude Bot")
4. 봇 사용자명 입력 (예: "my_claude_bot")
5. **봇 토큰** 복사 (예: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Chat ID 확인
1. 텔레그램에서 [@userinfobot](https://t.me/userinfobot) 검색
2. 봇에 메시지 전송
3. **Chat ID** 복사 (예: `123456789`)

### 3. 설정 파일 수정

`~/.claude/settings.json` 파일을 열고 다음 내용 추가:

```json
{
  "env": {
    "DMPLZ_PROVIDER": "telegram",
    "DMPLZ_TELEGRAM_BOT_TOKEN": "여기에_봇_토큰_입력",
    "DMPLZ_TELEGRAM_CHAT_ID": "여기에_Chat_ID_입력"
  }
}
```

---

## Option 2: Discord로 설치

### 1. Discord 봇 생성
1. [Discord Developer Portal](https://discord.com/developers/applications) 접속
2. "New Application" 클릭하고 이름 입력
3. "Bot" 섹션으로 이동하여 "Add Bot" 클릭
4. "Token" 아래 "Copy"를 클릭하여 **봇 토큰** 복사
5. "Privileged Gateway Intents"에서 "MESSAGE CONTENT INTENT" 활성화

### 2. 봇을 서버에 초대
1. "OAuth2" > "URL Generator"로 이동
2. Scopes에서 `bot` 선택
3. Permissions에서 다음 권한 선택:
   - Send Messages
   - Read Messages
   - Read Message History
4. 생성된 URL을 복사하여 브라우저에서 열기
5. 서버를 선택하고 봇을 승인

### 3. Channel ID 확인
1. Discord 설정에서 개발자 모드 활성화 (설정 > 고급 > 개발자 모드)
2. 알림을 받을 채널을 우클릭
3. "ID 복사"를 클릭하여 **Channel ID** 복사
4. (선택) 권한 요청을 DM으로 받고 싶다면 본인 사용자 프로필 우클릭 후 **User ID**도 복사

### 4. 설정 파일 수정

`~/.claude/settings.json` 파일을 열고 다음 내용 추가:

```json
{
  "env": {
    "DMPLZ_PROVIDER": "discord",
    "DMPLZ_DISCORD_BOT_TOKEN": "여기에_봇_토큰_입력",
    "DMPLZ_DISCORD_CHANNEL_ID": "여기에_Channel_ID_입력",
    "DMPLZ_DISCORD_DM_USER_ID": "여기에_User_ID_입력",
    "DMPLZ_PERMISSION_CHAT_ID": "여기에_권한요청_채널ID_입력"
  }
}
```

---

## 4. 플러그인 설치

```bash
# Claude Code에서 실행
# 로컬에서 설치할 경우
/plugin marketplace add /path/to/dm-plz
/plugin install dm-plz@dm-plz

# 또는 GitHub에서 설치할 경우
/plugin marketplace add yourusername/dm-plz
/plugin install dm-plz@dm-plz
```

---

## 5. Claude Code 재시작

설정을 적용하기 위해 Claude Code를 재시작합니다.

---

## 테스트

Claude Code를 실행하고 다음과 같이 말해보세요:

```
"테스트 메시지를 보내줘"
```

Telegram/Discord로 메시지가 오면 성공!

---

## 문제 해결

### Telegram: 봇이 메시지를 보내지 않음
- 봇 토큰과 Chat ID가 올바른지 확인
- 봇과 대화를 시작했는지 확인 (`/start` 명령어 전송)
- `claude --debug`로 로그 확인

### Discord: 봇이 메시지를 보내지 않음
- 봇 토큰과 Channel ID가 올바른지 확인
- 봇이 서버에 초대되었는지 확인
- 봇에게 필요한 권한이 있는지 확인
- MESSAGE CONTENT INTENT가 활성화되어 있는지 확인
- `claude --debug`로 로그 확인

### "Configuration error" 메시지
- `~/.claude/settings.json` 파일이 올바르게 작성되었는지 확인
- JSON 문법 오류가 없는지 확인
- `DMPLZ_PROVIDER` 값이 `telegram` 또는 `discord`인지 확인

### 플러그인이 로드되지 않음
- Claude Code 재시작
- 플러그인 경로가 올바른지 확인

---

## 사용 예시

### 1. 간단한 알림
```
Claude: "작업 완료했어! 알려줘"
→ Telegram/Discord로 알림 전송
```

### 2. 질문하기
```
Claude: "버그 3개 발견했는데, 지금 고칠까 아니면 이슈 만들까?"
→ Telegram/Discord로 질문 전송
→ 사용자 답변 대기
→ 답변에 따라 작업 진행
```

### 3. 상세 알림
```
Claude: "배포 완료! 상세 정보를 보내줘"
→ 제목과 내용이 포함된 알림 전송
```

---

## 환경 변수 전체 목록

```json
{
  "env": {
    "DMPLZ_PROVIDER": "telegram",  // 또는 "discord"

    // Telegram 설정 (DMPLZ_PROVIDER=telegram일 때)
    "DMPLZ_TELEGRAM_BOT_TOKEN": "your_token",
    "DMPLZ_TELEGRAM_CHAT_ID": "your_chat_id",

    // Discord 설정 (DMPLZ_PROVIDER=discord일 때)
    "DMPLZ_DISCORD_BOT_TOKEN": "your_token",
    "DMPLZ_DISCORD_CHANNEL_ID": "your_channel_id",
    "DMPLZ_DISCORD_DM_USER_ID": "your_user_id",  // 권한 요청을 DM으로 보낼 사용자 ID

    // 공통 설정 (선택사항)
    "DMPLZ_PERMISSION_CHAT_ID": "your_permission_chat_id",  // 권한 요청을 보낼 별도 채팅/채널 ID
    "DMPLZ_QUESTION_TIMEOUT_MS": "10800000"  // 3시간 (기본값)
  }
}
```

---

## 다음 단계

- GitHub에 푸시하여 다른 사람들과 공유
- 마켓플레이스에 등록
- 추가 기능 구현 (이미지 전송, 버튼 등)

---

## 플랫폼 비교

| 항목 | Telegram | Discord |
|------|----------|---------|
| 설정 난이도 | 매우 쉬움 | 쉬움 |
| 개인 DM | 지원 | 채널을 통해 지원 |
| 응답 속도 | 10초 간격 폴링 | 2초 간격 폴링 |
| 적합한 용도 | 개인 알림 | 팀/서버 알림 |
