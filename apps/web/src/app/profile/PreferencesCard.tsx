"use client";
import { useEffect, useId, useState } from "react";
import {
  applyPrefs,
  DEFAULT_PREFS,
  readPrefs,
  writePrefs,
  type Prefs,
} from "@/lib/preferences";
import styles from "./profile.module.css";

type Option<V extends string> = { value: V; label: string };

function Segmented<V extends string>({
  legend,
  name,
  options,
  value,
  onChange,
  hint,
}: {
  legend: string;
  name: string;
  options: Option<V>[];
  value: V;
  onChange: (v: V) => void;
  hint?: string;
}) {
  const hintId = useId();
  return (
    <fieldset className={styles.group} aria-describedby={hint ? hintId : undefined}>
      <legend className={styles.legend}>{legend}</legend>
      <div className={styles.segments}>
        {options.map((o) => (
          <label key={o.value} className={styles.segment}>
            <input
              type="radio"
              className={styles.radio}
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
    </fieldset>
  );
}

export function PreferencesCard() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const uid = useId();

  // Read after mount so server and client markup match.
  useEffect(() => {
    setPrefs(readPrefs());
  }, []);

  function update(patch: Partial<Prefs>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    writePrefs(next);
    applyPrefs(next);
  }

  return (
    <section className="sp-card" aria-labelledby="prefs-title">
      <h2 id="prefs-title" className={styles.heading}>
        Preferences
      </h2>
      <Segmented
        legend="Appearance"
        name={`${uid}-theme`}
        options={[
          { value: "auto", label: "Auto" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
        value={prefs.theme}
        onChange={(theme) => update({ theme })}
        hint="Auto follows your device."
      />
      <Segmented
        legend="Motion"
        name={`${uid}-motion`}
        options={[
          { value: "auto", label: "Auto" },
          { value: "reduced", label: "Reduced" },
        ]}
        value={prefs.motion}
        onChange={(motion) => update({ motion })}
      />
      <Segmented
        legend="Text size"
        name={`${uid}-text`}
        options={[
          { value: "default", label: "Default" },
          { value: "large", label: "Large" },
        ]}
        value={prefs.textSize}
        onChange={(textSize) => update({ textSize })}
      />
      <p className={styles.hint}>
        These settings are saved on this device and apply right away.
      </p>
    </section>
  );
}
