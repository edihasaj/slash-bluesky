# slash-bluesky

Local Bluesky CLI for posting and replying from the command line — a sibling of
[`slash-x`](https://github.com/edihasaj/slash-x) and
[`slash-reddit`](https://github.com/edihasaj/slash-reddit).

Dependency-free single file. Uses the AT Protocol with an app password.

## Install
```bash
cd ~/Projects/slash-bluesky && npm link    # exposes `slash-bluesky` and `slb`
```

## Auth
Create an app password at <https://bsky.app/settings/app-passwords>, then:
```bash
export BLUESKY_IDENTIFIER=you.bsky.social
export BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
slash-bluesky check
```

## Use
```bash
slash-bluesky post "shipping slash-bluesky 🦋"
slash-bluesky reply https://bsky.app/profile/someone.bsky.social/post/3kabc "nice!"
slash-bluesky reply at://did:plc:…/app.bsky.feed.post/3kabc --file note.md --json
```

| Command | Description |
| --- | --- |
| `post <text>` | Publish a new post |
| `reply <post> [text]` | Reply to a post (URL or `at://` uri) |
| `whoami` / `check` | Show / verify the logged-in account |

Options: `--file <path>`, `--json`, `--identifier`, `--password`.
