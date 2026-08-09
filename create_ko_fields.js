require('dotenv').config();
const https = require('https');

async function createFields() {
  const domain = process.env.KOMMO_DOMAIN;
  const token = process.env.KOMMO_LONG_LIVED_TOKEN;

  const data = JSON.stringify([
    {
      "name": "Tamanho da equipe",
      "type": "text"
    },
    {
      "name": "Maior gargalo",
      "type": "text"
    },
    {
      "name": "Possui líder operacional?",
      "type": "text"
    }
  ]);

  const options = {
    hostname: domain,
    port: 443,
    path: '/api/v4/leads/custom_fields',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': data.length
    }
  };

  const req = https.request(options, (res) => {
    let responseBody = '';
    res.on('data', (chunk) => {
      responseBody += chunk;
    });
    res.on('end', () => {
      console.log('Status:', res.statusCode);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const json = JSON.parse(responseBody);
        console.log('Fields created:');
        console.log(JSON.stringify(json._embedded.custom_fields, null, 2));
      } else {
        console.error('Error:', responseBody);
      }
    });
  });

  req.on('error', (e) => {
    console.error('Request Error:', e.message);
  });

  req.write(data);
  req.end();
}

createFields();
