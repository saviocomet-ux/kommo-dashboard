require('dotenv').config();

async function kommoRequest(method, endpoint, body = null) {
  const domain = process.env.KOMMO_DOMAIN;
  const token = process.env.KOMMO_LONG_LIVED_TOKEN;
  
  if (!domain || !token) {
    throw new Error('Kommo domain or long-lived token not configured in environment variables');
  }

  const url = `https://${domain}${endpoint}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  
  const response = await fetch(url, opts);
  
  if (response.status === 204) {
    return null;
  }
  
  if (response.status === 429) {
    console.log('[Kommo API] Rate limited, waiting 1.5s...');
    await new Promise(r => setTimeout(r, 1500));
    return kommoRequest(method, endpoint, body);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Kommo API Error (${response.status}): ${errText}`);
  }

  return response.json();
}

function parseFaturamentoNumber(str) {
  if (!str) return 0;
  const clean = String(str).toLowerCase().replace(/[\s_-]+/g, '');
  
  const rangeMatch = clean.match(/(?:entre)?(\d+(?:[.,]\d+)?)[ae](\d+(?:[.,]\d+)?)mil/);
  if (rangeMatch) {
    const num = parseFloat(rangeMatch[1].replace(',', '.'));
    return num * 1000;
  }
  
  let val = 0;
  if (clean.includes('milhao') || clean.includes('milhão') || clean.includes('1m') || clean.includes('2m') || clean.includes('5m')) {
    val = 1000000;
  } else {
    const kMatch = clean.match(/(\d+(?:[.,]\d+)?)\s*k/);
    if (kMatch) {
      const num = parseFloat(kMatch[1].replace(',', '.'));
      val = num * 1000;
    } else {
      const milMatch = clean.match(/(\d+(?:[.,]\d+)?)\s*mil/);
      if (milMatch) {
        const num = parseFloat(milMatch[1].replace(',', '.'));
        val = num * 1000;
      } else {
        const numbers = clean.replace(/[^0-9.,]/g, '');
        if (numbers) {
          if (numbers.includes(',') && numbers.split(',')[1].length === 2) {
            const parts = numbers.split(',');
            const mainPart = parts[0].replace(/\./g, '');
            val = parseFloat(mainPart);
          } else if (numbers.includes('.') && !numbers.includes(',')) {
            const parts = numbers.split('.');
            if (parts[parts.length - 1].length === 3) {
              val = parseFloat(numbers.replace(/\./g, ''));
            } else {
              val = parseFloat(numbers);
            }
          } else {
            const digits = clean.replace(/\D/g, '');
            if (digits.length > 0) {
              val = parseInt(digits, 10);
              if (clean.includes(',00') || clean.includes('.00')) {
                val = val / 100;
              }
            }
          }
        }
      }
    }
  }
  
  if (clean.includes('menos') || clean.includes('abaixo') || clean.includes('menor') || clean.includes('under') || clean.includes('less') || clean.includes('ate') || clean.includes('até')) {
    if (val > 0) val = val - 1;
  }
  
  return val;
}

function isFaturamentoAbove3k(faturamento, renda) {
  const fVal = parseFaturamentoNumber(faturamento);
  const rVal = parseFaturamentoNumber(renda);
  return fVal >= 3000 || rVal >= 3000;
}

async function main() {
  try {
    const PIPELINE_MLFP = 13304583;
    let page = 1;
    let hasMore = true;
    let count = 0;

    console.log(`Buscando leads no funil MLFP (${PIPELINE_MLFP}) para REMOVER tags incorretas...`);
    while (hasMore) {
      const data = await kommoRequest('GET', `/api/v4/leads?filter[statuses][0][pipeline_id]=${PIPELINE_MLFP}&limit=250&page=${page}`);
      
      if (!data || !data._embedded || !data._embedded.leads || data._embedded.leads.length === 0) {
        hasMore = false;
        break;
      }

      const leads = data._embedded.leads;
      for (const lead of leads) {
        const tags = lead._embedded?.tags?.map(t => t.name) || [];
        if (tags.includes('MQL') || tags.includes('mql')) {
          const fields = lead.custom_fields_values || [];
          let faturamento = '';
          let renda = '';
          
          for (const f of fields) {
            if (f.field_id === 128886) faturamento = f.values?.[0]?.value || '';
            if (f.field_id === 128476) renda = f.values?.[0]?.value || '';
          }

          const isMql = isFaturamentoAbove3k(faturamento, renda);
          if (!isMql) {
            console.log(`Lead ${lead.id} (${lead.name}): Faturamento/Renda NÃO É >= 3k ("${faturamento || renda}"). Removendo tag MQL...`);
            
            const newTags = tags.filter(t => t !== 'MQL' && t !== 'mql');
            await kommoRequest('PATCH', `/api/v4/leads/${lead.id}`, {
              _embedded: {
                tags: newTags.length > 0 ? newTags.map(name => ({ name })) : [] // Send empty array to remove all tags if only MQL was there
              }
            });
            count++;
          }
        }
      }

      if (leads.length < 250) {
        hasMore = false;
      } else {
        page++;
        await new Promise(r => setTimeout(r, 500));
      }
    }
    
    console.log(`Finalizado. ${count} leads corrigidos (tag MQL removida).`);
  } catch (err) {
    console.error('Erro:', err.message);
  }
}

main();
