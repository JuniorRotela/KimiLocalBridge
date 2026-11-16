# Agent memory vault

This directory is created and maintained by the optional OpenCode memory plugin. It is an ordinary Markdown folder, so you can open it directly as an **Obsidian vault**.

## Structure

```text
memory/
├── Home.md                 Entry point
├── Index.md                Links to notes and sessions
├── Daily.md                Latest session index
├── notes/                  Durable knowledge, decisions, preferences
├── sessions/               One Markdown history per OpenCode session
└── templates/              Optional templates for manual notes
```

The generated `Home.md`, `Index.md`, `Daily.md`, notes, and session histories are local data and are ignored by Git. Only this documentation and the templates are committed.

## Notes and sessions

- A session stores the user's messages, the assistant's text, and the name, target, and status of tool calls. Full shell output is not saved.
- Durable notes are created through the `memory_remember` tool. Reusing a title replaces that note.
- The agent retrieves relevant notes when a new prompt is sent through the `local-bridge` provider.
- The agent can use `memory_search` to search all notes and session histories.
- Search is local, keyword-based, and accent-insensitive. It requires no external database or service.
- Memory is per project: running the plugin from a different project creates a different `memory/` directory.

## Obsidian

1. In Obsidian, choose **Open folder as vault**.
2. Select this `memory/` folder.
3. Open `Home.md` or `Index.md` to browse notes.
4. Links such as `[[notes/Decisions]]` work in Obsidian and are also readable in any text editor.

You can manually edit or add Markdown notes in `notes/`. Keep the `.md` extension. The plugin reads them on the next relevant prompt.

## Privacy

Memory is local but **not encrypted**. It may include prompts, assistant responses, filenames, and tool activity. Do not store credentials, cookies, access tokens, private keys, or captcha tokens. Do not commit or share a memory vault without reviewing it first. Deleting a session file or note removes it from future search and retrieval.

The optional `KIMI_MEMORY_DIR` environment variable overrides the vault location for the OpenCode process. The optional `KIMI_MEMORY_RETRIEVE=false` disables automatic retrieval while keeping note creation and search available.
