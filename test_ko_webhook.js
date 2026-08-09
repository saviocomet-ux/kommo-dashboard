require('dotenv').config();
const http = require('http');

const payload = Buffer.from(JSON.stringify({
  "event": "lead_triage_completed",
  "timestamp": "2026-07-03T21:49:17.000Z",
  "page_url": "https://consultoriakomando.com.br/",
  "lead_status": "qualified", 
  "form_data": {
    "nome": "João Silva Teste KO",
    "telefone": "(11) 99999-9999",
    "faturamento": "R$ 100 a R$ 150 mil / mês",
    "equipe": "Entre 5 e 15 colaboradores",
    "gargalo": "CMV alto e desperdício de estoque",
    "lider": "Sim, tenho um braço direito operacional",
    "email": "joaoteste@ko.com"
  },
  "utm_data": {
    "utm_source": "instagram",
    "utm_medium": "bio",
    "utm_campaign": "lancamento",
    "utm_term": "restaurante",
    "utm_content": "video-stories"
  }
}), 'utf8');

const options = {
  hostname: 'localhost',
  port: process.env.PORT || 3000,
  path: '/api/ko-webhook',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': payload.length
  }
};

const req = http.request(options, (res) => {
  let responseBody = '';
  res.on('data', (chunk) => { responseBody += chunk; });
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Response:', responseBody);
  });
});

req.on('error', (e) => {
  console.error('Error:', e.message);
});

req.write(payload);
req.end();
