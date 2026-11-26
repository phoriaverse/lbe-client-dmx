import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const root=new URL('../',import.meta.url), source=new URL('./reference/dmx-client/src/',root), runtime=new URL('./native-test-runtime/',root);
mkdirSync(new URL('shared/',runtime),{recursive:true});
for(const p of ['shared/show-file.ts','shared/patch.ts','shared/brightness.ts','output.ts']){
 let s=readFileSync(new URL(p,source),'utf8');
 // Only import extensions are adapted for Node's TS loader. Original source retained separately.
 s=s.replace(/from "(.\/shared\/(?:patch|brightness))"/g,'from "$1.ts"');
 writeFileSync(new URL(p,runtime),s);
}
const {parseShow,frameView,durationMsOf}=await import(new URL('shared/show-file.ts',runtime));
const {validatePatch,compilePatch}=await import(new URL('shared/patch.ts',runtime));
const {Output}=await import(new URL('output.ts',runtime));
const index=JSON.parse(readFileSync(new URL('manifest.json',root)));
let frames=0,peak=0;
for(const record of index.shows){
 const bytes=readFileSync(new URL(''+record.file,root));
 const show=parseShow(bytes,bytes.length);const h=show.header;
 assert.deepEqual(validatePatch(h.patch),[]);assert.equal(show.dataOffset%8,0);assert.equal(durationMsOf(h)/1000,record.duration);
 assert.equal(bytes.length,show.dataOffset+show.frameBytes*h.frameCount);
 assert.throws(()=>parseShow(bytes,bytes.length-1),/truncated/);
 const compiled=compilePatch(h.patch);assert.equal(compiled.slots.length,1);assert.equal(compiled.slots[0].universe,1);assert.equal(compiled.slots[0].used,384);
 const preview=readFileSync(new URL(record.preview,root));
 let sent;
 const output=new Output({validatePatch:p=>validatePatch(p),sendUniverse:(host,port,universe,data)=>{assert.equal(host,'enttec-usb');assert.equal(universe,1);sent=new Uint8Array(data)}});
 output.setPatch(h.patch);output.setLevels({master:1,cap:.5});
 for(let i=0;i<h.frameCount;i++){
  output.render(frameView(bytes,show,i),h.transfer);
  assert.ok(sent.slice(384).every(v=>v===0));
  assert.deepEqual(sent.slice(0,384),new Uint8Array(preview.subarray(i*384,(i+1)*384)),'preview and native DMX output differ');
  for(const v of sent){assert.ok(v<=128);peak=Math.max(peak,v)}
  frames++;
 }
 output.render(null);assert.ok(sent.every(v=>v===0));
 console.log('PASS',record.file,record.duration+'s',h.frameCount+'frames');
}
// Boundary mapping: bottom R, top B independently in every fixture.
const h=parseShow(readFileSync(new URL(index.shows[0].file,root))).header;
let sent;const output=new Output({validatePatch,sendUniverse:(_h,_p,_u,d)=>sent=new Uint8Array(d)});
output.setPatch(h.patch);output.setLevels({master:1,cap:.5});const f=new Uint16Array(384);
for(let t=0;t<8;t++){f[t*48]=65535;f[t*48+47]=65535}
output.render(f,2.2);
for(let t=0;t<8;t++){assert.equal(sent[t*48],128);assert.equal(sent[t*48+47],128);assert.equal(sent[t*48+1],0)}
console.log('PASS 8 tube boundary patch, cap, blackout, truncation; frames='+frames+' peakDMX='+peak);
