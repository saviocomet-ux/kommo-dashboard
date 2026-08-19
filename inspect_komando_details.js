const fs = require('fs');
const path = require('path');

const leadsPath = path.join(__dirname, 'all_leads.json');
const leads = JSON.parse(fs.readFileSync(leadsPath, 'utf8'));

console.log(`Total leads in all_leads.json: ${leads.length}`);

const koInbound = leads.filter(l => l.pipeline_id === 13304659);
const koEbooks = leads.filter(l => l.pipeline_id === 13537971);
const kopInbound = leads.filter(l => l.pipeline_id === 14173256);

console.log(`\n📌 KO Inbound (13304659): ${koInbound.length} leads`);
console.log(`📌 KO Ebooks (13537971): ${koEbooks.length} leads`);
console.log(`📌 KOP Inbound (14173256): ${kopInbound.length} leads`);

// Inspect tags in Komando leads
const tagCounts = {};
koInbound.forEach(l => {
  const tags = (l._embedded?.tags || []).map(t => t.name);
  tags.forEach(t => {
    tagCounts[t] = (tagCounts[t] || 0) + 1;
  });
});

console.log('\n--- TAGS FOUND IN KO INBOUND LEADS ---');
console.log(tagCounts);

// Inspect custom fields in KO Inbound
const fieldCounts = {};
koInbound.forEach(l => {
  (l.custom_fields_values || []).forEach(f => {
    const key = `${f.field_name} (ID ${f.field_id})`;
    fieldCounts[key] = (fieldCounts[key] || 0) + 1;
  });
});

console.log('\n--- CUSTOM FIELDS IN KO INBOUND LEADS ---');
console.log(fieldCounts);

// Inspect status counts in KO Inbound
const statusCounts = {};
koInbound.forEach(l => {
  statusCounts[l.status_id] = (statusCounts[l.status_id] || 0) + 1;
});
console.log('\n--- STATUS COUNTS IN KO INBOUND LEADS ---');
console.log(statusCounts);
