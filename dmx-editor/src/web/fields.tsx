// Numeric fields that edit the document without fighting the person typing.
//
// A controlled field bound straight to the document would snap "1." back to "1" mid-keystroke. These
// keep a local draft while focused and commit on Enter, blur or an arrow-key step; when not focused
// they show the document's value, so a gizmo drag updates them live.

import { Group, NumberInput, Text } from "@mantine/core";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { Vec3 } from "../model/transform";

interface NumFieldProps {
  value: number;
  onCommit: (v: number) => void;
  label?: string;
  step?: number;
  min?: number;
  max?: number;
  decimals?: number;
  integer?: boolean;
  w?: number | string;
  disabled?: boolean;
  suffix?: string;
  leftSection?: React.ReactNode;
  /** The selection disagrees on this value: show "—" and commit only what is typed. */
  mixed?: boolean;
}

export function NumField({ value, onCommit, label, step = 0.01, min, max, decimals = 4, integer, w, disabled, suffix, leftSection, mixed }: NumFieldProps) {
  const shown = mixed ? "" : value;
  const [draft, setDraft] = useState<string | number>(shown);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(shown);
  }, [shown]);

  const commit = (raw: string | number) => {
    if (mixed && raw === "") return;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (raw === "" || !Number.isFinite(n)) return setDraft(shown);
    let v = integer ? Math.round(n) : n;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    if (v !== value || mixed) onCommit(v);
    setDraft(v);
  };

  return (
    <NumberInput
      size="xs"
      label={label}
      value={draft}
      placeholder={mixed ? "—" : undefined}
      step={step}
      min={min}
      max={max}
      decimalScale={integer ? 0 : decimals}
      allowDecimal={!integer}
      suffix={suffix}
      w={w}
      disabled={disabled}
      hideControls
      leftSection={leftSection}
      leftSectionWidth={leftSection ? 18 : undefined}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        commit(draft);
      }}
      onChange={setDraft}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(draft);
        if (e.key === "Escape") {
          setDraft(shown);
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const k = e.shiftKey ? 10 : 1;
          commit(Number(draft) + (e.key === "ArrowUp" ? step : -step) * k);
        }
      }}
    />
  );
}

export function Vec3Field({
  label,
  value,
  onCommit,
  step,
  decimals,
  mixed,
}: {
  label: string;
  value: Vec3;
  /** The whole vector with one axis changed, and which axis it was. */
  onCommit: (v: Vec3, axis: number) => void;
  step?: number;
  decimals?: number;
  mixed?: [boolean, boolean, boolean];
}) {
  const axes = ["X", "Y", "Z"] as const;
  return (
    <div>
      <Text size="xs" c="dimmed" mb={2}>
        {label}
      </Text>
      <Group gap={4} grow wrap="nowrap">
        {axes.map((axis, i) => (
          <NumField
            key={axis}
            value={value[i]!}
            step={step}
            decimals={decimals}
            mixed={mixed?.[i]}
            leftSection={<span className={`axis axis-${axis.toLowerCase()}`}>{axis}</span>}
            onCommit={(v) => {
              const next: Vec3 = [...value];
              next[i] = v;
              onCommit(next, i);
            }}
            w="100%"
          />
        ))}
      </Group>
    </div>
  );
}
