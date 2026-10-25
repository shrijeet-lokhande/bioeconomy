import type { ReactNode } from "react";

type BadgeTone =
  | "prototype"
  | "planned"
  | "neutral"
  | "positive"
  | "earth"
  | "muted";

const TONE_CLASS: Record<BadgeTone, string> = {
  prototype: "badge--prototype",
  planned: "badge--planned",
  neutral: "badge--neutral",
  positive: "badge--positive",
  earth: "badge--earth",
  muted: "badge--muted",
};

export type { BadgeTone };

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
}

/** Small status pill. Does not imply any data value, only workflow state. */
export function Badge({ tone = "neutral", children }: BadgeProps) {
  return <span className={`badge ${TONE_CLASS[tone]}`}>{children}</span>;
}
