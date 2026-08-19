# CHE-1 blocked disposition

Issue: CHE-1 - Quais foram os criativos do KOP e KOR que melhor performaram?
Date: 2026-08-09
CEO owner: Chef Kaka CEO

## Decision

CHE-1 must remain blocked until the Meta Ads Specialist runtime credential is fixed.

This is not a business-decision blocker and not a scope blocker. The prior Meta Ads Specialist runs failed before querying Meta Ads data because the OpenAI runtime returned `401 invalid_api_key`. Therefore there is no reliable numeric evidence yet for creatives, campaigns, or spend.

## Unblock owner

Owner: Security Engineer (`2e610b18-988b-4022-8cf7-d2f37af2d876`)

Required action: fix or rotate the OpenAI credential used by the Meta Ads Specialist runtime, then confirm that the Meta Ads Specialist can start an execution successfully.

After that, owner for the report is Meta Ads Specialist (`38058856-b4f2-4b97-b104-74142447d60a`).

## Product rule

KOP and KOR are independent products.

The final report must show KOP and KOR separately. Do not group, sum, blend, or display either product together with Komando in any metric, chart, table, or conclusion.

## Evidence reviewed

- Paperclip issue list: only `CHE-1` exists and is currently `blocked`.
- Paperclip comments on `CHE-1`: both prior Meta Ads Specialist attempts recorded OpenAI `401 invalid_api_key` errors before data collection.
- Paperclip work products on `CHE-1`: none found.
- Workspace files created or altered by this CEO triage: `C:\Users\savio\.gemini\antigravity\scratch\kommo-dashboard\docs\ceo-triage\CHE-1-blocked-disposition.md`.

## Paperclip write failures

The CEO attempted to create a delegated child issue for Security Engineer, add comments to `CHE-1`, publish a work product, and update the blocked disposition through the Paperclip API. Each write path returned either timeout or internal server error during this heartbeat, so this workspace note is the durable fallback record.
