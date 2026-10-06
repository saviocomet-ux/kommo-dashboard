# Auditoria do dashboard e das automações

Data: 18/09/2026. Base: arquivos presentes no workspace, incluindo alterações locais ainda não commitadas.

## Conclusão executiva

O projeto acumulou produtos e integrações úteis, mas concentrou interface, regras comerciais, cálculos, persistência e execução de automações em poucos arquivos. A maior oportunidade é estabelecer **uma definição verificável de cada número e um processamento rastreável de cada evento**.

Ordem recomendada: **proteger acessos → corrigir qualificação e vendas → tornar automações confiáveis → simplificar a experiência → modularizar progressivamente**.

### Dimensão observada

| Item | Situação local |
|---|---|
| Backend | `api/index.js`: 9.214 linhas |
| Frontend | `app.js`: 4.628 linhas |
| Interface | `index.html`: 1.550 linhas; `style.css`: 3.364 linhas |
| Simuladores | Dois HTMLs idênticos, com 636 linhas cada |
| Agendamentos | 8 crons em `vercel.json`, todos na mesma função com `maxDuration: 60` |
| Persistência | Memória + Vercel Blob privado + disco + snapshots empacotados |
| Base CRM | 6.471 registros; 6.398 após o filtro atual de testes |
| Resposta `/api/leads` | 7.892.394 bytes de JSON compacto com a base local: 7,89 MB / 7,53 MiB |
| Base Eduzz local | 883 vendas pagas; datas disponíveis até 16/06/2026; nenhum registro local com `origem: webhook` |
| Validação existente | Scripts de sintaxe; sem comando de testes automatizados no `package.json` |

A base Eduzz acima é o snapshot local, não uma medição do Blob de produção. O backend prevê leitura de dados mais recentes do Blob.

## Método e evidências

- Leitura do backend e do JavaScript do dashboard; revisão da estrutura HTML/CSS, simuladores, scripts operacionais, configuração de deploy e documentação comercial.
- Análise agregada dos snapshots locais, sem reproduzir dados pessoais ou credenciais neste relatório.
- `node -c api/index.js` e `node -c app.js`: aprovados.
- Execução de verificações isoladas com `node:vm`, dados sintéticos e chamadas de integração/persistência substituídas por mocks. Os resultados abaixo validam o comportamento do código local.
- A revisão de interface foi feita pelo código; não incluiu uma sessão de navegador para medir layout e desempenho visual. O estado efetivo das integrações em produção requer conferência operacional própria.

### Casos reproduzidos

| Caso | Resultado observado |
|---|---|
| Interpretar `1 mil`, `2 mil` ou `5 mil` | Retorna `1000000` |
| Qualificar Komando: Dono + `acima de 3 mil` | Retorna qualificado |
| KOP no status de entrada com tag Downsell | `isMql: true` e `isDownsell: true` |
| Mesmo pagamento de R$ 97 entregue duas vezes | Valor do cliente no CRM: R$ 100 → R$ 197 → R$ 294; arquivo de vendas mantém uma fatura |
| Pagamento KOR/cartão | Dispara Purchase pelo bloco genérico apesar da exclusão no helper específico |
| Mesmo Chef com renda de `5 mil` nas duas URLs MLFP | `/api/lp-webhook`: MQL; `/api/webhook/lp-webhook`: Downsell |
| Candidatos sem autenticação | Handler retorna os dados com HTTP 200 |
| Exclusão de configuração de vaga sem autenticação | Handler exclui o registro sintético com sucesso |
| Pergunta autorizada ao bot Telegram | Envia erro `runGeminiAgent is not defined` |
| Clique em KOP no painel semanal | O listener genérico altera o filtro CRM para `null` |
| Compra KOR anterior à entrada no Komando | Conta como venda ganha de Komando |
| Tag `FOLLOW_UP_2`, sem variante A/B | É interpretada como variante `2` |
| IDs da interface | `vturbLiveUsers` e `vturbTableBody` aparecem duas vezes |

## 1. Melhorias urgentes de acesso e disponibilidade

### 1.1 Autenticação e autorização incompletas — urgente

**Evidência:** `api/index.js:406`, `:719`, `:727`, `:1682`, `:4074`, `:5327`, `:8040`, `:8078`, `:8197`, `:8443`, `:9057`, `:9169`.

Leitura de leads/contatos, sincronização, reenvio de notificações, assistente e vários endpoints administrativos não exigem autenticação. Em vagas, a permissão só restringe quando existe um usuário identificado: omitir o token evita parte dessas restrições. O CORS global aceita qualquer origem; ele não substitui autenticação.

**Impacto:** exposição de dados e acionamento/alteração indevida da operação. A leitura de candidatos e a exclusão de configuração de vaga sem token foram reproduzidas com mocks.

**Melhoria:** middleware de autenticação para o dashboard e rotas administrativas; papéis de gestor/comercial/tráfego; autorização por `restaurant_id` imutável; segredo de cron; autenticação de webhooks conforme o provedor. No Telegram, verificar o segredo do webhook além do `chat_id` recebido no próprio payload. Formulários públicos precisam de validação e controle de abuso próprios.

### 1.2 Credenciais incorporadas ao código — urgente

**Evidência:** `api/index.js:41`, `:166-211`, `:279`, `:1033`, `:1483`, `:8677`, `:8763-8788`, `:8800-8801`; `CLAUDE.md`.

Existem tokens/chave privada como fallback, segredo de sessão padrão e usuários com senhas padrão. Senhas de vagas são comparadas com SHA-256 simples, incluindo compatibilidade com senha em texto puro. O log de Z-API inclui uma URL com token.

**Melhoria:** substituir credenciais expostas, eliminar fallbacks reais e usar configuração validada por ambiente. Utilizar Argon2/scrypt/bcrypt para senhas, revogação de sessões e logs com mascaramento. Documentar somente nomes de variáveis. A allowlist de arquivos estáticos e o Blob privado já são avanços, mas não resolvem a autenticação das rotas.

### 1.3 Carregamento da base inteira excede o limite padrão da Vercel — alta

**Evidência:** `api/index.js:719-723`; `app.js:786-802`.

O endpoint devolve todos os leads completos e o navegador calcula as métricas. A resposta compacta da base local tem 7,89 MB. A documentação da Vercel estabelece 4,5 MB para payload de request/response de funções: <https://vercel.com/docs/functions/limitations#request-body-size>.

**Impacto:** risco concreto de falha no carregamento com esse volume, além de transferência excessiva e processamento no navegador. Não é uma afirmação de que o deploy atual foi observado retornando erro.

**Melhoria:** endpoints agregados para KPIs, funis e campanhas; listagem paginada e filtrada de leads; detalhes e contatos carregados sob demanda; exportação separada da abertura do painel.

## 2. Confiabilidade dos números e regras comerciais

### 2.1 Parser monetário produz qualificações erradas — alta

**Evidência:** `api/index.js:2849-2915`, especialmente `:2871`; versões adicionais em `update_mql_tags.js:41` e `remove_mql_tags.js:41`.

Depois de remover espaços, `2 mil` vira `2mil`. A condição `includes('2m')` o classifica como um milhão. `menos de 3 mil` também vira 3.000, perdendo o limite superior.

**Melhoria:** campos numéricos ou faixas enumeradas, com limites explícitos. Um parser compartilhado para entradas legadas, testado com faixas, separadores brasileiros, “até”, “menos de”, “acima de” e valores ausentes.

### 2.2 Critérios de MQL divergem entre documentação, entrada e tela — alta

**Evidência:** `api/index.js:2801`, `:2939`, `:3418`, `:3895`, `:7253`, `:7343`, `:7468`; `app.js:275-284`; `CLAUDE.md`.

- A documentação define Komando em R$ 100 mil; `isKomandoQualified` aceita R$ 50 mil e qualquer texto contendo “acima de”. A lista de cargos inclui gerente/gestor, além dos cargos documentados.
- Os aliases MLFP têm regras distintas. Chef + renda de R$ 5 mil foi qualificado na URL principal e desqualificado no alias.
- Em KOP, a entrada da LP aceita `is1M` independentemente do cargo e testa faturamento por presença de substrings.
- O dashboard considera engajamento suficiente para ser MQL. Como a etapa inicial KOP é “Contato inicial”, um lead com Downsell pode ser contado como MQL.

**Melhoria:** serviço único `qualificarLead(produto, respostas, versaoRegra)`, retornando resultado e motivos. Separar **perfil qualificado**, **etapa comercial** e **compra realizada**. Os relatórios históricos discutem revisar a régua de Komando; isso exige registrar a decisão e a data de vigência, em vez de deixar versões conflitantes.

### 2.3 Venda está modelada como cliente agregado — alta

**Evidência:** `api/index.js:2153-2178`, `:2195`, `:770`; `app.js:359-363`, `:392-468`, `:2976-2982`.

O webhook procura um lead existente na Base de Clientes e acumula nele valores e tags de diferentes compras. Os relatórios depois tratam esse lead como se fosse uma transação: usam `created_at` como data do pagamento e o preço acumulado como valor do produto.

No frontend, só MLFP tem filtro de produto principal; em outros funis, qualquer compra do contato pode validar a venda. A flag `preExisting` é calculada, mas não impede a contagem. Uma mesma compra pode validar vários leads. Em KOR, há ainda a soma dos ganhos do Inbound com compradores da Base Eduzz.

**Melhoria:** registrar pedidos e itens individualmente, com `order_id`, `product_id`, valor em centavos, moeda, `paid_at`, status e vínculo com contato/lead. Relacionar a compra ao funil correto e distinguir comprador anterior, nova venda e recompra. Na recuperação, dar baixa somente na oportunidade do pedido pago — hoje todos os leads de recuperação do contato podem ser ganhos.

### 2.4 Dashboard, IA e relatórios têm definições financeiras diferentes — alta

**Evidência:** `app.js:420`, `:1036`, `:2937`; `api/index.js:4777-4846`, `:6693-6822`, `:5891-5919`.

O frontend cruza contatos; a IA soma vendas Eduzz com ganhos CRM; o relatório semanal alterna entre Eduzz, CRM e pixel. A IA pode contar a mesma transação duas vezes. O semanal agrupa todo o funil de Recuperação em KOR, enquanto o próprio contexto operacional informa que Recuperação atende todos os produtos. A base de clientes também entra como “leads” em algumas consultas.

**Melhoria:** um motor de métricas usado por dashboard, relatórios e IA. Dimensões independentes para produto, pipeline e canal. Preservar KO, KOP, KOR e MLFP separados; tratar Recuperação como processo transversal com identificação do produto. Reconciliar receita por transação, não pelo somatório de sistemas.

### 2.5 Datas, períodos e cobertura precisam ser explícitos — alta

**Evidência:** `api/index.js:903-914`, `:1225-1232`, `:5467-5479`, `:6771-6779`, `:6985`; `app.js:1036`, `:2885-2893`, `:3240`, `:3332`.

- A aba CRM seleciona a data de criação; o semanal usa fechamento para vendas, mas criação para reuniões. São perguntas diferentes exibidas lado a lado.
- O relatório diário calcula meia-noite UTC para o dia de Brasília, deslocando a janela em três horas.
- Eduzz é interpretada com fuso implícito em uma rota e `-03:00` explícito em outra.
- Pageviews são comparados como strings ISO, apesar de conterem fusos diferentes.
- “Todo” significa histórico completo no CRM, mês atual em Meta e início fixo de 2026 em Pages.
- A cobertura Eduzz usa um corte fixo de setembro; o snapshot local termina em junho. Ausência de dados precisa ser distinta de zero vendas.

**Melhoria:** utilitário central de datas com `America/Sao_Paulo`; modos “entradas do período”, “atividade no período” e “pagamentos do período”; metadados de cobertura e última atualização por fonte. Persistir eventos de mudança de etapa para medir reuniões/respostas reais e evitar inferência apenas pelo status atual.

### 2.6 Atribuição de tráfego é majoritariamente inferida — alta

**Evidência:** `app.js:893-925`, `:2956-3009`; `api/index.js:6494`, `:5868`, `:6917`, `:6831`, `:6521`.

O frontend descarta o trecho após `|` nas UTMs, que pode conter o ID da campanha. O custo é associado por nome/funil e dividido por todos os leads do pipeline, incluindo orgânicos. Isso é um custo combinado, não necessariamente CPL de mídia paga. Consultas semanais, anuais, IA e visão geral também cobrem conjuntos diferentes de contas. Várias consultas Meta não percorrem `paging.next`.

**Melhoria:** armazenar `account_id`, `campaign_id`, `adset_id`, `ad_id` e, quando pertinente, `creative_id`/`video_id`; preservar UTMs originais; distinguir “orgânico confirmado” de “sem atribuição”; centralizar contas, paginação, janela de atribuição e consultas Meta. Exibir cobertura de atribuição junto ao CPA/ROAS.

## 3. Automações e operação

### 3.1 Reprocessar pagamento repete o incremento no CRM — alta

**Evidência:** `api/index.js:879-882`, `:2176-2178`, `:2206`.

O arquivo de vendas remove duplicatas por `sale_id`, mas essa proteção não engloba os efeitos externos. Reenviar a mesma fatura de R$ 97 incrementou duas vezes o cliente sintético e executou novamente os envios.

**Melhoria:** tabela de eventos com chave única `provedor + event_id`, estados de processamento e idempotência por ação. Um erro após criar o contato ou atualizar o CRM deve retomar do ponto correto. Cobrir pagamento repetido, eventos fora de ordem, estorno/reembolso e chargeback; hoje eventos diferentes dos pagos/recuperação são ignorados (`api/index.js:2088`).

### 3.2 Bloco genérico de CAPI contorna as restrições — alta

**Evidência:** `api/index.js:803-817`, `:2104`, `:2460-2484`.

O helper respeita modo desligado, exclusão KOR, cartão e exigência de valor. No final da rota existe outro envio de Purchase para qualquer evento pago, sem passar por essas regras. O teste confirmou envio KOR/cartão pelo caminho genérico.

**Melhoria:** uma única política de despacho de conversão por produto/evento, com responsabilidade explícita entre Eduzz nativa, pixel e CRM; ID estável, data real e registro de resultado. Duas chamadas com o mesmo `event_id` podem ser deduplicadas pelo Meta; o problema comprovado é o desvio das regras, e a duplicação entre origens depende de seus IDs.

### 3.3 O fluxo principal KO pode não enviar MQL ao Meta — alta

**Evidência:** `api/index.js:3085-3088`, `:3263`, `:3759`, `:3851-3893`.

O webhook KO já grava a tag MQL e marca a notificação. O webhook de criação pode sair pela deduplicação de notificação; quando prossegue, só envia MQL ao Meta dentro do bloco que adiciona a tag ausente. Logo, “já possui tag” pode significar “evento nunca enviado”.

**Melhoria:** separar estado de qualificação, estado de notificação e estado de conversão. O envio ao Meta deve depender de um registro de evento enviado, não da existência de uma tag nem do envio anterior de WhatsApp.

### 3.4 Falhas externas podem terminar como sucesso — alta

**Evidência:** `api/index.js:166-244`, `:283-359`, `:7310`, `:7430`, `:7559`, `:7697`, `:8022`; `vercel.json:4`.

Helpers de mensagens absorvem falhas; rotas respondem “enviado” sem confirmar entrega. Algumas entradas retornam HTTP 200 mesmo quando o CRM falha. Há tarefas disparadas sem `await` e cadeias longas de chamadas dentro dos 60 segundos da função. O retry de Kommo em 429 não tem limite (`api/index.js:1869`).

**Melhoria:** receber, validar e persistir o evento; confirmar recebimento após gravação durável; executar integrações por fila/worker ou workflow durável. Adotar timeout, retries limitados com backoff, estados por destino e fila de falhas reprocessáveis. Se não houver persistência, a entrada não deve confirmar sucesso.

### 3.5 Cache JSON/Blob não oferece atualização transacional — alta

**Evidência:** `api/index.js:509-583`, `:587-600`, `:1682-1777`, `:7932-7944`.

Sync e webhooks leem/modificam/gravam o arquivo inteiro. Instâncias concorrentes podem sobrescrever alterações umas das outras. Memória é atualizada antes da persistência e vários chamadores ignoram o retorno `false`. A lista de nomes do Blob fica guardada sem TTL; arquivos criados por outra instância podem permanecer invisíveis à instância quente. Sync incremental também não trata exclusões explicitamente.

**Melhoria:** banco transacional para pedidos, eventos, leads, notificações e candidatos; Blob para snapshots/exports. Usar upsert por ID, versão de atualização, checkpoint e execução única da sincronização. Deduplicação de notificações precisa de armazenamento compartilhado, não apenas `Map` com TTL de 15 minutos.

### 3.6 Bot Telegram referencia função inexistente — alta

**Evidência:** `api/index.js:5392`.

`runGeminiAgent` é chamada, mas não há definição/importação no projeto. A pergunta autorizada foi reproduzida terminando em mensagem de erro. Existe outro motor implementado, `processDashboardAIAssistant`, mas não está ligado a esse caminho.

**Melhoria:** um serviço de assistente reutilizado pelos dois canais, com os mesmos dados e contexto; teste de ponta a ponta do handler com integrações simuladas. Registrar o webhook uma vez na configuração operacional, em vez de a cada inicialização de função (`api/index.js:5402`).

### 3.7 Reenvio preenche dados comerciais inventados — alta

**Evidência:** `api/index.js:4111-4131`.

Na ausência de campos reais, `/api/resend-lead` atribui cargo de dono, faixa de faturamento, equipe, gargalo, campanha, criativo e variante específicos. O título afirma que é um novo lead qualificado Komando, independentemente do funil real.

**Melhoria:** reusar o mesmo formatador/política de qualificação da entrada; exibir “não informado” e o motivo do reenvio; registrar canal, destinatário e resultado.

### 3.8 SLA e relatórios precisam medir trabalho real — média/alta

**Evidência:** `api/index.js:5482-5485`, `:6333-6369`, `:6424-6444`, `:4421`; `app.js:292-301`.

Relatório diário e SLA consultam somente 250 leads. O SLA exclui registros com mais de 24 horas: um lead de sexta pode escapar na segunda. O tempo decorrido é corrido, embora a execução seja limitada ao horário comercial. “Atendimento humano” é inferido por status/campo preenchido; “taxa de resposta” no relatório pode ser mensagens recebidas divididas por enviadas, não pessoas respondentes.

**Melhoria:** relógio de horas úteis, timestamp do primeiro atendimento humano, paginação, reabertura/escalonamento e métricas distintas para mensagens e pessoas. Healthcheck deve mostrar última execução/sucesso de cada integração; hoje alguns serviços recebem `ok` fixo.

## 4. Dashboard: bugs e oportunidades de experiência

### 4.1 Elementos duplicados impedem atualização da seção visível — alta

**Evidência:** `index.html:682`, `:733`, `:1191`, `:1212`; `app.js:3526-3528`, `:3578`.

O bloco VTurb antigo está oculto, mas mantém os mesmos IDs da aba Pages. `getElementById` encontra o primeiro, no bloco oculto, e a tabela visível pode permanecer em “Carregando”.

**Melhoria:** componente único de VTurb, IDs únicos e carregamento somente quando a seção é utilizada.

### 4.2 Filtros e estados de navegação se interferem — alta

**Evidência:** `app.js:676-694`, `:1458-1465`, `:3255-3277`, `:3332`, `:3459-3460`, `:3755`, `:4295`; `index.html:868-891`.

O listener global de `.pipeline-tab-btn` também captura botões do painel semanal, que não têm `data-pipeline`; o clique altera `state.pipelineId` para `null`. Modal e cards não aplicam exatamente o mesmo filtro de Repescagem. Quando o filtro não encontra leads, algumas tabelas voltam a usar a base inteira. Eduzz guarda o período antes do sucesso, impedindo nova tentativa no mesmo período após falha. Requisições não têm proteção contra respostas antigas sobrescrevendo seleções novas.

**Melhoria:** estado único de filtros, listeners restritos ao componente, filtros compartilhados entre card/modal/exportação, cancelamento com `AbortController` ou controle de versão da requisição e estados explícitos de loading/erro/vazio. Persistir filtros na URL. Exibir filtro de período também na aba Eduzz, que hoje depende do filtro localizado no CRM.

### 4.3 Metas e indicadores financeiros têm fórmulas inadequadas — alta

**Evidência:** `app.js:4001-4013`, `:4131-4139`, `:4175-4177`, `:4276`; `api/index.js:7200`.

Metas de CPL/CAC/ticket são somadas como se fossem volumes; percentuais e ROAS são exibidos como média, mas o percentual de atingimento usa a soma como denominador. Cinco metas semanais de CPL R$ 10 viram R$ 50 no total. As metas ficam só no navegador. ROAS >= 1 recebe rótulo “Lucrativo/Lucro Total”, embora custos de produto, taxas, impostos e equipe não sejam considerados.

**Melhoria:** derivar metas de razão dos totais planejados; compartilhar metas no backend por produto/período; indicar responsável e revisão. Distinguir ROAS, margem de contribuição e lucro. Zero real não deve virar “—”; indisponibilidade deve ser `null` com motivo.

### 4.4 A/B, GA4 e VSL precisam de atribuição por página/experimento — média/alta

**Evidência:** `app.js:944-965`, `:3334-3368`, `:3743-3803`; `api/index.js:1225-1280`, `:1454-1464`, `:1599-1643`.

A regex de variante aceita qualquer dígito de 1 a 6 em uma tag. O ranking declara “MELHOR” com 15 views, sem medida de incerteza. O frontend recalcula leads usando filtros diferentes dos acessos. GA4 atribui a cada URL o total do pipeline correspondente; somar usuários/sessões por página também não produz usuários/sessões únicos globais. O backend repete o total de todos os players em cada linha VTurb.

**Melhoria:** `experiment_id`, `variant_id`, `page_id` e sessão ligados à conversão; população e período iguais no numerador/denominador; métricas por player; consulta GA4 agregada separada para totais. Exibir “amostra insuficiente” e intervalo de confiança no A/B.

### 4.5 Rankings recomendam ações com critérios conflitantes — média/alta

**Evidência:** `api/index.js:5682-5685`, `:5996-6001`, `:7110-7129`; `.claude/agents/gestor_trafego.md:45-75`.

A documentação exige amostra mínima e métricas por objetivo, mas o painel pode recomendar pausa após R$ 50 sem conversão e chamar de campeão um anúncio por volume de vendas. Receita ausente do pixel recebe fallback de R$ 97 por compra. Os alertas de criativos usam leads sem guardar o objetivo, atingindo inclusive criativos de venda/engajamento.

**Melhoria:** critério versionado por produto/objetivo; ranking por resultado qualificado, custo, receita real, amostra e cobertura. Separar observação de recomendação. Identificar criativo pelo ID e disponibilizar o vínculo com os leads/pedidos atribuídos.

### 4.6 Reduzir densidade e tornar a tela acionável — média

**Evidência:** `index.html:179-185`, `:397-844`, `:905-936`, `:1404-1459`; `app.js:1668`, `:1564-1579`; `style.css:3-39`.

A visão geral reúne funil, mídia, rankings, perfil, campanhas, time e SDR/Closer em uma rolagem longa. A tabela semanal tem 14 colunas. O modal mostra somente os primeiros 100 leads, sem paginação. O responsável atual é usado como fallback tanto para SDR quanto para closer, criando atribuição não comprovada. Falta tratamento de teclado/foco do modal e há muitos estilos inline e tokens de cor usados sem definição central.

**Melhoria:** primeira tela com poucos KPIs, comparação com período anterior e fila de prioridades; detalhes progressivos. Tabelas com busca/paginação/ordenação e layout próprio para celular. Modal acessível com Escape, foco controlado e rótulos. Mostrar “SDR/Closer não atribuído” em vez de inferir. Fixar a versão do Chart.js (`index.html:14`) e reduzir estilos duplicados.

## 5. Organização e manutenção

### 5.1 Rotas duplicadas e responsabilidades sem fronteira — alta

**Evidência:** `api/index.js:3303`/`:7227`, `:7982`/`:8575`, `:8040`/`:8635`, `:7955`/`:8547`.

Express utiliza a primeira rota que encerra a resposta. Os segundos handlers de candidaturas ficam inacessíveis nos mesmos caminhos. Eles ainda usam arquivos diferentes: `candidatos_vagas.json` versus `vagas_candidaturas.json`. O resumo administrativo lê a segunda base, enquanto a entrada efetiva grava a primeira.

**Melhoria:** uma implementação por rota, migração explícita dos dados e contratos de entrada/saída. Módulos de vagas, pesquisas e formulários têm domínio distinto do dashboard comercial e devem ter fronteiras próprias. Os simuladores são demonstrações determinísticas com arquivos idênticos; manter uma implementação claramente identificada como simulação.

### 5.2 Falta uma rede de testes para regras e integrações — alta

**Evidência:** `package.json:6-9`; `test_ko_webhook.js:10`; `api/index.js:3025`.

O script de teste KO usa um nome que o filtro descarta como teste; ele pode receber 200 sem exercitar qualificação, criação ou notificações. Sintaxe válida não detecta os bugs reproduzidos nesta auditoria. Scripts de correção MQL repetem regras e podem aplicar resultados divergentes.

**Melhoria:** testes focados em invariantes reais: duplicação de eventos, compra de produto diferente, entrada sem e-mail, ordem de eventos, falha parcial, fusos, paginação, permissões e igualdade de métricas entre canais. Executar em CI com fixtures anonimizadas e integrações simuladas. Separar app e inicialização do servidor para permitir teste de rotas.

### 5.3 Assistente precisa explicar os dados usados — média

**Evidência:** `app.js:4591-4604`; `api/index.js:5048-5059`, `:5267-5278`.

O frontend envia contexto baseado em variáveis que não existem no estado atual, caindo em `all/this_month`. A mensagem atual já está no histórico e é acrescentada novamente no backend. O fallback pode responder “hoje” com gasto Meta do mês e tem análises comerciais fixas. A renderização manual de Markdown não valida protocolos/atributos de links (`app.js:4494-4502`).

**Melhoria:** contexto tipado derivado de `state`, período efetivo, fonte e timestamp na resposta; ferramentas de IA consumindo o motor único de métricas; distinguir fallback determinístico; sanitizador de Markdown/links. A IA deve explicar os números calculados, não manter outra versão deles.

## 6. Desenho recomendado do produto

Um seletor global de **produto + período + modo de data**. KO, KOP, KOR e MLFP permanecem identificados individualmente; processos como Recuperação, Repescagem e Social Selling são filtros/dimensões explícitos.

| Área | Pergunta principal | Conteúdo prioritário |
|---|---|---|
| Resumo executivo | Como estamos e onde agir? | Receita confirmada, investimento, vendas, CAC/ROAS, metas, variação e alertas |
| Comercial | Quem precisa ser atendido? | Funil específico, SLA, tarefas, reuniões, motivos de perda e responsáveis |
| Aquisição | Qual campanha traz resultado? | Investimento → lead → MQL → venda, atribuição por ID e cobertura |
| Receita | O que foi realmente pago? | Pedidos, produtos, reembolsos, reconciliação e novas compras/recompras |
| Páginas e experimentos | Onde perdemos conversão? | Página → formulário iniciado → concluído, variantes e VSL |
| Automações | O que executou e o que falhou? | Eventos, tentativas, destinos, última execução, pendências e reprocessamento |

Cada KPI deve trazer sua fórmula, fonte, período, atualização e detalhe clicável. O número do card, a lista aberta e o CSV precisam ser a mesma consulta.

## 7. Arquitetura incremental sugerida

Começar com um **monólito modular**, mantendo a implantação simples:

```text
api/index.js                 # composição do Express e adaptação Vercel
src/config/                 # ambiente, produtos, pipelines, regras versionadas
src/domain/                 # qualificação, vendas, atribuição e métricas
src/integrations/           # Kommo, Eduzz, Meta, GA4, VTurb, mensagens
src/routes/                 # validação, autenticação e contratos HTTP
src/services/               # orquestração dos casos de uso
src/repositories/           # banco e cache
src/jobs/                   # sync, relatórios, SLA e reprocessamento
public/js/                  # estado, cliente HTTP e componentes do dashboard
tests/                      # regras críticas e contratos de integração
```

Modelo mínimo: `products`, `contacts`, `leads`, `lead_events`, `orders`, `order_items`, `ad_insights_daily`, `webhook_events`, `notification_deliveries`, `job_runs`, `goals`. Vagas/restaurantes/pesquisas ficam em módulos próprios, com IDs de organização e autorização consistente.

Fluxo de automação recomendado:

```text
Webhook → validação/autenticação → evento persistido e deduplicado
        → processamento por etapas → CRM / Meta / mensagens
        → resultado por destino → retry limitado / falha reprocessável

Banco normalizado → motor de métricas → dashboard / relatórios / assistente
```

## 8. Plano priorizado

| Fase | Entregas | Critério de conclusão |
|---|---|---|
| 1 — Contenção | Autorização, credenciais, parser, aliases, CAPI genérica, idempotência de pagamentos, paginação de leads | Evento repetido não duplica receita; dados administrativos exigem acesso; carga inicial cabe no limite |
| 2 — Verdade dos números | Catálogo de produtos, decisão versionada de MQL, pedidos individuais, reconciliação e datas | Dashboard, relatório e IA concordam para o mesmo recorte e fórmula |
| 3 — Confiabilidade operacional | Persistência transacional, fila/workflow, retries, logs de entrega e painel de automações | Toda entrada pode ser rastreada até os destinos e reprocessada sem repetir efeitos |
| 4 — Simplificação da experiência | Resumo enxuto, filtros globais, detalhes consistentes, metas compartilhadas e interface mobile | Gestor encontra situação/ação prioritária rapidamente; card, detalhe e CSV batem |
| 5 — Evolução contínua | Extração de módulos, CI, contratos e documentação atualizada | Nova regra é alterada em um lugar e validada automaticamente |

Esforço relativo: correções de DOM, função inexistente e centralização do parser são pequenas; autenticação e unificação de regras são médias; pedidos, reconciliação e processamento durável são maiores. Prazo fechado depende da confirmação das regras comerciais e dos dados disponíveis para migrar.

## 9. Decisões de negócio que precisam ser registradas

1. Qual é a régua vigente de Komando: R$ 50 mil ou R$ 100 mil, quais cargos e desde quando?
2. O que representa KOR no catálogo atual, e como separar suas vendas do processo de recuperação de outros produtos?
3. Qual fonte registra as consultorias fechadas fora do CRM e permite reconciliá-las com pagamentos?
4. O painel principal deve abrir por entradas, atividade comercial ou receita recebida? Os três modos devem ter rótulos distintos.
5. Quais destinatários recebem cada evento? A política de silenciar KOR não é aplicada uniformemente entre criação, resposta e upsell.

## 10. Bases já úteis

- Integrações existentes cobrem o fluxo comercial e permitem evolução gradual.
- Cache Blob privado, TTL em memória e sincronização incremental já oferecem uma base de persistência/cache melhor que apenas `/tmp`.
- A allowlist de estáticos reduz exposição acidental de arquivos.
- O frontend já tem um núcleo de classificação de etapas por pipeline e separação visual de produtos.
- Há preocupação documentada com diferenças entre pixel, CRM, pagamento, downsell e qualidade de atribuição.
- Os relatórios comerciais existentes ajudam a definir casos reais de reconciliação; devem virar critérios verificáveis, com fonte e versão, em vez de regras repetidas em vários lugares.

**Recomendação final:** transformar regras e eventos em dados verificáveis. Isso reduz simultaneamente a complexidade de manutenção, a divergência entre indicadores e o esforço diário para descobrir por que uma automação falhou.
