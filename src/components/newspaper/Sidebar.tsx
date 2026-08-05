"use client";

import Link from "next/link";
import { Menu, Bookmark, History, Settings, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { signOutAction } from "@/app/auth/actions";

/**
 * Hamburger-triggered overlay sidebar, present on every newspaper page (see
 * docs/(C) UI_DESIGN.md's Sidebar section). shadcn's Sheet already gives us
 * the overlay/dimmed-backdrop/focus-trap behavior for free — the underlying
 * page never resizes, so grid box-sizing never has to account for a
 * variable content width.
 */
export function Sidebar() {
  return (
    <Sheet>
      <SheetTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Open menu" className="cursor-pointer">
            <Menu />
          </Button>
        }
      />
      <SheetContent side="left">
        <SheetHeader>
          <SheetTitle className="font-heading">Menu</SheetTitle>
        </SheetHeader>
        <nav className="flex flex-col gap-1 px-4">
          {/* SheetClose, not a plain Link: Masthead/Sidebar live in the
              shared (paper) layout and stay mounted across client-side
              navigation within it, so a plain Link click would change the
              URL but leave the Sheet's open state (and its inert-behind-
              backdrop underlying page) untouched — the destination page,
              including its own hamburger, would be stuck non-interactable
              until manually dismissed. SheetClose's render prop closes the
              dialog synchronously with the navigation, same pattern as the
              visible X button below. nativeButton={false} suppresses Base
              UI's dev warning about rendering a non-native-button element
              (it defaults to expecting one), but as a side effect Base UI
              applies role="button" to these anchors regardless of the
              underlying <a> tag — assistive tech announces them as
              buttons, not links, even though they're real navigable hrefs.
              Accepted trade-off for the close-and-navigate pattern. */}
          <SheetClose
            nativeButton={false}
            render={
              <Link
                href="/saved"
                className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-[var(--color-muted)]"
              />
            }
          >
            <Bookmark className="size-4" /> Saved
          </SheetClose>
          <SheetClose
            nativeButton={false}
            render={
              <Link
                href="/history"
                className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-[var(--color-muted)]"
              />
            }
          >
            <History className="size-4" /> History
          </SheetClose>
          <SheetClose
            nativeButton={false}
            render={
              <Link
                href="/profile"
                className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-[var(--color-muted)]"
              />
            }
          >
            <Settings className="size-4" /> Settings
          </SheetClose>
          <form action={signOutAction}>
            <button
              type="submit"
              className="flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-[var(--color-muted)]"
            >
              <LogOut className="size-4" /> Sign out
            </button>
          </form>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
