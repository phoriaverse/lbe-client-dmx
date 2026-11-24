// Fixture profiles, the room backdrop, and the live link to lighting-client.

import { Alert, Badge, Button, Card, FileButton, Group, Select, Slider, Stack, Switch, Text, TextInput, Tooltip } from "@mantine/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { COLOUR_ORDERS, type ColourOrder } from "../../../dmx-client/src/shared/patch";
import { addProfile, deleteProfile, updateGateway, updateProfile, updateRoom } from "../model/ops";
import { listModels, uploadModel } from "./api";
import { NumField, Vec3Field } from "./fields";
import { live } from "./live";
import { edit, notify, setUi, useRig, useUi } from "./state";

// ── Profiles ─────────────────────────────────────────────────────────────────

export function ProfilesPanel() {
  const rig = useRig();
  return (
    <Stack p="sm" gap="sm">
      <Text size="xs" c="dimmed">
        A profile is a fixture type. Every light points at one; change it here and every tube of that type follows.
      </Text>
      {rig.profiles.map((p) => {
        const users = rig.nodes.filter((n) => n.light?.profile === p.id).length;
        const set = (label: string, patch: Parameters<typeof updateProfile>[2], coalesce?: string) => edit(label, (d) => updateProfile(d, p.id, patch), coalesce);
        return (
          <Card key={p.id} p="xs" withBorder>
            <Group gap={6} align="end" wrap="nowrap">
              <TextInput size="xs" label="Name" value={p.name} style={{ flex: 1 }} onChange={(e) => set("Rename profile", { name: e.currentTarget.value }, `${p.id}.name`)} />
              <Badge variant="light" color="gray">
                {users} in use
              </Badge>
            </Group>
            <Group gap={6} mt={6} wrap="nowrap" align="end">
              <NumField label="Pixels" integer min={1} max={2048} w={70} value={p.pixels} onCommit={(v) => set("Profile pixels", { pixels: v })} />
              <NumField label="Length (m)" min={0.001} w={84} value={p.length} onCommit={(v) => set("Profile length", { length: v })} />
              <Select size="xs" label="Order" w={84} allowDeselect={false} data={COLOUR_ORDERS as unknown as string[]} value={p.order} onChange={(v) => v && set("Profile colour order", { order: v as ColourOrder })} />
              <NumField label="Gamma" min={0.1} max={5} step={0.1} w={64} value={p.gamma} onCommit={(v) => set("Profile gamma", { gamma: v })} />
            </Group>
            <Group gap={6} mt={6}>
              <Button size="compact-xs" variant="subtle" onClick={() => edit("Duplicate profile", (d) => void addProfile(d, p))}>
                Duplicate
              </Button>
              <Tooltip label={users ? "Lights use it" : "Remove"}>
                <Button size="compact-xs" variant="subtle" color="red" disabled={users > 0} onClick={() => edit("Remove profile", (d) => deleteProfile(d, p.id))}>
                  Remove
                </Button>
              </Tooltip>
            </Group>
          </Card>
        );
      })}
      <Button size="xs" variant="light" onClick={() => edit("Add profile", (d) => void addProfile(d))}>
        + Profile
      </Button>
      <Text size="xs" c="dimmed">
        Pixels run along the fixture's local X, pixel 0 (data in) at the red-cone end. Use Gamma 2.2 for Linear DMX (including PavoTubes set to Linear). Gamma 1.0 assumes the fixture itself applies an approximately 2.2 power curve; it does not describe every built-in dimming curve.
      </Text>
    </Stack>
  );
}

// ── Room ─────────────────────────────────────────────────────────────────────

export function RoomPanel({ roomStatus }: { roomStatus: string | null }) {
  const rig = useRig();
  const room = rig.room;
  const [models, setModels] = useState<{ file: string; sizeBytes: number }[]>([]);
  const [uploading, setUploading] = useState(false);
  const refresh = () => listModels().then(setModels).catch(() => {});
  useEffect(() => void refresh(), []);

  const upload = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const path = await uploadModel(file);
      await refresh();
      edit("Room model", (d) => updateRoom(d, { file: path }));
    } catch (err) {
      notify(`Upload failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setUploading(false);
    }
  };

  const options = [{ value: "", label: "None" }, ...models.map((m) => ({ value: m.file, label: `${m.file.replace(/^models\//, "")} (${(m.sizeBytes / 1e6).toFixed(1)} MB)` }))];
  if (room.file && !models.some((m) => m.file === room.file)) options.push({ value: room.file, label: `${room.file} (missing)` });

  return (
    <Stack p="sm" gap="sm">
      <Text size="xs" c="dimmed">
        A GLB of the room, drawn as a backdrop to place lights against. The editor works in metres, Y-up; fix the model up here if it was exported otherwise.
      </Text>
      <Group gap={6} align="end" wrap="nowrap">
        <Select size="xs" label="Model" style={{ flex: 1 }} data={options} value={room.file ?? ""} allowDeselect={false} onChange={(v) => edit("Room model", (d) => updateRoom(d, { file: v || null }))} />
        <FileButton onChange={upload} accept=".glb,.gltf,model/gltf-binary">
          {(props) => (
            <Button size="xs" variant="light" loading={uploading} {...props}>
              Import…
            </Button>
          )}
        </FileButton>
      </Group>
      {roomStatus && (
        <Text size="xs" c={roomStatus.startsWith("could not") ? "red" : "dimmed"}>
          {roomStatus}
        </Text>
      )}

      <div>
        <Text size="xs" c="dimmed" mb={2}>
          Scale to metres
        </Text>
        <Group gap={4} wrap="nowrap">
          <NumField value={room.scale} min={0.00001} decimals={6} w={90} onCommit={(v) => edit("Room scale", (d) => updateRoom(d, { scale: v }))} />
          {[
            ["m", 1],
            ["cm", 0.01],
            ["mm", 0.001],
            ["in", 0.0254],
            ["ft", 0.3048],
          ].map(([label, v]) => (
            <Button key={label} size="compact-xs" variant={room.scale === v ? "filled" : "default"} onClick={() => edit("Room scale", (d) => updateRoom(d, { scale: v as number }))}>
              {label}
            </Button>
          ))}
        </Group>
      </div>
      <Vec3Field label="Rotation (degrees)" value={room.rotation} step={90} decimals={3} onCommit={(v) => edit("Room rotation", (d) => updateRoom(d, { rotation: v }))} />
      <Group gap={4}>
        <Button size="compact-xs" variant="default" onClick={() => edit("Room rotation", (d) => updateRoom(d, { rotation: [-90, 0, 0] }))}>
          Z-up → Y-up
        </Button>
        <Button size="compact-xs" variant="default" onClick={() => edit("Room rotation", (d) => updateRoom(d, { rotation: [0, 0, 0] }))}>
          No rotation
        </Button>
      </Group>
      <Vec3Field label="Offset (metres)" value={room.position} step={0.1} onCommit={(v) => edit("Room offset", (d) => updateRoom(d, { position: v }))} />
      <Switch size="xs" label="Show room" checked={room.visible} onChange={(e) => edit("Room visibility", (d) => updateRoom(d, { visible: e.currentTarget.checked }))} />
      <div>
        <Text size="xs" c="dimmed">
          Opacity
        </Text>
        <Slider size="sm" min={0.05} max={1} step={0.05} value={room.opacity} onChangeEnd={(v) => edit("Room opacity", (d) => updateRoom(d, { opacity: v }))} />
      </div>
    </Stack>
  );
}

// ── Live ─────────────────────────────────────────────────────────────────────

export function useLive() {
  return useSyncExternalStore(live.subscribe, () => live.snapshot);
}

const OWNER_TEXT: Record<string, string> = {
  preview: "this editor",
  session: "a live LBE session — preview is ignored until it ends",
  blackout: "blackout (the client's stop button)",
  pattern: "a test pattern on the client's control page",
  ambient: "the ambient show",
  idle: "nobody (dark)",
};

export function LivePanel() {
  const rig = useRig();
  const ui = useUi();
  const snap = useLive();
  const [address, setAddress] = useState(ui.liveUrl);
  const connected = snap.state === "connected";

  return (
    <Stack p="sm" gap="sm">
      <Text size="xs" c="dimmed">
        The editor streams to a running <b>lighting-client</b>, which sends Art-Net or ENTTEC USB output. A live LBE session takes priority over editor preview.
      </Text>
      <Group gap={6} align="end" wrap="nowrap">
        <TextInput size="xs" label="lighting-client" style={{ flex: 1 }} value={address} onChange={(e) => setAddress(e.currentTarget.value)} placeholder="localhost:8091" />
        {snap.state === "off" ? (
          <Button
            size="xs"
            onClick={() => {
              setUi({ liveUrl: address });
              live.connect(address);
            }}
          >
            Connect
          </Button>
        ) : (
          <Button size="xs" variant="default" onClick={() => live.disconnect()}>
            Disconnect
          </Button>
        )}
      </Group>

      <Card p="xs" withBorder>
        <Group gap={6}>
          <Badge color={connected ? "teal" : snap.state === "off" ? "gray" : "orange"} variant="light">
            {snap.state}
          </Badge>
          {snap.status && (
            <Text size="xs">
              master {Math.round(snap.status.master * 100)}% × cap {Math.round(snap.status.cap * 100)}%
            </Text>
          )}
        </Group>
        {snap.error && snap.state !== "off" && (
          <Text size="xs" c="orange" mt={4}>
            {snap.error} — retrying. Is it running? (<code>cd dmx-client && bun run start</code>)
          </Text>
        )}
        {snap.status && (
          <Text size="xs" mt={4}>
            Driving the fixtures: <b>{OWNER_TEXT[snap.status.owner] ?? snap.status.owner}</b>
            {snap.status.session && ` (${snap.status.session.experience}, ${snap.status.session.phase})`}
          </Text>
        )}
        {snap.status?.output && (
          <Text size="xs" mt={4} c={snap.status.output.error ? "red" : snap.status.output.kind === "preview" ? "orange" : "dimmed"}>
            {snap.status.output.error ?? snap.status.output.label}
          </Text>
        )}
        {snap.status?.problem && (
          <Alert color="red" p="xs" mt={6}>
            <Text size="xs">{snap.status.problem}</Text>
          </Alert>
        )}
      </Card>

      <Card p="xs" withBorder>
        <Text fw={600} size="sm">
          Identify
        </Text>
        <Text size="xs" c="dimmed" mb={6}>
          Pauses the sequence and blinks the selected tubes (a selected rail blinks all its tubes) dim white, pixel 0 red. Play exits Identify or Walk and resumes the sequence. Enable Live to send the sequence to the tubes.
        </Text>
        <Group gap={6}>
          <Button size="xs" color={ui.identify ? "orange" : undefined} variant={ui.identify ? "filled" : "light"} onClick={() => setUi({ identify: !ui.identify, walk: false })}>
            {ui.identify ? "Stop identify" : "Identify (I)"}
          </Button>
          <Button size="xs" variant={ui.walk ? "filled" : "default"} disabled={!rig.chains.some((c) => c.links.length)} onClick={() => setUi({ walk: !ui.walk, identify: !ui.walk })}>
            {ui.walk ? "Stop walk" : "Walk the chain"}
          </Button>
        </Group>
        {ui.identify && !ui.selection.length && (
          <Text size="xs" c="orange" mt={4}>
            Select a tube to identify it.
          </Text>
        )}
        {ui.identify && !connected && (
          <Text size="xs" c="dimmed" mt={4}>
            Not connected — blinking in the viewport only.
          </Text>
        )}
      </Card>

      {(!snap.status?.output || snap.status.output.kind === "artnet") && <Card p="xs" withBorder>
        <Group justify="space-between">
          <Text fw={600} size="sm">
            Scan the fixture network
          </Text>
          <Button size="compact-xs" variant="light" disabled={!connected} loading={snap.polling} onClick={() => live.poll()}>
            Scan
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          ArtPoll, sent by the client. A gateway answering polls is not proof it accepts frames — Identify is.
        </Text>
        {snap.poll && (
          <Stack gap={4} mt={6}>
            {!snap.poll.nodes.length && <Text size="xs">Nothing answered. Is the Mac on the gateway's network (2.0.0.x)?</Text>}
            {snap.poll.nodes.map((n) => (
              <Group key={n.ip} gap={6} wrap="nowrap">
                <Text size="xs" style={{ flex: 1 }}>
                  <b>{n.ip}</b> {n.shortName} — universes {n.universes.join(", ") || "?"}
                </Text>
                {rig.gateways.map((g) =>
                  g.host === n.ip ? (
                    <Badge key={g.id} size="xs" color="teal" variant="light">
                      {g.name || g.id}
                    </Badge>
                  ) : (
                    <Button key={g.id} size="compact-xs" variant="subtle" onClick={() => edit("Gateway address", (d) => updateGateway(d, g.id, { host: n.ip }))}>
                      use for {g.name || g.id}
                    </Button>
                  ),
                )}
              </Group>
            ))}
          </Stack>
        )}
      </Card>}
    </Stack>
  );
}
