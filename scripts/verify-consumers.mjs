// Explicit multi-repository qualification: real consumer code, real HTTP/UDS,
// synthetic provider and synthetic scoped identities. No paid provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fixture, result, close, KEY } from '../tests/helpers.js';
import { createServer } from '../src/server.js';
import { hash } from '../src/util.js';

const [workspace, python] = process.argv.slice(2);
if (!path.isAbsolute(workspace ?? '') || !python) throw Error('Pass absolute workspace and Python with Mastermind dependencies');
const cleanup = [], directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wyvern-consumers-'));
const understanding = { title: 'Source facts', summary: 'A faithful summary.', topics: ['knowledge'], entities: [], suggested_links: [] };
const derivatives = { description: 'A faithfully derived description of the source.', abstractMarkdown: 'A faithful abstract of the provided source facts.', transcriptMarkdown: 'A faithful transcript of the provided PDF source.', evidence: [], warnings: [] };
let uploads = 0, deletes = 0;
try {
  const f = await fixture({ after: action => cleanup.push(action) }, { rawProvider: true,
    mutate(state) {
      state.config.adapters.google.profiles.default.capabilities.push('image','pdf','audio','video','youtube');
      state.config.adapters.google.profiles.default.max_output_tokens = 8192;
      for (const [id, functions, token] of [['mastermind',['text','media'],'a'],['laboratory',['derivatives'],'b']]) {
        state.config.clients[id] = { token_sha256: hash(token.repeat(64)), allowed_adapters: ['google'], enabled: true,
          bindings: Object.fromEntries(functions.map(name => [name, { adapter_id: 'google', profile: 'default' }])) };
      }
    }, provider(req, res, body) {
      assert.equal(req.headers['x-goog-api-key'], KEY);
      assert.equal(req.headers.authorization, undefined);
      if (req.headers['x-goog-upload-command'] === 'start') { res.setHeader('x-goog-upload-url', `http://${req.headers.host}/upload/v1beta/files?upload_id=fixture`); return res.end(); }
      if (req.headers['x-goog-upload-command'] === 'upload, finalize') { uploads++; assert.equal(body.toString(), '%PDF-fixture'); return res.end(JSON.stringify({ file: { name: 'files/fixture'+uploads, state: 'ACTIVE' } })); }
      if (req.method === 'DELETE') { deletes++; return res.end('{}'); }
      if (req.method === 'GET') return res.end(JSON.stringify({ name: req.url.slice('/v1beta/'.length), state: 'ACTIVE' }));
      if (req.url.endsWith(':countTokens')) return res.end(JSON.stringify({ totalTokens: 17 }));
      const schema = body.generationConfig.responseJsonSchema;
      assert.ok(schema, 'Provider receives the consumer schema');
      res.end(JSON.stringify(result(JSON.stringify(schema.properties.title ? understanding : derivatives))));
    } });
  const link = path.join(directory, 'link.json');
  await fs.writeFile(link, JSON.stringify({ schema:'exocortex.wyvern.link.v1', client_id:'mastermind', instance_id:'host-test', mode:'remote', url:'https://isolated.test', token:'a'.repeat(64) }), { mode:0o600 });
  const program = `import json,sys,httpx,contextlib
from mastermind.wyvern import Wyvern
from mastermind.gemini import Gemini, Understanding
gateway=Wyvern(sys.argv[1],client=httpx.Client(base_url=sys.argv[2]))
provider=Gemini(gateway=gateway)
assert provider.models()=={'text':'text','video':'media'}
assert provider.bound_source('text','source facts')['tokens']==17
assert provider.generate('text','Understand',{'source':'facts'},Understanding)['title']=='Source facts'
class Worker:
 @contextlib.contextmanager
 def media(self,identifier): yield {'size':12,'blocks':iter([b'%PDF-fixture'])}
saved={}
def checkpoint(key,action):
 if key not in saved: saved[key]=action()
 return saved[key]
value=provider.understand_media('media','source',{'type':'pdf','mime':'application/pdf'},Worker(),checkpoint,{'source_transmitted':0},lambda:None)
assert value['title']=='Source facts'
assert saved['media-upload']['media_id'].startswith('media_')
provider.cleanup_media({'results':saved})
assert provider.targets['media']['model']=='gemini-test'
provider.close()
print('mastermind text, structured output, media, usage and cleanup passed')
`;
  const child = spawn(python, ['-c', program, link, f.origin], { env: { ...process.env, PYTHONPATH:path.join(workspace,'mastermind/src') }, stdio:['ignore','pipe','pipe'] });
  let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  const [code] = await once(child, 'close'); assert.equal(code, 0, output);
  const { Wyvern } = await import(pathToFileURL(path.join(workspace,'laboratory/services/api/src/wyvern.js')));
  const { DerivedContentRuntime } = await import(pathToFileURL(path.join(workspace,'laboratory/services/api/src/derived-content.js')));
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\wyvern-consumers-'+randomUUID() : path.join(directory,'client.sock');
  const server = createServer(f.runtime); server.listen(socket); await once(server,'listening'); cleanup.push(() => close(server));
  const gateway = new Wyvern();
  // Override only discovery: all native request, streaming and response code runs.
  gateway.link = async () => ({ mode:'local', socket, token:'b'.repeat(64), client_id:'laboratory', instance_id:'host-test' });
  assert.equal((await gateway.status()).llm_ready, true);
  const library = { rootDir:directory, db:{ prepare:() => ({ run:() => {} }) } };
  const pipeline = new DerivedContentRuntime({ derivedContentEnabled:true }, library, {});
  pipeline.gateway = gateway; pipeline.systemInstruction = 'Create faithful publication derivatives from source facts.';
  const markdown = await pipeline.generate({ revision_id:1, title:'Facts', format:'markdown', markdown_source:'# Facts\nSource facts.' });
  assert.equal(markdown.target.model,'gemini-test'); assert.equal(markdown.usage.output_tokens,2);
  await fs.writeFile(path.join(directory,'source.pdf'),'%PDF-fixture');
  const pdf = await pipeline.generate({ revision_id:2, title:'Facts', format:'pdf', storage_path:'source.pdf', mime:'application/pdf' });
  assert.equal(pdf.target.adapter_id,'google'); assert.equal(pdf.validation.schema,true);
  assert.equal(uploads,2); assert.equal(deletes,2); assert.equal(f.runtime.status().active_requests,0);
  assert.equal(f.runtime.media.records.size,0);
  assert.equal(JSON.stringify([markdown,pdf,f.events]).includes(KEY),false);
  console.log(JSON.stringify({ schema:'exocortex.wyvern.consumer-qualification.v1', mastermind:true, laboratory:true, native_transports:true, uploads, cleanups:deletes, provider_key_contained:true }));
} finally {
  for (const action of cleanup.reverse()) await action();
  await fs.rm(directory,{ recursive:true,force:true });
}
