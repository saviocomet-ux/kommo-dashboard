const fs = require('fs');
const path = require('path');

const leadsPath = path.join(__dirname, 'all_leads.json');
const leads = JSON.parse(fs.readFileSync(leadsPath, 'utf8'));

const mlfpLeads = leads.filter(l => l.pipeline_id === 13304583);
const koLeads = leads.filter(l => l.pipeline_id === 13304659 || l.pipeline_id === 13537971 || l.pipeline_id === 14173256);

console.log(`MLFP leads count: ${mlfpLeads.length}`);
console.log(`KO/KOP leads count: ${koLeads.length}`);

// Inspect all custom field IDs and names in MLFP
const mlfpFieldMap = {};
mlfpLeads.forEach(l => {
  (l.custom_fields_values || []).forEach(f => {
    if (!mlfpFieldMap[f.field_id]) {
      mlfpFieldMap[f.field_id] = { name: f.field_name, code: f.field_code, samples: new Set() };
    }
    (f.values || []).forEach(v => {
      if (v.value && mlfpFieldMap[f.field_id].samples.size < 5) {
        mlfpFieldMap[f.field_id].samples.add(String(v.value));
      }
    });
  });
});

console.log('\n--- ALL CUSTOM FIELDS IN MLFP (13304583) ---');
for (const [fId, info] of Object.entries(mlfpFieldMap)) {
  console.log(`Field ID ${fId} | Name: "${info.name}" | Code: "${info.code || ''}" | Samples:`, Array.from(info.samples));
}

// Inspect responsible users (SDRs/Closers/Owners) in MLFP
const userCounts = {};
mlfpLeads.forEach(l => {
  const uId = l.responsible_user_id;
  userCounts[uId] = (userCounts[uId] || 0) + 1;
});
console.log('\n--- RESPONSIBLE USERS IN MLFP ---');
console.log(userCounts);
