# Ativação de reservas automáticas

O site continua estático e não contém tokens. O backend roda em Supabase Edge Functions; apenas um pagamento Mercado Pago com status `approved` muda a reserva para `paid` e cria o evento no Google Calendar. Checkouts pendentes expiram em 30 minutos e não bloqueiam permanentemente uma data.

## Supabase

1. Crie um projeto no Supabase e instale a CLI (`npm install -g supabase`).
2. Na raiz, execute `supabase login`, `supabase link --project-ref SEU_PROJECT_REF` e `supabase db push`.
3. Faça o deploy: `supabase functions deploy create-checkout`, `supabase functions deploy mercado-pago-webhook` e `supabase functions deploy availability`.
4. Substitua `YOUR_PROJECT_REF` em `index.html` pela referência pública do projeto e preencha `supabaseAnonKey` com a chave **anon public**. Nunca use a service role key no frontend.

## Secrets das funções

No dashboard em **Project Settings > Edge Functions > Secrets** (ou com `supabase secrets set`), configure:

| Nome | Valor |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key do projeto |
| `MERCADO_PAGO_ACCESS_TOKEN` | access token privado do app Mercado Pago |
| `PUBLIC_SITE_URL` | URL HTTPS final do site, sem barra final |
| `PUBLIC_SITE_ORIGIN` | origem HTTPS do site, por exemplo `https://exemplo.com` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | e-mail do service account |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | chave privada PEM, com quebras de linha como `\n` |
| `GOOGLE_CALENDAR_ID` | ID do calendário de reservas |

Nunca publique secrets, coloque-os no HTML, em commits, issues ou logs.

## Mercado Pago

No painel do app, configure as notificações de pagamentos para `https://SEU_PROJECT_REF.supabase.co/functions/v1/mercado-pago-webhook`. Teste primeiro com credenciais sandbox; antes da publicação troque pelo access token de produção. A função consulta cada pagamento diretamente, confere referência e valor e ignora pagamentos não aprovados.

## Google Calendar

No Google Cloud, crie um projeto, habilite a Google Calendar API e crie um service account. Gere a chave JSON uma única vez, copie o e-mail e `private_key` para os secrets e não faça commit do JSON. Compartilhe o calendário com o service account com permissão **Make changes to events**, e use o ID em `GOOGLE_CALENDAR_ID`.

## Checklist de produção

- Aplicar a migration e testar as três funções em staging.
- Testar data livre, data `paid`, checkout repetido com a mesma chave, pagamento recusado e webhook repetido.
- Confirmar os horários `America/Sao_Paulo`, o evento no calendário e os retornos aprovado/pendente/falho.
- Confirmar que o fallback do WhatsApp continua funcionando.
- Configurar domínio HTTPS, origem restrita e monitorar logs; só então usar token Mercado Pago de produção e fazer um pagamento real de baixo valor.
