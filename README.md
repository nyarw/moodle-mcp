# moodle-mcp

[Español](README.es.md)

A Claude Code plugin that lets Claude read your Moodle. It is made for the Moodle Centros site of Sevilla (Junta de Andalucía) with Acceso Único sign-in. It is unofficial and not affiliated with Moodle or the Junta.

## What it does

Ask in plain words, for example "what assignments haven't I done?" or "what did I get on the last exam?"

| Tool | What you get |
|---|---|
| `pending` | assignments not submitted, overdue ones included |
| `list` | every assignment with its state |
| `show` | one assignment: instructions, files, dates, submission, grade, feedback |
| `courses` | your courses |
| `contents` | sections, activities and files of a course |
| `quizzes` | quizzes with dates and attempts used |
| `grades` | grades and totals |
| `upcoming` | calendar deadlines |
| `news` | latest forum discussions |
| `file` | the contents of a course file |
| `login` | renews your access token |

It never submits or edits anything on Moodle.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- [Node.js](https://nodejs.org) 20 or newer
- Access to this repository while it is private, with git signed in to GitHub

## Install

Run these inside Claude Code:

```
/plugin marketplace add nyarw/moodle-mcp
```

```
/plugin install moodle@moodle-mcp
```

## Configure

1. Enter your Acceso Único (IdEA) username and password when the plugin asks for them. To change them later, open `/plugin` and configure `moodle`.
2. Restart Claude Code.
3. Sign in:

```
/moodle:login
```

Run it again if a tool says your token has expired.

## Your data

- The password is marked as sensitive in the plugin settings. It is the password for your whole school account, not only Moodle.
- The access token is saved in `.moodle-token.json` in your home folder. Anyone who has it can read your Moodle.
- What the tools return goes into your conversation with Claude.

## Development

The server is `src/moodle.mjs`. The plugin runs the bundle in `dist/`, so rebuild after a change and commit both:

```
npm install
```

```
npm run build
```

## License

[MIT](LICENSE)
