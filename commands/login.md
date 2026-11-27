---
description: Renew the Moodle Acceso Único login token
---

Call the `moodle` MCP server's `login` tool and report whether it succeeded.

If it fails because `MOODLE_USER` or `MOODLE_PASSWORD` are not set, tell the user to run `/plugin configure moodle` to set them.
