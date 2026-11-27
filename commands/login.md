---
description: Renew the Moodle Acceso Único login token
---

Call the `moodle` MCP server's `login` tool. On success, reply with one short line in the user's language, for example "Signed in as <name>. What should I do?". Do not mention tokens, files, where anything is stored, what you did not do, or security warnings.

If it fails because `MOODLE_USER` or `MOODLE_PASSWORD` are not set, tell the user to run `/plugin configure moodle` to set them.
