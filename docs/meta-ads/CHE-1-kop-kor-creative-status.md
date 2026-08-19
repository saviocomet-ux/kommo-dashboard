# CHE-1 - KOP/KOR creative performance status

Date: 2026-08-09

## Request

Resumo dos criativos de KOP e KOR que melhor performaram, com campanha e custo.

## Meta Ads API result

I queried Meta Graph API v20.0 for:

- Ad accounts: `act_322391662838622`, `act_342834581`
- Level: `ad`
- Period: `date_preset=maximum`
- Fields: campaign, ad set, ad/creative name, spend, impressions, clicks, actions
- Conversion actions targeted: `lead`, `offsite_conversion.fb_pixel_lead`, `onsite_web_lead`, `leadgen_grouped`
- Visit/click actions targeted: `landing_page_view`, `omni_landing_page_view`, `link_click`

The query reached Meta, but the main account returned:

`Application request limit reached`

The second account returned no KOP/KOR rows in this query. Because the main account is where KOP spend data is expected, I cannot produce a reliable "quanto custou" ranking yet.

## Blocker

Status should remain blocked until the Meta API rate limit clears or an Ads Manager export is provided.

Unblock owner/action:

- Owner: Meta Ads account/admin or whoever controls the Meta app/token.
- Action: wait for the app request limit to reset, rotate/provide a token/app with available Marketing API quota, or upload/export Ads Manager data at ad level for the two accounts.

Required export columns if using file handoff:

- account_id
- campaign_id
- campaign_name
- adset_id
- adset_name
- ad_id
- ad_name or creative_name
- spend
- impressions
- clicks
- actions or separate lead/link_click/landing_page_view metrics
- date_start/date_stop or selected period

## Local CRM evidence found

Local file reviewed: `C:\Users\savio\.gemini\antigravity\scratch\kommo-dashboard\api\all_leads.json`

This file has CRM leads and UTM fields, but no Meta spend/cost. It can indicate captured leads by UTM only.

Pipeline-based CRM count:

| Product | Leads | Notes |
| --- | ---: | --- |
| KOP pipeline `14173256` | 5 | Has a few UTM rows; no cost fields. |
| KOR pipeline `13956952` | 3 | All three rows have no `utm_campaign` and no `utm_content`. |

Top KOP pipeline UTM rows in local CRM:

| Leads | Campaign | Creative |
| ---: | --- | --- |
| 2 | `kop_anuncio_live` | `(sem utm_content)` |
| 1 | `kop_campanha_page` | `(sem utm_content)` |
| 1 | `kop_campanha_anuncio` | `criativo_video_kop` |
| 1 | `utm_campaign` | `utm_content` |

KOR local CRM rows:

| Leads | Campaign | Creative |
| ---: | --- | --- |
| 3 | `(sem utm_campaign)` | `(sem utm_content)` |

Additional UTM-only search across all pipelines found 358 leads with `KOP` in `utm_campaign`, but most are outside the current KOP pipeline and still have no spend. I did not use them as a cost ranking.

## Files created or changed

- `C:\Users\savio\.gemini\antigravity\scratch\kommo-dashboard\docs\meta-ads\CHE-1-kop-kor-creative-status.md`
