"""One-minute A/B taster; the complete, uncut scores remain separate."""
from pathlib import Path
import json,subprocess,os,shutil,tempfile
ROOT=Path(__file__).resolve().parents[1]
FF=os.environ.get('FFMPEG') or shutil.which('ffmpeg') or '/Users/trentino-claw/.local/bin/ffmpeg'

def main():
 tracks=json.loads((ROOT/'preview/index.json').read_text())
 satf=next(t for t in tracks if t['id']=='satf')
 satf_peaks=satf['measuredEnergyJumps']
 starts={'tsom':[36,210],'satf':[max(5,satf_peaks[0]-4),max(5,satf_peaks[-1]-4)],'second-nature':[10,125]}
 cuts=[]
 with tempfile.TemporaryDirectory(prefix='soundspace-dmx-highlights-') as td:
  folder=Path(td)
  for tr in tracks:
   for start in starts[tr['id']]:
    out=folder/f'{len(cuts):02}.mp4'
    subprocess.run([FF,'-v','error','-y','-ss',str(start),'-i',str(ROOT/'preview'/f"{tr['id']}-AB.mp4"),'-t','10','-c:v','libx264','-threads','2','-preset','veryfast','-crf','21','-pix_fmt','yuv420p','-af','afade=t=in:d=0.15,afade=t=out:st=9.8:d=0.2','-c:a','aac','-b:a','128k',str(out)],check=True)
    cuts.append({'track':tr['id'],'sourceStartSeconds':start,'durationSeconds':10,'reelStartSeconds':len(cuts)*10})
  (folder/'concat.txt').write_text(''.join(f"file '{i:02}.mp4'\n" for i in range(len(cuts))))
  subprocess.run([FF,'-v','error','-y','-f','concat','-safe','0','-i',str(folder/'concat.txt'),'-c','copy','-movflags','+faststart',str(ROOT/'preview/START-HERE-AB-Highlights.mp4')],check=True)
 (ROOT/'preview/highlights-cuts.json').write_text(json.dumps({'description':'Edited one-minute taster; full score timecode is visible in each shot. Preview audio has brief edit fades only.','cuts':cuts},indent=2)+'\n')
 print('Rendered one-minute A/B highlights',flush=True)

if __name__=='__main__':main()
