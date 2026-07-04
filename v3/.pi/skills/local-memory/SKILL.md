---
name: local-memory
description: Use when the user asks Pythos to remember, recall, list, or update short local notes.
---

# Local Memory

Use the `pythos_note` tool for short assistant memory.

Behavior:

- For "remember" requests, call `pythos_note` with `action` set to `add`.
- For recall requests, call `pythos_note` with `action` set to `list`.
- Keep notes concise and factual.
- Do not store secrets, passwords, tokens, or sensitive personal data.
