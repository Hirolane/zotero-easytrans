const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = vm.createContext({ TextEncoder });
vm.runInContext(fs.readFileSync('plugin/chrome/content/llamaHelper.js', 'utf8') + '\nglobalThis.Helper = LlamaHelper;', ctx);

async function check(lines, expectedEvents, expectedText) {
  const helper = new ctx.Helper();
  const chunks = [lines.join('\n') + '\n'];
  helper._proc = { stdin: { write: async () => {} }, stdout: { readString: async () => chunks.shift() || '' } };
  const events = [];
  const result = await helper._send({ type: 'translate' }, true, e => events.push(e.event));
  assert.deepEqual(events, expectedEvents);
  assert.equal(result.text, expectedText);
}
(async () => {
  await check(['{"event":"loading","percent":50}', '{"event":"processing","id":1}', '{"event":"generating","id":1,"tokens":4}', '{"id":1,"ok":true,"text":"result"}'], ['loading', 'processing', 'generating'], 'result');
  await check(['{"id":1,"ok":true,"text":"old helper"}'], [], 'old helper');
  await assert.rejects(check(['{"id":2,"ok":true}'], [], ''), /unexpected response ID/);
  console.log('Helper progress, final response, legacy response and ID validation passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
