// The playhead: play / pause, scrub, and the switches that decide where the preview goes.

import { Button, Slider, Switch, Text, Tooltip } from "@mantine/core";
import { useSyncExternalStore } from "react";
import { useLive } from "./OtherPanels";
import { preview } from "./preview";
import { togglePlayback } from "./playback";
import { formatTime } from "./SequencePanel";
import { setUi, useSeq, useUi } from "./state";

export function Transport() {
  const ui = useUi();
  const seq = useSeq();
  const snap = useSyncExternalStore(preview.subscribe, () => preview.snapshot);
  const liveSnap = useLive();
  const known = snap.durationMs > 0;
  const loading = Object.values(snap.videos).some((v) => !v.ready && !v.error);

  return (
    <div className="transport">
      <Tooltip label="Space">
        <Button size="compact-sm" w={64} variant={snap.playing ? "filled" : "default"} disabled={!known} onClick={togglePlayback}>
          {snap.playing ? "Pause" : "Play"}
        </Button>
      </Tooltip>
      <Text size="xs" className="transport-time">
        {formatTime(snap.timeMs)} / {known ? formatTime(snap.durationMs) : "–:––"}
      </Text>
      <Slider className="transport-scrub" size="sm" min={0} max={Math.max(1, snap.durationMs)} step={1000 / seq.fps} value={snap.timeMs} disabled={!known} label={null} onChange={(v) => preview.seek(v)} />
      <Text size="xs" c={ui.identify ? "orange" : "dimmed"} className="transport-name">
        {ui.identify ? `${ui.walk ? "Walk" : "Identify"} active · Play to resume sequence` : loading ? "loading video…" : seq.name}
      </Text>
      <Tooltip label="Estimated fixture brightness, including the sequence level and the connected client's master/cap. This previews the editor sequence; client test patterns are shown on the client page.">
        <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
          Preview ×{Math.round((liveSnap.status ? liveSnap.status.master * liveSnap.status.cap : 1) * 100)}%{liveSnap.status ? "" : " (offline)"}
        </Text>
      </Tooltip>
      <Switch size="xs" label="Sound" checked={ui.sound} onChange={(e) => setUi({ sound: e.currentTarget.checked })} />
      <Switch size="xs" label="Surfaces" checked={ui.showSurfaces} onChange={(e) => setUi({ showSurfaces: e.currentTarget.checked })} />
      <Tooltip label={liveSnap.state === "connected" ? "Send the preview to the tubes through the lighting-client" : "Not connected to a lighting-client (Live tab)"}>
        <div>
          <Switch size="xs" color="orange" label="Live" checked={ui.liveOutput} onChange={(e) => setUi({ liveOutput: e.currentTarget.checked })} />
        </div>
      </Tooltip>
    </div>
  );
}
