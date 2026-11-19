// The identity layer: a full-page overlay to pick your profile — name,
// color and the modular avatar look (skin, mid, bottom, top). Two uses:
//
// * **setup** (not dismissible): shown while the app loads when the
//   visitor has not picked everything yet (no persisted identity, no
//   URL-provided one) — the join waits for the confirm.
// * **edit** (dismissible): the profile button opens it over the running
//   game with the current setup selected; confirming with a changed
//   identity rejoins (the identity is fixed at join), confirming
//   unchanged just closes.
//
// The avatar config happens only here: there is no other surface that
// edits the look. The look parts pick one row per sheet
// (`world/characters.ts`); the thumbnails and the preview are composited
// cells of the four layers (tools/e2e drives identities through the URL
// params and never opens this).

import { COLORS, saveIdentity } from "./boot";
import {
  BODY_LAYER,
  BOTTOM_COUNT,
  BOTTOM_LAYER,
  IDLE_FRAME,
  MID_COUNT,
  MID_LAYER,
  SKIN_COUNT,
  TOP_COUNT,
  TOP_LAYER,
  loadAvatarSheets,
  parseColor,
  previewCell,
  type Look,
} from "../world/characters";

export interface Identity {
  name: string;
  color: string;
  /** The picked avatar look (one row per sheet). */
  look: Look;
}

export interface ProfileLayerOptions {
  /** `setup` cannot be dismissed; `edit` offers Escape/backdrop close. */
  mode: "setup" | "edit";
  /** The confirm button label ("Join" on first setup, "Done" on edits). */
  confirmLabel: string;
}

/** The look keys, indexed by picker (0 = skin, 1 = top/head, 2 = mid,
 *  3 = bottom). */
const LOOK_KEYS = ["skin", "top", "mid", "bottom"] as const;
/** Picker indexes (the grid order in the card). */
const SKIN_PICKER = 0;
const TOP_PICKER = 1;
const MID_PICKER = 2;
const BOTTOM_PICKER = 3;

/** Open the full-page layer; resolves with the confirmed identity
 *  (`saveIdentity` already persisted it), or `null` when dismissed
 *  (edit mode only). The avatar sheets must be in before the picker can
 *  build its thumbnails, so this awaits them (a no-op once loaded — the
 *  world's `loadAvatarSheets` dedupes through pixi's asset cache). */
export function openProfileLayer(
  root: HTMLElement,
  initial: Identity,
  opts: ProfileLayerOptions,
): Promise<Identity | null> {
  return loadAvatarSheets()
    .catch(() => undefined)
    .then(
      () =>
        new Promise<Identity | null>((resolve) => {
          // Drafts: they start at the current identity and only commit on
          // the confirm button.
          let name = initial.name;
          let color = initial.color;
          const look: Look = { ...initial.look };

          const layer = document.createElement("div");
          layer.className = "identity-layer";
          const card = document.createElement("div");
          card.className = "identity-card";
          const title = document.createElement("div");
          title.className = "identity-title";
          title.textContent =
            opts.mode === "setup" ? "Join the campfire" : "Your profile";
          const hint = document.createElement("div");
          hint.className = "identity-hint";
          hint.textContent =
            opts.mode === "setup"
              ? "pick a name, a color and your look — everyone sees them"
              : "changes rejoin the room";
          const nameInput = document.createElement("input");
          nameInput.className = "profile-name-input";
          nameInput.maxLength = 24;
          nameInput.placeholder = "your name";
          nameInput.autocomplete = "off";
          nameInput.value = name;
          const nameError = document.createElement("div");
          nameError.className = "profile-error hidden";
          const swatches = document.createElement("div");
          swatches.className = "profile-swatches";
          // The composited avatar preview: updates on every pick.
          const preview = document.createElement("canvas");
          preview.className = "identity-preview";
          const previewWrap = document.createElement("div");
          previewWrap.className = "identity-preview-wrap";
          previewWrap.appendChild(preview);
          const pickers: HTMLDivElement[] = [];
          for (let i = 0; i < 4; i++) {
            const grid = document.createElement("div");
            grid.className = "profile-characters";
            pickers.push(grid);
          }
          const doneBtn = document.createElement("button");
          doneBtn.className = "profile-done";
          doneBtn.textContent = opts.confirmLabel;

          nameInput.addEventListener("input", () => {
            name = nameInput.value;
            nameError.classList.add("hidden");
          });

          for (const c of COLORS) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "swatch";
            b.dataset.color = c;
            b.style.background = c;
            b.setAttribute("aria-label", `color ${c}`);
            b.addEventListener("click", () => {
              color = c;
              syncSwatchSelection();
              // The hair thumbnails and the preview carry the color.
              syncPickers(true);
            });
            swatches.appendChild(b);
          }

          /** One option button per sheet row. `parts` selects which layers
           *  the thumbnail composites (the part's own layer alone — the
           *  full preview above shows the combined look); the hair thumbs
           *  are tinted with the draft color. */
          function renderPicker(
            index: number,
            count: number,
            parts: readonly number[],
          ): void {
            const grid = pickers[index]!;
            grid.replaceChildren();
            const tint = parseColor(color);
            for (let i = 0; i < count; i++) {
              const b = document.createElement("button");
              b.type = "button";
              b.className = "swatch character";
              b.dataset.part = String(index);
              b.dataset.option = String(i);
              b.title = ["skin", "hair or cap", "shirt", "bottom"][index]! + ` ${i + 1}`;
              const draft = { ...look, [LOOK_KEYS[index]!]: i } as Look;
              const cell = previewCell(draft, IDLE_FRAME, parts, tint);
              if (cell) {
                cell.className = "character-cell";
                b.appendChild(cell);
              }
              b.addEventListener("click", () => {
                look[LOOK_KEYS[index]!] = i;
                syncPickers();
              });
              grid.appendChild(b);
            }
          }

          function syncSwatchSelection(): void {
            for (const s of swatches.children) {
              (s as HTMLElement).classList.toggle(
                "selected",
                (s as HTMLElement).dataset.color === color,
              );
            }
          }

          /** Refresh the preview + the pickers' selection marks. `rerender`
           *  rebuilds the grids' thumbnails (a skin or color change shows
           *  through hair/top/bottom thumbs). */
          function syncPickers(rerender = false): void {
            const cell = previewCell(look, IDLE_FRAME, undefined, parseColor(color));
            if (cell) {
              preview.width = cell.width;
              preview.height = cell.height;
              preview.getContext("2d")!.drawImage(cell, 0, 0);
            }
            if (rerender) {
              renderPicker(SKIN_PICKER, SKIN_COUNT, [BODY_LAYER]);
              renderPicker(TOP_PICKER, TOP_COUNT, [BODY_LAYER, TOP_LAYER]);
              renderPicker(MID_PICKER, MID_COUNT, [BODY_LAYER, MID_LAYER]);
              renderPicker(BOTTOM_PICKER, BOTTOM_COUNT, [BODY_LAYER, BOTTOM_LAYER]);
            }
            for (const grid of pickers) {
              for (const el of grid.children) {
                const b = el as HTMLElement;
                b.classList.toggle(
                  "selected",
                  Number(b.dataset.option) === look[LOOK_KEYS[Number(b.dataset.part)!]!],
                );
              }
            }
          }

          function close(): void {
            document.removeEventListener("keydown", onKey);
            layer.remove();
          }

          /** Edit mode only: Escape discards the draft. */
          function onKey(e: KeyboardEvent): void {
            if (e.key === "Escape") {
              close();
              resolve(null);
            }
          }

          doneBtn.addEventListener("click", () => {
            const trimmed = name.trim();
            if (trimmed.length < 1 || trimmed.length > 24) {
              nameError.textContent = "Name must be 1–24 characters.";
              nameError.classList.remove("hidden");
              return;
            }
            name = trimmed;
            saveIdentity(name, color, look);
            close();
            resolve({ name, color, look });
          });

          if (opts.mode === "edit") {
            // Escape or a click on the backdrop discards the draft.
            document.addEventListener("keydown", onKey);
            layer.addEventListener("mousedown", (e) => {
              if (e.target === layer) {
                close();
                resolve(null);
              }
            });
          }

          const label = (t: string): HTMLDivElement => {
            const d = document.createElement("div");
            d.className = "profile-label";
            d.textContent = t;
            return d;
          };
          card.append(
            title,
            hint,
            nameInput,
            nameError,
            label("Color"),
            swatches,
            previewWrap,
            label("Skin"),
            pickers[SKIN_PICKER]!,
            label("Hair & hats"),
            pickers[TOP_PICKER]!,
            label("Shirt"),
            pickers[MID_PICKER]!,
            label("Bottom"),
            pickers[BOTTOM_PICKER]!,
            doneBtn,
          );
          layer.appendChild(card);
          root.appendChild(layer);
          renderPicker(SKIN_PICKER, SKIN_COUNT, [BODY_LAYER]);
          renderPicker(TOP_PICKER, TOP_COUNT, [BODY_LAYER, TOP_LAYER]);
          renderPicker(MID_PICKER, MID_COUNT, [BODY_LAYER, MID_LAYER]);
          renderPicker(BOTTOM_PICKER, BOTTOM_COUNT, [BODY_LAYER, BOTTOM_LAYER]);
          syncSwatchSelection();
          syncPickers();
          nameInput.focus();
        }),
    );
}
