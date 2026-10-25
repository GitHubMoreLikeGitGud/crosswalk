// The run mode banner under the top bar: REPLAY for a saved run, LIVE for a run measuring now.
// Exactly one word is ever shown; an unknown mode shows nothing. Pure.

import { esc } from "../lib.js";

const WORD = { replay: "REPLAY", live: "LIVE" };

export function bannerHtml(mode, text = "") {
  const word = WORD[mode];
  if (!word) return "";
  return `<span class="banner__word banner__word--${mode}">${word}</span><span class="banner__text">${esc(text)}</span>`;
}
