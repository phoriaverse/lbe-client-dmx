"""TSOM's video goes black during live 3D: sample the completed scene reference there."""
from pathlib import Path
import subprocess,json
import numpy as np
from analyze import FF,smooth
ROOT=Path(__file__).resolve().parents[1]

def main():
 source=ROOT/'preview/tsom-context.mp4'
 raw=subprocess.check_output([FF,'-v','error','-threads','2','-i',str(source),'-vf','fps=10,scale=96:54','-f','rawvideo','-pix_fmt','rgb24','-'])
 frames=np.frombuffer(raw,np.uint8).reshape(-1,54,96,3).astype(np.float32)/255
 linear=np.where(frames<=.04045,frames/12.92,((frames+.055)/1.055)**2.4)
 # Upper scene excludes the filmed seated subject, chair and physical floor.
 palette=[];prev=np.tile([.85,.84,.8],(3,1))
 for frame in linear:
  colors=[]
  for c in range(3):
   region=frame[:28,c*32:(c+1)*32]
   luminance=region@np.array([.2126,.7152,.0722]);weight=np.sqrt(luminance)*np.clip((luminance-.008)/.04,0,1)
   colour=(region*weight[...,None]).sum(axis=(0,1))/max(float(weight.sum()),1e-6)
   colors.append(prev[c] if colour.max()<.008 else colour/max(float(colour.max()),.05))
  prev=np.asarray(colors);palette.append(prev.copy())
 arrays=dict(np.load(ROOT/'analysis/tsom.npz'));arrays['scenePalette']=smooth(np.asarray(palette),10,.35,.6)
 np.savez_compressed(ROOT/'analysis/tsom.npz',**arrays)
 (ROOT/'analysis/tsom-scene-palette.json').write_text(json.dumps({'source':'preview/tsom-context.mp4','sourceProvenance':'analysis/tsom-provenance.json','sampleFps':10,'sampleRegion':'Upper 28 of 54 rows, three horizontal sectors; seated subject and floor excluded','usage':'Only authored live NeuralNetwork windows. Colours follow the actual completed render, including silver and warm white.','limits':'Artistic estimate from an SDR scene reference, not a calibrated live renderer probe.'},indent=2)+'\n')
 print('Sampled TSOM live scene colours',flush=True)

if __name__=='__main__':main()
