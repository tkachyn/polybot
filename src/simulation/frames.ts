import type { HazardType } from "../api/dto.js";
import type { SimPage, StageLayout } from "./catalogue.js";

/** UI identity colours from the handoff, keyed by agent key. */
export const AGENT_COLORS: Readonly<Record<string, string>> = {
  gpt: "#7fd1c1",
  claude: "#e8c07a",
  gemini: "#79a8e8",
  grok: "#b39ae0",
};
const FALLBACK_COLOR = "#2c7da0";
const SABOTAGE_COLOR = "#e8736b";

export const FRAME_WIDTH = 1280;
export const FRAME_HEIGHT = 800;

export type SimFrameInput = {
  brand: string;
  page: SimPage;
  /** 1-based stage number; stageCount + 1 is the finish page. */
  stageNumber: number;
  stageCount: number;
  stageLabel: string;
  agentKey: string;
  agentName: string;
  step: number;
  maxSteps: number;
  action: string | null;
  disruption: { hazardType: HazardType; effectLabel: string } | null;
  status?: "working" | "finished" | "failed" | "idle";
};

type Box = { x: number; y: number; w: number; h: number };

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function rect(box: Box, fill: string, extra = ""): string {
  return `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="8" fill="${fill}"${extra}/>`;
}

function text(
  x: number,
  y: number,
  value: string,
  options: { size?: number; fill?: string; weight?: number; anchor?: "start" | "middle" | "end" } = {},
): string {
  const size = options.size ?? 16;
  const fill = options.fill ?? "#1f2933";
  const weight = options.weight ?? 400;
  const anchor = options.anchor ?? "start";
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" ` +
    `text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

/** Grey placeholder lines standing in for body copy. */
function lines(x: number, y: number, widths: number[], gap = 22): string {
  return widths
    .map((width, index) => `<rect x="${x}" y="${y + index * gap}" width="${width}" height="10" rx="5" fill="#dfe5ea"/>`)
    .join("");
}

function button(box: Box, label: string, fill: string, color = "#ffffff"): string {
  return rect(box, fill) +
    text(box.x + box.w / 2, box.y + box.h / 2 + 6, clip(label, 30), { size: 17, fill: color, weight: 600, anchor: "middle" });
}

function field(x: number, y: number, width: number, label: string, value: string): string {
  return text(x, y, label, { size: 13, fill: "#52606d", weight: 500 }) +
    `<rect x="${x}" y="${y + 10}" width="${width}" height="44" rx="6" fill="#ffffff" stroke="#cbd2d9"/>` +
    text(x + 14, y + 38, clip(value, 44), { size: 15, fill: "#323f4b" });
}

function actionValue(page: SimPage, index: number): string {
  const action = page.actions[index % page.actions.length] ?? "";
  const quoted = /"([^"]+)"/.exec(action);
  return quoted ? quoted[1] : clip(action.replace(/^\w+\s/, ""), 36);
}

/** Renders the layout body and returns where the target control sits. */
function layoutBody(layout: StageLayout, page: SimPage): { svg: string; target: Box } {
  const parts: string[] = [];
  let target: Box;
  switch (layout) {
    case "search": {
      parts.push(`<rect x="60" y="200" width="780" height="50" rx="25" fill="#ffffff" stroke="#cbd2d9"/>`);
      parts.push(text(88, 232, actionValue(page, 0), { size: 16, fill: "#323f4b" }));
      for (let index = 0; index < 4; index += 1) {
        const y = 280 + index * 110;
        parts.push(rect({ x: 60, y, w: 780, h: 96 }, "#ffffff", ` stroke="#e4e7eb"`));
        parts.push(`<rect x="76" y="${y + 14}" width="68" height="68" rx="6" fill="#e9eef3"/>`);
        parts.push(lines(164, y + 22, [360 - index * 30, 240, 120]));
      }
      target = { x: 900, y: 200, w: 300, h: 50 };
      break;
    }
    case "list": {
      for (let index = 0; index < 4; index += 1) {
        const y = 200 + index * 100;
        parts.push(rect({ x: 60, y, w: 780, h: 86 }, index === 1 ? "#eef6fb" : "#ffffff", ` stroke="#e4e7eb"`));
        parts.push(`<circle cx="92" cy="${y + 43}" r="10" fill="none" stroke="#9aa5b1" stroke-width="2"/>`);
        parts.push(lines(120, y + 26, [300 + (index % 2) * 120, 200]));
      }
      target = { x: 900, y: 600, w: 300, h: 56 };
      break;
    }
    case "detail": {
      parts.push(`<rect x="60" y="200" width="400" height="380" rx="10" fill="#e9eef3"/>`);
      parts.push(`<path d="M160 480 L240 380 L300 440 L340 400 L400 480 Z" fill="#cfd8e0"/>`);
      parts.push(lines(500, 214, [300, 260, 180]));
      parts.push(text(500, 330, actionValue(page, 0), { size: 22, fill: "#1f2933", weight: 600 }));
      parts.push(lines(500, 360, [320, 300, 280, 200]));
      target = { x: 500, y: 500, w: 320, h: 56 };
      break;
    }
    case "form": {
      for (let index = 0; index < 4; index += 1) {
        parts.push(field(60, 200 + index * 90, 620, `Field ${index + 1}`, actionValue(page, index)));
      }
      target = { x: 60, y: 580, w: 320, h: 56 };
      break;
    }
    case "cart": {
      for (let index = 0; index < 3; index += 1) {
        const y = 200 + index * 90;
        parts.push(rect({ x: 60, y, w: 780, h: 76 }, "#ffffff", ` stroke="#e4e7eb"`));
        parts.push(`<rect x="76" y="${y + 12}" width="52" height="52" rx="6" fill="#e9eef3"/>`);
        parts.push(lines(148, y + 22, [280, 160]));
        parts.push(`<rect x="740" y="${y + 30}" width="70" height="12" rx="6" fill="#cbd2d9"/>`);
      }
      parts.push(rect({ x: 900, y: 200, w: 320, h: 380 }, "#ffffff", ` stroke="#e4e7eb"`));
      parts.push(text(924, 240, "Summary", { size: 18, weight: 600 }));
      parts.push(lines(924, 270, [240, 200, 260, 180]));
      target = { x: 920, y: 500, w: 280, h: 56 };
      break;
    }
    case "calendar": {
      for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 6; column += 1) {
          const cell = { x: 60 + column * 130, y: 200 + row * 80, w: 116, h: 64 };
          const open = (row * 7 + column * 3) % 5 !== 0;
          parts.push(rect(cell, open ? "#ffffff" : "#eef1f4", ` stroke="#e4e7eb"`));
          if (open) parts.push(`<rect x="${cell.x + 18}" y="${cell.y + 27}" width="80" height="10" rx="5" fill="#dfe5ea"/>`);
        }
      }
      target = { x: 900, y: 360, w: 300, h: 56 };
      break;
    }
    case "confirm":
    default: {
      parts.push(rect({ x: 60, y: 200, w: 780, h: 380 }, "#ffffff", ` stroke="#e4e7eb"`));
      parts.push(`<circle cx="140" cy="280" r="34" fill="#e3f7ee"/>`);
      parts.push(`<path d="M124 280 L136 292 L158 268" fill="none" stroke="#34c98a" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`);
      parts.push(lines(200, 262, [380, 300]));
      parts.push(lines(100, 360, [640, 600, 520, 560, 380]));
      target = { x: 900, y: 500, w: 300, h: 56 };
      break;
    }
  }
  return { svg: parts.join(""), target };
}

function cursor(x: number, y: number, color: string): string {
  return `<path d="M${x} ${y} l0 26 l7 -7 l6 13 l5 -2 l-6 -13 l10 0 Z" fill="#111827" stroke="${color}" stroke-width="2"/>`;
}

function highlight(box: Box, color: string, agentName: string): string {
  const tagWidth = Math.min(220, 24 + agentName.length * 8.5);
  return `<rect x="${box.x - 6}" y="${box.y - 6}" width="${box.w + 12}" height="${box.h + 12}" rx="12" ` +
    `fill="none" stroke="${color}" stroke-width="4"/>` +
    `<rect x="${box.x - 6}" y="${box.y - 38}" width="${tagWidth}" height="26" rx="6" fill="${color}"/>` +
    text(box.x + 6, box.y - 20, clip(agentName, 24), { size: 13, fill: "#0d151d", weight: 600 }) +
    cursor(box.x + box.w - 30, box.y + box.h - 18, color);
}

/**
 * A stylised light-theme web page for one simulated agent's current stage,
 * as an SVG document (1280x800 viewBox).
 */
export function renderSimFrame(input: SimFrameInput): string {
  const color = AGENT_COLORS[input.agentKey] ?? FALLBACK_COLOR;
  const page = input.page;
  const { svg: body, target } = layoutBody(page.layout, page);
  const disruption = input.disruption;
  const parts: string[] = [];

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FRAME_WIDTH} ${FRAME_HEIGHT}" ` +
    `width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" font-family="Inter, Helvetica, Arial, sans-serif">`);
  parts.push(`<rect width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" fill="#f5f7fa"/>`);

  // Browser chrome.
  parts.push(`<rect width="${FRAME_WIDTH}" height="56" fill="#e6eaee"/>`);
  parts.push(`<circle cx="26" cy="28" r="7" fill="#ff5f57"/><circle cx="48" cy="28" r="7" fill="#febc2e"/>` +
    `<circle cx="70" cy="28" r="7" fill="#28c840"/>`);
  parts.push(`<rect x="100" y="12" width="1080" height="32" rx="16" fill="#ffffff"/>`);
  parts.push(text(122, 34, clip(page.url, 110), { size: 14, fill: "#52606d" }));

  // Site header.
  parts.push(`<rect y="56" width="${FRAME_WIDTH}" height="64" fill="#ffffff"/>`);
  parts.push(`<rect y="119" width="${FRAME_WIDTH}" height="1" fill="#e4e7eb"/>`);
  parts.push(text(60, 96, clip(input.brand, 32), { size: 22, weight: 700, fill: "#102a43" }));
  parts.push(`<rect x="830" y="84" width="70" height="10" rx="5" fill="#dfe5ea"/>` +
    `<rect x="920" y="84" width="70" height="10" rx="5" fill="#dfe5ea"/>` +
    `<rect x="1010" y="84" width="70" height="10" rx="5" fill="#dfe5ea"/>` +
    `<rect x="1100" y="78" width="120" height="24" rx="12" fill="#e9eef3"/>`);

  // Heading and stage breadcrumb.
  const stageText = input.stageNumber > input.stageCount
    ? "Final step"
    : `Step ${input.stageNumber} of ${input.stageCount} · ${input.stageLabel}`;
  parts.push(text(60, 150, clip(stageText, 70), { size: 13, fill: "#7b8794", weight: 500 }));
  parts.push(text(60, 182, clip(page.heading, 60), { size: 26, weight: 700, fill: "#1f2933" }));

  parts.push(body);

  // Target control, possibly sabotaged.
  const hazard = disruption?.hazardType ?? null;
  let targetBox = target;
  if (hazard === "move_primary_action") {
    parts.push(`<rect x="${target.x}" y="${target.y}" width="${target.w}" height="${target.h}" rx="8" ` +
      `fill="none" stroke="#9aa5b1" stroke-width="2" stroke-dasharray="8 6"/>`);
    targetBox = { x: 900, y: 690, w: target.w, h: 48 };
  }
  if (hazard === "temporary_disable") {
    parts.push(button(targetBox, page.target, "#d3d9df", "#8a96a3"));
    parts.push(text(targetBox.x + targetBox.w / 2, targetBox.y + targetBox.h + 22, "disabled", {
      size: 13, fill: SABOTAGE_COLOR, weight: 600, anchor: "middle",
    }));
  } else if (hazard === "rename_control") {
    parts.push(button(targetBox, disruption?.effectLabel ?? page.target, "#2c7da0"));
    parts.push(text(targetBox.x + targetBox.w / 2, targetBox.y + targetBox.h + 22, `was "${clip(page.target, 26)}"`, {
      size: 13, fill: SABOTAGE_COLOR, weight: 600, anchor: "middle",
    }));
  } else {
    parts.push(button(targetBox, page.target, "#2c7da0"));
  }
  if (hazard === "insert_decoy") {
    const decoy: Box = { x: targetBox.x, y: targetBox.y - 76, w: targetBox.w, h: targetBox.h };
    parts.push(button(decoy, disruption?.effectLabel ?? "Continue", "#f08c2e"));
    parts.push(`<rect x="${decoy.x - 4}" y="${decoy.y - 4}" width="${decoy.w + 8}" height="${decoy.h + 8}" rx="10" ` +
      `fill="none" stroke="${SABOTAGE_COLOR}" stroke-width="2" stroke-dasharray="6 5"/>`);
  }

  if (input.status !== "failed" && input.status !== "idle") {
    parts.push(highlight(targetBox, color, input.agentName));
  }

  if (hazard === "blocking_modal") {
    parts.push(`<rect y="56" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT - 104}" fill="#0b1220" fill-opacity="0.5"/>`);
    parts.push(`<rect x="370" y="220" width="540" height="320" rx="14" fill="#ffffff" stroke="${SABOTAGE_COLOR}" stroke-width="3"/>`);
    parts.push(text(640, 280, clip(disruption?.effectLabel ?? "Before you continue", 40), {
      size: 22, weight: 700, anchor: "middle",
    }));
    parts.push(lines(430, 310, [420, 380, 300]));
    parts.push(button({ x: 470, y: 420, w: 340, h: 52 }, "Yes, show me", "#f08c2e"));
    parts.push(text(640, 505, "Close", { size: 12, fill: "#9aa5b1", anchor: "middle" }));
    parts.push(cursor(700, 450, color));
  }

  if (input.status === "finished") {
    parts.push(rect({ x: 880, y: 140, w: 340, h: 44 }, "#e3f7ee") +
      text(1050, 168, "Task complete", { size: 16, weight: 600, fill: "#1f7a52", anchor: "middle" }));
  } else if (input.status === "failed") {
    parts.push(rect({ x: 880, y: 140, w: 340, h: 44 }, "#fdecea") +
      text(1050, 168, "Agent stopped", { size: 16, weight: 600, fill: "#b4413a", anchor: "middle" }));
  }

  // Agent status footer.
  parts.push(`<rect y="752" width="${FRAME_WIDTH}" height="48" fill="#15202b"/>`);
  parts.push(`<circle cx="30" cy="776" r="8" fill="${color}"/>`);
  parts.push(text(48, 782, clip(input.agentName, 24), { size: 15, weight: 600, fill: "#ffffff" }));
  parts.push(text(240, 782, clip(input.action ?? "waiting", 96), { size: 14, fill: "#9fb1bf" }));
  parts.push(text(1250, 782, `step ${input.step}/${input.maxSteps}`, { size: 14, fill: "#7e94a6", anchor: "end" }));
  if (hazard) {
    parts.push(rect({ x: 1020, y: 762, w: 120, h: 28 }, SABOTAGE_COLOR) +
      text(1080, 782, "SABOTAGE", { size: 13, weight: 700, fill: "#ffffff", anchor: "middle" }));
  }

  parts.push("</svg>");
  return parts.join("");
}
