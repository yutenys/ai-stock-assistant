const fs=require('node:fs');
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const {splitUserState}=require('../lib/user-state-store');

const file=path.resolve(process.argv[2] || path.join(__dirname,'..','data','user-state.json'));
const started=performance.now();
const raw=fs.readFileSync(file,'utf8');
const readAt=performance.now();
const state=JSON.parse(raw);
const parsedAt=performance.now();
const split=splitUserState(state);
const compact=JSON.stringify(split.state);
const evidence=JSON.stringify(split.evidence);
const completed=performance.now();
const labels=state.labels || [];
const rows=labels.flatMap(label=>label.stocks || []);
process.stdout.write(`${JSON.stringify({
  file,
  labels:labels.length,
  members:rows.length,
  uniqueCodes:new Set(rows.map(row=>row.code)).size,
  bytes:{original:Buffer.byteLength(raw),compactState:Buffer.byteLength(compact),evidence:Buffer.byteLength(evidence),
    total:Buffer.byteLength(compact)+Buffer.byteLength(evidence)},
  milliseconds:{read:Number((readAt-started).toFixed(2)),parse:Number((parsedAt-readAt).toFixed(2)),
    compactAndStringify:Number((completed-parsedAt).toFixed(2))}
},null,2)}\n`);
