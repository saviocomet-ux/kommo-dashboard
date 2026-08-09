# Kommo Dashboard & Automation Engine — Claude Code Guide

Este repositório contém a aplicação completa do **Kommo Sales Dashboard** e o motor de automação serverless (Express / Node.js) hospedado na Vercel.

---

## 🚀 Guia Rápido de Comandos

```bash
# Validar sintaxe do backend e frontend
node -c api/index.js
node -c app.js

# Rodar servidor localmente
npm start  # ou node api/index.js (porta 3000)

# Deploy em Produção (Vercel)
npx vercel --prod --yes
```

---

## 🔑 Acessos & Variáveis de Ambiente (.env)

As credenciais ativas do projeto estão pré-configuradas no arquivo `.env`:

* **URL de Produção:** `https://kommo-dashboard-delta.vercel.app`
* **Kommo CRM Domain:** `chefkakagomes.kommo.com`
* **Kommo Long-Lived Token:** Configurado em `KOMMO_LONG_LIVED_TOKEN` no `.env`
* **Meta Ads Access Token:** `EAAWTmZBZCudBcBSDyr5qIfwdotZCyzL9GTxRiy0BNiu5QxTEidArSHgd54L7kWIdt1gTwLSnUSYd9o1AyZAGBJxmAniRbczR4k5h6iqAJzaTZAMjRhsi3IzYgG2Q5jEtpwxNQOayzwNYPOEgOq4aZAYCJ5DhtdYWl9DWrTxMCyuchbDbmcb1eqfiWVrtdGBZAO6Jtz7Due7`
* **Contas de Anúncio Meta:**
  - `act_322391662838622` (`[KG] DISTRIBUIÇÃO / PERPÉTUO`)
  - `act_342834581` (`Caio Gomes`)
* **Z-API WhatsApp (Chef Kaká):**
  - **Instance ID:** `3EFEA33D477C038EB9D7C61238667D26`
  - **Token:** `7AF205F57962776381052B74`
  - **Client Token:** `F7b6f857e32b6433e8739d3bac819a251S`
  - **Telefone Notificação:** `5511995235763`
* **Telegram Bot:** Configurado em `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` e `TELEGRAM_CHAT_ID_ERROR`.

---

## 📌 Arquitetura & Produtos (REGRAS DE NEGÓCIO)

O sistema gerencia **4 produtos independentes**:

1. **🔴 Komando (KO)**:
   - Pipeline Kommo: `13304659` (KO Inbound) e `13537971` (KO Ebooks)
   - Qualificação MQL: Cargo (Dono/Sócio/Proprietário/CEO/Diretor) **E** Faturamento >= R$ 100k
2. **📦 KOP (Komando Operação)**:
   - Pipeline Kommo: `14173256` (KOP Inbound — PRODUTO INDEPENDENTE, NÃO somar ao Komando)
   - Qualificação MQL: Cargo (Dono/Sócio) **E** Faturamento >= R$ 100k
3. **🔄 KOR (Recuperação)**:
   - Pipeline Kommo: `13956952` (Funil de Recuperação — PRODUTO INDEPENDENTE)
   - Leads de carrinho abandonado, pix e boleto da Eduzz
4. **🔵 Mentoria MLFP**:
   - Pipeline Kommo: `13304583`
   - Qualificação MQL: Renda/Faturamento >= R$ 3k + Cargo Qualificado

> ⚠️ **REGRA CRÍTICA:** KOP e KOR **NÃO** devem ser agrupados dentro do Komando. Devem ser exibidos como abas e métricas totalmente separadas em todo o dashboard e relatórios!

---

## 🤖 Sistema de Agentes Especialistas (Claude Code Agents)

Para utilizar os agentes no Claude Code ou Claude Desktop, utilize as personas descritas na pasta `.claude/agents/`:

### 1. `backend_implementer`
* **Função:** Desenvolvimento da API Serverless Express em `api/index.js`
* **Responsabilidades:** Webhooks, integrações Z-API/Kommo/Eduzz/Meta Ads, rotas de dados.

### 2. `frontend_implementer`
* **Função:** Engenharia UI/UX do Dashboard (`index.html`, `style.css`, `app.js`)
* **Responsabilidades:** Layout Glassmorphism, tabelas de mídia paga, filtros de data, funil comercial visual.

### 3. `data_analyst`
* **Função:** Análise de Performance & KPIs
* **Responsabilidades:** Cruzamento Kommo CRM × Meta Ads, cálculo de CPL/CPMQL/ROAS, geração de relatórios de visitas.

### 4. `meta_ads_specialist`
* **Função:** Inspeção & Integração com Meta Graph API v20.0
* **Responsabilidades:** Captura de LPVs, leads por pixel/form, ROI, CTR, CPC por campanha.

### 5. `kommo_crm_ops`
* **Função:** Operações na API Kommo v4
* **Responsabilidades:** Atualização em lote de tags (`MQL`, `KOP`, `KOR`, `Downsell`), busca de contatos e pipelines.

### 6. `deploy_and_verify`
* **Função:** Deploy no Vercel & Teste de QA
* **Responsabilidades:** Validação de sintaxe (`node -c`), deploy via Vercel CLI e teste dos endpoints da API em produção.

---

## 📡 Webhooks Ativos

- `POST /api/webhook/lead-responded` → Dispara alerta WhatsApp no Z-API para Chef Kaka quando lead responde automação no Kommo.
- `POST /api/webhook/greatpages-kop` → Recebe cadastros da LP KOP GreatPages.
- `POST /api/eduzz-webhook` → Recebe vendas e abandonos da Eduzz.
- `POST /api/kommo-lead-created` → Z-API Webhook que qualifica MQL e notifica no Telegram/WhatsApp.
