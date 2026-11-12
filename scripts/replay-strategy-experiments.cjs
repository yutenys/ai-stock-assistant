#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {createStrategyExperimentManifest,replayStrategyExperiments} = require('../lib/strategy-experiments');

function main(argv) {
  const options = {};
  const numeric = { 'commission-rate':'commissionRate','minimum-commission':'minimumCommission',
    'stamp-duty-rate':'stampDutyRate','transfer-fee-rate':'transferFeeRate','lot-size':'lotSize',
    'slippage-bps':'slippageBps','initial-capital':'initialCapital'};
  const allowed = new Set(['input','out','freeze-date','model-version','as-of-date',...Object.keys(numeric)]);
  for (let index = 0;index < argv.length;index += 2) {
    const key = argv[index]?.replace(/^--/,'');
    if (!argv[index]?.startsWith('--') || !allowed.has(key) || options[key] !== undefined || !argv[index+1] || argv[index+1].startsWith('--')) throw new Error('Invalid CLI arguments');
    options[key] = argv[index+1];
  }
  if (!options.input || !options.out) throw new Error('Usage: --input JSON --out NEW_PATH; manifest or all explicit fee/slippage rules required');
  const input = fs.realpathSync(path.resolve(options.input)),output = path.resolve(options.out);
  if (input.toLowerCase() === output.toLowerCase() || fs.existsSync(output)) throw new Error('Output must be new and cannot overwrite input');
  const bytes = fs.readFileSync(input),data = JSON.parse(bytes.toString('utf8'));
  const overrides = Object.keys(options).filter(key=>!['input','out','as-of-date'].includes(key));
  if (data.manifest && overrides.length) throw new Error('Cannot override a frozen input manifest');
  let manifest = data.manifest;
  if (!manifest) {
    const rules = {tPlusOne:true,...data.rules};
    for (const [flag,key] of Object.entries(numeric)) {
      if (flag !== 'initial-capital' && options[flag] !== undefined) rules[key] = Number(options[flag]);
    }
    manifest = createStrategyExperimentManifest({freezeDate:options['freeze-date'] || data.freezeDate,
      modelVersion:options['model-version'] || data.modelVersion,
      initialCapital:options['initial-capital'] === undefined ? data.initialCapital : Number(options['initial-capital']),rules});
  }
  const replay = replayStrategyExperiments({...data,manifest,asOfDate:options['as-of-date'] || data.asOfDate});
  const result = {...replay,inputSha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  process.stdout.write(`Shadow replay written: ${output}\n`);
}

try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
