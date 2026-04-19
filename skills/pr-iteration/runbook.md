# PR lifecycle runbook :  local code-review + Copilot review loop

Reusable methodology for taking a change from first commit through PR, external Copilot review, fix-resolve iterations, and a green terminal state. Commands assume `gh` CLI authed.

---

## 0. Variables to set once per PR

```bash
OWNER=ctxr-dev                     # GitHub org/user
REPO=skill-llm-wiki                # repo name
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

Verify the response shows `login: "copilot-pull-request-reviewer"` in the request list. If the response is `{pullRequest: null}` or `requestReviews: null`, the call failed :  check the error message.

**Common mistake:** `POST /repos/.../requested_reviewers` with `{"reviewers":["Copilot"]}` returns 200 OK but does nothing for bots. Always use the GraphQL mutation with `botIds`.

---

## 5. Wait for CI + Copilot review

The current HEAD SHA is `git rev-parse HEAD`. Run this in the background; it exits when CI is done AND Copilot has either posted a review on HEAD or left unresolved threads:

```bash
HEAD_SHA=$(git rev-parse HEAD)

# Save as wait-for-review.sh and run in background (or use run_in_background):
until result=$(gh api graphql -F owner="$OWNER" -F name="$REPO" -F number="$PR_NUMBER" -f query='
  query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$number){
        reviewThreads(first:100){nodes{isResolved}}
        reviews(last:10){nodes{commit{oid}}}
        commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}
      }
    }
  }
' 2>/dev/null) && echo "$result" | python3 -c "
import json, sys
d = json.load(sys.stdin)
pr = d['data']['repository']['pullRequest']
threads = pr['reviewThreads']['nodes']
unresolved = sum(1 for t in threads if not t['isResolved'])
sha = pr['commits']['nodes'][0]['commit']['oid']
state = (pr['commits']['nodes'][0]['commit'].get('statusCheckRollup') or {}).get('state')
review_on_sha = any(r.get('commit',{}) and r['commit']['oid']==sha for r in pr['reviews']['nodes'])
ci_done = state in ('SUCCESS','FAILURE','ERROR')
print(f'ci={state} unresolved={unresolved} review_on_head={review_on_sha}', file=sys.stderr)
exit(0 if (ci_done and (unresolved>0 or review_on_sha)) else 1)
"; do sleep 30; done
echo "ACTIVITY"
```

Rationale for the exit condition:

- **CI must complete first** (SUCCESS/FAILURE/ERROR). Silence on red CI is noise.
- **Either unresolved threads OR review_on_sha** is the Copilot signal. A review on HEAD with zero comments means Copilot looked and found nothing :  still done.

---

## 6. Fetch all unresolved threads

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
    c = t['comments']['nodes'][0]
    print(f\"--- {t['id']}  {t['path']}:{t['line']}  on {c.get('commit',{}).get('oid','?')[:12] if c.get('commit') else '?'} ---\")
    for line in c['body'].split('\n'):
        print(f'  {line}')
    print()
"
```

Save the thread IDs (`PRRT_...`). You'll resolve them in step 8.

---

## 7. Triage + fix

Expect comments to fall into three buckets :  name them in your commit message:

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
2. **`unresolved = 0`** on PR review threads, AND the **most recent Copilot review is on the current HEAD SHA**. (If the most recent review is on an older commit, wait :  Copilot may still be processing the latest push.)
3. **CI is SUCCESS on the current HEAD** across all required jobs.

When all three hold, report the final state to the human and stop. The merge itself is a human gate :  never auto-merge.

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
