"""Export the repo's LBESHOW1 format; no USB or network output."""
from pathlib import Path
import json,struct,hashlib,datetime
ROOT=Path(__file__).resolve().parents[1]
def main():
 m=json.loads((ROOT/'manifest.json').read_text());out=ROOT/'native';out.mkdir(exist_ok=True)
 patch={'pixelCount':128,'gateways':[{'id':'enttec','name':'ENTTEC Mk2 / TimoLink TX','host':'enttec-usb'}],'runs':[{'first':i*16,'count':16,'gateway':'enttec','universe':1,'channel':1+48*i,'order':'RGB','gamma':2.2} for i in range(8)]}
 (ROOT/'hardware/patch.native.json').write_text(json.dumps(patch,indent=2)+'\n')
 shows=[('introduction',['intro','rise','reveal','aurora','return_delay','bass'],False),('ambient',['waiting'],True),('vr-idle',['idle'],True)]
 # Stage files allow a host integration to follow actual geometry-gated reveal timing.
 shows += [('stages/'+s['id'],[s['id']],s['loop']) for s in m['segments']]
 records=[]
 for name,stages,loop in shows:
  raw=b''.join((ROOT/'data'/f'{s}.rgb16').read_bytes() for s in stages)
  h={'version':1,'name':'SoundSpace onboarding v1 / '+name,'experience':name.split('/')[-1],'fps':m['fps'],'bits':16,'pixelCount':128,'frameCount':len(raw)//768,'transfer':2.2,'loop':loop,'patch':patch,'bakedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'bakedBy':'SoundSpace eight-tube score 1.0.0 / source build 13','hashes':{'rig':hashlib.sha256(json.dumps(patch,sort_keys=True).encode()).hexdigest(),'sequence':hashlib.sha256(raw).hexdigest()}}
  j=json.dumps(h,separators=(',',':')).encode();padding=(-(12+len(j)))%8;payload=b'LBESHOW1'+struct.pack('<I',len(j)+padding)+j+b' '*padding+raw
  path=out/(name+'.show');path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(payload)
  records.append({'file':str(path.relative_to(ROOT)),'stages':stages,'duration':h['frameCount']/h['fps'],'loop':loop,'bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()})
 (out/'index.json').write_text(json.dumps({'format':'LBESHOW1','sourceRepo':'phoriaverse/lbe-client-dmx','verifiedAgainstCommit':'4e95dac4393a1c66a4fbd344ebccac7ad39cda33','fps':m['fps'],'sampleBits':16,'transfer':2.2,'fixtureOutputBits':8,'clientMaster':1,'clientCap':.5,'shows':records},indent=2)+'\n')
 print('Exported',len(records),'native shows; introduction',records[0]['duration'],'seconds')
if __name__=='__main__':main()
