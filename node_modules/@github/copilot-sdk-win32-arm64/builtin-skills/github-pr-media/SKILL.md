---
name: github-pr-media
description: Upload an image or video to GitHub's user attachments API and embed it in a pull request description or comment. Use when asked to add screenshots, diagrams, recordings, or other media to a PR or GitHub comment.
user-invocable: false
---

# GitHub PR Media Uploads

Use this skill when a workspace agent needs to attach screenshots, diagrams, or videos to a pull request description or comment.

## When to use it

- Adding before/after screenshots to explain a UI change
- Sharing a diagram that clarifies architecture or flow
- Attaching a short recording that makes behavior easier to review
- Turning a local media file into a GitHub-hosted URL that can be linked from markdown

Only use this when visuals genuinely improve reviewer understanding.

## Instructions

GitHub CLI uploads local media itself, with a repeatable `--attach` flag on
`gh pr create`, `gh pr edit`, `gh pr comment`, and the same three `gh issue` commands.
It needs no repository id lookup and no separate upload request. `--repo` lets
`gh pr edit`, `gh pr comment`, and the `gh issue` commands run from any directory without
a checkout. `gh pr create` is the exception: it still needs the source branch, either
from a checkout of it or from an existing remote branch named with `--head`.

1. Check that `--attach` is available for this target. It was added in gh 2.99.0, so
   compare versions with `sort -V` rather than by eye — `2.100.0` and `2.9.0` both
   compare wrong as strings:

    ```bash
    VER="$(gh --version | sed -n '1s/^gh version \([0-9][0-9.]*\).*/\1/p')"
    [ -n "$VER" ] || { echo "gh missing or version unparseable" >&2; exit 1; }
    if printf '%s\n%s\n' 2.99.0 "$VER" | sort -V -C; then
      echo "gh $VER supports --attach"
    else
      echo "gh $VER is older than 2.99.0; use the fallback below" >&2
    fi
    ```

    The other two errors below surface only when the command runs, so just run the
    attach you intended and handle them.
    - **gh older than 2.99.0** — the flag does not exist. Use the fallback below.
    - **GitHub Enterprise Server** — the error is
      `attaching files is not supported on GitHub Enterprise Server`. GHES has no
      user-attachments upload endpoint at all, so the fallback does not help either.
      Attach the file through the web UI, or link to it if it already has a reachable
      URL; if neither is possible, say so rather than leaving a local path in the body.
      GitHub.com, GHEC, and `ghe.com` data residency tenants are all supported.
    - **`unsupported authentication type`** — attaching accepts OAuth tokens and
      personal access tokens, classic or fine-grained. GitHub App user and installation
      tokens are rejected, which is easy to hit in automation. Retry with a credential
      from that list. The fallback below is not a way around this: it is the same
      credential against the same endpoint, so do not assume it will be accepted.

2. Put the real values in shell variables first, so the untrusted filename is never
   pasted into the middle of another command. Set `TARGET` to the PR (or comment) you
   were asked to update, and `REPO` to that target's `owner/repo` — do **not** assume
   the current checkout is the right repository:

    ```bash
    FILE='assets/dashboard.png'          # path to the media file on disk
    ALT='the redesigned dashboard'       # what the image shows, for screen readers
    TARGET='https://github.com/OWNER/REPO/pull/123'
    REPO='OWNER/REPO'                    # owner/repo that owns TARGET
    ```

    Never build these from `$(...)` command substitution embedded in an untrusted
    filename — assign the filename to `FILE` with single quotes, then reference `"$FILE"`.
    A single-quoted string cannot contain an apostrophe, so alt text such as
    `the user's dashboard` must be written `ALT="the user's dashboard"` (double quotes,
    with no `$`, backtick, or `\` in the text) or `ALT='the user'\''s dashboard'`.
    Writing `ALT='the user's dashboard'` is a shell parse error and nothing is attached.

3. Attach the file. Alt text goes on the path after a `#`:

    ```bash
    # Add the image to an existing PR description:
    gh pr edit "$TARGET" --repo "$REPO" --attach "$FILE#$ALT"

    # Or post it as a new PR comment instead. Keep the URL it prints; step 5 needs it:
    # COMMENT_URL="$(gh pr comment "$TARGET" --repo "$REPO" \
    #   --body 'Here is the redesigned dashboard:' --attach "$FILE#$ALT")"
    ```

    An attachment-only `gh pr edit` keeps the body it already has and appends the
    attachment to the end — but only when that body does not already reference the same
    file. `gh` resolves both the flag path and every markdown destination in the existing
    body to an absolute path; on a match it rewrites that existing reference to the
    uploaded URL, keeping the old alt text and position, and appends nothing. Read the
    body first and, if it already references this path, attach a copy under a fresh name
    so the new media lands as a new reference instead of silently replacing an old one.

    Repeat `--attach` for more files, up to 50 per command. The same file cannot be
    attached twice in one command.

4. To place an image in the middle of the body rather than at the end, reference its
   local path in the markdown you pass and attach the same path. `gh` rewrites that
   reference to the uploaded URL in place, keeping the alt text written in the markdown,
   so a `#` alt text on the flag applies only to files the body does not reference.

    For a **new comment**, the body you pass is the whole comment:

    ```bash
    # pr-body.md (keep it in the working directory, not an absolute /tmp path, which
    # does not exist on Windows) holds the markdown, with ordinary local paths:
    #
    #   The dashboard now groups the filters above the chart.
    #
    #   ![the old dashboard](./before.png)
    #   ![the redesigned dashboard](./after.png)

    COMMENT_URL="$(gh pr comment "$TARGET" --repo "$REPO" --body-file pr-body.md \
      --attach ./before.png --attach ./after.png)"
    ```

    For an **existing PR description**, `gh pr edit --body-file` **replaces** the whole
    description — the keep-what-is-there behavior of step 3 applies only when no body
    flag is passed. Start from the current body so nothing is discarded:

    ```bash
    gh pr view "$TARGET" --repo "$REPO" --json body -q .body > pr-body.md || exit 1
    # Edit pr-body.md, inserting ![the redesigned dashboard](./after.png) where you
    # want it, then write it back:
    gh pr edit "$TARGET" --repo "$REPO" --body-file pr-body.md --attach ./after.png
    ```

    The markdown references and the `--attach` paths are both resolved relative to the
    directory you run `gh` in, so keep the body file and the media where those paths
    match.

5. Confirm the upload landed, reading back the object you actually wrote. Run these with
   `set -o pipefail` so a failed read is not disguised as a verification miss — without
   it `jq` exits 4 on empty input, which looks exactly like "not found", and you would go
   hunting for an object that is in fact fine when the right move is to retry the read.

    Existence of the object proves nothing: a partial attach still updates it (see
    **Important details**), so assert that every file you attached is present. Count the
    `user-attachments` asset URLs and check that no local path you attached is still in
    the body. For a description edited with `gh pr edit`:

    ```bash
    set -o pipefail
    N=1   # how many files you attached in that command
    BODY="$(gh pr view "$TARGET" --repo "$REPO" --json body -q .body)" || exit 1
    [ "$(printf '%s\n' "$BODY" | grep -c 'user-attachments/assets/')" -ge "$N" ] \
      || { echo "expected $N attachment URLs in the body" >&2; exit 1; }
    printf '%s\n' "$BODY" | grep -qF "$FILE" \
      && { echo "$FILE was not rewritten to an asset URL" >&2; exit 1; }
    true
    ```

    For a comment, read back the exact comment you posted, matched on the `COMMENT_URL`
    the write printed, and apply the same attachment assertions to its body. Reading it
    through `gh pr view` keeps the same host and repository resolution the write used,
    and `-e` makes a miss exit non-zero instead of printing nothing and succeeding:

    ```bash
    set -o pipefail
    BODY="$(gh pr view "$TARGET" --repo "$REPO" --json comments \
      | jq -er --arg url "$COMMENT_URL" '.comments[] | select(.url == $url) | .body')"
    ```

    Then run the same two assertions on `$BODY` as above.

    If `TARGET` is an ordinary issue rather than a pull request, use `gh issue view`
    instead — `gh pr view` rejects a non-PR target:

    ```bash
    gh issue view "$TARGET" --repo "$REPO" --json comments | jq -er ...
    ```

    `gh pr view --json comments` returns only its first page. On a conversation with
    more than 100 comments the one you just posted may not be in it, so fall back to a
    paginated read before concluding the write is missing:

    ```bash
    NUMBER="${TARGET##*/}"   # issue or PR number; comments share one endpoint
    gh api --paginate "repos/$REPO/issues/$NUMBER/comments" \
      --jq ".[] | select(.html_url == \"$COMMENT_URL\") | .body"
    ```

    A miss on a read that itself succeeded means the write could not be verified — an
    unset or wrong `COMMENT_URL` looks the same as a comment that never posted. Do not
    repost on that alone; find the comment first. Do not take the newest comment instead
    of matching the URL either, since another comment can land between the write and the
    read, and that would confirm somebody else's comment as your own.

    Either way the local path should now be a user attachments asset URL:
    `https://github.com/user-attachments/assets/...` on GitHub.com and GHEC, and the
    same path on your own host for a `ghe.com` tenant.

## Video

GitHub renders a video player only when the asset URL stands alone in its paragraph.
Image markdown does **not** work: `![](./demo.mp4)` is rewritten in place and stays
`![](https://...mp4)`, which renders as a broken image rather than a player.

So attach a video without referencing it in the body — `--attach ./demo.mp4` with no
matching markdown destination appends the bare URL on its own line, which is what
GitHub needs. To control where it goes, attach it first, read the body back for the
asset URL (step 5), then move that bare URL to the paragraph you want with
`gh pr edit --body-file`. Alt text is not supported on video, so leave the `#` off.

## Important details

- Only images and video are supported. For anything else, link to the file rather than
  attaching it.
- Attaching requires push access to the repository that owns the target.
- If some attachments upload and others fail, the issue or pull request is still created
  or updated with the ones that succeeded, and the command exits non-zero. Keep that exit
  status and gh's stderr, which names the files that failed — they are the only record of
  which file is missing. The asset URLs in the body are opaque
  (`user-attachments/assets/<id>`) and do not identify their source filename, so once the
  status and stderr are gone you cannot tell what to retry. A command substitution such as
  `COMMENT_URL="$(gh pr comment ...)"` discards the status, so capture it explicitly:

    ```bash
    COMMENT_URL="$(gh pr comment "$TARGET" --repo "$REPO" \
      --body-file pr-body.md --attach ./before.png --attach ./after.png 2>attach.err)"; rc=$?
    [ "$rc" -eq 0 ] || cat attach.err >&2   # names the files that failed
    ```

    Re-attach only those files — never replay the whole command, which would upload the
    successful ones a second time. If you did not keep the status and stderr, attach the
    files one at a time so each result maps to a known file instead of guessing from the
    body.

- Keep untrusted filenames inside quoted shell variables; never paste them into the body
  of another command where shell metacharacters could be evaluated.

## Fallback: manual upload

Use this when `gh` is older than 2.99.0. It targets GitHub.com: the repository lookup,
the credential, and the upload endpoint below are all pinned to `github.com`, so it is
unaffected by `GH_HOST`. On a `ghe.com` data residency tenant, upgrade `gh` to 2.99.0 or
later rather than using this path. It does not apply to GitHub Enterprise Server, which
has no user-attachments upload endpoint to call.

Upload the bytes yourself and embed the returned URL. Use the same `FILE`, `ALT`,
`TARGET`, and `REPO` variables from step 2, plus:

```bash
NAME="$(basename -- "$FILE")"         # display name shown in the attachment
MIME='image/png'                      # actual MIME type (e.g. video/mp4 for video)
```

1. Resolve the repository database id for `REPO`, failing loudly if the lookup does not
   return a numeric id:

    ```bash
    REPO_ID="$(gh api "repos/$REPO" --hostname github.com --jq .id)" || { echo "repo lookup failed" >&2; exit 1; }
    case "$REPO_ID" in ''|*[!0-9]*) echo "no repository_id for $REPO" >&2; exit 1;; esac
    ```

2. Upload the raw media bytes to GitHub. Everything untrusted stays inside a quoted
   variable, and `--url-query` URL-encodes each value:

    ```bash
    URL="$(curl --fail-with-body -sS -X POST \
      "https://uploads.github.com/user-attachments/assets" \
      --url-query "name=$NAME" \
      --url-query "content_type=$MIME" \
      --url-query "repository_id=$REPO_ID" \
      -H "Content-Type: application/octet-stream" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "Authorization: Bearer $(gh auth token --hostname github.com)" \
      --data-binary "@$FILE" | jq -r .url)"
    case "$URL" in https://*) ;; *) echo "upload failed: $URL" >&2; exit 1;; esac
    ```

3. Embed the hosted URL in markdown and **actually submit it** to the requested target —
   showing the markdown is not enough, you must update the PR or comment. Escape the alt
   text first: `]` and `\` are markdown syntax between `![` and `]`, and a newline would
   split the reference and inject body content:

    ```bash
    ALT_MD="$(printf '%s' "$ALT" | tr '\n' ' ' | sed -e 's/[][\\]/\\&/g')"
    ```

    ```bash
    # For a PR description: fetch, append, and write it back. Bail out if the fetch
    # fails, so an empty BODY never overwrites the description.
    BODY="$(gh pr view "$TARGET" --repo "$REPO" --json body -q .body)" || exit 1
    printf '%s\n\n![%s](%s)\n' "$BODY" "$ALT_MD" "$URL" \
      | gh pr edit "$TARGET" --repo "$REPO" --body-file -

    # For a new PR comment instead:
    # COMMENT_URL="$(gh pr comment "$TARGET" --repo "$REPO" --body "![$ALT_MD]($URL)")"
    ```

    Use `![alt text](url)` for images. For video or other non-image media, paste the URL
    on its own line (GitHub renders a player) or use a plain markdown link if that reads
    better in context.

Details that matter on this path:

- Send the file as raw binary bytes with `--data-binary "@$FILE"`. Do **not** use
  multipart form uploads, base64 encoding, or JSON wrappers.
- Put `name`, `content_type`, and `repository_id` in the query string via `--url-query`,
  which URL-encodes each value. Never interpolate them directly into the URL — a filename
  with spaces, `&`, `#`, or other reserved characters would corrupt the request.
- `--url-query` needs curl >= 7.87 and `--fail-with-body` needs curl >= 7.76. On older
  curl, encode the query manually and use `--fail --show-error` (which exits nonzero but
  discards the error body).
- Always confirm a `https://` `url` came back before embedding it, so an expired token or
  4xx/5xx response fails the task instead of silently succeeding.
- For video, keep the same request shape and set `MIME` to the real video MIME type, for
  example `video/mp4`.

## When not to use it

- Text-only changes where the diff already explains everything
- Cases where a simple markdown list or code snippet is clearer than an image
