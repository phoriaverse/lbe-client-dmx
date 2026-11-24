// The sequence: what plays for one experience. Which video is on which surface, how lights sample
// them, the bake settings, and the Bake button. (The timeline arrives with milestone 4.)

import { Alert, Button, Card, Divider, Group, Progress, SegmentedControl, Select, Stack, Switch, Text, TextInput } from "@mantine/core";
import { useState, useSyncExternalStore } from "react";
import { isSurface } from "../model/rig";
import { frameCountOf, type Sampling, setSurfaceUse } from "../model/sequence";
import { bakeSequence, bakeStatus, createSequence, deleteSequence, loadMedia, mediaList, openSequence, sequenceList } from "./api";
import { NumField } from "./fields";
import { useLive } from "./OtherPanels";
import { preview } from "./preview";
import { editSeq, notify, seqStore, setUi, useRig, useSeq, useSeqDirty, useUi } from "./state";

export const formatTime = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
};

export function SequencePanel() {
  const rig = useRig();
  const seq = useSeq();
  const ui = useUi();
  const dirty = useSeqDirty();
  const list = useSyncExternalStore(sequenceList.subscribe, sequenceList.get);
  const media = useSyncExternalStore(mediaList.subscribe, mediaList.get);
  const bake = useSyncExternalStore(bakeStatus.subscribe, bakeStatus.get);
  const snap = useSyncExternalStore(preview.subscribe, () => preview.snapshot);
  const liveSnap = useLive();
  const [baking, setBaking] = useState(false);

  const surfaces = rig.nodes.filter(isSurface);
  const options = [{ value: "", label: "None" }, ...media.videos.map((v) => ({ value: v.name, label: `${v.name} — ${v.source}/` }))];
  const onDisk = list.some((s) => s.id === seq.id);
  const sequences = [...list.map((s) => ({ value: s.id, label: s.id === seq.id ? seq.name : s.name })), ...(onDisk ? [] : [{ value: seq.id, label: `${seq.name} (not saved yet)` }])];
  const frames = frameCountOf(snap.durationMs, seq.fps);
  const cap = liveSnap.status ? liveSnap.status.cap * liveSnap.status.master : 0.5;

  const leave = () => !(seqStore.dirty && !confirm(`Discard unsaved changes to “${seq.name}”?`));
  const run = async () => {
    setBaking(true);
    try {
      const status = await bakeSequence();
      if (status.state === "error") notify(`Bake failed: ${status.error}`, "error");
      else if (status.result) notify(`Baked ${status.result.relative}`);
    } catch (err) {
      notify(`Bake failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setBaking(false);
    }
  };

  return (
    <Stack p="sm" gap="sm">
      <Group gap={6} align="end" wrap="nowrap">
        <Select
          size="xs"
          label="Sequence"
          style={{ flex: 1 }}
          data={sequences}
          value={seq.id}
          allowDeselect={false}
          onChange={(v) => v && v !== seq.id && leave() && openSequence(v).catch((err) => notify(String(err.message ?? err), "error"))}
        />
        <Button
          size="xs"
          variant="light"
          onClick={() => {
            const name = leave() ? prompt("Name the new sequence — usually the experience it is for", "Second Nature") : null;
            if (name?.trim()) createSequence(name.trim());
          }}
        >
          New…
        </Button>
        <Button
          size="xs"
          variant="subtle"
          color="red"
          disabled={!onDisk}
          onClick={() => confirm(`Delete the sequence “${seq.name}” from disk? Its baked .show is left alone.`) && deleteSequence(seq.id).catch((err) => notify(String(err.message ?? err), "error"))}
        >
          Delete
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        project/sequences/{seq.id}.json{dirty ? " — unsaved (⌘S)" : ""}
      </Text>

      <TextInput size="xs" label="Name" value={seq.name} onChange={(e) => editSeq("Rename sequence", (d) => void (d.name = e.currentTarget.value), "seq.name")} />
      <TextInput
        size="xs"
        label="Experience"
        description="Names the editor’s bake and is saved in its header."
        value={seq.experience}
        onChange={(e) => editSeq("Sequence experience", (d) => void (d.experience = e.currentTarget.value), "seq.experience")}
      />

      <Divider label="Videos on surfaces" labelPosition="left" />
      {!surfaces.length && (
        <Text size="xs" c="dimmed">
          The rig has no video surfaces yet. Add one with <b>+ Surface</b> above the hierarchy, place it over the lights, then choose its video here.
        </Text>
      )}
      {surfaces.map((node) => {
        const use = seq.surfaces[node.id];
        const state = use?.video ? snap.videos[use.video] : undefined;
        const missing = !!use?.video && !media.videos.some((v) => v.name === use.video);
        return (
          <Group key={node.id} gap={6} align="end" wrap="nowrap">
            <Select
              size="xs"
              style={{ flex: 1 }}
              label={
                <a href="#" onClick={(e) => (e.preventDefault(), setUi({ selection: [node.id], tab: "inspector" }))}>
                  {node.name} ({node.surface.projection})
                </a>
              }
              data={missing ? [...options, { value: use!.video!, label: `${use!.video} (missing)` }] : options}
              value={use?.video ?? ""}
              allowDeselect={false}
              searchable
              error={missing ? "not in dmx-editor/media/ or media/" : state?.error || undefined}
              onChange={(v) => editSeq("Surface video", (d) => setSurfaceUse(d, node.id, { video: v || null }))}
            />
            <NumField label="Gain" min={0} max={16} step={0.05} w={64} value={use?.gain ?? 1} onCommit={(v) => editSeq("Surface gain", (d) => setSurfaceUse(d, node.id, { gain: v }))} />
          </Group>
        );
      })}
      <Group gap={6}>
        <Button size="compact-xs" variant="subtle" onClick={() => loadMedia().catch(() => {})}>
          Rescan videos
        </Button>
        <Text size="xs" c="dimmed">
          {media.videos.length} in dmx-editor/media/ and media/
        </Text>
      </Group>

      <Divider label="Sampling" labelPosition="left" />
      <SegmentedControl
        size="xs"
        fullWidth
        value={seq.sampling}
        onChange={(v) => editSeq("Sampling", (d) => void (d.sampling = v as Sampling))}
        data={[
          { value: "projection", label: "Projection" },
          { value: "nearest", label: "Nearest surface" },
          ...(seq.unison ? [{ value: "unison", label: "Unison" }] : []),
        ]}
      />
      <Text size="xs" c="dimmed">
        {seq.sampling === "unison"
          ? "All tubes share one colour and intensity, following the analysed video/audio track. Position does not affect the lighting."
          : seq.sampling === "projection"
          ? "Each surface lights the pixels its projection covers; overlapping surfaces add, and uncovered pixels stay dark."
          : "Every pixel takes the closest point of whichever surface with a video is nearest to it. Nothing is left dark."}
      </Text>
      {seq.sampling === "unison" && seq.unison && (
        <Card p="xs" withBorder>
          <Group gap={8} wrap="nowrap">
            <div style={{ width: 24, height: 24, flexShrink: 0, borderRadius: 4, background: `rgb(${seq.unison.color.join(",")})` }} />
            <Text size="xs">{seq.unison.description}</Text>
          </Group>
          <Text size="xs" c="dimmed" mt={6}>Source starts at {formatTime(seq.unison.sourceStartMs)}. The waiting section is retained in the original video.</Text>
        </Card>
      )}
      <Group gap={6} align="end" wrap="nowrap">
        <NumField label="Level" min={0} max={1} step={0.05} w={80} value={seq.level} onCommit={(v) => editSeq("Sequence level", (d) => void (d.level = v))} />
        <NumField label="Sample size (px)" integer min={8} max={2048} step={16} w={110} value={seq.sampleSize} onCommit={(v) => editSeq("Sample size", (d) => void (d.sampleSize = v))} />
      </Group>
      <Text size="xs" c="dimmed">
        Level is baked in, under the client's dimmers: peak reaches the tubes at up to {Math.round(seq.level * 100)}% × {Math.round(cap * 100)}% = <b>{(seq.level * cap * 100).toFixed(1)}%</b>. The fixture preview includes these levels. Sample size is the long edge
        videos are scaled to first; smaller is softer.
      </Text>

      <Divider label="Length" labelPosition="left" />
      <Group gap={6} align="end" wrap="nowrap">
        <Switch size="xs" label="Follow the video" checked={seq.durationMs === null} onChange={(e) => editSeq("Sequence length", (d) => void (d.durationMs = e.currentTarget.checked ? null : Math.round(snap.durationMs) || 60_000))} />
        {seq.durationMs !== null && <NumField label="Seconds" min={0.1} step={1} decimals={3} w={100} value={seq.durationMs / 1000} onCommit={(v) => editSeq("Sequence length", (d) => void (d.durationMs = Math.round(v * 1000)))} />}
      </Group>
      <Text size="xs" c="dimmed">
        {snap.durationMs > 0 ? `${formatTime(snap.durationMs)} (${(snap.durationMs / 1000).toFixed(3)} s) — ${frames} frames at ${seq.fps} fps` : "Unknown until a surface has a video that loads."}
      </Text>

      <Divider label="Bake" labelPosition="left" />
      <Group gap={6} align="end" wrap="nowrap">
        <NumField label="fps" min={1} max={240} step={1} decimals={3} w={70} value={seq.fps} onCommit={(v) => editSeq("Bake fps", (d) => void (d.fps = v))} />
        <Select size="xs" label="Bits" w={80} allowDeselect={false} data={["8", "16"]} value={String(seq.bits)} onChange={(v) => v && editSeq("Bake bits", (d) => void (d.bits = Number(v) as 8 | 16))} />
        <Button size="xs" loading={baking || bake.state === "running"} disabled={!bake.ffmpeg} onClick={run}>
          Bake .show
        </Button>
      </Group>
      {!bake.ffmpeg && (
        <Alert color="orange" p="xs">
          <Text size="xs">
            ffmpeg is not installed, and the bake decodes video with it. Run <code>brew install ffmpeg</code>, then reload this page.
          </Text>
        </Alert>
      )}
      {bake.state === "running" && <Progress value={bake.total ? (100 * (bake.done ?? 0)) / bake.total : 0} size="sm" animated />}
      {bake.state === "error" && (
        <Alert color="red" p="xs">
          <Text size="xs">{bake.error}</Text>
        </Alert>
      )}
      {bake.state === "done" && bake.result && (
        <Card p="xs" withBorder>
          <Text size="xs">
            <b>{bake.result.relative}</b> — “{bake.result.experience}”, {formatTime(bake.result.durationMs)}, {bake.result.frameCount} frames @ {bake.result.fps} fps {bake.result.bits}-bit, {bake.result.pixelCount} px,{" "}
            {(bake.result.sizeBytes / 1e6).toFixed(1)} MB, in {(bake.result.tookMs / 1000).toFixed(1)} s
          </Text>
          {bake.result.warnings.map((w) => (
            <Text key={w} size="xs" c="orange">
              {w}
            </Text>
          ))}
        </Card>
      )}
      <Text size="xs" c="dimmed">
        Bakes into {bake.showsDir}/. For journey playback, copy the file to <code>dmx-client/media/</code> under its state name, for example <code>second nature.show</code>.
      </Text>

      <Divider label="Live" labelPosition="left" />
      <Switch size="xs" label="Send the preview to the tubes" checked={ui.liveOutput} onChange={(e) => setUi({ liveOutput: e.currentTarget.checked })} />
      <Text size="xs" c="dimmed">
        {liveSnap.state !== "connected" ? "Not connected to a lighting-client (Live tab) — previewing in the viewport only." : liveSnap.status?.owner === "session" ? "A live LBE session is running on the client; it wins until it ends." : "Streams the playhead to the lighting-client, at this sequence's level."}
      </Text>
    </Stack>
  );
}
