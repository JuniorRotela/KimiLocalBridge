# Kimi Local Bridge

Transform Kimi K3.1 Pro—via NVIDIA Build, using a free and unlimited API—into a local programming agent for OpenCode. It features real-time streaming, native tool calls, file editing, terminal command execution, and browser automation via Playwright. No NVIDIA API key is required.

> **Unofficial project.** This bridge is not affiliated with or endorsed by NVIDIA, Moonshot AI, or OpenCode. It provides a way to use Kimi K3.1 Pro without needing an API—simply connect it via OpenCode and start using it.

## Why Kimi Local Bridge?

<img width="1032" height="594" alt="Captura de pantalla 2026-11-16 a la(s) 09 58 36" src="https://github.com/user-attachments/assets/e5008ba9-5b1f-4e86-a64b-5c0194d70396" />

# NVIDIA Kimi K3 OpenCode Bridge

NVIDIA currently offers free access to **Kimi K3** exclusively through its web Playground, without official API key generation to connect it to external tools. This project acts as a local bridge that exposes the NVIDIA Playground as an OpenAI-compatible API—allowing you to connect Kimi K3 directly to **OpenCode** (and other coding agents) without needing an API key.

## Key Features

* **Real coding agent:** Connect Kimi to OpenCode and let it read, write, and edit files and run commands through OpenCode's tools, subject to your permissions.
* **Real-time SSE streaming:** Forwards the playground's live token stream directly instead of scraping the final DOM.
* **Native function calling:** Supports tools, tool results, parallel tool calls, and multi-turn conversations.
* **Browser-session aware:** Uses your interactive NVIDIA Build login and captcha; it does not bypass them.
* **Local and private by default:** Listens on `127.0.0.1` only. Your prompts go directly to NVIDIA through your browser session.
* **Two independent browser tabs:** Allows concurrent requests with queuing, retries, graceful aborts, and automatic browser recovery.
* **OpenAI-compatible API:** Works out of the box with OpenCode and any OpenAI-compatible chat-completion client.
* **Optional Obsidian memory:** Stores project conversations, decisions, preferences, and next steps as linked Markdown notes.
* **No output-token limit:** When Kimi reaches the playground's per-turn cap, the bridge automatically asks it to continue and concatenates the output, so long files and answers are not truncated.
* **Complete responses by default:** Prioritizes precise, direct answers and verified coding actions without cutting off requested content.

## How it works

```text
OpenCode / your app
        |
        | OpenAI-compatible request
        v
localhost:4000/v1/chat/completions
        |
        | Express + Playwright
        v
NVIDIA Build Kimi K3.1 Pro Playground
        |
        | Authenticated request + real SSE stream
        v
OpenCode reads / edits files or executes allowed tools
```

The browser performs a real playground request. Playwright replaces its outgoing JSON body with your client's messages while retaining the page's session headers. A small fetch wrapper mirrors the resulting server-sent events back to the bridge. OpenCode, not this server, executes file and shell tools on your machine.

## Requirements

- Node.js **18 or later** (Node.js 22+ recommended).
- An operating system supported by Playwright Chromium: macOS, Linux, or Windows.
- Access to the [Kimi K3.1 Pro playground](https://build.nvidia.com/moonshotai/kimi-k3_1-pro/playground). An NVIDIA account may be required.
- [OpenCode](https://opencode.ai/) for the coding-agent workflow.

## Quick start

### 1. Install

```bash
git clone https://github.com/JuniorRotela/KimiLocalBridge.git
cd KimiLocalBridge
npm install
npx playwright install chromium
```

On Linux, if Chromium reports missing system libraries:

```bash
npx playwright install --with-deps chromium
```

### 2. Sign in to NVIDIA Build

```bash
npm start
```

A Chromium window opens on the Kimi playground. On the **first run**, sign in and complete any displayed verification manually. Wait until the normal chat interface appears and the log shows `Playground ready; Kimi is available`.

The session is saved in `nvidia-profile/`. **Never share or commit this directory.** It may contain authentication cookies and other private browser data. It is already excluded by `.gitignore`.

Keep the bridge terminal running. Closing the Chromium window is supported: the bridge automatically relaunches it on the next request.

### 3. Test the API

In another terminal:

```bash
curl http://127.0.0.1:4000/health

curl http://127.0.0.1:4000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "moonshotai/kimi-k3_1-pro",
    "messages": [{"role": "user", "content": "Reply with exactly: BRIDGE_OK"}],
    "stream": false
  }'
```

For streaming, add `"stream": true`. Use `http://localhost:4000/v1` or `http://127.0.0.1:4000/v1` for clients that resolve localhost normally.

## Use with OpenCode

> Configuration below is for the **legacy configuration format used by OpenCode 1.x**. Newer OpenCode releases may use `providers` instead of `provider`, and `settings` instead of `options`. See [OpenCode's provider documentation](https://opencode.ai/docs/providers/) if your version requires the newer format.

Add the following to your existing `~/.config/opencode/opencode.json` (macOS/Linux) or the equivalent OpenCode user configuration file. Merge it with your current settings; do not overwrite other providers. The `apiKey` value is only a local placeholder: the bridge does not require a key and is bound to localhost.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "local-bridge": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "NVIDIA Playground Bridge",
      "options": {
        "baseURL": "http://localhost:4000/v1",
        "apiKey": "bridge-session-active"
      },
      "models": {
        "moonshotai/kimi-k3_1-pro": {
          "name": "Kimi K3.1 Pro (Bridge)",
          "limit": {
            "context": 1048576,
            "output": 65536
          }
        }
      }
    }
  }
}
```

For current OpenCode versions using the newer provider format, the equivalent is:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "local-bridge": {
      "package": "@opencode/ai/providers/openai-compatible",
      "name": "NVIDIA Playground Bridge",
      "settings": {
        "baseURL": "http://localhost:4000/v1",
        "apiKey": "bridge-session-active"
      },
      "models": {
        "kimi-k3_1-pro": {
          "name": "Kimi K3.1 Pro (Bridge)",
          "modelID": "moonshotai/kimi-k3_1-pro",
          "capabilities": {
            "tools": true,
            "input": ["text"],
            "output": ["text"]
          },
          "limit": {
            "context": 1048576,
            "output": 65536
          }
        }
      }
    }
  }
}
```

OpenCode assumes a 32,000-token output limit for models it does not recognize. The `limit` blocks above declare the model's 1M-token context and a 65,536-token output so OpenCode does not impose a smaller cap. If the playground still stops earlier, the bridge continues automatically as described in [Unlimited output](#unlimited-output).

Then run a command inside the project you want the agent to work on:

```bash
opencode run -m local-bridge/moonshotai/kimi-k3_1-pro \
  "Create hello.txt containing 'Hello from Kimi', then read it back."
```

Or select **Kimi K3.1 Pro (Bridge)** in the OpenCode interface. The full model identifier may appear as `local-bridge/kimi-k3_1-pro` with the newer configuration.

### Persistent memory (Obsidian-compatible)

Enable the optional local plugin after configuring the `local-bridge` provider:

```bash
npm run setup:memory
```

For OpenCode **1.x**, this preserves your existing provider settings and adds `plugin: ["/absolute/path/to/plugins/kimi-local-bridge-memory"]` to your global configuration. It copies the plugin, so future updates can be applied by running the setup command again. For newer versions with the `providers` configuration format, it uses `plugins`.

For OpenCode **1.x**, use **one** loading method: the global setup above, or copy `src/memory.js` and `.opencode/plugins/kimi-memory.js` into the target project's `.opencode/plugins/` directory. Do not load both copies. Newer OpenCode versions can auto-discover the included project-level plugin.

Restart OpenCode after setup. It creates a **local `memory/` folder in each project you work on**. Open that folder directly as an Obsidian vault:

```text
memory/
├── Home.md
├── Index.md
├── Daily.md
├── notes/       Durable facts, preferences, decisions, and next steps
├── sessions/    User/assistant messages and tool activity per session
└── templates/   Optional templates for manual notes
```

The agent adds relevant durable notes to new prompts. It can also call `memory_remember` to save a decision or preference and `memory_search` to search notes and past sessions. Try:

```text
Remember that my preferred package manager is npm.
```

Then start a new session and ask:

```text
Which package manager do I prefer?
```

Session histories store messages and tool names, targets, and statuses—not complete shell output. Durable notes are Markdown with `[[wiki links]]`; you can edit or create them manually. The vault is local and ignored by Git. It is **not encrypted**: never store credentials, cookies, tokens, or secrets. See [memory/README.md](memory/README.md) for details.

The bridge instructs Kimi to answer in the user's language, stay precise, and verify coding actions, while preferring complete answers over brevity. Requested files and code are never intentionally truncated. Set `CONCISE_RESPONSES=false` to disable this instruction.

### Tool safety

File creation, edits, shell commands, and application launches are performed by **OpenCode on your computer**, not by the remote model itself. Review proposed commands and configure OpenCode's permissions appropriately. An instruction such as "delete files" or "install a package" may have real effects; the bridge is not a sandbox. This project does not provide unrestricted desktop/GUI control.

## Unlimited output

The playground applies a per-generation output cap (currently 65536 tokens), and NIM defaults to ~1024 when the field is missing, so the bridge always sends a per-call value. It treats that cap as a checkpoint, not a limit:

- `MAX_TOKENS=0` (the default) adds no bridge-imposed ceiling: each call uses 65536 tokens and client `max_tokens` / `max_completion_tokens` values are forwarded unchanged. Set `MAX_TOKENS` to a positive number only if you want a hard ceiling.
- When a generation finishes because of the cap (`finish_reason: "length"`), the bridge automatically sends a continuation turn with the partial answer and appends the new content to the same response. Streaming clients receive a single uninterrupted stream with one final `finish_reason`.
- Continuations repeat up to `MAX_CONTINUATIONS` times (default 12). If all of them are consumed, the final `finish_reason` is `length` so the client can tell the answer is incomplete.
- Set `AUTO_CONTINUE=false` to disable automatic continuation.
- Streams that drop without a finish event are also treated as incomplete and continued instead of being returned cut off.

## Configuration

The bridge reads environment variables from the shell. It does **not** automatically load `.env`; `.env.example` documents the available values. For example:

```bash
REASONING_EFFORT=high WORKERS=2 npm start
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP server port. |
| `HOST` | `127.0.0.1` | Listen address. Keep it loopback unless you add authentication. |
| `WORKERS` | `2` | Number of independent Chromium tabs, `1`–`6`. Each needs a playground session. |
| `HEADLESS` | `false` | Run without a visible browser when `true`; interactive verification is harder and headless mode may trigger captchas. |
| `PROFILE_DIR` | `./nvidia-profile` | Persistent Chromium profile directory, relative to your current directory. |
| `PLAYGROUND_URL` | Kimi playground URL | Playground page to automate. |
| `MODEL_ID` | `moonshotai/kimi-k3_1-pro` | Primary model ID advertised to clients. The dotted alias is also listed. |
| `UPSTREAM_MODEL` | `moonshotai/kimi-k3.1-pro` | Model ID sent to the playground API. |
| `MAX_TOKENS` | `0` | Optional hard output cap per upstream call. `0` means no bridge limit: calls use 65536 tokens and client values are forwarded unchanged. The bridge auto-continues past the cap, so output is effectively unlimited. |
| `AUTO_CONTINUE` | `true` | When Kimi hits the per-turn cap, ask it to continue and merge the output into one response. |
| `MAX_CONTINUATIONS` | `12` | Maximum automatic continuation turns per request, `0`–`100`. |
| `CONTINUE_PROMPT` | built-in text | Prompt sent to Kimi on each continuation turn. |
| `REASONING_EFFORT` | `low` | Default `low`, `medium`, `high`, or `max`; clients can override it. |
| `CONCISE_RESPONSES` | `true` | Add instructions for precise answers and verified coding actions while never truncating requested content. |
| `KIMI_MEMORY_DIR` | `<project>/memory` | Optional custom Obsidian vault location for the OpenCode process. |
| `KIMI_MEMORY_RETRIEVE` | `true` | Set to `false` to disable automatic note retrieval; memory tools remain available. |
| `TRIGGER_TEXT` | `continuar` | Placeholder UI text; the bridge replaces the request body with your messages. |
| `FIRST_BYTE_TIMEOUT_MS` | `90000` | Maximum wait for a playground response to begin. |
| `IDLE_TIMEOUT_MS` | `180000` | Maximum gap between incoming browser stream chunks. |
| `REQUEST_TIMEOUT_MS` | `1800000` | Total generation timeout (30 minutes). |
| `QUEUE_TIMEOUT_MS` | `600000` | Maximum wait for a free worker. |
| `RESET_AFTER_TURNS` | `40` | Reload a playground tab after this many completed turns. |
| `BROWSER_TIMEOUT_MS` | `60000` | Playwright navigation timeout. |
| `HEADERS_DELAY_MS` | `8000` | Delay before opening an empty SSE response to keep clients connected. |
| `MAX_MESSAGE_BYTES` | `104857600` | Maximum incoming JSON request size. |
| `DEBUG` | `false` | Enable browser and stream diagnostics when `true`. |

Stop the bridge with **Ctrl+C** to close its browser cleanly.

## API

- `GET /health`: browser, worker, and queue status.
- `GET /v1/models`: available public model IDs.
- `POST /v1/chat/completions`: chat completions, with or without streaming.

Supported inputs include system, user, assistant, and tool messages; text and image content parts; function tools and tool results; `tool_choice`, `parallel_tool_calls`, `max_tokens`, `max_completion_tokens`, `temperature`, `top_p`, `seed`, `stop`, and `reasoning_effort`. This is a chat-completions bridge, not a complete OpenAI API implementation: embeddings, the Responses API, and unrelated endpoints are not included.

### Function calling example

```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "moonshotai/kimi-k3_1-pro",
    "messages": [{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather for a city",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }]
  }'
```

Your client must execute the returned tool calls and send their results back in subsequent `tool` messages.

## Troubleshooting

**The browser asks for a login or verification.** Complete it manually in the bridge's Chromium window. This bridge does not bypass authentication or captchas.

**A request times out waiting for the playground.** Ensure the Kimi playground is usable interactively, you are signed in, the page is not showing an error, and you have not exceeded NVIDIA's limits. Try a fresh restart with `HEADLESS=false`.

**The browser profile is locked.** Close any other bridge/Chromium instance using the same `PROFILE_DIR`. Stop old bridge processes before restarting; do not delete profile files while Chromium is running.

**`Port 4000 is already in use`.** Stop the other instance or run `PORT=4001 npm start`, then update your client's base URL.

**Chromium is missing.** Run `npx playwright install chromium`; on Linux, use `npx playwright install --with-deps chromium`.

**OpenCode reports an unknown model.** Check the provider configuration for your installed OpenCode version, keep the bridge running, and ensure the selected model ID matches the configured key.

**All browser tabs are busy.** Requests wait for a free tab. Increase `WORKERS` moderately, or retry after current generations finish. NVIDIA may still apply its own usage limits.

**The playground changed and automation no longer works.** The selectors and network route are in `src/playground.js`. Open an issue with your OS, Node.js version, logs (with sensitive data removed), and the visible playground behavior.

## Development

```bash
npm test
npm run check
```

The tests cover memory persistence, search, and Obsidian links; `check` validates JavaScript syntax. A full end-to-end check requires an interactive NVIDIA session and OpenCode: start the bridge, run the API smoke test, then ask OpenCode to create and read a file in a disposable test directory.

```text
index.js             Express API, SSE transport, retries, and shutdown
src/config.js        Environment configuration
src/openai.js        OpenAI request normalization and response formatting
src/playground.js    Chromium session, request interception, and worker pool
src/sse.js           Stream accumulation and tool-call handling
src/memory.js        Obsidian-compatible memory storage and retrieval
.opencode/plugins/   OpenCode integration
scripts/             Optional global/project memory setup
memory/templates/    Public note templates; personal notes stay local
test/                Unit tests for token policy, streaming relay, and memory
```

## Security and responsible use

- The bridge has **no API authentication**. Never expose it to a public network without adding appropriate authentication and transport security.
- Browser-profile cookies and NVIDIA session data stay in `nvidia-profile/`, which is intentionally not committed. Set `PROFILE_DIR` to another private location if desired.
- Memory notes and session histories are local and ignored by Git. They may contain prompts and filenames; review or delete them before sharing a project.
- Do not paste credentials into prompts or publish logs containing private information.
- Keep your dependencies and browser updated, and review agent actions before allowing destructive commands.

## Contributing

Issues and focused pull requests are welcome. Include reproduction steps, your OS and Node.js version, and sanitized logs. Do not attach your `nvidia-profile`, cookies, account credentials, or captcha tokens.

## License

[MIT](LICENSE)
