export const NODE_LABELS = ["Discussion", "Topic", "Entity", "User", "Channel"] as const;
export type NodeLabel = (typeof NODE_LABELS)[number];

/** Concrete hex (WebGL can't use CSS vars) - the dataviz categorical hues. */
export const NODE_LABEL_COLOR: Record<string, string> = {
  Discussion: "#2a78d6",
  Topic: "#1baf7a",
  Entity: "#eda100",
  User: "#e87ba4",
  Channel: "#4a3aa7",
};

export const NODE_LABEL_CS: Record<string, string> = {
  Discussion: "diskuze",
  Topic: "téma",
  Entity: "entita",
  User: "uživatel",
  Channel: "kanál",
};

export function nodeColor(label: string): string {
  return NODE_LABEL_COLOR[label] ?? "#8b8b8b";
}

/** Node radius from total degree, square-root scaled. */
export function nodeSize(degree: number): number {
  return 4 + Math.sqrt(degree) * 2;
}
