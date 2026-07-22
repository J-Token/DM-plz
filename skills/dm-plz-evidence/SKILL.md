---
name: dm-plz-evidence
description: Record screen evidence of GUI work and send it to the user over Telegram or Discord with DM-Plz. Use when the user is away from the machine and a desktop, browser, or installer task needs to be proven rather than described.
---

# dm-plz-evidence

A remote user cannot verify "the installer finished" from a text summary. This skill records the work with `airec` and sends the file through DM-Plz's `send_media` tool, so the proof arrives on their phone.

Recordings capture whatever is on screen, including passwords, tokens, and personal messages. They travel to Telegram or Discord, which are not end-to-end encrypted, and a copy stays on those servers after the local file is gone. Record the narrowest target that proves the work, and do not record at all when the screen is likely to expose secrets.

## Check prerequisites once

Both pieces are optional installs, and either may be missing.

- `send_media` must exist in the DM-Plz tool list. Without it there is nowhere to send the file, so do not record.
- `airec --version` must succeed. If it fails, tell the user once how to install it and continue the task with a text report:

  ```powershell
  irm https://raw.githubusercontent.com/j-token/airec/main/install.ps1 | iex
  ```

  Do not raise it again in the same session.

airec is Windows-only. On any other platform, skip these checks entirely and report in text.

A missing prerequisite never blocks the work the user actually asked for.

## Decide whether to record

Record when the result lives on screen and the user is not there to see it: installers and setup wizards, browser form flows, desktop app configuration, UI automation, anything driven through computer-use.

Do not record work whose result is a file or a log — code edits, builds, tests, refactors, git operations. A diff proves those better than a video does.

Do not record when the screen is likely to show a password manager, an authentication flow, a token in a terminal, banking, or private messages. Narrow the target to a single window instead, or fall back to a text report.

If the user says not to record, that holds for the rest of the session.

## Pick a target

Prefer one window over a whole monitor. Window capture keeps unrelated content out of the evidence and keeps the file smaller. Use a monitor only when the work spans several windows or the target cannot be identified.

Find targets with `airec list windows --json` or `airec list monitors --json`. Specify a window by title fragment, HWND, or process name.

If airec returns `AMBIGUOUS_TARGET`, it includes the candidate list in `data`. Narrow the query from those candidates rather than guessing.

## Record

Start before the first interaction, not after:

```powershell
airec start --window "Setup" --out "$env:LOCALAPPDATA\dm-plz\recordings\installer.mp4" --max-duration 30m --json
# {"event":"started","session":"a1b2",...}
```

Keep the `session` value. Always pass `--max-duration` so an abandoned session ends on its own. Write to `%LOCALAPPDATA%\dm-plz\recordings\` or a temp directory — never into the user's project, where the file would show up in `git status`.

Check `airec status --json` before starting anything; if a session is already active, use it instead of opening a second one.

Stop when the work is done, and read the terminal event:

```powershell
airec stop --session a1b2 --json
# {"event":"saved","file":"...","stop_reason":"requested","duration_ms":12400,"frames":372}
```

Read stdout as JSONL and keep stderr separate as diagnostics. Ignore event types and fields you do not recognize.

## Judge the evidence

`stop_reason` decides whether the recording can be trusted. Put the verdict in the caption, and carry it into whatever you tell the user.

| `stop_reason` | Verdict to convey |
| --- | --- |
| `requested` | ✅ ended normally |
| `duration_limit` | ✅ ended at the requested duration |
| `max_duration` | ✅ hit the duration ceiling — may not cover the whole task |
| `target_lost` | ⚠️ the target window disappeared |
| `error` | ⚠️ the capture pipeline failed |
| `aborted_on_failure` | ⚠️ stopped because another target failed |
| anything else, or missing | ⚠️ reason unknown |

These are meanings, not strings to copy. Express each one in the user's language, keeping the ✅ / ⚠️ marker.

If no `saved` event arrives, or the file is missing or zero bytes, there is no evidence. Report in text instead of sending.

A warning-marked recording is still worth sending — send it with the warning intact. Never treat an untrusted recording as confirmation that the task succeeded.

## Send

Compose a caption with what the work was, the duration and size, and the trust verdict. Then send the absolute path.

**Write the caption in the language the user speaks to you in** — they are reading it on their phone, away from the machine. This applies to every line that reaches them: the caption, the size-failure notice, and the privacy note. Keep the numbers, the file path, and the ✅ / ⚠️ markers as they are.

A Korean-speaking user gets:

```
send_media({
  file_path: "C:\\Users\\me\\AppData\\Local\\dm-plz\\recordings\\installer.mp4",
  caption: "설치 마법사 5단계 완료\n\n🎬 12.4초 · 3.1 MB · 대상: 창 \"Setup\"\n✅ 정상 종료"
})
```

An English-speaking user gets the same structure in English:

```
send_media({
  file_path: "C:\\Users\\me\\AppData\\Local\\dm-plz\\recordings\\installer.mp4",
  caption: "Installer wizard completed through step 5\n\n🎬 12.4s · 3.1 MB · target: window \"Setup\"\n✅ ended normally"
})
```

Send as soon as the work finishes. Do not wait to be asked.

On the first send of a session, add one line noting that recordings may contain sensitive on-screen content and that nothing is masked automatically. If the destination is a shared Discord channel rather than a personal DM, say so — the user may not have that in mind.

### When the file is too large

`MEDIA_TOO_LARGE` comes back with `limitBytes`. Shrink through `airec convert`, at most twice:

```powershell
airec convert installer.mp4 --out installer.gif --fps 10 --width 960 --json
# still over the limit:
airec convert installer.mp4 --out installer-small.gif --fps 6 --width 480 --json
```

Conversion never overwrites an existing output. A GIF can come out larger than its MP4 when the screen changes on every frame — if that happens, treat the attempt as failed and move on.

After two failures, stop converting and report the duration, size, how many shrink attempts were made, and the absolute local path — in the user's language:

```
🎬 41분 12초 · 214 MB
❌ 파일이 커서 전송하지 못했습니다 (축소 2회 시도)
📁 C:\Users\me\AppData\Local\dm-plz\recordings\installer.mp4
```

The report always goes out, attachment or not. Silence is the one unacceptable outcome.

## Afterwards

Keep the file. Evidence is more useful kept than tidy, and the user may ask for it again. Delete it only when they ask.

## Relationship to the `airec` skill

The `airec` skill documents the CLI itself — flags, effects, config, exit codes. Consult it for anything beyond the commands above rather than duplicating its content here.

This skill covers the judgment: when recording is warranted, what to capture, whether the result can be trusted, and how it reaches the user. When the two conflict, take the safer path — do not record, or do not send.
