# Slack Review scanner

The scanner reads one Slack channel for actionable messages from one person and submits suggestions to the private
Slack Review queue ([SLACK_REVIEW.md](SLACK_REVIEW.md)). It can only submit; everything else is the owner's job in the
dashboard.

**Status: not scheduled.** Activate it only after the queue is deployed and verified (see rollout order in the handoff).

## Setup (once, outside this repo)

1. Resolve the exact Slack **channel ID** and the author's **member ID**. Use IDs, never names. If a lookup returns more
   than one candidate, stop and ask the planning owner which one is meant.
2. Generate the scanner credential (≥ 32 random characters). Set it as `SLACK_REVIEW_INGEST_SECRET` and the channel ID
   as `SLACK_REVIEW_CHANNEL_ID` in the dashboard's environment, and give the same credential to the scanner's own secret
   store. Never paste it into a prompt, file or log.
3. Choose the first-run start point (a Slack ts or time). It is used only while the checkpoint is empty.
4. Keep the channel ID, member ID, start point and credential in the scanner's configuration, not in this repository.

## Each run

1. `GET /api/review-intake/checkpoint`. Scan from `checkpoint_ts` if set, otherwise from the configured start point.
2. Read, in the channel, **since that point**:
   - new top-level messages by the author;
   - the author's thread replies, **including replies on threads that started before the checkpoint**. (Search the
     author's messages in the channel by time; don't only walk new top-level messages.)
   - Read nearby replies in a thread only when needed to understand the author's message (e.g. it was already done, or
     the action was assigned). Never submit someone else's message as a suggestion.
3. Decide what is actionable:
   - **Skip:** FYIs and announcements, status updates, brainstorms or questions with no decision, work already completed
     (in the message or in replies), social chatter.
   - **Split** a message with several independent actions into one suggestion each (`action_id` `a1`, `a2`, …).
   - **Combine** repeats: a later message about an action already submitted is sent with `followup_of` set to that
     action's source key `slack:<channel>:<ts>:<action_id>`, not as a new suggestion.
4. Fill each suggestion:
   - `title`: short imperative task title. `brief`: one or two sentences, only what the message supports.
   - `excerpt`: the relevant message text (private to the owner). `message_url`, `thread_url`, `posted_at`, `thread_ts`.
   - `business` (`sb`, `p2s`, `perksradar`) only when the message makes it clear; otherwise null.
   - `assignee_hint`: only a person the message explicitly asks or names for the task. **Never infer the assignee from
     the author.** Otherwise null.
   - `due_date` only for an exact date. For wording like "next week", "before the sale", "ASAP", leave `due_date` null and
     put the wording in `deadline_text`.
   - `flags` for anything uncertain (e.g. `deadline_ambiguous`, `business_unclear`, `assignee_unclear`), and an optional
     short `scanner_note`.
   - `action_id` must stay the same for the same action on every rescan (number actions in the order they appear).
5. Submit one batch: `POST /api/review-intake/batches` with a `batch_id` unique to this run (reuse it on retry),
   `range` = what was read (`from_ts` = the checkpoint you started from, or the configured start on the first run),
   `checkpoint_ts` = the newest ts fully processed, `skipped_count`, and the suggestions.
   - On a network error or 5xx, retry **the same batch with the same `batch_id`**. Retries never duplicate.
   - The checkpoint advances only when the batch is accepted. If submission fails, the next run starts from the old
     checkpoint and resubmits; existing suggestions are left unchanged (never overwritten, never reopened).
   - On 409 `checkpoint_gap`, the run started after the saved checkpoint: re-read the checkpoint and scan again from it.
   - On 422, fix the named fields; on 401/403/503, stop and report.
6. Report: counts (found, submitted, follow-ups, skipped, unchanged) and error codes. **No message text** in reports,
   logs or notifications.

## Scheduled-run prompt template

Use when activating a scheduled task (fill the bracketed items from the scanner's private configuration, never in this
repo):

> Scan Slack channel [CHANNEL_ID] for actionable messages by member [MEMBER_ID] and submit them to the Marketing
> Dashboard Slack Review intake, following docs/SLACK_REVIEW_SCANNER.md in the sb-marketing-dashboard repository exactly.
> Get the checkpoint first; if it is empty start from [START_TS]. Include the member's replies on older threads. Skip FYIs,
> status updates, undecided brainstorms and completed work. Never infer the assignee from the author; keep ambiguous
> deadlines as deadline_text with no due_date. Use the credential from [SECRET_SOURCE]. Retry with the same batch_id on
> failure. Report counts and error codes only, no message text.

## Testing

`tests/slack-review.test.ts` covers the intake contract with synthetic messages: top-level and old-thread reply reach
the queue, rescans and replays don't duplicate or overwrite, follow-ups attach, the checkpoint advances only on
acceptance, and the scanner credential cannot read or act on the queue.
