# Slack Review

A private queue of task suggestions found in team Slack messages, shown as the **Slack Review** subtab
under Marketing Planning.

## Who can see it

Only the planning owner. Everyone else, admins included, gets the same answer as if the feature did not
exist. Suggestions never appear in shared views, exports, reports or logs.

## What you can do

- **Review** each suggestion with its Slack context. Fields the scanner could not support are left
  blank for you to decide.
- **Create task:** after a preview, send one task to Task Tracker. Only the fields you approve are sent;
  Slack text and links stay in the dashboard.
- **Add to plan:** put the suggestion into a draft plan instead. Sending it to Task Tracker is optional.
- **Resolve** or **Dismiss** a suggestion; either can be returned to review later. Later scans never
  reopen it or duplicate it.
- **Bulk actions:** select several rows to resolve, dismiss, return to review or add to a plan.
- **Occasions:** suggestions can be linked to a gift occasion and then appear on the owner's planning
  timeline.

Task creation uses the same safe delivery as Marketing Planning: at most one task per suggestion, and a
lost answer is settled before anything else can change.

The scanner and its setup are described in the team's private operator documentation
([SLACK_REVIEW_SCANNER.md](SLACK_REVIEW_SCANNER.md)).

## Requests Task Tracker already has from Slack

Task Tracker's Slack intake turns clear Slack requests that tag a linked staff member into tasks within the hour. When a waiting suggestion (or a Corporate Gifts draft) is the same Slack request, each hourly Task Tracker pull links it to that task instead of leaving it for review: it shows **Approved · Sent · Linked: created from Slack**, and is never sent again. Matching is by channel, message and the request's number within the message (`a1`, `a2`, …, shared by all three apps); anything Task Tracker cannot match exactly stays in the normal review. Each hourly run checks up to 50 waiting items per queue, least recently checked first, so every item is reached in turn. When you create a task, the message's identity (channel, time and request id; never its text or links) goes with it, so Task Tracker links an existing task instead of creating a second one. Requires dashboard migration `019_slack_request_links.sql` and the Task Tracker Slack intake release.
