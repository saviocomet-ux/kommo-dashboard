# CHE-1 - Criativos KOP e KOR

Data: 2026-08-09

## Pedido

Resumo dos criativos de KOP e KOR que melhor performaram, mostrando campanha e quanto custou.

## Resultado

Nao foi possivel entregar o ranking confiavel com custo nesta execucao, porque o Meta Graph API retornou limite de requisicao do aplicativo para as duas contas solicitadas.

Contas consultadas:

- `act_322391662838622`
- `act_342834581`

Consulta tentada:

- API: Meta Graph API `v20.0`
- Nivel: `ad`
- Periodo: `date_preset=maximum`
- Campos: `account_id`, `account_name`, `campaign_id`, `campaign_name`, `adset_id`, `adset_name`, `ad_id`, `ad_name`, `spend`, `impressions`, `clicks`, `ctr`, `cpc`, `actions`
- Conversoes consideradas: `lead`, `offsite_conversion.fb_pixel_lead`, `onsite_web_lead`, `leadgen_grouped`
- Visitas consideradas: `landing_page_view`, `omni_landing_page_view`
- Cliques considerados: `link_click`

Erro retornado pelas duas contas:

`Application request limit reached`

Como o campo `spend` vem do Meta Ads, nao ha como responder "quanto custou" por criativo sem a API liberar a consulta ou sem um export do Ads Manager.

## Evidencia local disponivel no CRM

Arquivo analisado:

`C:\Users\savio\.gemini\antigravity\scratch\kommo-dashboard\api\all_leads.json`

O CRM tem UTMs e criativos capturados, mas nao tem custo de midia. Portanto os dados abaixo sao apenas proxy de volume de leads, nao ranking final de performance/custo.

Resumo local:

| Funil | Leads com indicio por UTM/nome | Observacao |
| --- | ---: | --- |
| KOP | 361 | Ha campanhas e criativos em UTM. |
| KOR | 2 | Pouca atribuicao local; um registro usa placeholders `{{campaign.name}}` / `{{ad.name}}`. |

Top evidencias KOP por leads no CRM:

| Leads | Campanha | Criativo |
| ---: | --- | --- |
| 4 | `KOP | VENDAS | ADS VALIDADOS | BID CAP | 13/01/25|120237038675970352` | `(sem utm_content)` |
| 2 | `KOP | ENGLISH | WORLDWIDE | VENDAS | TESTE DE CRIATIVOS | 11/10/25|120231895337080352` | `[ENG] [OUT] IMG 03|120231915170120352` |
| 2 | `kop_anuncio_live` | `(sem utm_content)` |
| 2 | `KOP | VENDAS | TESTE DE CRIATIVOS | KOP_DEZ_VD 04 | 06/12/25|120235354222480352` | `KOP_DEZ_VD 04|120235354222490352` |
| 2 | `KOP | VENDAS | TESTE DE CRIATIVOS | KOP_DEZ_VD 02 | 06/12/25|120235353782980352` | `KOP_DEZ_VD 02|120235353782990352` |
| 2 | `KOP | VENDAS | TESTE DE CRIATIVOS | KOP_DEZ_VD 01 | 06/12/25|120235347526290352` | `(sem utm_content)` |

Top evidencias KOR por leads no CRM:

| Leads | Campanha | Criativo |
| ---: | --- | --- |
| 1 | `(sem utm_campaign)` | `(sem utm_content)` |
| 1 | `{{campaign.name}}|{{campaign.id}}` | `{{ad.name}}|{{ad.id}}` |

## Bloqueio

Status correto: `blocked`.

Responsavel por desbloquear: administrador da conta/app Meta Ads ou responsavel pelo export do Ads Manager.

Acao necessaria:

- aguardar o limite do app Meta resetar; ou
- fornecer/rotacionar token/app com quota disponivel para Marketing API; ou
- enviar export do Ads Manager em nivel de anuncio/criativo para as contas acima.

Colunas minimas se for via export:

- `account_id`
- `campaign_id`
- `campaign_name`
- `adset_id`
- `adset_name`
- `ad_id`
- `ad_name` ou `creative_name`
- `spend`
- `impressions`
- `clicks`
- `actions` ou colunas separadas para leads, landing page views e link clicks
- `date_start`
- `date_stop`

## Arquivos criados ou alterados

- `C:\Users\savio\.gemini\antigravity\scratch\kommo-dashboard\docs\meta-ads\CHE-1-kop-kor-creative-report.md`
