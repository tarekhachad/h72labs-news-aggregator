"use client"

import * as React from "react"
import type { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"

import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"

/**
 * A searchable multi-select that submits with a plain <form>: Base UI's
 * multiple Combobox renders one hidden <input name={name}> per selected
 * value, so a server action reads the picks with formData.getAll(name).
 *
 * `max` stops further picks in the UI once reached (already-picked items
 * can still be removed). A default selection over `max` is kept as given,
 * with a notice asking the reader to trim it; the server enforces the limit.
 */
export function MultiSelect<T extends string>({
  id,
  name,
  label,
  hint,
  items,
  defaultValue = [],
  max,
  noun,
  placeholder,
}: {
  id: string
  name: string
  label: string
  /** Shown under the label and read with the input, e.g. "Pick 3 to 10." */
  hint: string
  items: readonly T[]
  defaultValue?: readonly T[]
  max?: number
  /** Plural noun for the counter and notices, e.g. "topics". */
  noun: string
  placeholder: string
}) {
  const [value, setValue] = React.useState<T[]>(() => [...defaultValue])
  const chipsRef = React.useRef<HTMLDivElement>(null)

  const atMax = max !== undefined && value.length >= max
  const overMax = max !== undefined && value.length > max

  function handleValueChange(next: T[], details: ComboboxPrimitive.Root.ChangeEventDetails) {
    // Base UI clears every pick on Escape in a closed list. Here that would
    // let a stray Escape empty the picker and the next save (delete-then-
    // insert) wipe the reader's saved preferences, so Escape never changes
    // the selection; it still closes the list and clears the search text.
    if (details.reason === "escape-key") return
    // Enter only adds. Typing highlights the first match, which may be a
    // topic already picked ("Morocco" lists a picked "Morocco Politics"
    // first), and a toggle would silently drop it. Removing stays on the
    // chips and on a click of a picked row.
    if (
      details.reason === "item-press" &&
      details.event instanceof KeyboardEvent &&
      details.event.key === "Enter" &&
      next.length < value.length
    ) {
      return
    }
    // Disabled items already stop a pick past the limit; this also covers
    // any path that adds a value without going through an item.
    if (max !== undefined && next.length > max && next.length > value.length) return
    setValue(next)
  }

  // Enter in a text input submits its form unless the keydown is
  // default-prevented, and Base UI only prevents it when an item is
  // highlighted. autoHighlight covers a search with matches; this covers one
  // with none (or a disabled match at the limit), so a half-typed search
  // never saves the form without the item the reader was looking for.
  // preventDefault doesn't stop Base UI's own handler from picking the
  // highlighted item.
  function preventSubmitWhileSearching(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && event.currentTarget.value !== "") event.preventDefault()
  }

  const hintId = `${id}-hint`
  const countId = `${id}-count`

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-4">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <span
          id={countId}
          aria-live="polite"
          className="text-sm tabular-nums"
          style={{ color: overMax ? "var(--color-destructive)" : "var(--color-muted-foreground)" }}
        >
          {max === undefined ? `${value.length} selected` : `${value.length} of ${max}`}
        </span>
      </div>
      <p id={hintId} className="text-sm" style={{ color: "var(--color-muted-foreground)" }}>
        {hint}
      </p>

      <Combobox
        multiple
        autoHighlight
        name={name}
        items={items}
        value={value}
        onValueChange={handleValueChange}
      >
        <ComboboxChips ref={chipsRef}>
          {value.map((item) => (
            <ComboboxChip key={item} removeLabel={`Remove ${item}`}>
              {item}
            </ComboboxChip>
          ))}
          <ComboboxChipsInput
            id={id}
            placeholder={value.length === 0 ? placeholder : undefined}
            aria-describedby={`${hintId} ${countId}`}
            onKeyDown={preventSubmitWhileSearching}
          />
        </ComboboxChips>

        <ComboboxContent anchor={chipsRef}>
          <ComboboxEmpty>No match.</ComboboxEmpty>
          <ComboboxList aria-label={label}>
            {(item: T) => (
              <ComboboxItem
                key={item}
                value={item}
                disabled={atMax && !value.includes(item)}
              >
                {item}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>

      {overMax && (
        <p role="status" className="text-sm" style={{ color: "var(--color-destructive)" }}>
          {`You follow ${value.length} ${noun}; the limit is now ${max}. Remove ${value.length - max} before you next save.`}
        </p>
      )}
    </div>
  )
}
