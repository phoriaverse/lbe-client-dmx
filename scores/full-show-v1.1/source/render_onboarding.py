"""Render the real captioned instructions against exact quantized DMX output."""
from pathlib import Path
import json, os, shutil, subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
FF = os.environ.get('FFMPEG') or shutil.which('ffmpeg') or '/Users/trentino-claw/.local/bin/ffmpeg'
FONT = os.environ.get('PREVIEW_FONT', '/System/Library/Fonts/Supplemental/Arial.ttf')
F = ImageFont.truetype(FONT, 21)
S = ImageFont.truetype(FONT, 15)
H = ImageFont.truetype(FONT, 29)
LUT = np.rint(255 * np.where(np.arange(256) / 255 <= .0031308,
                           12.92 * np.arange(256) / 255,
                           1.055 * (np.arange(256) / 255) ** (1 / 2.4) - .055)).astype(np.uint8)

def draw_frame(t, video, frame):
    im = Image.new('RGB', (1280, 720), '#0c1018')
    d = ImageDraw.Draw(im)
    d.text((24, 17), 'SOUND SPACE  /  Onboarding · Gentle White Waves', font=H, fill='#f0f2f7')
    d.text((1100, 24), f'{t:05.2f} / 30s', font=F, fill='#c4d1df')
    im.paste(video, (24, 72))
    d = ImageDraw.Draw(im)
    d.text((24, 478), 'Original captioned instructions · silent source · shared start at 0:00', font=S, fill='#a7b4c5')
    # Room positions retain the installed numbering; screen faces tubes 3–2–1.
    x, y, w, h = 858, 75, 394, 375
    d.rounded_rectangle((x, y, x+w, y+h), radius=16, outline='#334153', width=2)
    d.line((x+60, y+18, x+w-60, y+18), fill='#728296', width=3)
    d.text((x+w/2-28, y+27), 'SCREEN', font=S, fill='#a7b4c5')
    positions = json.loads((ROOT/'hardware/positions.json').read_text())['xzMetres']
    for i, (px, pz) in enumerate(positions):
        tx = x + 40 + (px - 5.9) / 5.8 * (w-80)
        ty = y + 90 + (pz - 1.3) / 5.75 * (h-150)
        color = tuple(int(c) for c in LUT[np.rint(frame[i].mean(axis=0)).astype(np.uint8)])
        d.ellipse((tx-16, ty-16, tx+16, ty+16), fill=color, outline='#5d6c80')
        d.text((tx-4, ty+20), str(i+1), font=S, fill='#a7b4c5')
    d.text((x+130, y+h/2), 'LISTENER', font=S, fill='#748397')
    d.text((858, 462), 'Slow 12s circulation · neutral RGB white', font=S, fill='#a7b4c5')
    d.text((858, 484), 'Master 1.0 / cap 0.5 · peak DMX 22/255', font=S, fill='#a7b4c5')
    d.text((24, 516), 'Eight tubes, 16 independently driven pixels each · bottom → top', font=F, fill='#e2e7ee')
    for tube in range(8):
        tx = 82 + tube * 160
        d.rounded_rectangle((tx-15, 553, tx+15, 666), radius=9, fill='#273242')
        for p in range(16):
            py = 662 - (p+1)*6.5
            color = tuple(int(c) for c in LUT[frame[tube, p]])
            d.rectangle((tx-9, py, tx+9, py+5.5), fill=color)
        d.text((tx-4, 670), str(tube+1), font=S, fill='#a7b4c5')
    d.text((24, 698), '40 Hz lighting / 20 fps review · sRGB preview of native DMX values · simulated fixtures, not measured room brightness', font=S, fill='#748397')
    return im

def main():
    cfg = json.loads((ROOT/'onboarding-settings.json').read_text())
    score = np.frombuffer((ROOT/'preview/onboarding.dmx8').read_bytes(), np.uint8).reshape(-1, 8, 16, 3)
    source = ROOT/'reference'/cfg['sourceVideo']
    output = ROOT/'preview/Onboarding-Gentle-White-Waves.mp4'
    dec = subprocess.Popen([FF, '-v', 'error', '-threads', '2', '-i', str(source), '-vf', 'fps=20,scale=800:400', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
    enc = subprocess.Popen([FF, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '1280x720', '-r', '20', '-i', '-', '-c:v', 'libx264', '-threads', '2', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(output)], stdin=subprocess.PIPE)
    count = 0
    while True:
        raw = dec.stdout.read(800*400*3)
        if not raw:
            break
        assert len(raw) == 800*400*3
        t = count / 20
        frame = score[min(int(t*cfg['fps']), len(score)-1)]
        im = draw_frame(t, Image.frombytes('RGB', (800, 400), raw), frame)
        enc.stdin.write(im.tobytes())
        if count in [100, 300, 500]:
            im.save(ROOT/'preview'/f'review-{count//20:02}.jpg', quality=94)
        count += 1
    dec.stdout.close()
    enc.stdin.close()
    assert dec.wait() == 0 and enc.wait() == 0
    assert count == round(cfg['durationSeconds']*20), (count, cfg['durationSeconds'])
    print('Rendered', count, 'frames:', output)

if __name__ == '__main__':
    main()
