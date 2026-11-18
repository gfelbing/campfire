// The identity layer: a full-page overlay to pick your profile — name,
// color and pixel-art character. Two uses:
//
// * **setup** (not dismissible): shown while the app loads when the
//   visitor has not picked everything yet (no persisted identity, no
//   URL-provided one) — the join waits for the confirm.
// * **edit** (dismissible): the profile button opens it over the running
//   game; confirming with a changed identity rejoins (the identity is
//   fixed at join), confirming unchanged just closes.
//
// Replaces the old topbar popover: the same form, one layer, one code
// path (tools/e2e drives identities through the URL params and never
// opens this).

import { COLORS, saveIdentity } from "./boot";
import {
  CHARACTER_COUNT,
  loadCharacters,
  previewCell,
} from "../world/characters";

export interface Identity {
  name: string;
  color: string;
  /** The chosen pixel-art character; `null` = derived from the name. */
  character: number | null;
}

export interface ProfileLayerOptions {
  /** `setup` requires a character pick and cannot be dismissed; `edit`
   *  offers the ∅ auto entry and Escape/backdrop close. */
  mode: "setup" | "edit";
  /** The confirm button label ("Join" on first setup, "Done" on edits). */
  confirmLabel: string;
}

/** Open the full-page layer; resolves with the confirmed identity
 *  (`saveIdentity` already persisted it), or `null` when dismissed
 *  (edit mode only). The character sheets must be in before the picker
 *  can build its thumbnails, so this awaits them (a no-op once loaded —
 *  the world's `loadCharacters` dedupes through pixi's asset cache). */
export function openProfileLayer(
  root: HTMLElement,
  initial: Identity,
  opts: ProfileLayerOptions,
): Promise<Identity | null> {
  // The character sheets must be in before the picker can build its
  // thumbnails, so this awaits them (a no-op once loaded — the world's
  // `loadCharacters` dedupes through pixi's asset cache).
  return loadCharacters()
    .catch(() => undefined)
    .then(
      () =>
        new Promise<Identity | null>((resolve) => {
          // Drafts: they start at the current identity and only commit on the
          // confirm button.
          let name = initial.name;
          let color = initial.color;
          let character = initial.character;

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
              ? "pick a name, a color and a character — everyone sees them"
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
          const characters = document.createElement("div");
          characters.className = "profile-characters";
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
              renderCharacterGrid();
            });
            swatches.appendChild(b);
          }

          // A canvas thumbnail per sheet (the idle south frame, recolored to
          // the draft color), plus the ∅ auto entry (edit mode only): the
          // character derived from the name hash, the pre-picker behavior.
          function renderCharacterGrid(): void {
            characters.replaceChildren();
            if (opts.mode === "edit") {
              const auto = document.createElement("button");
              auto.type = "button";
              auto.className = "swatch character";
              auto.textContent = "∅";
              auto.title = "derive the character from your name";
              auto.addEventListener("click", () => {
                character = null;
                syncCharacterSelection();
              });
              characters.appendChild(auto);
            }
            for (let i = 0; i < CHARACTER_COUNT; i++) {
              const b = document.createElement("button");
              b.type = "button";
              b.className = "swatch character";
              b.dataset.character = String(i);
              b.title = `character ${i + 1}`;
              const cell = previewCell(i, color);
              if (cell) {
                cell.className = "character-cell";
                b.appendChild(cell);
              }
              b.addEventListener("click", () => {
                character = i;
                syncCharacterSelection();
              });
              characters.appendChild(b);
            }
            syncCharacterSelection();
          }

          function syncSwatchSelection(): void {
            for (const s of swatches.children) {
              (s as HTMLElement).classList.toggle(
                "selected",
                (s as HTMLElement).dataset.color === color,
              );
            }
          }

          function syncCharacterSelection(): void {
            for (const el of characters.children) {
              const b = el as HTMLElement;
              const sel =
                b.textContent === "∅"
                  ? character === null
                  : Number(b.dataset.character) === character;
              b.classList.toggle("selected", sel);
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
            if (opts.mode === "setup" && character === null) {
              nameError.textContent = "Pick a character below.";
              nameError.classList.remove("hidden");
              return;
            }
            name = trimmed;
            saveIdentity(name, color, character);
            close();
            resolve({ name, color, character });
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
            label("Name"),
            nameInput,
            nameError,
            label("Color"),
            swatches,
            label("Character"),
            characters,
            doneBtn,
          );
          layer.appendChild(card);
          root.appendChild(layer);
          renderCharacterGrid();
          nameInput.focus();
        }),
    );
}
