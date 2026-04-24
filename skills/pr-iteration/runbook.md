# PR lifecycle runbook for the local code-review + Copilot review loop

Reusable methodology for taking a change from first commit through PR, external Copilot review, fix-resolve iterations, and a green terminal state. Commands assume `gh` CLI authed.

---

## 0. Variables to set once per PR

```bash
OWNER=<your-github-org-or-user>    # from trackers.dev.owner in ops.config.json
REPO=<your-repo-name>              # from trackers.dev.repo in ops.config.json
# NB: project.repo in ops.config.json is already "owner/name";
# do NOT substitute it here. The gh commands below join OWNER/REPO.
PR_NUMBER=1                        # after you create the PR
BRANCH=feat/my-change              # feature branch name
```

---

## 1. Create the PR (once)

```bash
git checkout -b "$BRANCH"
# ... commits ...
git push -u origin "$BRANCH"

gh pr create --repo "$OWNER/$REPO" --base main --head "$BRANCH" \
  --title "short title" \
  --body "$(cat <<'EOF'
## Summary
...
## Test plan
- [ ] ...
EOF
)"

# Capture PR_NUMBER from the URL the command prints, then:
PR_NUMBER=<number>
```

### Capture the two node IDs you'll reuse forever

```bash
# PR's GraphQL node ID:
PR_NODE_ID=$(gh api graphql -f query="
  { repository(owner:\"$OWNER\",name:\"$REPO\"){pullRequest(number:$PR_NUMBER){id}} }
" --jq '.data.repository.pullRequest.id')

# Copilot bot's node ID (stable per repo; get it from any prior Copilot review,
# or from a PR where Copilot has already reviewed):
COPILOT_BOT_ID=$(gh api graphql -f query="
  { repository(owner:\"$OWNER\",name:\"$REPO\"){pullRequest(number:$PR_NUMBER){
      reviews(last:10){nodes{author{... on Bot{id login}}}}
  }}}
" --jq '.data.repository.pullRequest.reviews.nodes[] | select(.author.login==\"copilot-pull-request-reviewer\") | .author.id' | head -1)

echo "PR_NODE_ID=$PR_NODE_ID"
echo "COPILOT_BOT_ID=$COPILOT_BOT_ID"
```

If Copilot hasn't reviewed yet, the bot ID is missing. Trigger an initial review (see step 4), then re-run the capture.

---

## 2. Local implementation

Do the work normally: edits, tests, lint.

```bash
node --test tests/...            # unit
npm run lint                     # markdown / code lint
```

Fix any failures before moving on.

---

## 3. Local multi-specialist code review

Invoke `skill-code-review` (or your multi-reviewer skill) against the branch's diff vs main.

- Expect a CONDITIONAL or NO-GO on first pass for any non-trivial change.
- Fix every Critical and Important finding.
- Minor findings: decide which to defer; write the rationale in the commit body.
- Re-run the review after fixes. Repeat until verdict is **GO**.

**Do not push until local review says GO.** You save Copilot round-trips this way.

---

## 4. Push + trigger Copilot review

```bash
git push origin "$BRANCH"

# REST endpoint silently ignores bots — use GraphQL with botIds.
gh api graphql -f query="
  mutation {
    requestReviews(input:{
      pullRequestId: \"$PR_NODE_ID\"
      botIds: [\"$COPILOT_BOT_ID\"]
      union: true
    }) {
      pullRequest { reviewRequests(first:10) { nodes { requestedReviewer { ... on Bot { login } } } } }
    }
  }
"
```

Verify the response shows `login: "copilot-pull-request-reviewer"` in the request list. If the response is `{pullRequest: null}` or `requestReviews: null`, the call failed; check the error message.

**Common mistake:** `POST /repos/.../requested_reviewers` with `{"reviewers":["Copilot"]}` returns 200 OK but does nothing for bots. Always use the GraphQL mutation with `botIds`.

---

## 5. Wait for CI + Copilot review

The current HEAD SHA is `git rev-parse HEAD`. Run this in the background; it exits when CI is done AND Copilot has either posted a review on HEAD or left unresolved threads.

> **Scope note.** This inline poll recipe is a one-off for operators and assumes the PR has <= 100 review threads (the `first: 100` window is not paged). On PRs larger than that the `unresolved` count can undercount and exit early. For production use, drive the loop through `skills/pr-iteration` which uses the paginated `pollForReview` impl in `scripts/lib/trackers/github.mjs`.

```bash
HEAD_SHA=$(git rev-parse HEAD)

# Save as wait-for-review.sh and run in background (or use run_in_background):
#
# The review_on_sha check MUST filter by the configured bot login, not
# match any review on HEAD: a teammate reviewing before Copilot does
# would otherwise trip the gate and exit the loop before Copilot's
# verdict landed. Adjust BOT_LOGIN to match your configured external
# reviewer if it's not Copilot.
until result=$(gh api graphql -F owner="$OWNER" -F name="$REPO" -F number="$PR_NUMBER" -f query='
  query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$number){
        reviewThreads(first:100){nodes{isResolved}}
        reviews(last:10){nodes{commit{oid} author{__typename login}}}
        commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}
      }
    }
  }
' 2>/dev/null) && echo "$result" | BOT_LOGIN="copilot-pull-request-reviewer" python3 -c "
import json, os, sys
bot = os.environ.get('BOT_LOGIN','copilot-pull-request-reviewer')
d = json.load(sys.stdin)
pr = d['data']['repository']['pullRequest']
threads = pr['reviewThreads']['nodes']
unresolved = sum(1 for t in threads if not t['isResolved'])
sha = pr['commits']['nodes'][0]['commit']['oid']
state = (pr['commits']['nodes'][0]['commit'].get('statusCheckRollup') or {}).get('state')
review_on_sha = any(
    (r.get('commit') or {}).get('oid') == sha
    and (r.get('author') or {}).get('login') == bot
    for r in pr['reviews']['nodes']
)
ci_done = state in ('SUCCESS','FAILURE','ERROR')
print(f'ci={state} unresolved={unresolved} review_on_head={review_on_sha}', file=sys.stderr)
exit(0 if (ci_done and (unresolved>0 or review_on_sha)) else 1)
"; do sleep 30; done
echo "ACTIVITY"
```

Rationale for the exit condition:

- **CI must complete first** (SUCCESS/FAILURE/ERROR). Silence on red CI is noise.
- **Either unresolved threads OR review_on_sha** is the Copilot signal. A review on HEAD with zero comments means Copilot looked and found nothing; still done.

---

## 6. Fetch all unresolved threads

> **Scope note.** Same caveat as the poll snippet above: `first: 100` is not paged here. On PRs with >100 threads this snippet misses the tail. Drive the real loop through `skills/pr-iteration`, whose `fetchUnresolvedThreads` impl pages through all threads with a hard 10-page cap.

```bash
gh api graphql -F owner="$OWNER" -F name="$REPO" -F number="$PR_NUMBER" -f query='
  query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$number){
        reviewThreads(first:100){
          nodes{
            id isResolved isOutdated path line
            comments(first:5){nodes{author{login} body commit{oid} createdAt}}
          }
        }
      }
    }
  }
' | python3 -c "
import json, sys
d = json.load(sys.stdin)
threads = d['data']['repository']['pullRequest']['reviewThreads']['nodes']
for t in threads:
    if t['isResolved']: continue
    # A thread's comments.nodes can be empty when the first comment has
    # been deleted or hidden. Guard so the whole summary doesn't crash
    # on one borderline thread; emit a placeholder instead.
    comments = t['comments']['nodes']
    if comments:
        c = comments[0]
        commit_oid = c.get('commit', {}).get('oid', '?')[:12] if c.get('commit') else '?'
        body = c.get('body') or ''
    else:
        commit_oid = '?'
        body = '[comment body unavailable]'
    print(f\"--- {t['id']}  {t['path']}:{t['line']}  on {commit_oid} ---\")
    for line in body.split('\n'):
        print(f'  {line}')
    print()
"
```

Save the thread IDs (`PRRT_...`). You'll resolve them in step 8.

---

## 7. Triage + fix

Expect comments to fall into three buckets. Name them in your commit message:

1. **Stale**: the reviewer re-emitted a comment on already-fixed code. Verify by reading the file; if fixed, mark for resolution in step 8 with no code change.
2. **Net-new actionable**: real issue. Fix.
3. **Suggestion-only / style**: take or push back with a reply.

For each net-new fix:

- Add a test that locks in the fix if the issue was behavioural (security, TOCTOU, exit code, parsing).
- Run `node --test tests/affected.test.mjs` locally.
- After all fixes in the round: `node --test --test-concurrency=1 tests/unit/*.test.mjs` serially + `npm run lint`.

---

## 8. Commit, push, resolve threads, re-request Copilot

```bash
git add -A
git commit -m "fix(review-round-N): <short summary>

<per-thread bullets: path:line — what changed>

Addresses PR #$PR_NUMBER review threads on <previous-HEAD-sha>:
<thread-id-1> (<topic>), <thread-id-2> (<topic>), ..."

git push origin "$BRANCH"

# Resolve each fixed thread:
for tid in PRRT_id1 PRRT_id2 PRRT_id3; do
  gh api graphql -F tid="$tid" -f query='
    mutation($tid:ID!){resolveReviewThread(input:{threadId:$tid}){thread{isResolved}}}
  '
done

# Re-request Copilot on the new HEAD:
gh api graphql -f query="
  mutation {
    requestReviews(input:{
      pullRequestId: \"$PR_NODE_ID\"
      botIds: [\"$COPILOT_BOT_ID\"]
      union: true
    }) { pullRequest { reviewRequests(first:10) { nodes { requestedReviewer { ... on Bot { login } } } } } }
  }
"
```

Then go back to step 5.

---

## 9. Exit criteria

Stop the loop when **all three** are true:

1. **Local code-review says GO** on the current HEAD. (Re-run after the final Copilot round to catch regressions from fixes.)
2. **`unresolved = 0`** on PR review threads, AND the **most recent Copilot review is on the current HEAD SHA**. (If the most recent review is on an older commit, wait; Copilot may still be processing the latest push.)
3. **CI is SUCCESS on the current HEAD** across all required jobs.

When all three hold, report the final state to the human and stop. The merge itself is a human gate; never auto-merge.

---

## 10. Common gotchas

- **`requested_reviewers: ["Copilot"]` via REST silently no-ops.** Always use GraphQL `requestReviews` with `botIds`.
- **Copilot re-emits already-fixed comments** on each review pass against fresh commit SHAs. ~30-50% of "unresolved" threads after the first iteration are stale. Verify against current code before changing anything.
- **Windows CI + LF-only regex.** Any `^---\n` / `\nmode:` regex written on macOS breaks on Windows git checkouts (CRLF). Use `\r?\n` or split on `/\r?\n/`.
- **macOS `/var/folders/...` symlink.** Any "walk up to /" security guard will false-positive on `/var → /private/var`. Anchor guards at the user-supplied base and stop there.
- **Path separator in test assertions.** `assert.ok(stdout.includes(".claude/skills"))` fails on Windows (`\`). Use `path.join` for comparison.
- **Background poll pattern.** Use `run_in_background: true` with an `until <check>; do sleep 30; done` wrapper. Sleep >270s hits the cache-miss boundary; >600s is blocked by the harness. Poll every 30s; 30 iterations → 15 minutes, enough for typical Copilot turnaround.
- **Exit condition for the poll must be OR-wide, not AND-narrow.** `ci_done AND (unresolved>0 OR review_on_sha)` covers all three terminal states (Copilot found issues, Copilot found nothing, CI went red).
- **Don't resolve threads before the fix is pushed.** If you resolve then discover the fix was wrong, the thread is gone; you have to leave a fresh comment or force-unresolve.

---

## 11. Minimal daily-use cheat sheet

```bash
# After a push:
gh api graphql -f query="mutation{requestReviews(input:{pullRequestId:\"$PR_NODE_ID\" botIds:[\"$COPILOT_BOT_ID\"] union:true}){pullRequest{reviewRequests(first:1){nodes{requestedReviewer{... on Bot{login}}}}}}}"

# Poll until activity:
# (paste the until-loop from step 5)

# Fetch unresolved:
gh api graphql -F owner="$OWNER" -F name="$REPO" -F number="$PR_NUMBER" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved path line comments(first:1){nodes{body}}}}}}}'

# Resolve one:
gh api graphql -F tid="PRRT_xxx" -f query='mutation($tid:ID!){resolveReviewThread(input:{threadId:$tid}){thread{isResolved}}}'
```

That's the whole protocol. Loop is: local-review GO → push → trigger Copilot → wait → fix+resolve → re-trigger → repeat until both reviews green and no unresolved threads remain.

---

## Solo dev flow (no external reviewer)

When `workflow.external_review.provider` is `"none"` (typical for solo repos or projects without Copilot), the loop runs a simplified path:

1. **No `requestReview`** call. No external reviewer to request.
2. **No `fetchUnresolvedThreads`** call. No threads to triage.
3. **CI check only.** The caller fetches CI status independently (e.g. via `gh api graphql` statusCheckRollup on HEAD) and passes it to the tick as `opts.ciState`. No review polling.
4. **Relaxed exit set.** The tick checks `localReviewGo + ciSuccessOnHead` only. The `zeroUnresolvedOnHead` condition is not applicable.
5. **Merge prompt.** When both conditions hold, the tick returns `"solo-ready"`. The skill layer prompts:

```text
CI is green and local code review passed on HEAD <sha>.

1. Merge now (I will stop; you merge manually).
2. Not yet (reschedule; I will check again later).
```

Option 1: the skill writes the final report, deletes the state file, and stops. The user merges manually (human gate preserved).

Option 2: the skill reschedules a wakeup tick and re-checks on the next wake.

**Safety cap and cancel** work identically to the team path: `.stopped` sidecar for user cancel, `.paused` sidecar after `max_consecutive_wakes`. The solo-ready path increments `consecutiveWakes` on every tick (including ticks where the user defers merge), so the cap fires even if CI stays green indefinitely.
