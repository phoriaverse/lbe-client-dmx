import { Badge, Button, Group, SegmentedControl, Tabs, Text, TextInput, Tooltip } from "@mantine/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { deleteNodes, duplicateNode, setTransform } from "../model/ops";
import { rigOrder } from "../model/patch";
import { loadMedia, loadRig, loadSequences, mediaList, refreshBake, rigPath, saveAll } from "./api";
import { Hierarchy } from "./Hierarchy";
import { Inspector } from "./Inspector";
import { live, WALK_STEP_MS, walkOrder } from "./live";
import { preview } from "./preview";
import { SequencePanel } from "./SequencePanel";
import { Transport } from "./Transport";
import { LivePanel, ProfilesPanel, RoomPanel, useLive } from "./OtherPanels";
import { PatchPanel } from "./PatchPanel";
import { SceneView } from "./scene";
import { activeOf, edit, getUi, notify, rigStore, seqStore, setUi, useRig, useRigDirty, useSeq, useSeqDirty, useUi } from "./state";
import { NumField } from "./fields";

export function App() {
  const rig = useRig();
  const ui = useUi();
  const seq = useSeq();
  const rigDirty = useRigDirty();
  const dirty = useSeqDirty() || rigDirty;
  const snap = useLive();
  const viewportRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneView | null>(null);
  const [roomStatus, setRoomStatus] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Load once; connect to the client if we were connected last time ────────
  useEffect(() => {
    loadRig().catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
    loadSequences().catch((err) => notify(`Sequences could not be loaded: ${err instanceof Error ? err.message : err}`, "error"));
    const offMedia = mediaList.subscribe(() => preview.setMedia(mediaList.get().videos));
    loadMedia().catch(() => {});
    refreshBake().catch(() => {});
    if (getUi().liveUrl) live.connect(getUi().liveUrl);
    const warn = (e: BeforeUnloadEvent) => {
      if (rigStore.dirty || seqStore.dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      offMedia();
      window.removeEventListener("beforeunload", warn);
    };
  }, []);

  // ── Viewport ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const view = new SceneView(viewportRef.current!, {
      onSelect: (ids) => setUi({ selection: ids }),
      onTransforms: (changes) => {
        const nodes = rigStore.get().nodes;
        const what = changes.length === 1 ? nodes.find((n) => n.id === changes[0]!.id)?.name ?? "node" : `${changes.length} objects`;
        const verb = { translate: "Move", rotate: "Rotate", scale: "Scale", view: "Move" }[getUi().tool];
        edit(`${verb} ${what}`, (d) => {
          for (const c of changes) setTransform(d, c.id, c.transform);
        });
      },
    });
    view.onRoomStatus(setRoomStatus);
    sceneRef.current = view;
    view.setVideoSource((id) => preview.videoFor(id));
    const off = preview.onFrame((frame, exposure) => view.setFrame(frame, exposure));
    return () => {
      off();
      view.dispose();
      sceneRef.current = null;
    };
  }, []);

  const videos = useSyncExternalStore(preview.subscribe, () => Object.keys(preview.snapshot.videos).join("|"));
  useEffect(() => {
    // The preview first: the viewport asks it which <video> each surface shows.
    preview.setDocs(rig, seq);
    sceneRef.current?.sync(rig, { selection: ui.selection, tool: ui.tool, space: ui.space, pivot: ui.pivot, snapMove: ui.snapMove, snapRotate: ui.snapRotate, showSurfaces: ui.showSurfaces });
  }, [rig, seq, videos, ui.selection, ui.tool, ui.space, ui.pivot, ui.snapMove, ui.snapRotate, ui.showSurfaces]);

  useEffect(() => preview.setLiveOutput(ui.liveOutput), [ui.liveOutput]);
  useEffect(() => preview.setSound(ui.sound), [ui.sound]);

  // Nodes that no longer exist (deleted, or a different rig loaded) drop out of the selection.
  useEffect(() => {
    const kept = ui.selection.filter((id) => rig.nodes.some((n) => n.id === id));
    if (kept.length !== ui.selection.length) setUi({ selection: kept });
  }, [rig, ui.selection]);

  // ── Identify follows the selection ─────────────────────────────────────────
  useEffect(() => {
    preview.identify(rig, ui.identify ? ui.selection : null);
  }, [rig, ui.identify, ui.selection]);

  // Walk: step the selection through the chain, one tube every couple of seconds.
  useEffect(() => {
    if (!ui.walk) return;
    const step = () => {
      const order = walkOrder(rigStore.get());
      if (!order.length) return setUi({ walk: false });
      const i = order.indexOf(activeOf(getUi().selection) ?? "");
      setUi({ selection: [order[(i + 1) % order.length]!], identify: true });
    };
    step();
    const timer = setInterval(step, WALK_STEP_MS);
    return () => clearInterval(timer);
  }, [ui.walk]);

  // ── Save ───────────────────────────────────────────────────────────────────
  const save = async () => {
    setSaving(true);
    try {
      const saved = await saveAll();
      notify(saved.length ? `Saved ${saved.join(" and ")}` : "Nothing to save");
    } catch (err) {
      notify(`Save failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setSaving(false);
    }
  };
  const revert = async () => {
    if (dirty && !confirm("Discard unsaved changes and reload the rig and sequence from disk?")) return;
    try {
      await loadRig();
      await loadSequences();
      await loadMedia();
      setLoadError(null);
      notify("Reloaded from disk");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      notify(`Reload failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  };

  // ── Keyboard: Unity's Scene View hotkeys ───────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "s") {
        e.preventDefault();
        void save();
        return;
      }
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable=true]")) return;
      // While RMB-flying the camera owns the keyboard (it swallows W/A/S/D/Q/E itself; this is the backstop).
      if (sceneRef.current?.flying) return;
      const sel = getUi().selection;
      const key = e.key.toLowerCase();

      if (mod && key === "d" && sel.length) {
        e.preventDefault();
        const copies: string[] = [];
        if (edit("Duplicate", (d) => sel.forEach((id) => { const c = duplicateNode(d, id); if (c) copies.push(c); }))) setUi({ selection: copies });
        return;
      }
      if (mod && key === "a") {
        e.preventDefault();
        setUi({ selection: rigStore.get().nodes.map((n) => n.id) });
        return;
      }
      // Delete: the Delete key, or ⌘⌫ — as on macOS Unity. (Plain Backspace deletes nothing there either.)
      if ((key === "delete" || (mod && key === "backspace")) && sel.length) {
        e.preventDefault();
        if (edit(sel.length === 1 ? "Delete" : `Delete ${sel.length} objects`, (d) => deleteNodes(d, sel))) setUi({ selection: [] });
        return;
      }
      if (e.altKey && e.shiftKey && e.code === "KeyA") {
        setUi({ selection: [] }); // Edit ▸ Deselect All
        return;
      }
      if (mod || e.altKey) return;
      switch (e.code) {
        case "KeyQ":
          setUi({ tool: "view" });
          break;
        case "KeyW":
          setUi({ tool: "translate" });
          break;
        case "KeyE":
          setUi({ tool: "rotate" });
          break;
        case "KeyR":
          setUi({ tool: "scale" });
          break;
        case "KeyZ":
          setUi({ pivot: getUi().pivot === "pivot" ? "center" : "pivot" });
          break;
        case "KeyX":
          setUi({ space: getUi().space === "local" ? "world" : "local" });
          break;
        case "KeyF":
          sceneRef.current?.frameSelection();
          break;
        case "Space":
          if (el.closest("button, [role=switch], [role=slider]")) break; // Space already presses the focused control
          e.preventDefault();
          preview.toggle();
          break;
        case "KeyI":
          setUi({ identify: !getUi().identify, walk: false });
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Notices fade ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!ui.notice) return;
    const t = setTimeout(() => setUi({ notice: null }), ui.notice.kind === "error" ? 8000 : 2500);
    return () => clearTimeout(t);
  }, [ui.notice]);

  const lights = rigOrder(rig);
  const pixels = lights.reduce((n, s) => n + s.count, 0);
  const owner = snap.status?.owner;

  return (
    <div className="app">
      <header className="bar">
        <Text fw={700} size="sm">
          Lighting Editor
        </Text>
        <TextInput size="xs" variant="unstyled" className="rig-name" value={rig.name} onChange={(e) => edit("Rename rig", (d) => void (d.name = e.currentTarget.value), "rig.name")} />
        <Text size="xs" c="dimmed">
          {lights.length} lights · {pixels} px · {rigPath} · {seq.name}
        </Text>
        <div style={{ flex: 1 }} />
        <Tooltip label={snap.state === "connected" ? `Connected to ${snap.url}` : snap.error ?? "Not connected to a lighting-client"}>
          <Badge
            variant="dot"
            color={snap.state !== "connected" ? "gray" : owner === "session" ? "red" : owner === "preview" ? "orange" : "teal"}
            style={{ cursor: "pointer" }}
            onClick={() => setUi({ tab: "live" })}
          >
            {snap.state !== "connected" ? "client: off" : owner === "session" ? "live session — preview ignored" : owner === "preview" ? "previewing" : `client: ${owner ?? "connected"}`}
          </Badge>
        </Tooltip>
        <Button size="compact-sm" variant={ui.identify ? "filled" : "default"} color={ui.identify ? "orange" : undefined} onClick={() => setUi({ identify: !ui.identify, walk: false })}>
          Identify
        </Button>
        <Button size="compact-sm" variant="default" onClick={revert}>
          Reload
        </Button>
        <Button size="compact-sm" loading={saving} variant={dirty ? "filled" : "default"} onClick={save}>
          {dirty ? "Save ●" : "Saved"}
        </Button>
      </header>

      <aside className="left">
        <Hierarchy place={() => sceneRef.current} />
      </aside>

      <main className="viewport-wrap">
        <div ref={viewportRef} className="viewport" />
        <div className="viewport-tools">
          <SegmentedControl
            size="xs"
            value={ui.tool}
            onChange={(v) => setUi({ tool: v as typeof ui.tool })}
            data={[
              { value: "view", label: "✋ Q" },
              { value: "translate", label: "Move W" },
              { value: "rotate", label: "Rotate E" },
              { value: "scale", label: "Scale R" },
            ]}
          />
          <Tooltip label="Z — gizmo at the active object's pivot, or the selection's centre">
            <Button size="compact-xs" variant="default" onClick={() => setUi({ pivot: ui.pivot === "pivot" ? "center" : "pivot" })}>
              {ui.pivot === "pivot" ? "Pivot" : "Center"}
            </Button>
          </Tooltip>
          <Tooltip label="X — gizmo axes: the active object's, or the world's">
            <Button size="compact-xs" variant="default" onClick={() => setUi({ space: ui.space === "local" ? "world" : "local" })}>
              {ui.space === "local" ? "Local" : "Global"}
            </Button>
          </Tooltip>
          <Tooltip label="Increment snap, applied while ⌘ is held during a drag">
            <Group gap={4} wrap="nowrap">
              <Text size="xs" c="dimmed">
                ⌘ snap
              </Text>
              <NumField w={58} value={ui.snapMove} min={0.001} decimals={3} suffix=" m" onCommit={(v) => setUi({ snapMove: v })} />
              <NumField w={48} value={ui.snapRotate} min={0.1} decimals={1} suffix="°" onCommit={(v) => setUi({ snapRotate: v })} />
            </Group>
          </Tooltip>
        </div>
        <div className="viewport-help">RMB fly · WASD QE · ⇧ fast · ⌥LMB orbit · ⌥RMB zoom · MMB pan · F frame</div>
        {loadError && (
          <div className="load-error">
            <b>The rig file could not be loaded</b> — nothing will be saved over it until this is fixed.
            <br />
            {loadError}
          </div>
        )}
        {ui.notice && <div className={`notice ${ui.notice.kind}`}>{ui.notice.text}</div>}
        <Transport />
      </main>

      <aside className="right">
        <Tabs value={ui.tab} onChange={(v) => v && setUi({ tab: v })} keepMounted={false} className="tabs">
          <Tabs.List grow>
            <Tabs.Tab value="inspector">Inspector</Tabs.Tab>
            <Tabs.Tab value="patch">Patch</Tabs.Tab>
            <Tabs.Tab value="profiles">Fixtures</Tabs.Tab>
            <Tabs.Tab value="room">Room</Tabs.Tab>
            <Tabs.Tab value="sequence">Sequence</Tabs.Tab>
            <Tabs.Tab value="live">Live</Tabs.Tab>
          </Tabs.List>
          <div className="tab-body">
            <Tabs.Panel value="inspector">
              <Inspector />
            </Tabs.Panel>
            <Tabs.Panel value="patch">
              <PatchPanel />
            </Tabs.Panel>
            <Tabs.Panel value="profiles">
              <ProfilesPanel />
            </Tabs.Panel>
            <Tabs.Panel value="room">
              <RoomPanel roomStatus={roomStatus} />
            </Tabs.Panel>
            <Tabs.Panel value="sequence">
              <SequencePanel />
            </Tabs.Panel>
            <Tabs.Panel value="live">
              <LivePanel />
            </Tabs.Panel>
          </div>
        </Tabs>
      </aside>
    </div>
  );
}
